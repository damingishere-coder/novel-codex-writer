import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError, assertInsidePath, assertNoSymlinkEscape, atomicWriteJsonInside, readFileInsideLimited, revisionOf, withProjectSnapshotLock, withProjectWriteLock } from "./file-storage.ts";
import type { WorkflowArtifact, WorkflowContextItem, WorkflowNextStep, WorkflowRecommendedAction, WorkflowState } from "../shared/api-contract.ts";
import { terminateProcessTree } from "./process-tree.ts";

interface WorkflowOptions {
  projectRoot: string;
  projectId: string;
  chapter?: number;
  signal?: AbortSignal;
}

interface WorkflowReadBudget {
  files: number;
  bytes: number;
  cache: Map<string, Buffer>;
}

const WORKFLOW_MAX_FILES = 128;
const WORKFLOW_MAX_FILE_BYTES = 2 * 1024 * 1024;
const WORKFLOW_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function createWorkflowReadBudget(): WorkflowReadBudget {
  return { files: 0, bytes: 0, cache: new Map() };
}

async function readWorkflowFile(
  projectRoot: string,
  path: string,
  budget: WorkflowReadBudget,
  signal?: AbortSignal
) {
  ensureNotAborted(signal);
  const cacheKey = resolve(path);
  const cached = budget.cache.get(cacheKey);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > WORKFLOW_MAX_FILES) {
    throw new ApiError(413, `工作流读取文件数超过 ${WORKFLOW_MAX_FILES} 个安全上限。`, "WORKFLOW_FILE_LIMIT");
  }
  const remaining = WORKFLOW_MAX_TOTAL_BYTES - budget.bytes;
  if (remaining <= 0) {
    throw new ApiError(413, `工作流读取总量超过 ${WORKFLOW_MAX_TOTAL_BYTES} 字节安全上限。`, "WORKFLOW_BYTE_LIMIT");
  }
  const maximum = Math.min(WORKFLOW_MAX_FILE_BYTES, remaining);
  try {
    const data = await readFileInsideLimited(projectRoot, path, maximum, signal);
    budget.bytes += data.length;
    budget.cache.set(cacheKey, data);
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.code === "READ_BYTE_LIMIT") {
      throw new ApiError(413, `工作流文件或总读取量超过安全上限：${projectPath(projectRoot, path)}`, "WORKFLOW_BYTE_LIMIT");
    }
    throw error;
  }
}

function ensureNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError(499, "工作流状态读取已取消。", "WORKFLOW_ABORTED");
}

function validateProjectBinding(projectRoot: string, projectId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(projectId) || basename(resolve(projectRoot)) !== projectId) {
    throw new ApiError(403, "projectId 与项目目录不匹配，已拒绝执行工作流。", "WORKFLOW_PROJECT_MISMATCH");
  }
}

function projectPath(projectRoot: string, target: string) {
  return relative(projectRoot, target).split(sep).join("/");
}

function extractChapter(value: string) {
  const match = value.match(/第\s*0*(\d+)\s*章/);
  return match ? Number(match[1]) : undefined;
}

async function markdownFiles(projectRoot: string, root: string) {
  if (!existsSync(root)) return [];
  assertNoSymlinkEscape(projectRoot, root);
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
    .map((entry) => resolve(root, entry.name));
  for (const path of files) assertNoSymlinkEscape(projectRoot, path);
  return files;
}

async function fileInfo(projectRoot: string, path: string | undefined, budget: WorkflowReadBudget, signal?: AbortSignal) {
  if (!path || !existsSync(path)) return undefined;
  const content = (await readWorkflowFile(projectRoot, path, budget, signal)).toString("utf8");
  return { path: projectPath(projectRoot, path), revision: revisionOf(content), content, empty: !content.trim() };
}

async function findChapterFile(projectRoot: string, root: string, chapter: number, filter?: (path: string) => boolean) {
  const matches = (await markdownFiles(projectRoot, root)).filter((path) => extractChapter(basename(path)) === chapter && (!filter || filter(path)));
  if (matches.length > 1) throw new ApiError(409, `第${String(chapter).padStart(3, "0")}章存在多个候选文件：${matches.map((path) => basename(path)).join("、")}`);
  return matches[0];
}

async function inferChapter(projectRoot: string) {
  const bodies = await markdownFiles(projectRoot, resolve(projectRoot, "正文"));
  const bodyNumbers = bodies.map((path) => extractChapter(basename(path))).filter((value): value is number => Boolean(value));
  if (bodyNumbers.length) return Math.max(...bodyNumbers);
  const outlines = await markdownFiles(projectRoot, resolve(projectRoot, "大纲"));
  const outlineNumbers = outlines.map((path) => extractChapter(basename(path))).filter((value): value is number => Boolean(value));
  return outlineNumbers.length ? Math.min(...outlineNumbers) : 1;
}

async function readJson(
  projectRoot: string,
  path: string,
  budget = createWorkflowReadBudget(),
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse((await readWorkflowFile(projectRoot, path, budget, signal)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("JSON 顶层必须是对象");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, `工作流 JSON 损坏或不可读：${projectPath(projectRoot, path)}`, "WORKFLOW_JSON_INVALID");
  }
}

async function taskbookStatus(projectRoot: string, chapter: number, budget: WorkflowReadBudget, signal?: AbortSignal): Promise<WorkflowArtifact> {
  const path = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
  const info = await fileInfo(projectRoot, path, budget, signal);
  if (!info) return { id: "taskbook", label: "任务书", status: "missing", message: "尚未生成本章写作任务书。" };
  if (info.empty) return { id: "taskbook", label: "任务书", status: "blocked", path: info.path, revision: info.revision, message: "任务书为空，不能进入写作工作流。" };
  const metadata = await readJson(projectRoot, `${path}.meta.json`, budget, signal);
  if (!metadata || metadata.chapter !== chapter || metadata.taskbook_revision !== info.revision) {
    return { id: "taskbook", label: "任务书", status: "stale", path: info.path, revision: info.revision, message: "任务书没有绑定当前章节或正文来源。" };
  }
  if (!Array.isArray(metadata.sources)) {
    return { id: "taskbook", label: "任务书", status: "blocked", path: info.path, revision: info.revision, message: "任务书来源清单格式无效。" };
  }
  const sources = metadata.sources;
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      return { id: "taskbook", label: "任务书", status: "blocked", path: info.path, revision: info.revision, message: "任务书来源条目格式无效。" };
    }
    const item = source as Record<string, unknown>;
    if (typeof item.path !== "string" || !isSha256(item.revision)) {
      return { id: "taskbook", label: "任务书", status: "blocked", path: info.path, revision: info.revision, message: "任务书来源 revision 格式无效。" };
    }
    const target = resolve(projectRoot, item.path);
    assertInsidePath(projectRoot, target, "任务书来源越界。");
    if (!existsSync(target) || revisionOf(await readWorkflowFile(projectRoot, target, budget, signal)) !== item.revision) {
      return { id: "taskbook", label: "任务书", status: "stale", path: info.path, revision: info.revision, message: `来源已变化：${item.path}` };
    }
  }
  const status = metadata.status === "ready" ? "ready" : "blocked";
  return { id: "taskbook", label: "任务书", status, path: info.path, revision: info.revision, message: status === "ready" ? "任务书与来源 revision 一致。" : "任务书记录了工作流阻断。" };
}

function parsePatch(content: string) {
  const fenced = content.match(/```json\s*([\s\S]*?)\s*```/i);
  try {
    const parsed = JSON.parse(fenced?.[1] ?? content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isRelativeEvidencePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return Boolean(normalized) && !isAbsolute(value) && !normalized.split("/").includes("..");
}

function isValidPatchOperation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  if (operation.action === "upsert") {
    if (!operation.record || typeof operation.record !== "object" || Array.isArray(operation.record)) return false;
    const record = operation.record as Record<string, unknown>;
    const validStatus = record.status === undefined || ["active", "tentative", "closed", "outdated", "contradicted"].includes(String(record.status));
    const validImportance = record.importance === undefined || ["critical", "high", "normal", "low"].includes(String(record.importance));
    const validLists = [record.entities, record.tags].every((item) => item === undefined || Array.isArray(item) && item.every((entry) => typeof entry === "string"));
    const validNumbers = [record.valid_from, record.valid_to, record.source_chapter].every((item) =>
      item === undefined || item === null || Number.isInteger(item) && Number(item) >= 0
    );
    return typeof record.id === "string" && /^[a-z0-9][a-z0-9._-]{2,80}$/.test(record.id) &&
      typeof record.category === "string" && Boolean(record.category.trim()) &&
      typeof record.content === "string" && Boolean(record.content.trim()) && validStatus && validImportance && validLists && validNumbers;
  }
  if (operation.action !== "close" && operation.action !== "archive") return false;
  return typeof operation.id === "string" && /^[a-z0-9][a-z0-9._-]{2,80}$/.test(operation.id) &&
    (operation.reason === undefined || operation.reason === null || typeof operation.reason === "string");
}

function isValidReviewProof(
  proof: Record<string, unknown> | null,
  chapter: number,
  documentPath: string,
  documentRevision: string
) {
  if (!proof) return false;
  const verification = proof.verification && typeof proof.verification === "object" && !Array.isArray(proof.verification)
    ? proof.verification as Record<string, unknown>
    : null;
  const contextRevisions = proof.context_revisions;
  return proof.schema_version === 2 && proof.kind === "chapter_review_proof" && proof.chapter === chapter &&
    proof.document_path === documentPath && proof.document_revision === documentRevision &&
    proof.disk_revision === documentRevision && proof.content_revision === documentRevision &&
    proof.status === "completed" && proof.verdict === "pass" && proof.blocking_findings === 0 &&
    typeof proof.run_id === "string" && Boolean(proof.run_id.trim()) &&
    typeof proof.prompt_version === "string" && Boolean(proof.prompt_version.trim()) && isSha256(proof.findings_digest) &&
    Boolean(verification) && Number.isInteger(verification?.required) && Number(verification?.required) >= 0 &&
    Number.isInteger(verification?.resolved) && Number(verification?.resolved) >= 0 &&
    verification?.unverified === 0 && verification?.required === verification?.resolved &&
    Boolean(contextRevisions) && typeof contextRevisions === "object" && !Array.isArray(contextRevisions) &&
    Object.entries(contextRevisions as Record<string, unknown>).every(([path, revision]) => isRelativeEvidencePath(path) && isSha256(revision));
}

async function reviewProofContextIsCurrent(
  projectRoot: string,
  proof: Record<string, unknown>,
  budget: WorkflowReadBudget,
  signal?: AbortSignal
) {
  const contextRevisions = proof.context_revisions as Record<string, string>;
  for (const [contextPath, expectedRevision] of Object.entries(contextRevisions)) {
    const target = resolve(projectRoot, contextPath);
    assertInsidePath(projectRoot, target, "审阅证明上下文越界。");
    if (!existsSync(target)) return false;
    if (revisionOf(await readWorkflowFile(projectRoot, target, budget, signal)) !== expectedRevision) return false;
  }
  return true;
}

async function validateChapterResultEvidence(
  projectRoot: string,
  patch: Record<string, unknown>,
  chapter: number,
  budget: WorkflowReadBudget,
  signal?: AbortSignal
): Promise<{ status: "blocked" | "stale"; message: string } | null> {
  const sources = patch.source_revisions as Record<string, string>;
  for (const [sourcePath, expectedRevision] of Object.entries(sources)) {
    const source = resolve(projectRoot, sourcePath);
    assertInsidePath(projectRoot, source, "patch 来源越界。");
    if (!existsSync(source)) return { status: "stale", message: `patch 来源已缺失：${sourcePath}` };
    if (revisionOf(await readWorkflowFile(projectRoot, source, budget, signal)) !== expectedRevision) {
      return { status: "stale", message: `patch 来源已变化：${sourcePath}` };
    }
  }
  const sourcePaths = Object.keys(sources);
  const bodySources = sourcePaths.filter((path) => path.replace(/\\/g, "/").startsWith("正文/") && extractChapter(path) === chapter);
  if (bodySources.length !== 1 || sources[bodySources[0]] !== patch.chapter_revision) {
    return { status: "blocked", message: "chapter_result 必须且只能绑定当前章节正文及 chapter_revision。" };
  }
  const blueprint = await findChapterFile(projectRoot, resolve(projectRoot, "大纲"), chapter, (path) => basename(path).includes("细纲"));
  const blueprintPath = blueprint ? projectPath(projectRoot, blueprint) : undefined;
  if (!blueprintPath || !(blueprintPath in sources)) return { status: "blocked", message: "source_revisions 缺少当前章节细纲。" };
  if (!("记忆库/current/本章写作任务书.md" in sources)) return { status: "blocked", message: "source_revisions 缺少本章任务书。" };

  const reviewSources = sourcePaths.filter((path) => path.replace(/\\/g, "/").startsWith("审查报告/") && path.toLowerCase().endsWith(".md") && extractChapter(path) === chapter);
  const proofSources = sourcePaths.filter((path) => path.replace(/\\/g, "/").startsWith("审查报告/") && path.toLowerCase().endsWith(".review.json") && extractChapter(path) === chapter);
  const commitSources = sourcePaths.filter((path) => path.replace(/\\/g, "/").startsWith("章节提交/") && path.toLowerCase().endsWith(".md") && !basename(path).startsWith("memory_patch_") && extractChapter(path) === chapter);
  if (reviewSources.length !== 1 || proofSources.length !== 1 || commitSources.length !== 1) {
    return { status: "blocked", message: "source_revisions 必须各绑定一份审查报告、机器证明和章节提交。" };
  }
  const proof = await readJson(projectRoot, resolve(projectRoot, proofSources[0]), budget, signal);
  if (!isValidReviewProof(proof, chapter, bodySources[0], String(patch.chapter_revision))) {
    return { status: "blocked", message: "机器可读审阅证明格式不完整或未绑定当前正文。" };
  }
  const contextRevisions = proof?.context_revisions as Record<string, string>;
  if (Object.entries(contextRevisions).some(([path, revision]) => sources[path] !== revision)) {
    return { status: "blocked", message: "机器可读审阅证明的上下文 revision 未被 patch source_revisions 完整绑定。" };
  }
  if (!await reviewProofContextIsCurrent(projectRoot, proof!, budget, signal)) {
    return { status: "stale", message: "机器可读审阅证明的上下文 revision 已变化。" };
  }
  for (const evidencePath of [reviewSources[0], commitSources[0]]) {
    if (!(await readWorkflowFile(projectRoot, resolve(projectRoot, evidencePath), budget, signal)).toString("utf8").includes(String(patch.chapter_revision))) {
      return { status: "blocked", message: `${evidencePath} 未记录当前正文 revision。` };
    }
  }
  return null;
}

async function patchStatus(
  projectRoot: string,
  chapter: number,
  bodyRevision?: string,
  budget = createWorkflowReadBudget(),
  signal?: AbortSignal
): Promise<WorkflowArtifact & { legacyChoices?: string[] }> {
  const patchRoot = resolve(projectRoot, "章节提交");
  const files = (await markdownFiles(projectRoot, patchRoot)).filter((path) => basename(path).startsWith("memory_patch_"));
  const classificationsFile = existsSync(resolve(patchRoot, "compat", "patch_classifications.json"))
    ? resolve(patchRoot, "compat", "patch_classifications.json")
    : resolve(patchRoot, "patch_classifications.json");
  const classifications = (await readJson(projectRoot, classificationsFile, budget, signal))?.classifications;
  const classificationMap = classifications && typeof classifications === "object" ? classifications as Record<string, unknown> : {};
  const patches: Array<{ path: string; content: string; patch: Record<string, unknown> | null; kind: unknown }> = [];
  for (const path of files) {
    const content = (await readWorkflowFile(projectRoot, path, budget, signal)).toString("utf8");
    const patch = parsePatch(content);
    if (!patch || patch.chapter === undefined || typeof patch.patch_id !== "string") {
      if (extractChapter(basename(path)) === chapter) patches.push({ path, content, patch: null, kind: "invalid" });
      continue;
    }
    if (patch.chapter !== chapter) continue;
    if (patch.schema_version === 2) {
      const canonicalName = `memory_patch_第${String(chapter).padStart(3, "0")}章_${patch.patch_id}.md`;
      if (basename(path) !== canonicalName) {
        patches.push({ path, content, patch, kind: "invalid" });
        continue;
      }
    }
    const kind = patch.schema_version === 2
      ? (isValidV2Patch(patch, chapter) ? patch.kind : "invalid")
      : classificationMap[patch.patch_id] ?? "legacy_unknown";
    patches.push({ path, content, patch, kind });
  }
  const results = patches.filter((item): item is typeof item & { patch: Record<string, unknown> } => item.patch?.schema_version === 2 && item.kind === "chapter_result");
  const legacy = patches.filter((item): item is typeof item & { patch: Record<string, unknown> } => item.kind === "legacy_unknown" && Boolean(item.patch));
  const classifiedLegacy = patches.filter((item) => item.patch?.schema_version !== 2 && item.kind !== "legacy_unknown" && item.kind !== "invalid");
  const invalid = patches.filter((item) => item.kind === "invalid");
  if (invalid.length) {
    return { id: "memoryPatch", label: "记忆更新", status: "blocked", message: "发现字段不完整的 schema v2 patch；必须修复来源 revision 和必填字段后再继续。" };
  }
  const manifestPath = resolve(patchRoot, `第${String(chapter).padStart(3, "0")}章_finalization.json`);
  const manifest = await readJson(projectRoot, manifestPath, budget, signal);
  const currentRevisionResults = bodyRevision
    ? results.filter((item) => item.patch.chapter_revision === bodyRevision)
    : [];
  const selectedByManifest = typeof manifest?.patch_id === "string"
    ? results.find((item) => item.patch.patch_id === manifest.patch_id)
    : undefined;
  if (results.length > 1 && currentRevisionResults.length !== 1 && !selectedByManifest) {
    return {
      id: "memoryPatch",
      label: "记忆更新",
      status: "blocked",
      message: "同章存在多个 schema v2 chapter_result；请通过最终化 manifest 明确当前结果后再继续。"
    };
  }
  if (!results.length && legacy.length) {
    return {
      id: "memoryPatch",
      label: "记忆更新",
      status: "blocked",
      message: "旧 patch 仅支持读取，应用前必须由作者完成兼容分类并生成 schema v2 结果。",
      legacyChoices: legacy.map((item) => String(item.patch.patch_id))
    };
  }
  if (!results.length && classifiedLegacy.length) {
    return { id: "memoryPatch", label: "记忆更新", status: "stale", message: "旧 patch 已完成语义分类，但仍需迁移为带来源 revision 的 schema v2 patch。" };
  }
  const selected = currentRevisionResults.length === 1
    ? currentRevisionResults[0]
    : selectedByManifest ?? results[0];
  if (!selected) return { id: "memoryPatch", label: "记忆更新", status: "missing", message: "尚未生成或确认 chapter_result patch。" };
  const info = await fileInfo(projectRoot, selected.path, budget, signal);
  const evidenceProblem = await validateChapterResultEvidence(projectRoot, selected.patch, chapter, budget, signal);
  if (evidenceProblem) {
    return { id: "memoryPatch", label: "记忆更新", status: evidenceProblem.status, path: info?.path, revision: info?.revision, message: evidenceProblem.message };
  }
  if (selected.patch.schema_version === 2 && bodyRevision && selected.patch.chapter_revision !== bodyRevision) {
    return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "patch 绑定的正文 revision 已过期。" };
  }
  if (!manifest) return { id: "memoryPatch", label: "记忆更新", status: "ready", path: info?.path, revision: info?.revision, message: "patch 已就绪，等待作者确认应用。" };
  if (manifest.patch_id !== selected.patch.patch_id) {
    return { id: "memoryPatch", label: "记忆更新", status: "ready", path: info?.path, revision: info?.revision, message: "发现绑定当前正文的新 patch，等待作者确认替换旧最终化 manifest。" };
  }
  const manifestPatch = manifest.patch && typeof manifest.patch === "object" && !Array.isArray(manifest.patch)
    ? manifest.patch as Record<string, unknown>
    : null;
  const manifestSources = Array.isArray(manifest.sources) ? manifest.sources : [];
  const expectedSources = selected.patch.source_revisions as Record<string, string>;
  const manifestShapeValid = manifest.schema_version === 1 && manifest.chapter === chapter && manifest.status === "finalized" &&
    manifest.chapter_revision === selected.patch.chapter_revision && manifestPatch?.path === info?.path &&
    manifestPatch?.revision === info?.revision && manifestSources.length === Object.keys(expectedSources).length &&
    new Set(manifestSources.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined)).size === manifestSources.length &&
    manifestSources.every((item) => {
      if (!item || typeof item !== "object") return false;
      const source = item as Record<string, unknown>;
      return typeof source.path === "string" && source.revision === expectedSources[source.path];
    });
  if (!manifestShapeValid) {
    return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "最终化 manifest 未严格绑定当前章节、patch 或完整来源。" };
  }
  const evidence = [
    ...(Array.isArray(manifest.sources) ? manifest.sources : []),
    manifest.patch
  ];
  for (const source of evidence) {
    if (!source || typeof source !== "object") return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "最终化 manifest 格式不完整。" };
    const item = source as Record<string, unknown>;
    if (typeof item.path !== "string" || !isSha256(item.revision)) {
      return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "最终化 manifest 的来源 revision 格式无效。" };
    }
    const target = resolve(projectRoot, item.path);
    assertInsidePath(projectRoot, target, "最终化来源越界。");
    if (!existsSync(target) || revisionOf(await readWorkflowFile(projectRoot, target, budget, signal)) !== item.revision) {
      return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: `最终化来源已变化：${item.path}` };
    }
  }
  return { id: "memoryPatch", label: "记忆更新", status: "finalized", path: info?.path, revision: info?.revision, message: "章节 manifest 与所有来源 revision 一致。" };
}

async function reviewContext(
  projectRoot: string,
  chapter: number,
  bodyPath: string | undefined,
  budget: WorkflowReadBudget,
  signal?: AbortSignal
): Promise<WorkflowContextItem[]> {
  const values: WorkflowContextItem[] = [];
  const add = async (path: string, role: string, expected?: string) => {
    const target = resolve(projectRoot, path);
    assertInsidePath(projectRoot, target, "审阅上下文越界。");
    if (!existsSync(target)) {
      values.push({ path, role, missing: true, stale: false });
      return;
    }
    const revision = revisionOf(await readWorkflowFile(projectRoot, target, budget, signal));
    values.push({ path, role, revision, missing: false, stale: Boolean(expected && expected !== revision) });
  };
  if (bodyPath) await add(projectPath(projectRoot, bodyPath), "当前草稿");
  await add("记忆库/current/本章写作任务书.md", "本章任务书");
  for (let number = Math.max(1, chapter - 5); number < chapter; number += 1) {
    const previous = await findChapterFile(projectRoot, resolve(projectRoot, "正文"), number);
    if (previous) await add(projectPath(projectRoot, previous), `前置正文 第${String(number).padStart(3, "0")}章`);
    else values.push({ path: `正文/第${String(number).padStart(3, "0")}章`, role: "缺失前置正文", missing: true, stale: false });
  }
  const metadata = await readJson(projectRoot, resolve(projectRoot, "记忆库", "current", "本章写作任务书.md.meta.json"), budget, signal);
  if (Array.isArray(metadata?.sources)) {
    for (const source of metadata.sources) {
      if (!source || typeof source !== "object") continue;
      const item = source as Record<string, unknown>;
      if (typeof item.path === "string") await add(item.path, "任务书来源", typeof item.revision === "string" ? item.revision : undefined);
    }
  }
  return values.filter((item, index, array) => array.findIndex((candidate) => candidate.path === item.path) === index);
}

async function getWorkflowStatusUnlocked(options: WorkflowOptions) {
  ensureNotAborted(options.signal);
  const budget = createWorkflowReadBudget();
  const chapter = options.chapter && options.chapter > 0 ? options.chapter : await inferChapter(options.projectRoot);
  const label = String(chapter).padStart(3, "0");
  const blueprintPath = await findChapterFile(options.projectRoot, resolve(options.projectRoot, "大纲"), chapter, (path) => basename(path).includes("细纲"));
  const blueprintInfo = await fileInfo(options.projectRoot, blueprintPath, budget, options.signal);
  const blueprint: WorkflowArtifact = blueprintInfo && !blueprintInfo.empty
    ? { id: "blueprint", label: "细纲", status: "ready", path: blueprintInfo.path, revision: blueprintInfo.revision, message: "本章细纲已存在。" }
    : blueprintInfo
      ? { id: "blueprint", label: "细纲", status: "blocked", path: blueprintInfo.path, revision: blueprintInfo.revision, message: "本章细纲为空，不能继续工作流。" }
    : { id: "blueprint", label: "细纲", status: "missing", message: "缺少本章细纲。" };
  const taskbook = await taskbookStatus(options.projectRoot, chapter, budget, options.signal);
  const bodyPath = await findChapterFile(options.projectRoot, resolve(options.projectRoot, "正文"), chapter);
  const bodyInfo = await fileInfo(options.projectRoot, bodyPath, budget, options.signal);
  const body: WorkflowArtifact = bodyInfo && !bodyInfo.empty
    ? { id: "body", label: "正文", status: "ready", path: bodyInfo.path, revision: bodyInfo.revision, message: "正文已保存。" }
    : bodyInfo
      ? { id: "body", label: "正文", status: "blocked", path: bodyInfo.path, revision: bodyInfo.revision, message: "正文为空，不能进入审查。" }
    : { id: "body", label: "正文", status: "missing", message: "尚未保存本章正文。" };
  const reviewPath = await findChapterFile(options.projectRoot, resolve(options.projectRoot, "审查报告"), chapter);
  const reviewInfo = await fileInfo(options.projectRoot, reviewPath, budget, options.signal);
  const reviewProofPath = reviewPath ? `${reviewPath.slice(0, -3)}.review.json` : undefined;
  const reviewProof = reviewProofPath ? await readJson(options.projectRoot, reviewProofPath, budget, options.signal) : null;
  const reviewProofShapePass = Boolean(
    bodyInfo && !bodyInfo.empty && bodyPath && isValidReviewProof(reviewProof, chapter, projectPath(options.projectRoot, bodyPath), bodyInfo.revision)
  );
  const reviewProofPass = Boolean(reviewProofShapePass && await reviewProofContextIsCurrent(options.projectRoot, reviewProof!, budget, options.signal));
  const reviewPass = Boolean(reviewInfo && bodyInfo && reviewInfo.content.includes(bodyInfo.revision) && /(?:结果|结论)：通过/.test(reviewInfo.content) && reviewProofPass);
  const review: WorkflowArtifact = !reviewInfo
    ? { id: "review", label: "审查", status: "missing", message: "尚未生成审查报告。" }
    : !bodyInfo || !reviewInfo.content.includes(bodyInfo.revision)
      ? { id: "review", label: "审查", status: "stale", path: reviewInfo.path, revision: reviewInfo.revision, message: "审查报告未绑定当前正文 revision。" }
      : reviewPass
        ? { id: "review", label: "审查", status: "ready", path: reviewInfo.path, revision: reviewInfo.revision, message: "审查通过且 revision 一致。" }
        : { id: "review", label: "审查", status: "needs_changes", path: reviewInfo.path, revision: reviewInfo.revision, message: reviewProofPass ? "审查要求修改正文。" : "缺少有效的机器可读审阅通过证明。" };
  const commitPath = await findChapterFile(options.projectRoot, resolve(options.projectRoot, "章节提交"), chapter, (path) => !basename(path).startsWith("memory_patch_"));
  const commitInfo = await fileInfo(options.projectRoot, commitPath, budget, options.signal);
  const commit: WorkflowArtifact = !commitInfo
    ? { id: "commit", label: "章节提交", status: "missing", message: "尚未记录章节提交。" }
    : !bodyInfo || !commitInfo.content.includes(bodyInfo.revision)
      ? { id: "commit", label: "章节提交", status: "stale", path: commitInfo.path, revision: commitInfo.revision, message: "提交记录未绑定当前正文 revision。" }
      : { id: "commit", label: "章节提交", status: "ready", path: commitInfo.path, revision: commitInfo.revision, message: "提交记录与正文 revision 一致。" };
  const memoryPatch = await patchStatus(options.projectRoot, chapter, bodyInfo?.revision, budget, options.signal);
  ensureNotAborted(options.signal);
  const artifacts = [blueprint, taskbook, body, review, commit, memoryPatch];
  let state: WorkflowState = "ready";
  let recommendedAction: WorkflowRecommendedAction = "copy_to_codex";
  let recommendation = "复制本章资料给 Codex，继续需要创作判断的步骤。";
  let nextStep: WorkflowNextStep = {
    id: "resolve_blocker",
    mode: "codex_prompt",
    label: "检查阻断原因",
    reason: recommendation,
    requiresConfirmation: false
  };
  if (memoryPatch.status === "blocked") {
    state = "blocked";
    if ((memoryPatch.legacyChoices ?? []).length > 1) {
      recommendedAction = "classify_patch";
      recommendation = "先确认同章旧 patch 的语义，未确认前不能写下一章。";
      nextStep = {
        id: "resolve_patch_classification",
        mode: "open_panel",
        label: "确认旧 patch 分类",
        reason: recommendation,
        serverAction: "classify_patch",
        requiresConfirmation: true
      };
    } else {
      recommendedAction = "copy_to_codex";
      recommendation = memoryPatch.message;
      nextStep = {
        id: "resolve_blocker",
        mode: "codex_prompt",
        label: "修复记忆更新阻断",
        reason: recommendation,
        targetPath: memoryPatch.path,
        requiresConfirmation: false
      };
    }
  } else if (taskbook.status === "blocked") {
    state = "blocked";
    recommendedAction = "generate_taskbook";
    recommendation = "任务书记录为阻断或元数据无效，请修复来源后重新生成。";
    nextStep = {
      id: "repair_taskbook",
      mode: "server_action",
      label: "重新生成任务书",
      reason: recommendation,
      serverAction: "generate_taskbook",
      targetPath: taskbook.path,
      requiresConfirmation: false
    };
  } else if (artifacts.some((item) => item.status === "blocked")) {
    state = "blocked";
    recommendedAction = "copy_to_codex";
    recommendation = "当前工作流存在阻断项，请先检查对应资料。";
    const blocker = artifacts.find((item) => item.status === "blocked");
    nextStep = {
      id: "resolve_blocker",
      mode: "codex_prompt",
      label: "处理工作流阻断",
      reason: blocker?.message ?? recommendation,
      targetPath: blocker?.path,
      requiresConfirmation: false
    };
  } else if (blueprint.status === "missing") {
    state = "blocked";
    recommendedAction = "copy_to_codex";
    recommendation = `请先创建并确认第${label}章细纲。`;
    nextStep = {
      id: "create_blueprint",
      mode: "codex_prompt",
      label: `创建第${label}章细纲`,
      reason: recommendation,
      targetPath: `大纲/细纲_第${label}章.md`,
      requiresConfirmation: false
    };
  } else if (taskbook.status !== "ready") {
    state = "needs_changes";
    recommendedAction = "generate_taskbook";
    recommendation = "重新诊断并生成绑定当前来源的任务书。";
    nextStep = {
      id: "generate_taskbook",
      mode: "server_action",
      label: "生成本章任务书",
      reason: recommendation,
      serverAction: "generate_taskbook",
      targetPath: "记忆库/current/本章写作任务书.md",
      requiresConfirmation: false
    };
  } else if (body.status === "missing") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "任务书已就绪，请复制给 Codex 创作正文。";
    nextStep = {
      id: "draft_body",
      mode: "codex_prompt",
      label: `创作第${label}章正文`,
      reason: recommendation,
      targetPath: `正文/第${label}章_新章节.md`,
      requiresConfirmation: true
    };
  } else if (review.status === "missing" || review.status === "stale") {
    state = "needs_changes";
    recommendedAction = "check_body";
    recommendation = "检查当前正文，生成绑定 revision 的审查报告。";
    nextStep = {
      id: "check_body",
      mode: "server_action",
      label: "检查当前正文",
      reason: recommendation,
      serverAction: "check_body",
      targetPath: review.path,
      requiresConfirmation: false
    };
  } else if (review.status === "needs_changes") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "按审查 Findings 修改正文，再重新检查。";
    nextStep = {
      id: "revise_body",
      mode: "codex_prompt",
      label: "按审查结果修改正文",
      reason: recommendation,
      targetPath: body.path,
      requiresConfirmation: true
    };
  } else if (commit.status !== "ready") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "请生成绑定当前正文 revision 的章节提交记录。";
    nextStep = {
      id: "create_commit",
      mode: "codex_prompt",
      label: "生成章节提交记录",
      reason: recommendation,
      targetPath: `章节提交/第${label}章_commit.md`,
      requiresConfirmation: false
    };
  } else if (memoryPatch.status === "missing" || memoryPatch.status === "stale") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "请生成 schema v2 chapter_result patch，并先做最终化预检。";
    nextStep = {
      id: "create_memory_patch",
      mode: "codex_prompt",
      label: "生成记忆更新 patch",
      reason: recommendation,
      targetPath: `章节提交/memory_patch_第${label}章.md`,
      requiresConfirmation: false
    };
  } else if (memoryPatch.status === "ready") {
    recommendedAction = "apply_patch";
    recommendation = "所有证据已就绪；作者确认后应用 patch 完成最终化。";
    nextStep = {
      id: "apply_patch",
      mode: "confirm_action",
      label: "确认并应用记忆更新",
      reason: recommendation,
      serverAction: "apply_patch",
      targetPath: memoryPatch.path,
      requiresConfirmation: true
    };
  } else if (memoryPatch.status === "finalized") {
    state = "finalized";
    recommendedAction = "copy_to_codex";
    recommendation = "本章已最终化，可以准备下一章。";
    const nextLabel = String(chapter + 1).padStart(3, "0");
    nextStep = {
      id: "prepare_next_chapter",
      mode: "codex_prompt",
      label: `准备第${nextLabel}章`,
      reason: recommendation,
      targetPath: `大纲/细纲_第${nextLabel}章.md`,
      requiresConfirmation: false
    };
  }
  ensureNotAborted(options.signal);
  const context = await reviewContext(options.projectRoot, chapter, bodyPath, budget, options.signal);
  ensureNotAborted(options.signal);
  return {
    schemaVersion: 2,
    projectId: options.projectId,
    chapter,
    state,
    artifacts,
    recommendedAction,
    recommendation,
    nextStep,
    reviewContext: context,
    legacyPatchChoices: memoryPatch.legacyChoices ?? []
  };
}

export async function getWorkflowStatus(options: WorkflowOptions) {
  validateProjectBinding(options.projectRoot, options.projectId);
  return withProjectSnapshotLock(options.projectRoot, () => getWorkflowStatusUnlocked(options), options.signal);
}

let detectedPythonCommand: { executable: string; prefix: string[] } | undefined;

function pythonCommand() {
  const configured = process.env.NOVEL_PYTHON_BIN?.trim();
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured)) {
      throw new ApiError(503, "NOVEL_PYTHON_BIN 必须指向存在的绝对 Python 路径。", "PYTHON_NOT_CONFIGURED");
    }
    return { executable: configured, prefix: [] as string[] };
  }
  const virtualEnvironment = process.env.VIRTUAL_ENV?.trim();
  if (virtualEnvironment) {
    const executable = resolve(virtualEnvironment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");
    if (existsSync(executable)) return { executable, prefix: [] as string[] };
  }
  if (process.platform === "win32") {
    const launcher = resolve(process.env.SystemRoot ?? "C:\\Windows", "py.exe");
    if (existsSync(launcher)) {
      if (detectedPythonCommand) return detectedPythonCommand;
      const probe = spawnSync(launcher, ["-3", "-X", "utf8", "-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000
      });
      const executable = probe.status === 0 ? probe.stdout.trim() : "";
      if (isAbsolute(executable) && existsSync(executable)) {
        detectedPythonCommand = { executable, prefix: [] };
        return detectedPythonCommand;
      }
    }
  }
  for (const executable of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (existsSync(executable)) return { executable, prefix: [] as string[] };
  }
  throw new ApiError(503, "找不到固定的 Python 解释器；请设置 NOVEL_PYTHON_BIN。", "PYTHON_NOT_CONFIGURED");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isValidV2Patch(patch: Record<string, unknown>, chapter: number) {
  const sources = patch.source_revisions;
  const operations = patch.operations;
  const touched = Array.isArray(operations)
    ? operations.map((operation) => operation && typeof operation === "object" ? (operation as Record<string, unknown>).action === "upsert"
      ? ((operation as Record<string, unknown>).record as Record<string, unknown> | undefined)?.id
      : (operation as Record<string, unknown>).id : undefined)
    : [];
  return patch.schema_version === 2 && patch.kind === "chapter_result" && patch.chapter === chapter &&
    typeof patch.patch_id === "string" && /^[a-z0-9][a-z0-9._-]{2,80}$/.test(patch.patch_id) && isSha256(patch.chapter_revision) &&
    typeof patch.summary === "string" && Boolean(patch.summary.trim()) &&
    typeof patch.ending_state === "string" && Boolean(patch.ending_state.trim()) && Array.isArray(operations) &&
    operations.every(isValidPatchOperation) && touched.every((id) => typeof id === "string") && new Set(touched).size === touched.length &&
    Boolean(sources) && typeof sources === "object" && !Array.isArray(sources) && Object.keys(sources as object).length > 0 &&
    Object.entries(sources as Record<string, unknown>).every(([path, revision]) => isRelativeEvidencePath(path) && isSha256(revision));
}

async function runPython(args: string[], cwd: string, signal?: AbortSignal, parentLockOwner?: string) {
  const command = pythonCommand();
  return new Promise<{ exitCode: number; output: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, [...command.prefix, "-X", "utf8", ...args], {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: parentLockOwner ? {
        ...process.env,
        NOVEL_PARENT_PROJECT_LOCK_OWNER: parentLockOwner,
        NOVEL_PARENT_PROJECT_LOCK_PID: String(process.pid)
      } : process.env
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let processError: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (error?: Error, result?: { exitCode: number; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise(result ?? { exitCode: 2, output: "" });
    };
    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      terminateProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 5_000);
      forceKill.unref();
    };
    const abort = () => {
      terminate(new ApiError(499, "工作流请求已取消；已等待 Python 子进程完全退出。", "WORKFLOW_ABORTED"));
    };
    const append = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        terminate(new ApiError(502, "Python 输出超过 1 MiB 安全上限；已等待子进程完全退出。", "WORKFLOW_OUTPUT_LIMIT"));
        return;
      }
      output += chunk.toString("utf8");
    };
    const timeout = setTimeout(() => {
      terminate(new ApiError(504, "Python 工作流超过 120 秒；已等待子进程完全退出。", "WORKFLOW_TIMEOUT"));
    }, 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      processError = new ApiError(503, `Python 子进程启动失败：${error.message}`, "PYTHON_START_FAILED");
    });
    child.on("close", (code) => finish(terminationError ?? processError, { exitCode: code ?? 2, output: output.slice(-20_000) }));
  });
}

export async function runWorkflowAction(input: {
  action: string;
  projectRoot: string;
  projectId: string;
  libraryRoot: string;
  workspaceRoot: string;
  chapter: number;
  patchPath?: string;
  confirmed?: boolean;
  classifications?: Record<string, string>;
  signal?: AbortSignal;
}) {
  validateProjectBinding(input.projectRoot, input.projectId);
  const scripts = resolve(input.workspaceRoot, ".agents", "skills", "webnovel-writer", "scripts");
  const common = ["--library-root", input.libraryRoot, "--project-root", input.projectRoot];
  if (input.action === "diagnose" || input.action === "finalization_preflight") {
    return { action: input.action, status: await getWorkflowStatus(input) };
  }
  if (input.action === "generate_taskbook") {
    const result = await withProjectSnapshotLock(input.projectRoot, (owner) =>
      runPython([resolve(scripts, "build_context.py"), "--chapter", String(input.chapter), ...common], input.workspaceRoot, input.signal, owner), input.signal
    );
    if (result.exitCode !== 0) throw new ApiError(409, result.output.trim() || "任务书生成被阻断。");
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "check_body") {
    const body = await findChapterFile(input.projectRoot, resolve(input.projectRoot, "正文"), input.chapter);
    if (!body) throw new ApiError(409, "尚未保存本章正文。");
    const output = resolve(input.projectRoot, "审查报告", `第${String(input.chapter).padStart(3, "0")}章_审查报告.md`);
    const result = await withProjectSnapshotLock(input.projectRoot, (owner) => runPython([
      resolve(scripts, "check_chapter.py"), body, "--chapter", String(input.chapter), "--output", output, ...common
    ], input.workspaceRoot, input.signal, owner), input.signal);
    if (result.exitCode > 1) throw new ApiError(409, result.output.trim() || "正文检查失败。");
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "apply_patch") {
    if (!input.confirmed) throw new ApiError(400, "应用 memory patch 前必须由作者明确确认。")
    if (!input.patchPath) throw new ApiError(400, "缺少 patchPath。")
    const result = await withProjectSnapshotLock(input.projectRoot, async (owner) => {
      ensureNotAborted(input.signal);
      const target = resolve(input.projectRoot, input.patchPath!);
      assertInsidePath(input.projectRoot, target, "patch 路径越界。");
      assertNoSymlinkEscape(input.projectRoot, target);
      const status = await getWorkflowStatusUnlocked(input);
      const patchArtifact = status.artifacts.find((item) => item.id === "memoryPatch");
      if (status.state !== "ready" || status.recommendedAction !== "apply_patch" || patchArtifact?.status !== "ready") {
        throw new ApiError(409, "当前工作流门禁未全部通过，不能应用 memory patch。", "WORKFLOW_APPLY_NOT_READY");
      }
      if (patchArtifact.path !== projectPath(input.projectRoot, target)) {
        throw new ApiError(409, "提交的 patchPath 不是当前章节唯一就绪的 patch。", "WORKFLOW_PATCH_MISMATCH");
      }
      const applyResult = await runPython([
        resolve(scripts, "update_memory.py"), "--patch", target, "--library-root", input.libraryRoot,
        "--current-dir", resolve(input.projectRoot, "记忆库", "current")
      ], input.workspaceRoot, input.signal, owner);
      if (applyResult.exitCode !== 0) throw new ApiError(409, applyResult.output.trim() || "memory patch 应用失败。");
      return applyResult;
    }, input.signal);
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "classify_patch") {
    if (!input.confirmed) throw new ApiError(400, "旧 patch 分类必须由作者明确确认。")
    const allowed = new Set(["chapter_result", "outline_baseline", "migration"]);
    const classifications = input.classifications ?? {};
    if (!Object.keys(classifications).length || Object.values(classifications).some((value) => !allowed.has(value))) {
      throw new ApiError(400, "patch 分类不完整或包含不支持的 kind。")
    }
    if (Object.values(classifications).filter((value) => value === "chapter_result").length !== 1) {
      throw new ApiError(400, "同一章必须且只能确认一个 chapter_result。")
    }
    await withProjectWriteLock(input.projectRoot, ".workflow/patch-classifications", async () => {
      const currentPatchStatus = await patchStatus(input.projectRoot, input.chapter);
      const expectedLegacyChoices = currentPatchStatus.legacyChoices ?? [];
      if (!expectedLegacyChoices.length || Object.keys(classifications).length !== expectedLegacyChoices.length ||
        expectedLegacyChoices.some((patchId) => !(patchId in classifications))) {
        throw new ApiError(400, "patch 分类必须覆盖本章全部未分类旧 patch。")
      }
      const legacyTarget = resolve(input.projectRoot, "章节提交", "patch_classifications.json");
      const currentTarget = resolve(input.projectRoot, "章节提交", "compat", "patch_classifications.json");
      const existingFile = existsSync(currentTarget) ? currentTarget : legacyTarget;
      const existingPayload = await readJson(input.projectRoot, existingFile);
      const existingClassifications = existingPayload?.classifications && typeof existingPayload.classifications === "object" && !Array.isArray(existingPayload.classifications)
        ? existingPayload.classifications as Record<string, string>
        : {};
      assertNoSymlinkEscape(input.projectRoot, currentTarget);
      await atomicWriteJsonInside(input.projectRoot, currentTarget, {
        schema_version: 1,
        updated_at: new Date().toISOString(),
        classifications: { ...existingClassifications, ...classifications }
      });
    }, input.signal);
    return { action: input.action, status: await getWorkflowStatus(input) };
  }
  throw new ApiError(400, "不支持的工作流动作。")
}
