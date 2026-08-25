import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, posix, relative, resolve, sep } from "node:path";
import type { DocumentVersion, TrashEntry } from "../shared/api-contract.ts";
import { FileLockTimeoutError, withCrossProcessLock } from "./file-lock.ts";
import { recordOperation } from "./observability.ts";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "REQUEST_FAILED"
  ) {
    super(message);
  }
}

export function assertInsidePath(root: string, target: string, message = "路径越界。") {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new ApiError(403, message);
  }
}

export function assertNoSymlinkEscape(root: string, target: string) {
  assertInsidePath(root, target, "只能访问当前小说项目目录内的文件。");
  const realRoot = realpathSync(root);
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  let lexical = normalizedRoot;
  const relativeParts = relative(normalizedRoot, normalizedTarget).split(sep).filter(Boolean);
  for (const part of relativeParts) {
    lexical = resolve(lexical, part);
    try {
      if (lstatSync(lexical).isSymbolicLink()) {
        throw new ApiError(403, "路径包含符号链接或 junction，已拒绝访问。", "SYMLINK_TARGET_FORBIDDEN");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  assertInsidePath(realRoot, realAncestor, "路径包含指向小说目录外的符号链接，已拒绝访问。");
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) {
      throw new ApiError(403, "不允许直接读写符号链接文件。", "SYMLINK_TARGET_FORBIDDEN");
    }
    assertInsidePath(realRoot, realpathSync(target), "文件符号链接越出小说目录，已拒绝访问。");
  }
}

const BOOK_EXPORT_MAX_FILES = 2_000;
const BOOK_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const PROJECT_EXPORT_MAX_FILES = 5_000;
const PROJECT_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_MAX_ENTRIES = 514;
const HISTORY_MAX_FILES = 512;
const HISTORY_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_MAX_VERSION_BYTES = 2 * 1024 * 1024;

export async function atomicWriteFileInside(
  root: string,
  target: string,
  content: string | Buffer,
  mode?: number
) {
  assertNoSymlinkEscape(root, target);
  await mkdir(dirname(target), { recursive: true });
  assertNoSymlinkEscape(root, dirname(target));
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(target));
  assertInsidePath(canonicalRoot, canonicalParent, "写入目标父目录已经越出边界。");
  const canonicalTarget = resolve(canonicalParent, basename(target));
  const temporary = resolve(canonicalParent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporary, "wx", mode ?? 0o666);
    const openedStat = await temporaryHandle.stat();
    const canonicalTemporary = await realpath(temporary);
    assertInsidePath(canonicalRoot, canonicalTemporary, "临时写入文件已经越出边界。");
    const pathStat = await stat(canonicalTemporary);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new ApiError(409, "创建临时文件期间路径发生变化，已停止写入。", "WRITE_TEMP_CHANGED");
    }
    await temporaryHandle.writeFile(content);
    await temporaryHandle.close();
    temporaryHandle = undefined;
    const confirmedParent = await realpath(dirname(target));
    if (confirmedParent !== canonicalParent) throw new ApiError(409, "写入期间父目录发生变化，已停止提交。", "WRITE_PARENT_CHANGED");
    assertNoSymlinkEscape(canonicalRoot, canonicalParent);
    if (await realpath(temporary) !== canonicalTemporary) {
      throw new ApiError(409, "提交前临时文件路径发生变化，已停止写入。", "WRITE_TEMP_CHANGED");
    }
    if (existsSync(canonicalTarget) && lstatSync(canonicalTarget).isSymbolicLink()) {
      throw new ApiError(403, "不允许覆盖符号链接文件。", "SYMLINK_TARGET_FORBIDDEN");
    }
    await rename(temporary, canonicalTarget);
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    if (existsSync(temporary)) await unlink(temporary).catch(() => undefined);
  }
}

export async function atomicWriteJsonInside(root: string, target: string, value: unknown) {
  await atomicWriteFileInside(root, target, `${JSON.stringify(value, null, 2)}\n`);
}

export function revisionOf(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeDocumentPath(value: string) {
  const raw = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = posix.normalize(raw);
  if (!raw || raw.includes("\0") || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ApiError(400, "非法文档路径。");
  }
  return normalized;
}

function documentIdentity(projectRoot: string, documentPath: string) {
  const normalized = normalizeDocumentPath(documentPath).normalize("NFC");
  const candidate = resolve(projectRoot, normalized);
  assertNoSymlinkEscape(projectRoot, candidate);
  const canonical = existsSync(candidate)
    ? relative(projectRoot, realpathSync(candidate)).split(sep).join("/").normalize("NFC")
    : normalized;
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function historyRootFor(projectRoot: string, documentPath: string) {
  const key = createHash("sha256").update(documentIdentity(projectRoot, documentPath), "utf8").digest("hex").slice(0, 24);
  return resolve(projectRoot, ".history", key);
}

function documentLockKey(projectRoot: string, documentPath: string) {
  const canonicalKey = documentIdentity(projectRoot, documentPath);
  return `document-${createHash("sha256").update(canonicalKey, "utf8").digest("hex")}`;
}

async function projectLockRoot(projectRoot: string) {
  if (!existsSync(projectRoot)) {
    throw new ApiError(409, "当前作品目录已不存在，已拒绝重新创建锁目录。", "PROJECT_ROOT_MISSING");
  }
  const projectRootStat = lstatSync(projectRoot);
  if (!projectRootStat.isDirectory() || projectRootStat.isSymbolicLink()) {
    throw new ApiError(403, "当前作品目录不能是符号链接或 junction。", "SYMLINK_TARGET_FORBIDDEN");
  }
  assertNoSymlinkEscape(projectRoot, projectRoot);
  const lockRoot = resolve(projectRoot, ".locks");
  assertInsidePath(projectRoot, lockRoot, "写入锁目录越界。");
  try {
    await mkdir(lockRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ApiError(409, "当前作品目录在加锁前发生变化，已停止写入。", "PROJECT_ROOT_CHANGED");
    }
  }
  assertNoSymlinkEscape(projectRoot, lockRoot);
  return lockRoot;
}

async function recoverInterruptedDeletion(projectRoot: string) {
  const marker = resolve(projectRoot, ".deleting");
  if (!existsSync(marker)) return;
  // Holding project-write.lock proves no deletion is still active. A marker
  // visible here can therefore only have been left by an interrupted attempt.
  await unlink(marker).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ApiError(409, "检测到未完成的项目删除，且无法清理删除标记。", "PROJECT_DELETE_RECOVERY_FAILED");
    }
  });
}

export async function withProjectSnapshotLock<T>(projectRoot: string, task: (owner: string) => Promise<T>, signal?: AbortSignal) {
  const lockRoot = await projectLockRoot(projectRoot);
  try {
    return await withCrossProcessLock(lockRoot, "project-write", async (owner) => {
      await recoverInterruptedDeletion(projectRoot);
      if (!existsSync(projectRoot)) {
        throw new ApiError(409, "当前作品目录在等待锁期间已不存在。", "PROJECT_ROOT_MISSING");
      }
      return task(owner);
    }, { timeoutMs: 10_000, signal, createRoot: false });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      throw new ApiError(409, "当前作品正在被另一个请求修改或导出，请稍后重试。");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ApiError(409, "当前作品目录在等待写入锁期间已被移走。", "PROJECT_ROOT_CHANGED");
    }
    throw error;
  }
}

export async function withProjectWriteLock<T>(
  projectRoot: string,
  documentPath: string,
  task: () => Promise<T>,
  signal?: AbortSignal
) {
  return withProjectSnapshotLock(projectRoot, async () => {
    const lockRoot = await projectLockRoot(projectRoot);
    try {
      return await withCrossProcessLock(lockRoot, documentLockKey(projectRoot, documentPath), task, {
        signal,
        createRoot: false
      });
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        throw new ApiError(409, "同一文档正在被另一个请求修改，请稍后重试。");
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ApiError(409, "当前作品目录在等待文档锁期间已被移走。", "PROJECT_ROOT_CHANGED");
      }
      throw error;
    }
  }, signal);
}

export function readFileInside(root: string, target: string, encoding: BufferEncoding): Promise<string>;
export function readFileInside(root: string, target: string): Promise<Buffer>;
export async function readFileInside(root: string, target: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  assertNoSymlinkEscape(root, target);
  const handle = await open(target, "r");
  try {
    const openedStat = await handle.stat();
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    assertInsidePath(canonicalRoot, canonicalTarget, "读取目标已经越出当前小说目录。");
    const pathStat = await stat(canonicalTarget);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new ApiError(409, "读取期间文件路径发生变化，已拒绝使用不稳定内容。");
    }
    return encoding ? handle.readFile({ encoding }) : handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readFileInsideLimited(root: string, target: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ApiError(500, "读取字节预算不合法。", "READ_BUDGET_INVALID");
  if (signal?.aborted) throw new ApiError(499, "文件读取已取消。", "READ_ABORTED");
  assertNoSymlinkEscape(root, target);
  const handle = await open(target, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new ApiError(409, "读取目标不是普通文件。", "READ_TARGET_INVALID");
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    assertInsidePath(canonicalRoot, canonicalTarget, "读取目标已经越出当前小说目录。");
    const pathStat = await stat(canonicalTarget);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new ApiError(409, "读取期间文件路径发生变化，已拒绝使用不稳定内容。");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      if (signal?.aborted) throw new ApiError(499, "文件读取已取消。", "READ_ABORTED");
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new ApiError(413, `实际读取内容超过 ${maxBytes} 字节安全上限。`, "READ_BYTE_LIMIT");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export interface CollectFilesOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
  include?: (path: string) => boolean;
  excludeDirectory?: (path: string) => boolean;
}

export async function collectFilesInside(
  root: string,
  scanRoot: string,
  options: CollectFilesOptions = {},
  budget = { files: 0, bytes: 0, entries: 0 },
  depth = 0
): Promise<string[]> {
  assertNoSymlinkEscape(root, scanRoot);
  if (!existsSync(scanRoot)) return [];
  const maxEntries = options.maxEntries ?? 10_000;
  const maxDepth = options.maxDepth ?? 32;
  if (depth > maxDepth) {
    throw new ApiError(413, `扫描目录深度超过 ${maxDepth} 层安全上限。`, "SCAN_DEPTH_LIMIT");
  }
  const entries = (await readdir(scanRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const values: string[] = [];
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > maxEntries) {
      throw new ApiError(413, `扫描目录项超过 ${maxEntries} 个安全上限。`, "SCAN_ENTRY_LIMIT");
    }
    const target = resolve(scanRoot, entry.name);
    assertNoSymlinkEscape(root, target);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (options.excludeDirectory?.(target)) continue;
      values.push(...await collectFilesInside(root, target, options, budget, depth + 1));
      continue;
    }
    if (!entry.isFile() || (options.include && !options.include(target))) continue;
    budget.files += 1;
    if (options.maxFiles !== undefined && budget.files > options.maxFiles) {
      throw new ApiError(413, `扫描文件数超过 ${options.maxFiles} 个安全上限。`, "SCAN_FILE_LIMIT");
    }
    if (options.maxBytes !== undefined) {
      budget.bytes += (await stat(target)).size;
      if (budget.bytes > options.maxBytes) {
        throw new ApiError(413, `扫描文件总大小超过 ${options.maxBytes} 字节安全上限。`, "SCAN_BYTE_LIMIT");
      }
    }
    values.push(target);
  }
  return values;
}

async function saveHistoryVersionUnlocked(projectRoot: string, documentPath: string, content: string) {
  const historyRoot = historyRootFor(projectRoot, documentPath);
  assertInsidePath(projectRoot, historyRoot, "历史版本目录越界。");
  assertNoSymlinkEscape(projectRoot, historyRoot);
  await mkdir(historyRoot, { recursive: true });
  const revision = revisionOf(content);
  if (Buffer.byteLength(content) > HISTORY_MAX_VERSION_BYTES) {
    throw new ApiError(413, `单个历史版本超过 ${HISTORY_MAX_VERSION_BYTES} 字节安全上限。`, "HISTORY_VERSION_TOO_LARGE");
  }
  const entries = await readdir(historyRoot, { withFileTypes: true });
  if (entries.length > HISTORY_MAX_ENTRIES) {
    throw new ApiError(413, `历史目录项超过 ${HISTORY_MAX_ENTRIES} 个安全上限。`, "HISTORY_ENTRY_LIMIT");
  }
  const versionNames = entries.filter((entry) => entry.isFile() && /-[a-f0-9]{64}\.md$/.test(entry.name));
  const alreadyStored = versionNames.some((entry) => entry.name.endsWith(`-${revision}.md`));
  const hasMetadata = entries.some((entry) => entry.isFile() && entry.name === "document.json");
  const projectedEntries = entries.length + Number(!alreadyStored) + Number(!hasMetadata);
  if (projectedEntries > HISTORY_MAX_ENTRIES) {
    throw new ApiError(413, `历史目录项达到 ${HISTORY_MAX_ENTRIES} 个安全上限；请先手动归档旧历史。`, "HISTORY_ENTRY_LIMIT");
  }
  if (versionNames.length >= HISTORY_MAX_FILES && !alreadyStored) {
    throw new ApiError(413, `历史版本达到 ${HISTORY_MAX_FILES} 个安全上限；请先手动归档旧历史。`, "HISTORY_FILE_LIMIT");
  }
  if (!alreadyStored) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await atomicWriteFileInside(projectRoot, resolve(historyRoot, `${timestamp}-${revision}.md`), content);
  }
  await atomicWriteJsonInside(projectRoot, resolve(historyRoot, "document.json"), {
    schemaVersion: 1,
    path: normalizeDocumentPath(documentPath)
  });
}

export async function saveHistoryVersion(projectRoot: string, documentPath: string, content: string) {
  return withProjectWriteLock(projectRoot, documentPath, () =>
    saveHistoryVersionUnlocked(projectRoot, documentPath, content)
  );
}

export async function writeDocumentVersioned(
  projectRoot: string,
  documentPath: string,
  target: string,
  content: string,
  expectedRevision: string
) {
  return withProjectWriteLock(projectRoot, documentPath, async () => {
    assertNoSymlinkEscape(projectRoot, target);
    const existed = existsSync(target);
    if (!existed) {
      if (expectedRevision !== "") {
        throw new ApiError(409, "目标文档尚不存在，但 expectedRevision 不是空值。");
      }
      if (existsSync(target)) throw new ApiError(409, "文档已由其他程序创建，请重新载入后再保存。");
      await atomicWriteFileInside(projectRoot, target, content);
      return content;
    }

    const previous = await readFileInside(projectRoot, target, "utf8");
    const previousRevision = revisionOf(previous);
    if (previousRevision !== expectedRevision) {
      throw new ApiError(409, "文档已被其他程序修改。已阻止覆盖，请重新载入后再保存。");
    }
    if (previous === content) return content;

    await saveHistoryVersionUnlocked(projectRoot, documentPath, previous);
    const beforeCommit = await readFileInside(projectRoot, target, "utf8");
    if (revisionOf(beforeCommit) !== previousRevision) {
      throw new ApiError(409, "保存前检测到文档发生变化，已阻止覆盖。");
    }
    await atomicWriteFileInside(projectRoot, target, content);
    return content;
  });
}

async function listDocumentVersionsUnlocked(projectRoot: string, documentPath: string): Promise<DocumentVersion[]> {
  const historyRoot = historyRootFor(projectRoot, documentPath);
  assertNoSymlinkEscape(projectRoot, historyRoot);
  if (!existsSync(historyRoot)) return [];
  const entries = await readdir(historyRoot, { withFileTypes: true });
  if (entries.length > HISTORY_MAX_ENTRIES) {
    throw new ApiError(413, `历史目录项超过 ${HISTORY_MAX_ENTRIES} 个安全上限。`, "HISTORY_ENTRY_LIMIT");
  }
  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = entry.name.match(/^(.*)-([a-f0-9]{64})\.md$/);
    return match ? [{ entry, match }] : [];
  });
  if (candidates.length > HISTORY_MAX_FILES) {
    throw new ApiError(413, `历史版本超过 ${HISTORY_MAX_FILES} 个安全上限。`, "HISTORY_FILE_LIMIT");
  }
  const versions: DocumentVersion[] = [];
  const seenRevisions = new Set<string>();
  let remainingBytes = HISTORY_MAX_BYTES;
  for (const { entry, match } of candidates
    .sort((left, right) => right.entry.name.localeCompare(left.entry.name))) {
    if (seenRevisions.has(match[2])) continue;
    if (versions.length >= 30) break;
    const target = resolve(historyRoot, entry.name);
    assertNoSymlinkEscape(projectRoot, target);
    const fileStat = await lstat(target);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new ApiError(409, "历史版本不是普通文件，已拒绝使用。", "HISTORY_VERSION_INVALID");
    }
    if (fileStat.size > remainingBytes) {
      throw new ApiError(413, `历史版本总大小超过 ${HISTORY_MAX_BYTES} 字节安全上限。`, "HISTORY_BYTE_LIMIT");
    }
    const content = await readFileInsideLimited(projectRoot, target, remainingBytes);
    remainingBytes -= content.length;
    if (revisionOf(content) !== match[2]) {
      throw new ApiError(409, "历史版本内容与 revision 不匹配，已拒绝使用。", "HISTORY_VERSION_CORRUPT");
    }
    seenRevisions.add(match[2]);
    versions.push({
      id: entry.name,
      revision: match[2],
      createdAt: fileStat.mtime.toISOString(),
      size: fileStat.size
    });
  }
  return versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

async function readVersion(projectRoot: string, documentPath: string, versionId: string) {
  if (!/^[A-Za-z0-9.-]+\.md$/.test(versionId)) throw new ApiError(400, "版本 ID 不合法。");
  const historyRoot = historyRootFor(projectRoot, documentPath);
  const target = resolve(historyRoot, versionId);
  assertInsidePath(historyRoot, target, "历史版本路径越界。");
  assertNoSymlinkEscape(projectRoot, target);
  if (!existsSync(target)) throw new ApiError(404, "找不到指定历史版本。");
  const content = (await readFileInsideLimited(projectRoot, target, HISTORY_MAX_VERSION_BYTES)).toString("utf8");
  const match = versionId.match(/-([a-f0-9]{64})\.md$/);
  if (!match || revisionOf(content) !== match[1]) {
    throw new ApiError(409, "历史版本内容与 revision 不匹配，已拒绝使用。", "HISTORY_VERSION_CORRUPT");
  }
  return content;
}

export async function previewVersionDiff(
  projectRoot: string,
  documentPath: string,
  versionId: string,
  currentContent: string
) {
  return withProjectWriteLock(projectRoot, documentPath, async () => {
    const historical = await readVersion(projectRoot, documentPath, versionId);
    const beforeLines = historical.split(/\r?\n/);
    const afterLines = currentContent.split(/\r?\n/);
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) suffix += 1;
    return {
      versionId,
      historicalRevision: revisionOf(historical),
      currentRevision: revisionOf(currentContent),
      before: beforeLines.slice(prefix, beforeLines.length - suffix).join("\n"),
      after: afterLines.slice(prefix, afterLines.length - suffix).join("\n"),
      fromLine: prefix + 1
    };
  });
}

export async function restoreDocumentVersion(
  projectRoot: string,
  documentPath: string,
  versionId: string,
  target: string,
  expectedRevision: string
) {
  return withProjectWriteLock(projectRoot, documentPath, async () => {
    assertNoSymlinkEscape(projectRoot, target);
    const current = await readFileInside(projectRoot, target, "utf8");
    const currentRevision = revisionOf(current);
    if (currentRevision !== expectedRevision) {
      throw new ApiError(409, "当前文档 revision 已变化，已阻止恢复覆盖。");
    }
    const historical = await readVersion(projectRoot, documentPath, versionId);
    if (historical === current) return historical;
    await saveHistoryVersionUnlocked(projectRoot, documentPath, current);
    const beforeCommit = await readFileInside(projectRoot, target, "utf8");
    if (revisionOf(beforeCommit) !== currentRevision) {
      throw new ApiError(409, "恢复前检测到文档发生变化，已阻止覆盖。");
    }
    await atomicWriteFileInside(projectRoot, target, historical);
    return historical;
  });
}

export async function listDocumentVersions(projectRoot: string, documentPath: string): Promise<DocumentVersion[]> {
  return withProjectWriteLock(projectRoot, documentPath, () => listDocumentVersionsUnlocked(projectRoot, documentPath));
}

function inferTrashTarget(projectId: string, trashRelative: string) {
  const parts = trashRelative.replace(/\\/g, "/").split("/");
  if (parts[0] === "files" && parts[1] === projectId && parts.length >= 4) return parts.slice(3).join("/");
  if (parts[0] === projectId && parts.length >= 3) return parts.slice(2).join("/");
  return null;
}

async function listTrashEntriesUnlocked(libraryRoot: string, trashRoot: string, projectId: string): Promise<TrashEntry[]> {
  const roots = [resolve(trashRoot, "files", projectId), resolve(trashRoot, projectId)];
  const files = (await Promise.all(roots.map((root) => collectFilesInside(trashRoot, root)))).flat();
  const results = await Promise.all(files.flatMap(async (file) => {
    if (extname(file).toLowerCase() !== ".md") return [];
    const trashRelative = relative(trashRoot, file).split(sep).join("/");
    const target = inferTrashTarget(projectId, trashRelative);
    if (!target) return [];
    const fileStat = await stat(file);
    return [{
      id: Buffer.from(trashRelative, "utf8").toString("base64url"),
      path: target,
      trashedPath: relative(libraryRoot, file).split(sep).join("/"),
      deletedAt: fileStat.mtime.toISOString(),
      size: fileStat.size
    }];
  }));
  return results.flat().sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

export async function restoreTrashEntry(
  libraryRoot: string,
  trashRoot: string,
  projectRoot: string,
  projectId: string,
  entryId: string
) {
  assertInsidePath(libraryRoot, trashRoot, "回收站目录越出作品库。");
  assertNoSymlinkEscape(libraryRoot, trashRoot);
  assertInsidePath(libraryRoot, projectRoot, "作品目录越出作品库。");
  assertNoSymlinkEscape(libraryRoot, projectRoot);
  let trashRelative: string;
  try {
    trashRelative = Buffer.from(entryId, "base64url").toString("utf8");
  } catch {
    throw new ApiError(400, "回收站条目 ID 不合法。");
  }
  const documentPath = inferTrashTarget(projectId, trashRelative);
  if (!documentPath || extname(documentPath).toLowerCase() !== ".md") throw new ApiError(400, "回收站条目不属于当前作品。");
  return withProjectWriteLock(projectRoot, documentPath, async () => {
    const source = resolve(trashRoot, trashRelative);
    assertInsidePath(trashRoot, source, "回收站来源越界。");
    assertNoSymlinkEscape(trashRoot, source);
    if (!existsSync(source)) throw new ApiError(404, "回收站条目已不存在。");
    const sourcePathStat = await lstat(source);
    if (!sourcePathStat.isFile()) throw new ApiError(409, "回收站来源不是普通文件。", "TRASH_SOURCE_CHANGED");
    const sourceHandle = await open(source, "r");
    let sourceSnapshot: Stats;
    let sourceData: Buffer;
    try {
      sourceSnapshot = await sourceHandle.stat();
      const canonicalSource = await realpath(source);
      assertInsidePath(await realpath(trashRoot), canonicalSource, "回收站来源越界。");
      if (sourceSnapshot.dev !== sourcePathStat.dev || sourceSnapshot.ino !== sourcePathStat.ino) {
        throw new ApiError(409, "回收站来源在打开前发生变化。", "TRASH_SOURCE_CHANGED");
      }
      sourceData = await sourceHandle.readFile();
      const afterRead = await sourceHandle.stat();
      if (afterRead.dev !== sourceSnapshot.dev || afterRead.ino !== sourceSnapshot.ino ||
          afterRead.size !== sourceSnapshot.size || afterRead.mtimeMs !== sourceSnapshot.mtimeMs) {
        throw new ApiError(409, "回收站来源在读取期间发生变化。", "TRASH_SOURCE_CHANGED");
      }
    } finally {
      await sourceHandle.close();
    }
    const target = resolve(projectRoot, normalizeDocumentPath(documentPath));
    assertInsidePath(projectRoot, target, "恢复目标越界。");
    assertNoSymlinkEscape(projectRoot, target);
    if (existsSync(target)) throw new ApiError(409, "原位置已有同名文件，已阻止覆盖。");
    await mkdir(dirname(target), { recursive: true });
    const canonicalTargetParent = await realpath(dirname(target));
    assertInsidePath(await realpath(projectRoot), canonicalTargetParent, "恢复目标父目录越界。");
    const committedTarget = resolve(canonicalTargetParent, basename(target));
    const temporary = resolve(canonicalTargetParent, `.${basename(target)}.${process.pid}.${randomUUID()}.restore`);
    try {
      await writeFile(temporary, sourceData, { flag: "wx" });
      if (await realpath(dirname(target)) !== canonicalTargetParent) {
        throw new ApiError(409, "恢复期间目标父目录发生变化，已停止提交。", "RESTORE_PARENT_CHANGED");
      }
      await link(temporary, committedTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "原位置已有同名文件，已阻止覆盖。");
      throw error;
    } finally {
      if (existsSync(temporary)) await unlink(temporary).catch(() => undefined);
    }
    // Keep the original trash inode in place. Node does not expose a portable
    // directory-handle-relative rename, so moving it into a second directory
    // would reopen a symlink-swap window after the target has committed.
    return { restored: true, path: normalizeDocumentPath(documentPath), recoveryArchived: false };
  });
}

export async function listTrashEntries(libraryRoot: string, trashRoot: string, projectId: string): Promise<TrashEntry[]> {
  assertInsidePath(libraryRoot, trashRoot, "回收站目录越出作品库。");
  assertNoSymlinkEscape(libraryRoot, trashRoot);
  const projectRoot = resolve(libraryRoot, "作品", projectId);
  assertNoSymlinkEscape(libraryRoot, projectRoot);
  if (!existsSync(projectRoot)) return listTrashEntriesUnlocked(libraryRoot, trashRoot, projectId);
  return withProjectSnapshotLock(projectRoot, () => listTrashEntriesUnlocked(libraryRoot, trashRoot, projectId));
}

function chapterNumber(path: string) {
  const match = basename(path).match(/第\s*0*(\d+)\s*章/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

export async function exportBookMarkdown(projectRoot: string, projectName: string) {
  return withProjectSnapshotLock(projectRoot, () => exportBookMarkdownUnlocked(projectRoot, projectName));
}

async function exportBookMarkdownUnlocked(projectRoot: string, projectName: string) {
  const started = performance.now();
  const bodyRoot = resolve(projectRoot, "正文");
  const files = await collectFilesInside(projectRoot, bodyRoot, {
    maxFiles: BOOK_EXPORT_MAX_FILES,
    maxBytes: BOOK_EXPORT_MAX_BYTES,
    include: (file) => extname(file).toLowerCase() === ".md"
  });
  if (!files.length) {
    throw new ApiError(422, "正文目录中没有可导出的 Markdown 章节。", "BOOK_EXPORT_EMPTY");
  }
  files.sort((left, right) => chapterNumber(left) - chapterNumber(right) || left.localeCompare(right, "zh-CN"));
  const numbers = files.map((file) => chapterNumber(file)).filter(Number.isFinite).filter((value) => value !== Number.MAX_SAFE_INTEGER);
  const missing: number[] = [];
  if (numbers.length) {
    const minimum = numbers.reduce((value, number) => Math.min(value, number), Number.POSITIVE_INFINITY);
    const maximum = numbers.reduce((value, number) => Math.max(value, number), Number.NEGATIVE_INFINITY);
    if (maximum - minimum > 10_000) {
      throw new ApiError(422, "章节编号跨度超过 10000，已拒绝生成可能耗尽内存的缺章列表。");
    }
    const knownNumbers = new Set(numbers);
    for (let number = minimum; number <= maximum; number += 1) {
      if (!knownNumbers.has(number)) missing.push(number);
    }
  }
  const chapters: string[] = [];
  let remainingBytes = BOOK_EXPORT_MAX_BYTES;
  for (const file of files) {
    const content = await readFileInsideLimited(projectRoot, file, remainingBytes);
    remainingBytes -= content.length;
    chapters.push(content.toString("utf8"));
  }
  const warning = missing.length ? `> 缺章提示：${missing.map((value) => `第${String(value).padStart(3, "0")}章`).join("、")}\n\n` : "";
  const markdown = `# ${projectName}\n\n${warning}${chapters.map((value) => value.trim()).join("\n\n---\n\n")}\n`;
  if (Buffer.byteLength(markdown) > BOOK_EXPORT_MAX_BYTES) {
    throw new ApiError(413, `整书导出实际内容超过 ${BOOK_EXPORT_MAX_BYTES} 字节安全上限。`, "EXPORT_BYTE_LIMIT");
  }
  const exportsRoot = resolve(projectRoot, ".exports");
  const target = resolve(exportsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-整书.md`);
  assertNoSymlinkEscape(projectRoot, target);
  await atomicWriteFileInside(projectRoot, target, markdown);
  recordOperation("export", {
    durationMs: performance.now() - started,
    files: files.length,
    bytes: Buffer.byteLength(markdown)
  });
  return { path: relative(projectRoot, target).split(sep).join("/"), missingChapters: missing };
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDate(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createStoredZip(entries: Array<{ name: string; data: Buffer; modifiedAt: Date }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const checksum = crc32(entry.data);
    const stamp = zipDate(entry.modifiedAt);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function projectBackupExcluded(projectRelative: string) {
  const parts = projectRelative.replace(/\\/g, "/").split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  const credentialLikeName = /(^|[._-])(auth|cookie|credential|secret|session|token)s?([._-]|$)/i.test(name);
  const secretName = (
    name === ".env" || name.startsWith(".env.") ||
    [".npmrc", ".pypirc", ".netrc", "_netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(name) ||
    credentialLikeName ||
    [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"].some((suffix) => name.endsWith(suffix))
  );
  return (
    parts.some((part) => [
      ".git", ".exports", ".runtime", ".transactions", ".locks", ".write.lock", "logs",
      ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", "secrets", "credentials", "tokens", "cookies"
    ].includes(part.toLowerCase())) ||
    secretName || name.endsWith(".log")
  );
}

function projectBackupDirectoryExcluded(projectRoot: string, directory: string) {
  const projectRelative = relative(projectRoot, directory).split(sep).join("/");
  return projectRelative.split("/").some((part) =>
    [
      ".git", ".exports", ".runtime", ".transactions", ".locks", ".write.lock", "logs",
      ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", "secrets", "credentials", "tokens", "cookies"
    ].includes(part.toLowerCase())
  );
}

export async function exportProjectZip(
  projectRoot: string,
  project: { id: string; name: string; createdAt: string; updatedAt: string }
) {
  return withProjectSnapshotLock(projectRoot, () => exportProjectZipUnlocked(projectRoot, project));
}

async function exportProjectZipUnlocked(
  projectRoot: string,
  project: { id: string; name: string; createdAt: string; updatedAt: string }
) {
  const started = performance.now();
  const files = await collectFilesInside(projectRoot, projectRoot, {
    maxFiles: PROJECT_EXPORT_MAX_FILES,
    maxBytes: PROJECT_EXPORT_MAX_BYTES,
    excludeDirectory: (directory) => projectBackupDirectoryExcluded(projectRoot, directory),
    include: (file) => !projectBackupExcluded(relative(projectRoot, file).split(sep).join("/"))
  });
  const entries: Array<{ name: string; data: Buffer; modifiedAt: Date }> = [];
  let remainingBytes = PROJECT_EXPORT_MAX_BYTES;
  for (const file of files) {
    const projectRelative = relative(projectRoot, file).split(sep).join("/");
    const fileStat = await lstat(file);
    if (!fileStat.isFile()) continue;
    const data = await readFileInsideLimited(projectRoot, file, remainingBytes);
    remainingBytes -= data.length;
    entries.push({ name: `project/${projectRelative}`, data, modifiedAt: fileStat.mtime });
  }
  const projectMetadata = Buffer.from(`${JSON.stringify({ schemaVersion: 1, project }, null, 2)}\n`, "utf8");
  if (projectMetadata.length > remainingBytes) {
    throw new ApiError(413, `项目备份实际内容超过 ${PROJECT_EXPORT_MAX_BYTES} 字节安全上限。`, "EXPORT_BYTE_LIMIT");
  }
  entries.push({
    name: "library-project.json",
    data: projectMetadata,
    modifiedAt: new Date()
  });
  const zip = createStoredZip(entries);
  if (zip.length > PROJECT_EXPORT_MAX_BYTES) {
    throw new ApiError(413, `项目备份实际内容超过 ${PROJECT_EXPORT_MAX_BYTES} 字节安全上限。`, "EXPORT_BYTE_LIMIT");
  }
  const exportsRoot = resolve(projectRoot, ".exports");
  const target = resolve(exportsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-完整备份.zip`);
  assertNoSymlinkEscape(projectRoot, target);
  await atomicWriteFileInside(projectRoot, target, zip);
  recordOperation("export", {
    durationMs: performance.now() - started,
    files: entries.length,
    bytes: zip.length
  });
  return { path: relative(projectRoot, target).split(sep).join("/"), size: zip.length };
}
