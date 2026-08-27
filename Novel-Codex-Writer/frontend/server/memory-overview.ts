import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type {
  MemoryChapterSummary,
  MemoryDiagnostic,
  MemoryOverview,
  MemoryOverviewRecord
} from "../shared/api-contract.ts";
import { assertInsidePath, assertNoSymlinkEscape, readFileInsideLimited, revisionOf } from "./file-storage.ts";

const INDEX_MAX_BYTES = 8 * 1024 * 1024;
const SOURCE_MAX_FILES = 5_000;
const SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SOURCE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalPositiveInteger(value: unknown) {
  return value === undefined || value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function stringArray(value: unknown, maximum = 100) {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && item.length <= 240);
}

function safeProjectPath(value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.length > 500) return false;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("/");
}

function parseOverviewRecord(value: unknown): MemoryOverviewRecord | undefined {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id || value.id.length > 240
    || typeof value.category !== "string" || !value.category || value.category.length > 80
    || typeof value.status !== "string" || !value.status || value.status.length > 80
    || typeof value.importance !== "string" || value.importance.length > 80
    || !optionalPositiveInteger(value.valid_from)
    || !optionalPositiveInteger(value.valid_to)
    || !optionalPositiveInteger(value.source_chapter)
    || !stringArray(value.entities)
    || !stringArray(value.tags)
    || typeof value.title !== "string" || value.title.length > 500
    || !safeProjectPath(value.file)
    || !Number.isSafeInteger(value.line) || Number(value.line) <= 0
    || typeof value.archived !== "boolean"
    || (value.updated_by_patch !== undefined && value.updated_by_patch !== null && (typeof value.updated_by_patch !== "string" || value.updated_by_patch.length > 240))) {
    return undefined;
  }
  return {
    id: value.id,
    category: value.category,
    status: value.status,
    importance: value.importance,
    ...(value.valid_from === undefined || value.valid_from === null ? {} : { validFrom: Number(value.valid_from) }),
    ...(value.valid_to === undefined || value.valid_to === null ? {} : { validTo: Number(value.valid_to) }),
    entities: value.entities as string[],
    tags: value.tags as string[],
    ...(value.source_chapter === undefined || value.source_chapter === null ? {} : { sourceChapter: Number(value.source_chapter) }),
    ...(value.updated_by_patch === undefined || value.updated_by_patch === null ? {} : { updatedByPatch: value.updated_by_patch as string }),
    title: value.title || value.id,
    source: value.file as string,
    line: Number(value.line),
    archived: value.archived
  };
}

function parseChapterSummary(value: unknown): MemoryChapterSummary | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.chapter) || Number(value.chapter) <= 0
    || typeof value.patch_id !== "string" || !value.patch_id
    || typeof value.kind !== "string" || !value.kind
    || typeof value.summary !== "string"
    || typeof value.ending_state !== "string"
    || (value.chapter_revision !== null && value.chapter_revision !== undefined && typeof value.chapter_revision !== "string")) return undefined;
  return {
    chapter: Number(value.chapter),
    patchId: value.patch_id,
    kind: value.kind,
    ...(typeof value.chapter_revision === "string" ? { chapterRevision: value.chapter_revision } : {}),
    summary: value.summary,
    endingState: value.ending_state
  };
}

async function hasPendingTransactions(projectRoot: string) {
  const root = resolve(projectRoot, "记忆库", ".transactions");
  assertInsidePath(projectRoot, root, "事务目录越出当前小说。");
  if (!await pathEntryExists(root)) return false;
  assertNoSymlinkEscape(projectRoot, root);
  if (!(await lstat(root)).isDirectory()) return true;
  return (await readdir(root, { withFileTypes: true })).some((entry) => entry.isDirectory() && !entry.name.startsWith("."));
}

async function pathEntryExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function emptyOverview(projectId: string, indexStatus: "missing" | "invalid", diagnostics: MemoryDiagnostic[]): MemoryOverview {
  return { schemaVersion: 1, projectId, indexStatus, records: [], chapterSummaries: [], diagnostics };
}

export async function getMemoryOverview(projectRoot: string, projectId: string): Promise<MemoryOverview> {
  const diagnostics: MemoryDiagnostic[] = [];
  if (await hasPendingTransactions(projectRoot)) {
    diagnostics.push({
      code: "TRANSACTION_PENDING",
      severity: "error",
      message: "存在未完成记忆事务；当前只报告，不会自动恢复。"
    });
  }
  const indexPath = resolve(projectRoot, "记忆库", "index", "memory_index.json");
  assertInsidePath(projectRoot, indexPath, "记忆索引路径越出当前小说。");
  if (!await pathEntryExists(indexPath)) {
    diagnostics.push({ code: "INDEX_MISSING", severity: "warning", message: "记忆索引尚未生成；Markdown 事实源没有丢失。" });
    return emptyOverview(projectId, "missing", diagnostics);
  }
  assertNoSymlinkEscape(projectRoot, indexPath);

  let parsed: unknown;
  try {
    const raw = await readFileInsideLimited(projectRoot, indexPath, INDEX_MAX_BYTES);
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    diagnostics.push({ code: "INDEX_INVALID", severity: "error", message: "记忆索引损坏或超过安全上限，请只读诊断后重建。" });
    return emptyOverview(projectId, "invalid", diagnostics);
  }
  if (!isRecord(parsed)
    || parsed.schema_version !== 2
    || !isRecord(parsed.source_hashes)
    || !Array.isArray(parsed.records) || parsed.records.length > SOURCE_MAX_FILES
    || !Array.isArray(parsed.chapter_summaries) || parsed.chapter_summaries.length > 10_000) {
    diagnostics.push({ code: "INDEX_INVALID", severity: "error", message: "记忆索引结构无效，请只读诊断后重建。" });
    return emptyOverview(projectId, "invalid", diagnostics);
  }

  const records = parsed.records.map(parseOverviewRecord);
  const chapterSummaries = parsed.chapter_summaries.map(parseChapterSummary);
  const sourceEntries = Object.entries(parsed.source_hashes);
  if (records.some((item) => !item) || chapterSummaries.some((item) => !item) || sourceEntries.length > SOURCE_MAX_FILES
    || sourceEntries.some(([path, hash]) => !safeProjectPath(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) {
    diagnostics.push({ code: "INDEX_INVALID", severity: "error", message: "记忆索引包含非法记录或来源路径。" });
    return emptyOverview(projectId, "invalid", diagnostics);
  }

  let remainingBytes = SOURCE_MAX_TOTAL_BYTES;
  let stale = false;
  for (const [source, expectedRevision] of sourceEntries) {
    const target = resolve(projectRoot, source);
    assertInsidePath(projectRoot, target, "记忆索引来源越出当前小说。");
    if (!existsSync(target)) {
      stale = true;
      break;
    }
    const maximum = Math.min(SOURCE_MAX_FILE_BYTES, remainingBytes);
    if (maximum <= 0) {
      stale = true;
      break;
    }
    try {
      const content = await readFileInsideLimited(projectRoot, target, maximum);
      remainingBytes -= content.length;
      if (revisionOf(content) !== expectedRevision) {
        stale = true;
        break;
      }
    } catch {
      stale = true;
      break;
    }
  }
  if (stale) diagnostics.push({ code: "INDEX_STALE", severity: "warning", message: "记忆来源已变化；当前列表可能过期，请从 Markdown 事实源重建索引。" });

  return {
    schemaVersion: 1,
    projectId,
    indexStatus: stale ? "stale" : "ready",
    records: records as MemoryOverviewRecord[],
    chapterSummaries: chapterSummaries as MemoryChapterSummary[],
    diagnostics
  };
}
