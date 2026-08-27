import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, posix, relative, resolve, sep } from "node:path";
import { assertInsidePath, assertNoSymlinkEscape, atomicWriteFileInside, atomicWriteJsonInside, readFileInside, withProjectSnapshotLock } from "./file-storage.ts";
import { FileLockTimeoutError, withCrossProcessLock } from "./file-lock.ts";
import { HttpError } from "./http-error.ts";
import type { ImportedProjectFile } from "./project-import.ts";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [0, 25, 75, 150, 300, 600];

async function renameDirectorySafely(source: string, destination: string) {
  const delays = process.platform === "win32" ? WINDOWS_RENAME_RETRY_DELAYS_MS : [0];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!retryable || attempt === delays.length - 1) throw error;
    }
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIndex {
  activeProjectId: string | null;
  projects: ProjectSummary[];
}

export interface ProjectBody {
  name?: unknown;
  active?: unknown;
}

interface ProjectServiceOptions {
  libraryRoot: string;
  projectsDir: string;
  trashDir: string;
  projectsFile: string;
  skeletonDirs: string[];
  onProjectDeleted?: (projectRoot: string) => void;
}

export function assertInside(root: string, target: string, message: string) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const insideRoot = normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
  if (!insideRoot) throw new HttpError(403, message);
}

export function createProjectService(options: ProjectServiceOptions) {
  const { libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs, onProjectDeleted } = options;

  function assertCollectionRoot(target: string, label: string) {
    assertInside(libraryRoot, target, `${label}路径越出作品库。`);
    assertNoSymlinkEscape(libraryRoot, target);
  }

  function getProjectRoot(project: ProjectSummary) {
    assertCollectionRoot(projectsDir, "作品目录");
    const projectRoot = resolve(projectsDir, project.id);
    assertInside(projectsDir, projectRoot, "小说项目路径越界。");
    assertNoSymlinkEscape(projectsDir, projectRoot);
    return projectRoot;
  }

  function normalizeRelativePath(relativePath: string) {
    const raw = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const normalizedPath = posix.normalize(raw);
    if (!raw || raw.includes("\0") || normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../") || normalizedPath.length > 500) {
      throw new HttpError(400, "非法路径。");
    }
    return normalizedPath;
  }

  function resolveProjectFile(projectRoot: string, relativePath: string) {
    const target = resolve(projectRoot, normalizeRelativePath(relativePath));
    assertInside(projectRoot, target, "只能访问当前小说项目目录内的文件。");
    if (extname(target).toLowerCase() !== ".md") throw new HttpError(400, "只能读取或保存 Markdown 文件。");
    assertNoSymlinkEscape(projectRoot, target);
    return target;
  }

  function toProjectPath(projectRoot: string, absolutePath: string) {
    return relative(projectRoot, absolutePath).split(sep).join("/");
  }

  async function loadProjectIndex(): Promise<ProjectIndex> {
    if (!await pathEntryExists(projectsFile)) return { activeProjectId: null, projects: [] };
    const raw = await readFileInside(libraryRoot, projectsFile, "utf8") as string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(500, "作品索引 JSON 已损坏，已拒绝用空索引覆盖。", "PROJECT_INDEX_INVALID");
    }
    if (!isProjectIndex(parsed)) {
      throw new HttpError(500, "作品索引结构无效，已拒绝丢弃损坏条目。", "PROJECT_INDEX_INVALID");
    }
    const indexedProjects = parsed.projects.map((project) => ({ ...project, root: `作品/${project.id}` }));
    const projects: ProjectSummary[] = [];
    for (const project of indexedProjects) {
      const projectRoot = getProjectRoot(project);
      if (await pathEntryExists(projectRoot)) projects.push(project);
    }
    const activeProjectId =
      typeof parsed.activeProjectId === "string" && projects.some((project) => project.id === parsed.activeProjectId)
        ? parsed.activeProjectId
        : (projects[0]?.id ?? null);
    return { activeProjectId, projects };
  }

  async function saveProjectIndex(index: ProjectIndex) {
    await atomicWriteJsonInside(libraryRoot, projectsFile, {
      activeProjectId: index.activeProjectId,
      projects: index.projects.map((project) => ({ ...project, root: `作品/${project.id}` }))
    } satisfies ProjectIndex);
  }

  async function withProjectIndexWrite<T>(task: () => Promise<T>) {
    const lockRoot = resolve(libraryRoot, ".locks");
    assertInside(libraryRoot, lockRoot, "项目索引锁目录越界。");
    await mkdir(lockRoot, { recursive: true });
    assertNoSymlinkEscape(libraryRoot, lockRoot);
    try {
      return await withCrossProcessLock(lockRoot, "projects-index", task, { timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof FileLockTimeoutError) throw new HttpError(409, "作品索引正在被另一个请求修改，请稍后重试。");
      throw error;
    }
  }

  async function saveProjectAndIndex(index: ProjectIndex, project: ProjectSummary) {
    const projectRoot = getProjectRoot(project);
    if (!await pathEntryExists(projectRoot)) return saveProjectIndex(index);
    await withProjectSnapshotLock(projectRoot, async () => {
      const target = resolve(projectRoot, "project.json");
      const previous = await pathEntryExists(target) ? await readFileInside(projectRoot, target) : undefined;
      await atomicWriteJsonInside(projectRoot, target, project);
      try {
        await saveProjectIndex(index);
      } catch (error) {
        try {
          if (previous === undefined) await unlink(target);
          else await atomicWriteFileInside(projectRoot, target, previous);
        } catch {
          throw new HttpError(500, "作品索引保存失败，且项目元数据无法回滚；请检查本机文件。", "PROJECT_METADATA_ROLLBACK_FAILED");
        }
        throw error;
      }
    });
  }

  async function create(nameValue: unknown): Promise<ProjectSummary> {
    const name = normalizeProjectName(nameValue);
    assertCollectionRoot(projectsDir, "作品目录");
    assertCollectionRoot(trashDir, "回收站目录");
    return withProjectIndexWrite(async () => {
      const index = await loadProjectIndex();
      const id = createProjectId(index, projectsDir);
      const now = new Date().toISOString();
      const project: ProjectSummary = { id, name, root: `作品/${id}`, createdAt: now, updatedAt: now };
      const projectRoot = getProjectRoot(project);
      try {
        await mkdir(projectRoot, { recursive: true });
        for (const dir of skeletonDirs) {
          const target = resolve(projectRoot, dir);
          assertInside(projectRoot, target, "项目骨架目录越界。");
          await mkdir(target, { recursive: true });
          await writeFile(resolve(target, ".gitkeep"), "", "utf8");
        }
        await atomicWriteJsonInside(projectRoot, resolve(projectRoot, "project.json"), project);
        index.projects.push(project);
        index.activeProjectId = project.id;
        await saveProjectIndex(index);
      } catch (error) {
        if (!await pathEntryExists(projectRoot)) throw error;
        assertCollectionRoot(trashDir, "回收站目录");
        const rollbackRoot = resolve(trashDir, "projects");
        const rollbackTarget = resolve(rollbackRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${project.id}-create-failed`);
        try {
          assertInside(trashDir, rollbackTarget, "项目创建回滚路径越界。");
          await mkdir(rollbackRoot, { recursive: true });
          assertNoSymlinkEscape(trashDir, rollbackTarget);
          await rename(projectRoot, rollbackTarget);
        } catch {
          throw new HttpError(500, "作品索引保存失败，且新项目目录无法移入回收站；请检查本机文件。", "PROJECT_CREATE_ROLLBACK_FAILED");
        }
        throw error;
      }
      return project;
    });
  }

  async function importFiles(nameValue: unknown, files: ImportedProjectFile[]): Promise<ProjectSummary> {
    const name = normalizeProjectName(nameValue);
    if (!files.length || files.length > 5_000) throw new HttpError(400, "导入文件数量无效。", "IMPORT_FILE_LIMIT");
    if (files.reduce((total, file) => total + file.data.length, 0) > 64 * 1024 * 1024) {
      throw new HttpError(413, "导入内容超过 64 MiB。", "IMPORT_BYTE_LIMIT");
    }
    assertCollectionRoot(projectsDir, "作品目录");
    assertCollectionRoot(trashDir, "回收站目录");
    return withProjectIndexWrite(async () => {
      const index = await loadProjectIndex();
      const id = createProjectId(index, projectsDir);
      const now = new Date().toISOString();
      const project: ProjectSummary = { id, name, root: `作品/${id}`, createdAt: now, updatedAt: now };
      const projectRoot = getProjectRoot(project);
      const stagingRoot = resolve(projectsDir, `.${id}.${randomUUID()}.importing`);
      assertInside(projectsDir, stagingRoot, "导入暂存目录越界。");
      if (await pathEntryExists(projectRoot) || await pathEntryExists(stagingRoot)) {
        throw new HttpError(409, "导入目标已存在，请重试。", "IMPORT_TARGET_EXISTS");
      }
      let committed = false;
      try {
        await mkdir(stagingRoot, { recursive: false });
        assertNoSymlinkEscape(projectsDir, stagingRoot);
        for (const dir of skeletonDirs) {
          const target = resolve(stagingRoot, dir);
          assertInside(stagingRoot, target, "导入项目骨架目录越界。");
          await mkdir(target, { recursive: true });
        }
        const normalizedPaths = new Set<string>();
        for (const file of files) {
          const relativePath = normalizeRelativePath(file.path);
          const key = relativePath.toLowerCase();
          if (relativePath === "project.json" || normalizedPaths.has(key)) {
            throw new HttpError(400, "导入包含保留文件或重复路径。", "IMPORT_PATH_INVALID");
          }
          normalizedPaths.add(key);
          const target = resolve(stagingRoot, relativePath);
          assertInside(stagingRoot, target, "导入文件路径越界。");
          await atomicWriteFileInside(stagingRoot, target, file.data);
        }
        await atomicWriteJsonInside(stagingRoot, resolve(stagingRoot, "project.json"), project);
        await renameDirectorySafely(stagingRoot, projectRoot);
        committed = true;
        index.projects.push(project);
        index.activeProjectId = project.id;
        await saveProjectIndex(index);
        return project;
      } catch (error) {
        const rollbackSource = committed ? projectRoot : stagingRoot;
        if (await pathEntryExists(rollbackSource)) {
          const rollbackRoot = resolve(trashDir, "projects");
          const rollbackTarget = resolve(rollbackRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}-import-failed`);
          try {
            await mkdir(rollbackRoot, { recursive: true });
            assertInside(trashDir, rollbackTarget, "导入回滚路径越界。");
            await renameDirectorySafely(rollbackSource, rollbackTarget);
          } catch {
            throw new HttpError(500, "导入失败，且暂存目录无法移入回收站；请检查本机文件。", "IMPORT_ROLLBACK_FAILED");
          }
        }
        throw error;
      }
    });
  }

  async function update(id: string, body: ProjectBody): Promise<ProjectSummary> {
    return withProjectIndexWrite(async () => {
      const index = await loadProjectIndex();
      const project = index.projects.find((item) => item.id === id);
      if (!project) throw new HttpError(404, "找不到要更新的小说项目。");
      if (typeof body.name === "string" && body.name.trim()) project.name = normalizeProjectName(body.name);
      if (body.active === true) index.activeProjectId = project.id;
      project.updatedAt = new Date().toISOString();
      await saveProjectAndIndex(index, project);
      return project;
    });
  }

  async function remove(id: string) {
    assertCollectionRoot(projectsDir, "作品目录");
    assertCollectionRoot(trashDir, "回收站目录");
    return withProjectIndexWrite(async () => {
      const index = await loadProjectIndex();
      const project = index.projects.find((item) => item.id === id);
      if (!project) throw new HttpError(404, "找不到要删除的小说项目。");
      const projectRoot = getProjectRoot(project);
      let trashedPath: string | undefined;
      if (await pathEntryExists(projectRoot)) {
        trashedPath = await withProjectSnapshotLock(projectRoot, async () => {
          const deletingMarker = resolve(projectRoot, ".deleting");
          await writeFile(deletingMarker, new Date().toISOString(), { flag: "wx" });
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            assertCollectionRoot(trashDir, "回收站目录");
            const destination = resolve(trashDir, "projects", `${stamp}-${project.id}`);
            assertInside(trashDir, destination, "项目回收站路径越界。");
            await mkdir(dirname(destination), { recursive: true });
            assertNoSymlinkEscape(trashDir, destination);
            const canonicalProjectRoot = await realpath(projectRoot);
            const canonicalDestinationParent = await realpath(dirname(destination));
            assertInsidePath(projectsDir, canonicalProjectRoot, "作品目录已经越出项目集合。");
            assertInsidePath(trashDir, canonicalDestinationParent, "项目回收站父目录越界。");
            if (await realpath(dirname(destination)) !== canonicalDestinationParent) {
              throw new HttpError(409, "删除期间项目回收站目录发生变化，已停止操作。");
            }
            await rename(canonicalProjectRoot, resolve(canonicalDestinationParent, basename(destination)));
            onProjectDeleted?.(projectRoot);
            return relative(libraryRoot, destination).split(sep).join("/");
          } catch (error) {
            for (const delayMs of [0, 10, 25, 50]) {
              if (delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
              try {
                await unlink(deletingMarker);
                break;
              } catch (cleanupError) {
                if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") break;
                if (delayMs === 50) {
                  throw new HttpError(500, "项目删除失败，且删除标记清理失败；已停止后续写入，请检查本机文件。", "PROJECT_DELETE_MARKER_STUCK");
                }
              }
            }
            throw error;
          }
        });
      }
      index.projects = index.projects.filter((item) => item.id !== id);
      if (index.activeProjectId === id) index.activeProjectId = index.projects[0]?.id ?? null;
      try {
        await saveProjectIndex(index);
      } catch (error) {
        if (trashedPath) {
          const trashedRoot = resolve(libraryRoot, trashedPath);
          try {
            assertInside(trashDir, trashedRoot, "项目删除回滚来源越界。");
            if (await pathEntryExists(projectRoot)) throw new Error("project root already exists");
            await rename(trashedRoot, projectRoot);
            await unlink(resolve(projectRoot, ".deleting")).catch((cleanupError) => {
              if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
            });
          } catch {
            throw new HttpError(500, "作品索引保存失败，且项目目录无法从回收站恢复；请检查本机文件。", "PROJECT_DELETE_ROLLBACK_FAILED");
          }
        }
        throw error;
      }
      return { id: project.id, name: project.name, trashedPath };
    });
  }

  async function touch(id: string) {
    return withProjectIndexWrite(async () => {
      const index = await loadProjectIndex();
      const project = index.projects.find((item) => item.id === id);
      if (!project) return;
      project.updatedAt = new Date().toISOString();
      await saveProjectAndIndex(index, project);
    });
  }

  async function listPayload() {
    const index = await loadProjectIndex();
    return { libraryRoot, activeProjectId: index.activeProjectId, projects: index.projects };
  }

  async function select(projectId?: string | null) {
    const index = await loadProjectIndex();
    const selectedId = projectId || index.activeProjectId;
    if (!selectedId) throw new HttpError(404, "还没有小说项目，请先在网页里新建一本小说。");
    const project = index.projects.find((item) => item.id === selectedId);
    if (!project) throw new HttpError(404, "找不到指定的小说项目。");
    return project;
  }

  async function findById(value: unknown) {
    if (typeof value !== "string") throw new HttpError(400, "缺少 projectId。");
    return select(value);
  }

  return {
    create,
    importFiles,
    update,
    remove,
    touch,
    listPayload,
    select,
    findById,
    loadProjectIndex,
    getProjectRoot,
    resolveProjectFile,
    normalizeRelativePath,
    toProjectPath
  };
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  return typeof project.id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(project.id)
    && typeof project.name === "string"
    && project.name.length > 0
    && project.name.length <= 120
    && project.root === `作品/${project.id}`
    && typeof project.createdAt === "string"
    && typeof project.updatedAt === "string";
}

function isProjectIndex(value: unknown): value is ProjectIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  if (index.activeProjectId !== null && typeof index.activeProjectId !== "string") return false;
  if (!Array.isArray(index.projects) || !index.projects.every(isProjectSummary)) return false;
  const normalizedIds = index.projects.map((project) => project.id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length) return false;
  return index.activeProjectId === null
    || index.projects.some((project) => project.id === index.activeProjectId);
}

async function pathEntryExists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizeProjectName(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    const name = value.trim();
    if (name.length > 120) throw new HttpError(400, "作品名称不能超过 120 个字符。");
    return name;
  }
  return "未命名小说";
}

function createProjectId(index: ProjectIndex, projectsDir: string) {
  let candidate = `novel-${Date.now().toString(36)}`;
  let counter = 1;
  while (index.projects.some((project) => project.id === candidate) || existsSync(resolve(projectsDir, candidate))) {
    candidate = `novel-${Date.now().toString(36)}-${counter}`;
    counter += 1;
  }
  return candidate;
}
