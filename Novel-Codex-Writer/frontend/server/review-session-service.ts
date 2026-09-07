import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { normalizeChapterReviewRun, type ChapterReviewRun, type ReviewFinding } from "./chapter-review.ts";
import { assertNoSymlinkEscape, atomicWriteJsonInside, readFileInside, withProjectWriteLock } from "./file-storage.ts";
import { HttpError } from "./http-error.ts";
import { createRevision } from "./review-utils.ts";

export interface ReviewSessionBody {
  schemaVersion?: unknown;
  projectId?: unknown;
  documentPath?: unknown;
  baseRevision?: unknown;
  status?: unknown;
  annotations?: unknown;
  chapterReviewRuns?: unknown;
  updatedAt?: unknown;
  sessionRevision?: unknown;
  expectedRevision?: unknown;
}

export function parseReviewSessionBody(raw: string): ReviewSessionBody {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as ReviewSessionBody;
  } catch {
    throw new HttpError(409, "批注会话文件已损坏，已拒绝继续读写。", "REVIEW_SESSION_INVALID");
  }
}

function documentPathIdentity(value: string) {
  const normalized = posix.normalize(value.replace(/\\/g, "/").replace(/^\/+/, "")).normalize("NFC");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameDocumentPath(left: unknown, right: string) {
  return typeof left === "string" && documentPathIdentity(left) === documentPathIdentity(right);
}

export function createEmptyReviewSession(projectId: string, documentPath: string) {
  return {
    schemaVersion: 4,
    projectId,
    documentPath,
    baseRevision: "",
    status: "active",
    annotations: [],
    chapterReviewRuns: [],
    updatedAt: new Date().toISOString(),
    sessionRevision: ""
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" && value[key].length > 0;
}

function optionalString(value: Record<string, unknown>, key: string) {
  return value[key] === undefined || typeof value[key] === "string";
}

function isAiEngine(value: unknown) {
  return value === "deepseek" || value === "codex";
}

const reviewSeverities = new Set(["S1", "S2", "S3", "S4"]);
const suggestionCategories = new Set([
  "outline", "continuity", "character", "timeline", "world", "foreshadowing",
  "pacing", "voice", "repetition", "language"
]);
const annotationStatuses = new Set(["draft", "pending", "running", "ready", "accepted", "ignored", "stale", "error"]);

function isSuggestion(value: unknown) {
  if (!isRecord(value)) return false;
  const usage = value.usage;
  const validUsage = usage === null || (isRecord(usage)
    && (usage.inputTokens === undefined || (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)))
    && (usage.outputTokens === undefined || (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens))));
  return (value.decision === "change" || value.decision === "keep")
    && reviewSeverities.has(String(value.severity))
    && suggestionCategories.has(String(value.category))
    && typeof value.before === "string"
    && typeof value.after === "string"
    && requiredString(value, "rationale")
    && requiredString(value, "model")
    && validUsage;
}

function isConversationMessage(value: unknown) {
  return isRecord(value)
    && requiredString(value, "id")
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && requiredString(value, "createdAt")
    && (value.engine === undefined || isAiEngine(value.engine))
    && (value.suggestion === undefined || isSuggestion(value.suggestion));
}

function isReviewAnnotation(value: unknown) {
  if (!isRecord(value)) return false;
  const messages = value.messages;
  return requiredString(value, "id")
    && Number.isInteger(value.fromLine)
    && Number(value.fromLine) > 0
    && Number.isInteger(value.toLine)
    && Number(value.toLine) >= Number(value.fromLine)
    && typeof value.comment === "string"
    && (messages === undefined || (Array.isArray(messages) && messages.length <= 200 && messages.every(isConversationMessage)))
    && typeof value.originalText === "string"
    && isAiEngine(value.engine)
    && annotationStatuses.has(String(value.status))
    && requiredString(value, "anchorHash")
    && (value.suggestion === undefined || isSuggestion(value.suggestion))
    && optionalString(value, "error")
    && requiredString(value, "createdAt")
    && requiredString(value, "updatedAt");
}

function invalidSession(touch: boolean, message: string) {
  return new HttpError(touch ? 400 : 409, message, "REVIEW_SESSION_INVALID");
}

export function normalizeReviewSession(body: ReviewSessionBody, projectId: string, documentPath: string, touch: boolean) {
  if (body.projectId !== undefined && body.projectId !== projectId) throw new HttpError(403, "不能把其他小说的批注写入当前作品。");
  if (body.documentPath !== undefined && !sameDocumentPath(body.documentPath, documentPath)) throw new HttpError(400, "批注文档路径不一致。");
  if (body.schemaVersion !== undefined && (!Number.isInteger(body.schemaVersion) || Number(body.schemaVersion) < 1 || Number(body.schemaVersion) > 4)) {
    throw invalidSession(touch, "批注会话 schema 版本不受支持。");
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "completed") {
    throw invalidSession(touch, "批注会话状态格式不正确。");
  }
  if (body.baseRevision !== undefined && typeof body.baseRevision !== "string") {
    throw invalidSession(touch, "批注会话正文 revision 格式不正确。");
  }
  if (body.updatedAt !== undefined && typeof body.updatedAt !== "string") {
    throw invalidSession(touch, "批注会话更新时间格式不正确。");
  }
  if (body.annotations !== undefined && !Array.isArray(body.annotations)) throw invalidSession(touch, "批注列表格式不正确。");
  const annotations = Array.isArray(body.annotations) ? body.annotations : [];
  if (annotations.length > 500) throw invalidSession(touch, "批注列表超过 500 条上限。");
  if (!annotations.every(isReviewAnnotation)) throw invalidSession(touch, "批注列表包含无效或损坏数据，已拒绝继续。");
  if (body.chapterReviewRuns !== undefined && !Array.isArray(body.chapterReviewRuns)) throw new HttpError(400, "整章审阅记录格式不正确。");
  const rawRuns = Array.isArray(body.chapterReviewRuns) ? body.chapterReviewRuns : [];
  if (rawRuns.length > 20) throw new HttpError(touch ? 400 : 409, "整章审阅记录超过 20 条上限。", "REVIEW_SESSION_INVALID");
  // Only persisted pre-v4 sessions may lack the evidence revisions introduced in v4.
  // Retain their findings but downgrade unsupported confirmation; never migrate client writes.
  const legacyEvidence = !touch && (body.schemaVersion === undefined || Number(body.schemaVersion) < 4);
  const chapterReviewRuns = rawRuns.map((run) => normalizeChapterReviewRun(run, { legacyEvidence }));
  if (chapterReviewRuns.some((item) => item === null)) {
    throw new HttpError(touch ? 400 : 409, "整章审阅记录包含无效或损坏数据，已拒绝继续。", "REVIEW_SESSION_INVALID");
  }
  const normalized = {
    schemaVersion: 4,
    projectId,
    documentPath,
    baseRevision: typeof body.baseRevision === "string" ? body.baseRevision : "",
    status: body.status === "completed" ? "completed" : "active",
    annotations,
    chapterReviewRuns: chapterReviewRuns as ChapterReviewRun[],
    // Missing legacy timestamps need a stable, nonempty value for client validation and revision checks.
    updatedAt: touch ? new Date().toISOString() : typeof body.updatedAt === "string" && body.updatedAt ? body.updatedAt : "1970-01-01T00:00:00.000Z"
  };
  return { ...normalized, sessionRevision: createRevision(JSON.stringify(normalized)) };
}

export async function persistReviewSessionVersioned(input: {
  projectRoot: string;
  sessionFile: string;
  projectId: string;
  documentPath: string;
  body: ReviewSessionBody;
  loadDocumentRevision(): Promise<string>;
}) {
  return withProjectWriteLock(input.projectRoot, `.review-sessions/${input.documentPath}`, async () => {
    let currentRevision = "";
    let storedRuns: ChapterReviewRun[] = [];
    if (existsSync(input.sessionFile)) {
      const stored = normalizeReviewSession(
        parseReviewSessionBody(await readFileInside(input.projectRoot, input.sessionFile, "utf8")),
        input.projectId,
        input.documentPath,
        false
      );
      currentRevision = stored.sessionRevision;
      storedRuns = stored.chapterReviewRuns;
    }
    if (input.body.expectedRevision !== currentRevision) {
      throw new HttpError(409, "批注会话已被其他请求修改，请重新载入后再保存。");
    }
    const documentRevision = await input.loadDocumentRevision();
    if (typeof input.body.baseRevision !== "string" || input.body.baseRevision !== documentRevision) {
      throw new HttpError(409, "批注会话绑定的正文 revision 已过期，请重新载入正文。");
    }
    const session = normalizeReviewSession(input.body, input.projectId, input.documentPath, true);
    for (const run of session.chapterReviewRuns) {
      if (run.status === "running") {
        throw new HttpError(409, "仍在运行的整章审阅尚未由服务端签发，不能持久化。", "REVIEW_RUN_NOT_FINAL");
      }
      if (run.documentRevision !== documentRevision && run.status !== "stale") {
        throw new HttpError(409, "整章审阅记录绑定的正文 revision 已过期，不能挂入当前会话。", "REVIEW_RUN_STALE");
      }
      if (run.documentRevision === documentRevision && run.status === "stale") {
        throw new HttpError(409, "整章审阅记录与当前正文 revision 一致，不能伪造为 stale。", "REVIEW_RUN_INVALID_STATE");
      }
      const issued = await loadIssuedReviewRun(input.projectRoot, input.documentPath, run.id);
      // Before server-issued proofs existed, sessions already contained historical runs.
      // They may be retained as stale records, but cannot be edited or revived as new results.
      const retainedHistory = !issued && !existsSync(issuedReviewRunPath(input.projectRoot, run.id))
        && isRetainedHistoricalRun(run, storedRuns.find((item) => item.id === run.id));
      if ((!issued || !isDerivedFromIssuedRun(run, issued)) && !retainedHistory) {
        throw new HttpError(409, "整章审阅记录没有匹配的服务端签发依据，已拒绝保存。", "REVIEW_RUN_UNTRUSTED");
      }
    }
    assertNoSymlinkEscape(input.projectRoot, input.sessionFile);
    await mkdir(dirname(input.sessionFile), { recursive: true });
    await atomicWriteJsonInside(input.projectRoot, input.sessionFile, session);
    return session;
  });
}

function isRetainedHistoricalRun(candidate: ChapterReviewRun, stored: ChapterReviewRun | undefined) {
  if (!stored || candidate.status !== "stale" || stored.status === "running") return false;
  const historical = {
    ...stored,
    status: "stale",
    verdict: "stale",
    findings: stored.findings.map((finding, index) => ({
      ...finding,
      status: candidate.findings[index]?.status === "stale" ? "stale" : finding.status
    }))
  };
  return JSON.stringify(candidate) === JSON.stringify(historical);
}

function issuedReviewRunPath(projectRoot: string, runId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new HttpError(400, "审阅运行 ID 不合法。", "REVIEW_RUN_ID_INVALID");
  const target = resolve(projectRoot, "审查报告", ".review-runs", `${runId}.json`);
  assertNoSymlinkEscape(projectRoot, target);
  return target;
}

export async function persistIssuedReviewRun(projectRoot: string, documentPath: string, run: ChapterReviewRun) {
  await withProjectWriteLock(projectRoot, `.review-runs/${run.id}`, () =>
    atomicWriteJsonInside(projectRoot, issuedReviewRunPath(projectRoot, run.id), { schemaVersion: 1, documentPath, run })
  );
}

export async function loadIssuedReviewRun(projectRoot: string, documentPath: string, runId: string) {
  const target = issuedReviewRunPath(projectRoot, runId);
  if (!existsSync(target)) return null;
  try {
    const payload = JSON.parse(await readFileInside(projectRoot, target, "utf8")) as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || !sameDocumentPath(payload.documentPath, documentPath)) return null;
    return normalizeChapterReviewRun(payload.run);
  } catch {
    return null;
  }
}

function immutableFinding(value: ReviewFinding) {
  const { status: _status, dismissalReason: _dismissalReason, ...immutable } = value;
  return immutable;
}

export function isDerivedFromIssuedRun(candidate: ChapterReviewRun, issued: ChapterReviewRun) {
  if (
    (issued.status !== "completed" && issued.status !== "error") || candidate.id !== issued.id || candidate.documentRevision !== issued.documentRevision ||
    (candidate.status !== issued.status && candidate.status !== "stale") || candidate.engine !== issued.engine || candidate.promptVersion !== issued.promptVersion ||
    candidate.createdAt !== issued.createdAt || candidate.summary !== issued.summary || candidate.error !== issued.error ||
    JSON.stringify(candidate.contextManifest) !== JSON.stringify(issued.contextManifest) ||
    candidate.completedAt !== issued.completedAt || candidate.findings.length !== issued.findings.length
  ) return false;
  if (new Set(issued.findings.map((item) => item.id)).size !== issued.findings.length) return false;
  if (new Set(candidate.findings.map((item) => item.id)).size !== candidate.findings.length) return false;
  const issuedFindings = new Map(issued.findings.map((item) => [item.id, immutableFinding(item)]));
  return candidate.findings.every((item) => {
    const original = issuedFindings.get(item.id);
    return original !== undefined && JSON.stringify(immutableFinding(item)) === JSON.stringify(original);
  });
}
