import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { DocumentVersion, TrashEntry } from "../shared/api-contract";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
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
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  assertInsidePath(realRoot, realAncestor, "路径包含指向小说目录外的符号链接，已拒绝访问。");
  if (existsSync(target)) {
    assertInsidePath(realRoot, realpathSync(target), "文件符号链接越出小说目录，已拒绝访问。");
  }
}

export async function atomicWriteFile(target: string, content: string | Buffer, mode?: number) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${target.split(/[\\/]/).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, mode ? { mode } : undefined);
    await rename(temporary, target);
  } finally {
    if (existsSync(temporary)) await unlink(temporary).catch(() => undefined);
  }
}

export async function atomicWriteJson(target: string, value: unknown) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function revisionOf(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeDocumentPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new ApiError(400, "非法文档路径。");
  }
  return normalized;
}

function historyRootFor(projectRoot: string, documentPath: string) {
  const normalized = normalizeDocumentPath(documentPath);
  const key = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
  return resolve(projectRoot, ".history", key);
}

export async function saveHistoryVersion(projectRoot: string, documentPath: string, content: string) {
  const historyRoot = historyRootFor(projectRoot, documentPath);
  assertInsidePath(projectRoot, historyRoot, "历史版本目录越界。");
  await mkdir(historyRoot, { recursive: true });
  const revision = revisionOf(content);
  const existing = await listDocumentVersions(projectRoot, documentPath);
  if (existing.some((item) => item.revision === revision)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await atomicWriteFile(resolve(historyRoot, `${timestamp}-${revision}.md`), content);
  await atomicWriteJson(resolve(historyRoot, "document.json"), {
    schemaVersion: 1,
    path: normalizeDocumentPath(documentPath)
  });
  const updated = await listDocumentVersions(projectRoot, documentPath);
  for (const old of updated.slice(30)) {
    const target = resolve(historyRoot, old.id);
    assertInsidePath(historyRoot, target, "历史版本路径越界。");
    await unlink(target);
  }
}

export async function listDocumentVersions(projectRoot: string, documentPath: string): Promise<DocumentVersion[]> {
  const historyRoot = historyRootFor(projectRoot, documentPath);
  if (!existsSync(historyRoot)) return [];
  const entries = await readdir(historyRoot, { withFileTypes: true });
  const versions = await Promise.all(entries.flatMap(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
    const match = entry.name.match(/^(.*)-([a-f0-9]{64})\.md$/);
    if (!match) return [];
    const fileStat = await stat(resolve(historyRoot, entry.name));
    return [{
      id: entry.name,
      revision: match[2],
      createdAt: fileStat.mtime.toISOString(),
      size: fileStat.size
    }];
  }));
  return versions.flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function readVersion(projectRoot: string, documentPath: string, versionId: string) {
  if (!/^[A-Za-z0-9.-]+\.md$/.test(versionId)) throw new ApiError(400, "版本 ID 不合法。");
  const historyRoot = historyRootFor(projectRoot, documentPath);
  const target = resolve(historyRoot, versionId);
  assertInsidePath(historyRoot, target, "历史版本路径越界。");
  if (!existsSync(target)) throw new ApiError(404, "找不到指定历史版本。");
  return readFile(target, "utf8");
}

export async function previewVersionDiff(
  projectRoot: string,
  documentPath: string,
  versionId: string,
  currentContent: string
) {
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
}

export async function restoreDocumentVersion(
  projectRoot: string,
  documentPath: string,
  versionId: string,
  target: string,
  expectedRevision: string
) {
  const current = await readFile(target, "utf8");
  if (revisionOf(current) !== expectedRevision) {
    throw new ApiError(409, "当前文档 revision 已变化，已阻止恢复覆盖。");
  }
  const historical = await readVersion(projectRoot, documentPath, versionId);
  if (historical === current) return historical;
  await saveHistoryVersion(projectRoot, documentPath, current);
  await atomicWriteFile(target, historical);
  return historical;
}

async function collectFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const values = await Promise.all(entries.map(async (entry) => {
    const target = resolve(root, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return collectFiles(target);
    return entry.isFile() ? [target] : [];
  }));
  return values.flat();
}

function inferTrashTarget(projectId: string, trashRelative: string) {
  const parts = trashRelative.replace(/\\/g, "/").split("/");
  if (parts[0] === "files" && parts[1] === projectId && parts.length >= 4) return parts.slice(3).join("/");
  if (parts[0] === projectId && parts.length >= 3) return parts.slice(2).join("/");
  return null;
}

export async function listTrashEntries(libraryRoot: string, trashRoot: string, projectId: string): Promise<TrashEntry[]> {
  const roots = [resolve(trashRoot, "files", projectId), resolve(trashRoot, projectId)];
  const files = (await Promise.all(roots.map(collectFiles))).flat();
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
  trashRoot: string,
  projectRoot: string,
  projectId: string,
  entryId: string
) {
  let trashRelative: string;
  try {
    trashRelative = Buffer.from(entryId, "base64url").toString("utf8");
  } catch {
    throw new ApiError(400, "回收站条目 ID 不合法。");
  }
  const source = resolve(trashRoot, trashRelative);
  assertInsidePath(trashRoot, source, "回收站来源越界。");
  const documentPath = inferTrashTarget(projectId, trashRelative);
  if (!documentPath || extname(documentPath).toLowerCase() !== ".md") throw new ApiError(400, "回收站条目不属于当前作品。");
  if (!existsSync(source)) throw new ApiError(404, "回收站条目已不存在。");
  const target = resolve(projectRoot, documentPath);
  assertInsidePath(projectRoot, target, "恢复目标越界。");
  assertNoSymlinkEscape(projectRoot, target);
  if (existsSync(target)) throw new ApiError(409, "原位置已有同名文件，已阻止覆盖。");
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  return { restored: true, path: documentPath };
}

function chapterNumber(path: string) {
  const match = path.match(/第\s*0*(\d+)\s*章/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export async function exportBookMarkdown(projectRoot: string, projectName: string) {
  const bodyRoot = resolve(projectRoot, "正文");
  const files = (await collectFiles(bodyRoot)).filter((file) => extname(file).toLowerCase() === ".md");
  files.sort((left, right) => chapterNumber(left) - chapterNumber(right) || left.localeCompare(right, "zh-CN"));
  const numbers = files.map((file) => chapterNumber(file)).filter(Number.isFinite).filter((value) => value !== Number.MAX_SAFE_INTEGER);
  const missing: number[] = [];
  if (numbers.length) {
    for (let number = Math.min(...numbers); number <= Math.max(...numbers); number += 1) {
      if (!numbers.includes(number)) missing.push(number);
    }
  }
  const chapters = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const warning = missing.length ? `> 缺章提示：${missing.map((value) => `第${String(value).padStart(3, "0")}章`).join("、")}\n\n` : "";
  const markdown = `# ${projectName}\n\n${warning}${chapters.map((value) => value.trim()).join("\n\n---\n\n")}\n`;
  const exportsRoot = resolve(projectRoot, ".exports");
  const target = resolve(exportsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-整书.md`);
  await atomicWriteFile(target, markdown);
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

function backupExcluded(projectRelative: string) {
  const parts = projectRelative.replace(/\\/g, "/").split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return (
    parts.some((part) => [".exports", ".runtime", ".transactions", "logs"].includes(part.toLowerCase())) ||
    name === ".env" || name.endsWith(".log")
  );
}

export async function exportProjectZip(
  projectRoot: string,
  project: { id: string; name: string; createdAt: string; updatedAt: string }
) {
  const files = await collectFiles(projectRoot);
  const entries = (await Promise.all(files.map(async (file) => {
    const projectRelative = relative(projectRoot, file).split(sep).join("/");
    if (backupExcluded(projectRelative)) return [];
    const fileStat = await lstat(file);
    if (!fileStat.isFile()) return [];
    return [{ name: `project/${projectRelative}`, data: await readFile(file), modifiedAt: fileStat.mtime }];
  }))).flat();
  entries.push({
    name: "library-project.json",
    data: Buffer.from(`${JSON.stringify({ schemaVersion: 1, project }, null, 2)}\n`, "utf8"),
    modifiedAt: new Date()
  });
  const zip = createStoredZip(entries);
  const exportsRoot = resolve(projectRoot, ".exports");
  const target = resolve(exportsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-完整备份.zip`);
  await atomicWriteFile(target, zip);
  return { path: relative(projectRoot, target).split(sep).join("/"), size: zip.length };
}
