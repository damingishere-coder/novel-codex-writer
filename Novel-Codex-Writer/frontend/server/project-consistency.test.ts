import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkProjectConsistency } from "./project-consistency";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject() {
  const root = await mkdtemp(resolve(tmpdir(), "project-consistency-"));
  roots.push(root);
  for (const directory of ["大纲", "写作规范", "正文", "章节提交", "审查报告", "记忆库/current", "记忆库/index", "记忆库/snapshots", "档案库"]) {
    await mkdir(resolve(root, directory), { recursive: true });
  }
  await writeFile(resolve(root, "project.json"), JSON.stringify({ id: "novel-test", name: "测试作品" }));
  await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), JSON.stringify({ schema_version: 2, source_hashes: {}, records: [], chapter_summaries: [] }));
  return root;
}

describe("project consistency", () => {
  it("健康项目只读检查通过", async () => {
    const root = await makeProject();
    const report = await checkProjectConsistency(root, "novel-test");
    expect(report).toMatchObject({ status: "ready", issues: [] });
  });

  it("报告重复正式章节与 metadata 不匹配，不执行修复", async () => {
    const root = await makeProject();
    await writeFile(resolve(root, "project.json"), JSON.stringify({ id: "other", name: "测试作品" }));
    await writeFile(resolve(root, "正文", "第001章_A.md"), "A");
    await writeFile(resolve(root, "正文", "第001章_B.md"), "B");
    const report = await checkProjectConsistency(root, "novel-test");
    expect(report.status).toBe("error");
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["PROJECT_METADATA_INVALID", "CHAPTER_DUPLICATE"]));
  });
});
