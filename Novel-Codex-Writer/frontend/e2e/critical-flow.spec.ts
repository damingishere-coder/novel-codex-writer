import { expect, test, type APIRequestContext } from "@playwright/test";

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

test("新建作品和正文后工作台会打开当前文档", async ({ page, request }) => {
  const fixture = await createProjectWithChapter(request, "界面");

  await page.goto("/");
  await expect(page.getByText(fixture.name).first()).toBeVisible();
  await expect(page.getByText("第1章-界面.md").first()).toBeVisible();
  await expect(page.getByText("这是一段只存在于临时 E2E 小说库的测试正文。")).toBeVisible();
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
