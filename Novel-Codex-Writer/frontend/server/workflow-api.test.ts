import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "./file-storage";
import { getWorkflowStatus, runWorkflowAction } from "./workflow-api";

const roots: string[] = [];

async function makeProject() {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "workflow-api-"));
  roots.push(projectRoot);
  for (const directory of ["大纲", "正文", "审查报告", "章节提交", "记忆库/current"]) {
    await mkdir(resolve(projectRoot, directory), { recursive: true });
  }
  return projectRoot;
}

async function write(path: string, content: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow status", () => {
  it("returns one actionable next step from revision-bound artifacts", async () => {
    const projectRoot = await makeProject();
    const blueprint = resolve(projectRoot, "大纲", "细纲_第001章.md");
    const taskbook = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
    const body = resolve(projectRoot, "正文", "第001章_正文.md");
    await write(blueprint, "# 第001章 细纲\n");
    await write(taskbook, "# 第001章 本章写作任务书\n");
    await write(body, "# 第001章 正文\n\n当前正文。\n");
    const taskRevision = revisionOf(await readFile(taskbook));
    await write(`${taskbook}.meta.json`, `${JSON.stringify({
      schema_version: 1,
      chapter: 1,
      status: "ready",
      taskbook_revision: taskRevision,
      sources: []
    })}\n`);
    const bodyRevision = revisionOf(await readFile(body));
    await write(resolve(projectRoot, "审查报告", "第001章_审查报告.md"), `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：通过\n`);
    await write(resolve(projectRoot, "章节提交", "第001章_章节提交.md"), `# 第001章 章节提交\n- 正文 revision：${bodyRevision}\n`);
    const patch = {
      schema_version: 2,
      patch_id: "chapter-001-v1",
      kind: "chapter_result",
      chapter: 1,
      chapter_revision: bodyRevision,
      source_revisions: {},
      summary: "完成",
      ending_state: "结束",
      operations: []
    };
    await write(resolve(projectRoot, "章节提交", "memory_patch_第001章_chapter-001-v1.md"), `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);

    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.state).toBe("ready");
    expect(status.recommendedAction).toBe("apply_patch");
    expect(status.artifacts).toHaveLength(6);
    expect(status.reviewContext.some((item) => item.role === "当前草稿" && item.revision === bodyRevision)).toBe(true);
  });

  it("blocks ambiguous legacy patches until the author classifies them", async () => {
    const projectRoot = await makeProject();
    await write(resolve(projectRoot, "大纲", "细纲_第001章.md"), "# 第001章 细纲\n");
    for (const patchId of ["chapter-001-v1", "outline-rewrite-001-v1"]) {
      const patch = { schema_version: 1, patch_id: patchId, chapter: 1, summary: patchId, ending_state: patchId, operations: [] };
      await write(resolve(projectRoot, "章节提交", `memory_patch_第001章_${patchId}.md`), `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);
    }
    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.state).toBe("blocked");
    expect(status.legacyPatchChoices).toEqual(["chapter-001-v1", "outline-rewrite-001-v1"]);
    expect(status.recommendedAction).toBe("classify_patch");
    await write(resolve(projectRoot, "章节提交", "patch_classifications.json"), JSON.stringify({
      schema_version: 1,
      classifications: { "chapter-000-migration": "migration" }
    }));

    const classified = await runWorkflowAction({
      action: "classify_patch",
      projectRoot,
      projectId: "novel-test",
      libraryRoot: resolve(projectRoot, ".."),
      workspaceRoot: resolve(projectRoot, ".."),
      chapter: 1,
      confirmed: true,
      classifications: {
        "chapter-001-v1": "chapter_result",
        "outline-rewrite-001-v1": "outline_baseline"
      }
    });
    expect(classified.status.state).not.toBe("blocked");
    const compatibility = await readFile(resolve(projectRoot, "章节提交", "compat", "patch_classifications.json"), "utf8");
    expect(compatibility).toContain("chapter_result");
    expect(compatibility).toContain("chapter-000-migration");
  });
});
