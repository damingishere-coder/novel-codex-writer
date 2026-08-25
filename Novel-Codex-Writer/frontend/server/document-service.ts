import { existsSync } from "node:fs";
import { mkdir, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { countReadableWords, createRevision } from "./review-utils.ts";
import { assertInsidePath, assertNoSymlinkEscape, readFileInside, withProjectWriteLock, writeDocumentVersioned } from "./file-storage.ts";
import { HttpError } from "./http-error.ts";
import type { ProjectSummary } from "./project-service.ts";

interface CachedDocument {
  mtimeMs: number;
  size: number;
  content: string;
  revision: string;
}

interface ProjectDocumentPaths {
  getProjectRoot(project: ProjectSummary): string;
  resolveProjectFile(projectRoot: string, relativePath: string): string;
  normalizeRelativePath(relativePath: string): string;
  toProjectPath(projectRoot: string, absolutePath: string): string;
}

interface DocumentServiceOptions {
  libraryRoot: string;
  trashDir: string;
  cache: Map<string, CachedDocument>;
  paths: ProjectDocumentPaths;
  extractTitle(content: string, fallbackPath: string): string;
}

export function createDocumentService(options: DocumentServiceOptions) {
  const { libraryRoot, trashDir, cache, paths, extractTitle } = options;

  async function readCachedDocument(projectRoot: string, target: string) {
    assertNoSymlinkEscape(projectRoot, target);
    const details = await stat(target);
    const cached = cache.get(target);
    if (cached && cached.mtimeMs === details.mtimeMs && cached.size === details.size) return { ...cached, details };
    const content = await readFileInside(projectRoot, target, "utf8");
    const value = { mtimeMs: details.mtimeMs, size: details.size, content, revision: createRevision(content) };
    cache.set(target, value);
    return { ...value, details };
  }

  async function read(project: ProjectSummary, requestedPath: string) {
    const projectRoot = paths.getProjectRoot(project);
    const target = paths.resolveProjectFile(projectRoot, requestedPath);
    if (!existsSync(target)) throw new HttpError(404, "找不到对应文档。");
    const { details, content, revision } = await readCachedDocument(projectRoot, target);
    const relativePath = paths.toProjectPath(projectRoot, target);
    return {
      path: relativePath,
      title: extractTitle(content, relativePath),
      content,
      updatedAt: details.mtime.toISOString(),
      size: details.size,
      wordCount: countReadableWords(content),
      revision
    };
  }

  async function write(project: ProjectSummary, requestedPath: string, content: string, expectedRevision: string) {
    const projectRoot = paths.getProjectRoot(project);
    const target = paths.resolveProjectFile(projectRoot, requestedPath);
    await writeDocumentVersioned(
      projectRoot,
      paths.normalizeRelativePath(requestedPath),
      target,
      content,
      expectedRevision
    );
    cache.delete(target);
    return read(project, requestedPath);
  }

  async function trash(project: ProjectSummary, requestedPath: string) {
    assertInsidePath(libraryRoot, trashDir, "回收站目录越出作品库。");
    assertNoSymlinkEscape(libraryRoot, trashDir);
    const projectRoot = paths.getProjectRoot(project);
    const normalizedPath = paths.normalizeRelativePath(requestedPath);
    return withProjectWriteLock(projectRoot, normalizedPath, async () => {
      const target = paths.resolveProjectFile(projectRoot, normalizedPath);
      if (!existsSync(target)) throw new HttpError(404, "找不到要删除的 Markdown 文件。");
      const destinationRoot = resolve(trashDir, "files", project.id, new Date().toISOString().replace(/[:.]/g, "-"));
      const destination = resolve(destinationRoot, normalizedPath);
      if (!(destination === destinationRoot || destination.startsWith(`${destinationRoot}${sep}`))) {
        throw new HttpError(403, "文档回收站路径越界。");
      }
      await mkdir(dirname(destination), { recursive: true });
      assertNoSymlinkEscape(trashDir, destination);
      const canonicalSource = await realpath(target);
      const canonicalDestinationParent = await realpath(dirname(destination));
      assertInsidePath(projectRoot, canonicalSource, "文档来源已经越出当前作品。");
      assertInsidePath(trashDir, canonicalDestinationParent, "回收站目标父目录越界。");
      if (await realpath(dirname(destination)) !== canonicalDestinationParent) {
        throw new HttpError(409, "移入回收站期间目标目录发生变化，已停止操作。");
      }
      await rename(canonicalSource, resolve(canonicalDestinationParent, basename(destination)));
      cache.delete(target);
      return {
        deleted: true,
        path: normalizedPath,
        trashedPath: relative(libraryRoot, destination).split(sep).join("/")
      };
    });
  }

  return { read, write, trash, readCachedDocument };
}
