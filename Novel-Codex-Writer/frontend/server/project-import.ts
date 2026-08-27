import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ProjectImportPreview } from "../shared/api-contract.ts";
import { ApiError, assertInsidePath, assertNoSymlinkEscape, atomicWriteFileInside, projectBackupExcluded } from "./file-storage.ts";

export const PROJECT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECT_IMPORT_MAX_FILES = 5_000;
const PROJECT_IMPORT_STAGE_TTL_MS = 30 * 60 * 1_000;

export interface ImportedProjectFile {
  path: string;
  data: Buffer;
}

export interface ParsedProjectBackup {
  sourceProjectId: string;
  projectName: string;
  files: ImportedProjectFile[];
  totalBytes: number;
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttributes: number;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ApiError(400, "ZIP 文件名不是合法 UTF-8。", "IMPORT_ZIP_NAME_INVALID");
  }
}

function normalizeImportPath(value: string) {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ApiError(400, "ZIP 包含非法或绝对路径。", "IMPORT_PATH_INVALID");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new ApiError(400, "ZIP 包含路径穿越或空路径段。", "IMPORT_PATH_INVALID");
  }
  const normalized = parts.join("/");
  if (normalized.length > 500) throw new ApiError(400, "ZIP 文件路径过长。", "IMPORT_PATH_INVALID");
  return normalized;
}

function findEndOfCentralDirectory(zip: Buffer) {
  const minimum = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ApiError(400, "ZIP 缺少有效的中央目录。", "IMPORT_ZIP_INVALID");
}

function readCentralEntries(zip: Buffer): CentralEntry[] {
  if (zip.length > PROJECT_IMPORT_MAX_BYTES) {
    throw new ApiError(413, "完整备份不能超过 64 MiB。", "IMPORT_BYTE_LIMIT");
  }
  if (zip.length < 22) throw new ApiError(400, "ZIP 缺少有效的中央目录。", "IMPORT_ZIP_INVALID");
  const endOffset = findEndOfCentralDirectory(zip);
  const diskNumber = zip.readUInt16LE(endOffset + 4);
  const centralDisk = zip.readUInt16LE(endOffset + 6);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  const commentLength = zip.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entryCount > PROJECT_IMPORT_MAX_FILES
    || endOffset + 22 + commentLength !== zip.length
    || centralOffset + centralSize !== endOffset) {
    throw new ApiError(400, "ZIP 中央目录结构不受支持。", "IMPORT_ZIP_INVALID");
  }
  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new ApiError(400, "ZIP 中央目录条目损坏。", "IMPORT_ZIP_INVALID");
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const entryCommentLength = zip.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > endOffset) throw new ApiError(400, "ZIP 中央目录越界。", "IMPORT_ZIP_INVALID");
    entries.push({
      name: decodeName(zip.subarray(offset + 46, offset + 46 + nameLength)),
      flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10),
      crc: zip.readUInt32LE(offset + 16),
      compressedSize: zip.readUInt32LE(offset + 20),
      uncompressedSize: zip.readUInt32LE(offset + 24),
      externalAttributes: zip.readUInt32LE(offset + 38),
      localOffset: zip.readUInt32LE(offset + 42)
    });
    offset = next;
  }
  if (offset !== endOffset) throw new ApiError(400, "ZIP 中央目录包含未识别数据。", "IMPORT_ZIP_INVALID");
  return entries;
}

function extractEntry(zip: Buffer, entry: CentralEntry) {
  const unixMode = entry.externalAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) throw new ApiError(400, "ZIP 不允许包含符号链接。", "IMPORT_SYMLINK_FORBIDDEN");
  if ((entry.flags & 0x0001) !== 0) throw new ApiError(400, "ZIP 不允许加密条目。", "IMPORT_ENCRYPTED_FORBIDDEN");
  if ((entry.flags & 0x0008) !== 0 || entry.method !== 0 || entry.compressedSize !== entry.uncompressedSize) {
    throw new ApiError(400, "只支持本项目导出的 stored ZIP 备份。", "IMPORT_COMPRESSION_UNSUPPORTED");
  }
  if (entry.localOffset + 30 > zip.length || zip.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new ApiError(400, "ZIP 本地条目损坏。", "IMPORT_ZIP_INVALID");
  }
  const localFlags = zip.readUInt16LE(entry.localOffset + 6);
  const localMethod = zip.readUInt16LE(entry.localOffset + 8);
  const nameLength = zip.readUInt16LE(entry.localOffset + 26);
  const extraLength = zip.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (localFlags !== entry.flags || localMethod !== entry.method || dataEnd > zip.length) {
    throw new ApiError(400, "ZIP 本地条目与中央目录不一致。", "IMPORT_ZIP_INVALID");
  }
  const localName = decodeName(zip.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength));
  if (localName !== entry.name) throw new ApiError(400, "ZIP 条目名称不一致。", "IMPORT_ZIP_INVALID");
  const data = Buffer.from(zip.subarray(dataOffset, dataEnd));
  if (crc32(data) !== entry.crc) throw new ApiError(400, "ZIP 条目校验失败。", "IMPORT_CRC_MISMATCH");
  return data;
}

function isProjectMetadata(value: unknown): value is {
  schemaVersion: 1;
  project: { id: string; name: string; createdAt: string; updatedAt: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  if (metadata.schemaVersion !== 1 || !metadata.project || typeof metadata.project !== "object" || Array.isArray(metadata.project)) return false;
  const project = metadata.project as Record<string, unknown>;
  return typeof project.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(project.id)
    && typeof project.name === "string" && project.name.trim().length > 0 && project.name.length <= 120
    && typeof project.createdAt === "string" && typeof project.updatedAt === "string";
}

export function parseProjectBackup(zip: Buffer): ParsedProjectBackup {
  const entries = readCentralEntries(zip);
  const names = new Set<string>();
  const files: ImportedProjectFile[] = [];
  let metadata: unknown;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const name = normalizeImportPath(entry.name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new ApiError(400, "ZIP 包含重复文件名。", "IMPORT_DUPLICATE_PATH");
    names.add(key);
    totalBytes += entry.uncompressedSize;
    if (totalBytes > PROJECT_IMPORT_MAX_BYTES) throw new ApiError(413, "ZIP 解包内容超过 64 MiB。", "IMPORT_BYTE_LIMIT");
    const data = extractEntry(zip, entry);
    if (name === "library-project.json") {
      try {
        metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      } catch {
        throw new ApiError(400, "备份 metadata 不是合法 UTF-8 JSON。", "IMPORT_METADATA_INVALID");
      }
      continue;
    }
    if (!name.startsWith("project/")) throw new ApiError(400, "ZIP 包含项目目录以外的条目。", "IMPORT_PATH_INVALID");
    const projectPath = normalizeImportPath(name.slice("project/".length));
    if (projectBackupExcluded(projectPath)) throw new ApiError(400, "ZIP 包含不允许导入的敏感或运行文件。", "IMPORT_FILE_FORBIDDEN");
    if (projectPath !== "project.json") files.push({ path: projectPath, data });
  }
  if (!isProjectMetadata(metadata)) throw new ApiError(400, "备份 metadata 缺失或结构无效。", "IMPORT_METADATA_INVALID");
  if (!files.length) throw new ApiError(400, "备份中没有可导入的项目文件。", "IMPORT_EMPTY");
  return {
    sourceProjectId: metadata.project.id,
    projectName: metadata.project.name,
    files,
    totalBytes
  };
}

interface ProjectImportServiceOptions<TProject> {
  runtimeRoot: string;
  importProject(name: string, files: ImportedProjectFile[]): Promise<TProject>;
  sourceProjectIdExists?(id: string): Promise<boolean>;
}

export function createProjectImportService<TProject>(options: ProjectImportServiceOptions<TProject>) {
  const importRoot = resolve(options.runtimeRoot, "imports");
  const staged = new Map<string, { path: string; createdAt: number; preview: ProjectImportPreview }>();

  async function cleanupExpired() {
    const now = Date.now();
    for (const [token, value] of staged) {
      if (now - value.createdAt <= PROJECT_IMPORT_STAGE_TTL_MS) continue;
      staged.delete(token);
      await unlink(value.path).catch(() => undefined);
    }
  }

  async function cleanupOrphanedFiles() {
    if (!existsSync(importRoot)) return;
    const activePaths = new Set([...staged.values()].map((value) => value.path.toLowerCase()));
    const now = Date.now();
    for (const entry of await readdir(importRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.zip$/i.test(entry.name)) continue;
      const target = resolve(importRoot, entry.name);
      assertInsidePath(importRoot, target, "导入暂存清理路径越界。");
      if (activePaths.has(target.toLowerCase())) continue;
      const info = await stat(target);
      if (now - info.mtimeMs > PROJECT_IMPORT_STAGE_TTL_MS) await unlink(target).catch(() => undefined);
    }
  }

  async function preview(zip: Buffer): Promise<ProjectImportPreview> {
    await cleanupExpired();
    const parsed = parseProjectBackup(zip);
    await mkdir(options.runtimeRoot, { recursive: true });
    assertNoSymlinkEscape(options.runtimeRoot, options.runtimeRoot);
    await mkdir(importRoot, { recursive: true });
    assertNoSymlinkEscape(options.runtimeRoot, importRoot);
    await cleanupOrphanedFiles();
    const token = randomUUID();
    const target = resolve(importRoot, `${token}.zip`);
    assertInsidePath(importRoot, target, "导入暂存路径越界。");
    await atomicWriteFileInside(importRoot, target, zip, 0o600);
    const duplicateSourceId = await options.sourceProjectIdExists?.(parsed.sourceProjectId) ?? false;
    const result: ProjectImportPreview = {
      schemaVersion: 1,
      token,
      projectName: parsed.projectName,
      sourceProjectId: parsed.sourceProjectId,
      fileCount: parsed.files.length,
      totalBytes: parsed.totalBytes,
      warnings: [
        "导入会创建新的项目 ID，不会覆盖现有作品。",
        ...(duplicateSourceId ? ["作品库中已存在相同的来源项目 ID；确认后仍会使用全新的 ID 创建副本。"] : [])
      ]
    };
    staged.set(token, { path: target, createdAt: Date.now(), preview: result });
    return result;
  }

  async function confirm(token: unknown, nameValue?: unknown) {
    await cleanupExpired();
    if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) throw new ApiError(400, "导入确认 token 无效。", "IMPORT_TOKEN_INVALID");
    const value = staged.get(token);
    if (!value || !existsSync(value.path)) throw new ApiError(410, "导入预检已过期，请重新选择备份。", "IMPORT_PREVIEW_EXPIRED");
    const parsed = parseProjectBackup(await readFile(value.path));
    const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : parsed.projectName;
    if (name.length > 120) throw new ApiError(400, "作品名称不能超过 120 个字符。", "IMPORT_NAME_INVALID");
    const project = await options.importProject(name, parsed.files);
    staged.delete(token);
    await unlink(value.path).catch(() => undefined);
    return project;
  }

  return { preview, confirm };
}
