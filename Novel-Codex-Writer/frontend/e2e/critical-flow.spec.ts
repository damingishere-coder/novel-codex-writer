import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { exportProjectZip, revisionOf } from "../server/file-storage";

interface ProjectFixture {
  id: string;
  name: string;
  path: string;
  content: string;
  revision: string;
}

async function createProjectWithChapter(request: APIRequestContext, suffix: string): Promise<ProjectFixture> {
  const name = `E2E 隔离小说 ${suffix}`;
  const projectResponse = await request.post("/api/projects", { data: { name } });
  expect(projectResponse.status()).toBe(201);
  const projectPayload = await projectResponse.json();
  const id = projectPayload.project.id as string;
  const path = `正文/第1章-${suffix}.md`;
  const content = `# 第1章 ${suffix}\n\n这是一段只存在于临时 E2E 小说库的测试正文。`;
  const documentResponse = await request.put(
    `/api/document?projectId=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`,
    { data: { content, expectedRevision: "" } }
  );
  expect(documentResponse.ok()).toBeTruthy();
  const document = await documentResponse.json();
  return { id, name, path, content, revision: document.revision as string };
}

async function writeProjectFile(request: APIRequestContext, projectId: string, path: string, content: string, expectedRevision = "") {
  const response = await request.put(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    { data: { content, expectedRevision } }
  );
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ revision: string }>;
}

async function workflowStatus(request: APIRequestContext, projectId: string) {
  const response = await request.get(`/api/workflow/status?projectId=${encodeURIComponent(projectId)}&chapter=1`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function importWorkflowFixture(request: APIRequestContext, suffix: string, files: Record<string, string>) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "novel-e2e-workflow-"));
  try {
    const projectRoot = resolve(temporaryRoot, `fixture-${suffix}`);
    await mkdir(projectRoot, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      const target = resolve(projectRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const now = new Date().toISOString();
    const exported = await exportProjectZip(projectRoot, {
      id: `source-${revisionOf(suffix).slice(0, 12)}`,
      name: `E2E 状态 ${suffix}`,
      createdAt: now,
      updatedAt: now
    });
    const backup = await readFile(resolve(projectRoot, exported.path));
    const previewResponse = await request.post("/api/projects/import/preview", {
      data: backup,
      headers: { "content-type": "application/zip" }
    });
    const previewText = await previewResponse.text();
    expect(previewResponse.ok(), previewText).toBeTruthy();
    const preview = JSON.parse(previewText);
    const confirmResponse = await request.post("/api/projects/import/confirm", {
      data: { token: preview.token, name: `E2E 状态 ${suffix}` }
    });
    const confirmText = await confirmResponse.text();
    expect(confirmResponse.status(), confirmText).toBe(201);
    return JSON.parse(confirmText).project.id as string;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("首次启动无作品时仍能进入创建入口", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("未选择作品").first()).toBeVisible();
  await page.getByRole("button", { name: "创建或导入小说" }).click();
  await expect(page.getByPlaceholder("输入新小说名称")).toBeVisible();
  await expect(page.getByText("从 ZIP 安全导入")).toBeVisible();
});

test("新建作品和正文后工作台会打开当前文档", async ({ page, request }) => {
  const fixture = await createProjectWithChapter(request, "界面");

  await page.goto("/");
  await expect(page.getByText(fixture.name).first()).toBeVisible();
  await expect(page.getByText("第1章-界面.md").first()).toBeVisible();
  await expect(page.getByText("这是一段只存在于临时 E2E 小说库的测试正文。")).toBeVisible();
});

test("首次创作状态只显示一个结构化主操作", async ({ page, request }) => {
  const projectResponse = await request.post("/api/projects", { data: { name: "E2E 首次创作" } });
  expect(projectResponse.status()).toBe(201);
  const project = (await projectResponse.json()).project;

  const statusResponse = await request.get(`/api/workflow/status?projectId=${encodeURIComponent(project.id)}&chapter=1`);
  expect(statusResponse.ok()).toBeTruthy();
  await expect(statusResponse.json()).resolves.toMatchObject({
    schemaVersion: 2,
    nextStep: { id: "create_blueprint", mode: "codex_prompt", requiresConfirmation: false }
  });

  await page.goto("/");
  await expect(page.getByLabel("下一章写作驾驶舱")).toBeVisible();
  await expect(page.locator(".workflow-primary-action")).toHaveCount(1);
  await expect(page.locator(".workflow-primary-action")).toHaveText("复制任务给 Codex");
  await expect(page.locator(".workflow-primary-action")).toHaveAttribute("title", "创建第001章细纲");
});

test("关键章节状态通过真实 HTTP 边界保持唯一下一步", async ({ request }) => {
  const blueprintPath = "大纲/细纲_第001章.md";
  const taskbookPath = "记忆库/current/本章写作任务书.md";
  const taskbookMetaPath = `${taskbookPath}.meta.json`;
  const bodyPath = "正文/第001章_正文.md";
  const reviewPath = "审查报告/第001章_审查报告.md";
  const proofPath = "审查报告/第001章_审查报告.review.json";
  const commitPath = "章节提交/第001章_章节提交.md";
  const blueprint = "# 第001章 已确认细纲\n";
  const taskbook = "# 第001章 本章写作任务书\n";
  const body = "# 第001章 正文\n\n这是一段隔离测试正文。\n";
  const bodyRevision = revisionOf(body);
  const taskbookMeta = JSON.stringify({
    schema_version: 1,
    chapter: 1,
    status: "ready",
    taskbook_revision: revisionOf(taskbook),
    sources: [{ path: blueprintPath, revision: revisionOf(blueprint) }]
  });
  const review = `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：通过\n`;
  const proof = JSON.stringify({
    schema_version: 2,
    kind: "chapter_review_proof",
    chapter: 1,
    document_path: bodyPath,
    document_revision: bodyRevision,
    disk_revision: bodyRevision,
    content_revision: bodyRevision,
    run_id: "e2e-review-proof",
    status: "completed",
    verdict: "pass",
    blocking_findings: 0,
    verification: { required: 0, resolved: 0, unverified: 0 },
    findings_digest: "0".repeat(64),
    context_revisions: {},
    prompt_version: "chapter-audit@v1 + finding-verify@v1"
  });
  const commit = `# 第001章 章节提交\n- 正文 revision：${bodyRevision}\n`;
  const sourceRevisions = {
    [blueprintPath]: revisionOf(blueprint),
    [taskbookPath]: revisionOf(taskbook),
    [bodyPath]: bodyRevision,
    [reviewPath]: revisionOf(review),
    [proofPath]: revisionOf(proof),
    [commitPath]: revisionOf(commit)
  };
  const patchId = "chapter-001-e2e";
  const patchPath = `章节提交/memory_patch_第001章_${patchId}.md`;
  const patch = `\`\`\`json\n${JSON.stringify({
    schema_version: 2,
    patch_id: patchId,
    kind: "chapter_result",
    chapter: 1,
    chapter_revision: bodyRevision,
    source_revisions: sourceRevisions,
    summary: "隔离 E2E 章节已完成",
    ending_state: "第一章结束",
    operations: []
  })}\n\`\`\`\n`;
  const manifest = JSON.stringify({
    schema_version: 1,
    chapter: 1,
    status: "finalized",
    patch_id: patchId,
    chapter_revision: bodyRevision,
    sources: Object.entries(sourceRevisions).map(([path, revision]) => ({ path, revision })),
    patch: { path: patchPath, revision: revisionOf(patch) }
  });
  const base = { [blueprintPath]: blueprint, [taskbookPath]: taskbook };

  const staleTaskbookProject = await importWorkflowFixture(request, "任务书过期", {
    ...base,
    [taskbookMetaPath]: JSON.stringify({ ...JSON.parse(taskbookMeta), sources: [{ path: blueprintPath, revision: "1".repeat(64) }] })
  });
  await expect(workflowStatus(request, staleTaskbookProject)).resolves.toMatchObject({ nextStep: { id: "generate_taskbook" } });

  const bodyPendingProject = await importWorkflowFixture(request, "正文待审", { ...base, [taskbookMetaPath]: taskbookMeta, [bodyPath]: body });
  await expect(workflowStatus(request, bodyPendingProject)).resolves.toMatchObject({ nextStep: { id: "check_body" } });

  const reviewChangesProject = await importWorkflowFixture(request, "审查需改", {
    ...base,
    [taskbookMetaPath]: taskbookMeta,
    [bodyPath]: body,
    [reviewPath]: `# 第001章 审查报告\n- 正文 revision：${bodyRevision}\n- 结果：需要修改\n`
  });
  await expect(workflowStatus(request, reviewChangesProject)).resolves.toMatchObject({ nextStep: { id: "revise_body" } });

  const readyFiles = { ...base, [taskbookMetaPath]: taskbookMeta, [bodyPath]: body, [reviewPath]: review, [proofPath]: proof, [commitPath]: commit, [patchPath]: patch };
  const patchPendingProject = await importWorkflowFixture(request, "patch待确认", readyFiles);
  await expect(workflowStatus(request, patchPendingProject)).resolves.toMatchObject({ nextStep: { id: "apply_patch" } });

  const finalizedProject = await importWorkflowFixture(request, "章节最终化", { ...readyFiles, "章节提交/第001章_finalization.json": manifest });
  await expect(workflowStatus(request, finalizedProject)).resolves.toMatchObject({ state: "finalized", nextStep: { id: "prepare_next_chapter" } });
});

test("未保存正文不能越过 revision 门禁调用 AI", async ({ request }) => {
  const fixture = await createProjectWithChapter(request, "门禁");
  const response = await request.post("/api/ai/review-chapter", {
    data: {
      projectId: fixture.id,
      documentPath: fixture.path,
      content: `${fixture.content}\n\n未保存变更`,
      expectedRevision: fixture.revision,
      requestId: crypto.randomUUID(),
      engine: "deepseek"
    }
  });

  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: "DOCUMENT_REVISION_CONFLICT" });
});

test("编辑并保存后磁盘正文与界面同步", async ({ page, request }) => {
  const fixture = await createProjectWithChapter(request, "保存");
  const updated = "# 第1章 保存\n\n这是通过工作台编辑并明确保存的隔离测试正文。";

  await page.goto("/");
  await page.getByRole("button", { name: "关闭右栏" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill(updated);
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("正文已保存，批注锚点已同步")).toBeVisible();

  const response = await request.get(
    `/api/document?projectId=${encodeURIComponent(fixture.id)}&path=${encodeURIComponent(fixture.path)}`
  );
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({ content: updated });
});
