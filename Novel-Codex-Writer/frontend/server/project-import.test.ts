import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportProjectZip } from "./file-storage";
import { createProjectImportService, parseProjectBackup } from "./project-import";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function backup() {
  const root = await mkdtemp(resolve(tmpdir(), "project-import-"));
  roots.push(root);
  await mkdir(resolve(root, "正文"), { recursive: true });
  await writeFile(resolve(root, "abcd.txt"), "safe file", "utf8");
  await writeFile(resolve(root, "正文", "第001章.md"), "# 测试正文", "utf8");
  const metadata = { id: "source-novel", name: "来源作品", createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z" };
  const exported = await exportProjectZip(root, metadata);
  return readFile(resolve(root, exported.path));
}

describe("safe project import", () => {
  it("预检后确认创建新项目，且二次使用 token 失败", async () => {
    const zip = await backup();
    const runtimeRoot = await mkdtemp(resolve(tmpdir(), "project-import-runtime-"));
    roots.push(runtimeRoot);
    const importProject = vi.fn(async (name: string, files: Array<{ path: string; data: Buffer }>) => ({ id: "new-id", name, files: files.length }));
    const service = createProjectImportService({ runtimeRoot, importProject, sourceProjectIdExists: async () => true });
    const preview = await service.preview(zip);
    expect(preview).toMatchObject({ projectName: "来源作品", sourceProjectId: "source-novel", fileCount: 2 });
    expect(preview.warnings[0]).toContain("不会覆盖");
    expect(preview.warnings[1]).toContain("相同的来源项目 ID");
    await expect(service.confirm(preview.token, "导入副本")).resolves.toMatchObject({ id: "new-id", name: "导入副本" });
    expect(importProject).toHaveBeenCalledTimes(1);
    await expect(service.confirm(preview.token)).rejects.toMatchObject({ statusCode: 410, code: "IMPORT_PREVIEW_EXPIRED" });
  });

  it("拒绝 ZIP 路径逃逸", async () => {
    const zip = await backup();
    const safeName = Buffer.from("project/abcd.txt");
    const unsafeName = Buffer.from("project/../x.txt");
    expect(safeName.length).toBe(unsafeName.length);
    let offset = zip.indexOf(safeName);
    let replacements = 0;
    while (offset >= 0) {
      unsafeName.copy(zip, offset);
      replacements += 1;
      offset = zip.indexOf(safeName, offset + safeName.length);
    }
    expect(replacements).toBe(2);
    expect(() => parseProjectBackup(zip)).toThrowError(/路径穿越/);
  });

  it("损坏的短文件返回稳定的导入错误", () => {
    expect(() => parseProjectBackup(Buffer.from("not-a-zip"))).toThrowError(/中央目录/);
  });
});
