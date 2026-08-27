import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "./file-storage";
import { getWorkflowStatus, runWorkflowAction } from "./workflow-api";

const roots: string[] = [];

async function makeProject() {
  const root = await mkdtemp(resolve(tmpdir(), "workflow-api-"));
  roots.push(root);
  const projectRoot = resolve(root, "novel-test");
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
  it("never reports ready when the current chapter body is missing", async () => {
    const projectRoot = await makeProject();
    const blueprint = resolve(projectRoot, "大纲", "细纲_第001章.md");
    const taskbook = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
    await write(blueprint, "# 第001章 细纲\n");
    await write(taskbook, "# 第001章 本章写作任务书\n");
    const taskRevision = revisionOf(await readFile(taskbook));
    await write(`${taskbook}.meta.json`, JSON.stringify({
      schema_version: 1,
      chapter: 1,
      status: "ready",
      taskbook_revision: taskRevision,
      sources: []
    }));
    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.artifacts.find((item) => item.id === "body")?.status).toBe("missing");
    expect(status.state).toBe("needs_changes");
    expect(status.schemaVersion).toBe(2);
    expect(status.nextStep).toMatchObject({ id: "draft_body", mode: "codex_prompt", requiresConfirmation: true });
  });

  it("从首次启动到任务书阶段始终给出一个结构化下一步", async () => {
    const projectRoot = await makeProject();
    const initial = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(initial.nextStep).toMatchObject({ id: "create_blueprint", targetPath: "大纲/细纲_第001章.md" });
    await write(resolve(projectRoot, "大纲", "细纲_第001章.md"), "# 第001章 细纲\n");
    const afterBlueprint = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(afterBlueprint.nextStep).toMatchObject({ id: "generate_taskbook", mode: "server_action", serverAction: "generate_taskbook" });
  });

  it("为正文检查、修改、提交、patch 和下一章返回稳定的 nextStep 契约", async () => {
    const projectRoot = await makeProject();
    const blueprint = resolve(projectRoot, "大纲", "细纲_第001章.md");
    const taskbook = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
    const body = resolve(projectRoot, "正文", "第001章_正文.md");
    const review = resolve(projectRoot, "审查报告", "第001章_审查报告.md");
    const proof = resolve(projectRoot, "审查报告", "第001章_审查报告.review.json");
    const commit = resolve(projectRoot, "章节提交", "第001章_章节提交.md");
    await write(blueprint, "# 第001章 细纲\n");
    await write(taskbook, "# 第001章 本章写作任务书\n");
    const taskRevision = revisionOf(await readFile(taskbook));
    await write(`${taskbook}.meta.json`, JSON.stringify({
      schema_version: 1,
      chapter: 1,
      status: "ready",
      taskbook_revision: taskRevision,
      sources: []
    }));
    await write(body, "# 第001章 正文\n\n当前正文。\n");
    const bodyRevision = revisionOf(await readFile(body));

    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "check_body", mode: "server_action", requiresConfirmation: false });

    await write(review, `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：需要修改\n`);
    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "revise_body", mode: "codex_prompt", requiresConfirmation: true });

    await write(review, `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：通过\n`);
    await write(proof, JSON.stringify({
      schema_version: 2,
      kind: "chapter_review_proof",
      chapter: 1,
      document_path: "正文/第001章_正文.md",
      document_revision: bodyRevision,
      disk_revision: bodyRevision,
      content_revision: bodyRevision,
      run_id: "review-run-contract",
      status: "completed",
      verdict: "pass",
      blocking_findings: 0,
      verification: { required: 0, resolved: 0, unverified: 0 },
      findings_digest: "0".repeat(64),
      context_revisions: {},
      prompt_version: "chapter-audit@v1 + finding-verify@v1"
    }));
    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "create_commit", mode: "codex_prompt", requiresConfirmation: false });

    await write(commit, `# 第001章 章节提交\n- 正文 revision：${bodyRevision}\n`);
    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "create_memory_patch", mode: "codex_prompt", requiresConfirmation: false });

    const sourceRevisions = {
      "大纲/细纲_第001章.md": revisionOf(await readFile(blueprint)),
      "记忆库/current/本章写作任务书.md": taskRevision,
      "正文/第001章_正文.md": bodyRevision,
      "审查报告/第001章_审查报告.md": revisionOf(await readFile(review)),
      "审查报告/第001章_审查报告.review.json": revisionOf(await readFile(proof)),
      "章节提交/第001章_章节提交.md": revisionOf(await readFile(commit))
    };
    const patchPath = resolve(projectRoot, "章节提交", "memory_patch_第001章_chapter-001-contract.md");
    const patch = {
      schema_version: 2,
      patch_id: "chapter-001-contract",
      kind: "chapter_result",
      chapter: 1,
      chapter_revision: bodyRevision,
      source_revisions: sourceRevisions,
      summary: "完成契约测试",
      ending_state: "第一章结束",
      operations: []
    };
    await write(patchPath, `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);
    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "apply_patch", mode: "confirm_action", requiresConfirmation: true });

    const patchRevision = revisionOf(await readFile(patchPath));
    await write(resolve(projectRoot, "章节提交", "第001章_finalization.json"), JSON.stringify({
      schema_version: 1,
      chapter: 1,
      status: "finalized",
      patch_id: patch.patch_id,
      chapter_revision: bodyRevision,
      sources: Object.entries(sourceRevisions).map(([path, revision]) => ({ path, revision })),
      patch: { path: "章节提交/memory_patch_第001章_chapter-001-contract.md", revision: patchRevision }
    }));
    expect((await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).nextStep)
      .toMatchObject({ id: "prepare_next_chapter", mode: "codex_prompt", requiresConfirmation: false });
  });

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
    const review = resolve(projectRoot, "审查报告", "第001章_审查报告.md");
    const proof = resolve(projectRoot, "审查报告", "第001章_审查报告.review.json");
    const commit = resolve(projectRoot, "章节提交", "第001章_章节提交.md");
    await write(review, `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：通过\n`);
    await write(proof, `${JSON.stringify({
      schema_version: 2,
      kind: "chapter_review_proof",
      chapter: 1,
      document_path: "正文/第001章_正文.md",
      document_revision: bodyRevision,
      disk_revision: bodyRevision,
      content_revision: bodyRevision,
      run_id: "review-run-001",
      status: "completed",
      verdict: "pass",
      blocking_findings: 0,
      verification: { required: 0, resolved: 0, unverified: 0 },
      findings_digest: "0".repeat(64),
      context_revisions: {},
      prompt_version: "chapter-audit@v1 + finding-verify@v1"
    })}\n`);
    await write(commit, `# 第001章 章节提交\n- 正文 revision：${bodyRevision}\n`);
    const patch = {
      schema_version: 2,
      patch_id: "chapter-001-v1",
      kind: "chapter_result",
      chapter: 1,
      chapter_revision: bodyRevision,
      source_revisions: {
        "大纲/细纲_第001章.md": revisionOf(await readFile(blueprint)),
        "记忆库/current/本章写作任务书.md": taskRevision,
        "正文/第001章_正文.md": bodyRevision,
        "审查报告/第001章_审查报告.md": revisionOf(await readFile(review)),
        "审查报告/第001章_审查报告.review.json": revisionOf(await readFile(proof)),
        "章节提交/第001章_章节提交.md": revisionOf(await readFile(commit))
      },
      summary: "完成",
      ending_state: "结束",
      operations: []
    };
    await write(resolve(projectRoot, "章节提交", "memory_patch_第001章_chapter-001-v1.md"), `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);
    const nonCanonicalPatch = resolve(projectRoot, "章节提交", "memory_patch_第001章_candidate.md");
    await write(nonCanonicalPatch, `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);
    const blockedByNonCanonical = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(blockedByNonCanonical.artifacts.find((item) => item.id === "memoryPatch")?.status).toBe("blocked");
    await unlink(nonCanonicalPatch);

    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.state).toBe("ready");
    expect(status.recommendedAction).toBe("apply_patch");
    expect(status.nextStep).toMatchObject({ id: "apply_patch", mode: "confirm_action", requiresConfirmation: true });
    expect(status.artifacts).toHaveLength(6);
    expect(status.reviewContext.some((item) => item.role === "当前草稿" && item.revision === bodyRevision)).toBe(true);
    await expect(runWorkflowAction({
      action: "apply_patch",
      projectRoot,
      projectId: "novel-test",
      libraryRoot: resolve(projectRoot, ".."),
      workspaceRoot: resolve(projectRoot, ".."),
      chapter: 1,
      confirmed: true,
      patchPath: "章节提交/memory_patch_第002章_wrong.md"
    })).rejects.toMatchObject({ statusCode: 409, code: "WORKFLOW_PATCH_MISMATCH" });

    const proofPayload = JSON.parse(await readFile(proof, "utf8"));
    proofPayload.context_revisions = { "大纲/细纲_第001章.md": "1".repeat(64) };
    await write(proof, JSON.stringify(proofPayload));
    patch.source_revisions["审查报告/第001章_审查报告.review.json"] = revisionOf(await readFile(proof));
    await write(resolve(projectRoot, "章节提交", "memory_patch_第001章_chapter-001-v1.md"), `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\`\n`);
    const contextMismatch = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(contextMismatch.artifacts.find((item) => item.id === "review")?.status).toBe("needs_changes");
    expect(contextMismatch.artifacts.find((item) => item.id === "memoryPatch")?.status).toBe("blocked");
  });

  it("blocks empty blueprint and taskbook artifacts", async () => {
    const projectRoot = await makeProject();
    const blueprint = resolve(projectRoot, "大纲", "细纲_第001章.md");
    const taskbook = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
    await write(blueprint, "  \n");
    await write(taskbook, "\t\n");
    await write(`${taskbook}.meta.json`, JSON.stringify({
      schema_version: 1,
      chapter: 1,
      status: "ready",
      taskbook_revision: revisionOf(await readFile(taskbook)),
      sources: []
    }));

    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.state).toBe("blocked");
    expect(status.artifacts.find((item) => item.id === "blueprint")?.status).toBe("blocked");
    expect(status.artifacts.find((item) => item.id === "taskbook")?.status).toBe("blocked");
    expect(status.nextStep.id).toBe("repair_taskbook");
  });

  it("rejects a workflow artifact larger than the per-file read budget", async () => {
    const projectRoot = await makeProject();
    await write(resolve(projectRoot, "大纲", "细纲_第001章.md"), "纲".repeat(2 * 1024 * 1024 + 1));
    await expect(getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).rejects.toMatchObject({
      statusCode: 413,
      code: "WORKFLOW_BYTE_LIMIT"
    });
  });

  it("rejects a projectId that does not match the project directory", async () => {
    const projectRoot = await makeProject();
    await expect(getWorkflowStatus({ projectRoot, projectId: "novel-other", chapter: 1 })).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_PROJECT_MISMATCH"
    });
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
    expect(status.nextStep).toMatchObject({ id: "resolve_patch_classification", mode: "open_panel", requiresConfirmation: true });
    await write(resolve(projectRoot, "章节提交", "patch_classifications.json"), JSON.stringify({
      schema_version: 1,
      classifications: { "chapter-000-migration": "migration" }
    }));

    await expect(runWorkflowAction({
      action: "classify_patch",
      projectRoot,
      projectId: "novel-test",
      libraryRoot: resolve(projectRoot, ".."),
      workspaceRoot: resolve(projectRoot, ".."),
      chapter: 1,
      confirmed: true,
      classifications: { "chapter-001-v1": "chapter_result" }
    })).rejects.toMatchObject({ statusCode: 400 });

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

  it("fails closed for incomplete review proofs and invalid schema v2 patches", async () => {
    const projectRoot = await makeProject();
    const body = resolve(projectRoot, "正文", "第001章_正文.md");
    await write(resolve(projectRoot, "大纲", "细纲_第001章.md"), "# 第001章 细纲\n");
    await write(body, "# 第001章 正文\n");
    const bodyRevision = revisionOf(await readFile(body));
    await write(resolve(projectRoot, "审查报告", "第001章_审查报告.md"), `# 报告\n- 正文 revision：${bodyRevision}\n- 结果：通过\n`);
    await write(resolve(projectRoot, "审查报告", "第001章_审查报告.review.json"), JSON.stringify({
      schema_version: 2,
      kind: "chapter_review_proof",
      chapter: 1,
      document_revision: bodyRevision,
      disk_revision: bodyRevision,
      content_revision: bodyRevision,
      run_id: "review-run-001",
      status: "completed",
      verdict: "pass",
      blocking_findings: 0,
      verification: { unverified: 0 },
      findings_digest: "0".repeat(64),
      prompt_version: "chapter-audit@v1"
    }));
    await write(resolve(projectRoot, "章节提交", "memory_patch_第001章_invalid.md"), `\`\`\`json\n${JSON.stringify({
      schema_version: 2,
      patch_id: "invalid",
      kind: "chapter_result",
      chapter: 1,
      chapter_revision: bodyRevision,
      source_revisions: {},
      summary: "",
      ending_state: "",
      operations: []
    })}\n\`\`\`\n`);

    const status = await getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 });
    expect(status.artifacts.find((item) => item.id === "review")?.status).toBe("needs_changes");
    expect(status.artifacts.find((item) => item.id === "memoryPatch")?.status).toBe("blocked");
    expect(status.nextStep.id).toBe("resolve_blocker");
  });

  it("rejects corrupt workflow JSON instead of treating it as missing", async () => {
    const projectRoot = await makeProject();
    await write(resolve(projectRoot, "大纲", "细纲_第001章.md"), "# 第001章 细纲\n");
    const taskbook = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
    await write(taskbook, "# 第001章 本章写作任务书\n");
    await write(`${taskbook}.meta.json`, "{not-json");

    await expect(getWorkflowStatus({ projectRoot, projectId: "novel-test", chapter: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: "WORKFLOW_JSON_INVALID"
    });
  });
});
