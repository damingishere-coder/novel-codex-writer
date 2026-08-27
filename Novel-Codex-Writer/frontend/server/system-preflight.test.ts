import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSystemPreflight } from "./system-preflight";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("system preflight", () => {
  it("只返回隐私安全的本机检查结果", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "preflight-"));
    roots.push(libraryRoot);
    const result = await getSystemPreflight({
      libraryRoot,
      port: 5174,
      loadProjectIndex: async () => ({ activeProjectId: null, projects: [] }),
      getProjectRoot: () => libraryRoot
    });
    expect(result.runtime).toMatchObject({ mode: "native", host: "127.0.0.1", port: 5174 });
    expect(result.checks.find((item) => item.id === "library")?.state).toBe("pass");
    expect(result.checks.find((item) => item.id === "npm")?.state).toBe("pass");
    expect(JSON.stringify(result)).not.toContain(libraryRoot);
  });

  it("报告未完成事务但不自动修复", async () => {
    const libraryRoot = await mkdtemp(resolve(tmpdir(), "preflight-transactions-"));
    roots.push(libraryRoot);
    const project = { id: "novel-test", name: "测试", root: "作品/novel-test", createdAt: "2026-08-27", updatedAt: "2026-08-27" };
    const projectRoot = resolve(libraryRoot, project.root);
    await mkdir(resolve(projectRoot, "记忆库", ".transactions", "pending-1"), { recursive: true });
    const result = await getSystemPreflight({
      libraryRoot,
      port: 5173,
      loadProjectIndex: async () => ({ activeProjectId: project.id, projects: [project] }),
      getProjectRoot: () => projectRoot
    });
    expect(result.runtime.mode).toBe("docker");
    expect(result.checks.find((item) => item.id === "transactions")).toMatchObject({ state: "warning", blocking: false });
  });
});
