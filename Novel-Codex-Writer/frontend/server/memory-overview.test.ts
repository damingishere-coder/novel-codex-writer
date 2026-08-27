import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "./file-storage";
import { getMemoryOverview } from "./memory-overview";

const roots: string[] = [];

async function projectRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "memory-overview-"));
  roots.push(root);
  await mkdir(resolve(root, "记忆库", "index"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function index(source: string, hash: string) {
  return {
    schema_version: 2,
    generated_at: "2026-08-27T00:00:00Z",
    source_hashes: { [source]: hash },
    records: [{
      id: "character:lin",
      category: "人物",
      status: "active",
      importance: "high",
      valid_from: 1,
      valid_to: null,
      entities: ["林舟"],
      tags: ["主角"],
      source_chapter: 1,
      updated_by_patch: "chapter-001-v1",
      title: "林舟当前状态",
      file: source,
      line: 3,
      archived: false
    }],
    chapter_summaries: [{ chapter: 1, patch_id: "chapter-001-v1", kind: "chapter_result", summary: "完成第一章", ending_state: "离开车站" }]
  };
}

describe("memory overview", () => {
  it("只读返回分类记录、来源与当前诊断", async () => {
    const root = await projectRoot();
    const source = "记忆库/current/当前人物状态.md";
    const content = Buffer.from("# 当前人物\n\n林舟在车站。\n");
    await mkdir(resolve(root, "记忆库", "current"), { recursive: true });
    await writeFile(resolve(root, source), content);
    await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), JSON.stringify(index(source, revisionOf(content))));

    const result = await getMemoryOverview(root, "novel-test");
    expect(result.indexStatus).toBe("ready");
    expect(result.records[0]).toMatchObject({ category: "人物", source, line: 3, updatedByPatch: "chapter-001-v1" });
    expect(result.chapterSummaries[0]?.chapter).toBe(1);
  });

  it("来源变化、损坏索引与文件预算均失败闭合", async () => {
    const root = await projectRoot();
    const source = "记忆库/current/事实.md";
    await mkdir(resolve(root, "记忆库", "current"), { recursive: true });
    await writeFile(resolve(root, source), "已变化");
    await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), JSON.stringify(index(source, "0".repeat(64))));
    expect((await getMemoryOverview(root, "novel-test")).indexStatus).toBe("stale");

    const oversizedSources = Object.fromEntries(Array.from({ length: 5_001 }, (_, i) => [`记忆库/current/${i}.md`, "0".repeat(64)]));
    await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), JSON.stringify({ ...index(source, "0".repeat(64)), source_hashes: oversizedSources }));
    expect((await getMemoryOverview(root, "novel-test")).indexStatus).toBe("invalid");

    await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), "{bad-json");
    expect((await getMemoryOverview(root, "novel-test")).indexStatus).toBe("invalid");
  });

  it("不会沿符号链接读取项目外来源", async () => {
    const root = await projectRoot();
    const outside = resolve(root, "..", `outside-${Date.now()}.md`);
    roots.push(outside);
    await writeFile(outside, "私人正文");
    await mkdir(resolve(root, "记忆库", "current"), { recursive: true });
    const source = "记忆库/current/link.md";
    try {
      await symlink(outside, resolve(root, source), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await writeFile(resolve(root, "记忆库", "index", "memory_index.json"), JSON.stringify(index(source, revisionOf(Buffer.from("私人正文")))));
    expect((await getMemoryOverview(root, "novel-test")).indexStatus).toBe("stale");
  });
});
