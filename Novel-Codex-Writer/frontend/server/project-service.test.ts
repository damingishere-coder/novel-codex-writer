import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectService } from "./project-service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project creation rollback", () => {
  it("安全导入始终创建新的项目 ID，不覆盖现有作品", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "project-import-new-id-"));
    temporaryRoots.push(libraryRoot);
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(projectsDir, { recursive: true });
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: ["正文"] });
    const existing = await service.create("现有作品");
    await writeFile(resolve(projectsDir, existing.id, "正文", "第001章.md"), "原内容", "utf8");

    const imported = await service.importFiles("导入副本", [{ path: "正文/第001章.md", data: Buffer.from("导入内容") }]);
    expect(imported.id).not.toBe(existing.id);
    expect(await readFile(resolve(projectsDir, existing.id, "正文", "第001章.md"), "utf8")).toBe("原内容");
    expect(await readFile(resolve(projectsDir, imported.id, "正文", "第001章.md"), "utf8")).toBe("导入内容");
    expect((await service.loadProjectIndex()).activeProjectId).toBe(imported.id);
  });

  it("rejects a projects index symlink that points outside the library", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "project-index-boundary-"));
    temporaryRoots.push(root);
    const libraryRoot = resolve(root, "library");
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    const outside = resolve(root, "outside.json");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(outside, JSON.stringify({ activeProjectId: null, projects: [] }), "utf8");
    try {
      await symlink(outside, projectsFile, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: [] });
    await expect(service.loadProjectIndex()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a dangling projects index symlink instead of treating it as absent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "project-index-dangling-"));
    temporaryRoots.push(root);
    const libraryRoot = resolve(root, "library");
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(projectsDir, { recursive: true });
    try {
      await symlink(resolve(root, "missing-index.json"), projectsFile, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: [] });
    await expect(service.loadProjectIndex()).rejects.toMatchObject({
      statusCode: 403,
      code: "SYMLINK_TARGET_FORBIDDEN"
    });
  });

  it("moves a partially initialized project to trash when skeleton creation fails", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "project-create-rollback-"));
    temporaryRoots.push(libraryRoot);
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(projectsDir, { recursive: true });
    const service = createProjectService({
      libraryRoot,
      projectsDir,
      trashDir,
      projectsFile,
      skeletonDirs: ["正文", "../outside"]
    });

    await expect(service.create("测试作品")).rejects.toMatchObject({ statusCode: 403 });
    expect(await readdir(projectsDir)).toEqual([]);
    expect(existsSync(projectsFile)).toBe(false);
    expect((await readdir(resolve(trashDir, "projects"))).some((name) => name.endsWith("-create-failed"))).toBe(true);
  });

  it("rejects a structurally corrupt project index instead of replacing it with an empty list", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "project-index-shape-"));
    temporaryRoots.push(libraryRoot);
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(projectsFile, JSON.stringify({ activeProjectId: null, projects: [{ id: "broken" }] }), "utf8");
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: [] });
    await expect(service.loadProjectIndex()).rejects.toMatchObject({
      statusCode: 500,
      code: "PROJECT_INDEX_INVALID"
    });
  });

  it("rejects project ids and roots that can collapse the per-project boundary", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "project-index-id-boundary-"));
    temporaryRoots.push(libraryRoot);
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(projectsFile, JSON.stringify({
      activeProjectId: ".",
      projects: [{
        id: ".",
        name: "越界作品",
        root: "作品/.",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z"
      }]
    }), "utf8");
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: [] });
    await expect(service.loadProjectIndex()).rejects.toMatchObject({
      statusCode: 500,
      code: "PROJECT_INDEX_INVALID"
    });
  });

  it("rejects a projects collection junction that escapes the library root", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "project-collection-boundary-"));
    temporaryRoots.push(root);
    const libraryRoot = resolve(root, "library");
    const outside = resolve(root, "outside-projects");
    const projectsDir = resolve(libraryRoot, "作品");
    const trashDir = resolve(libraryRoot, ".trash");
    const projectsFile = resolve(libraryRoot, "projects.json");
    await mkdir(libraryRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, projectsDir, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const service = createProjectService({ libraryRoot, projectsDir, trashDir, projectsFile, skeletonDirs: [] });
    await expect(service.create("不应创建到外部")).rejects.toMatchObject({
      statusCode: 403,
      code: "SYMLINK_TARGET_FORBIDDEN"
    });
    expect(await readdir(outside)).toEqual([]);
  });
});
