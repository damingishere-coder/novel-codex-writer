import { expect as baseExpect, test, type APIRequestContext, type Page } from "@playwright/test";

test.setTimeout(60_000);
// Filesystem-backed startup can take longer on Windows under concurrent checks.
const expect = baseExpect.configure({ timeout: 15_000 });

const chapterPath = "正文/第1章-风起之时.md";
const story = "# 第1章 风起之时\n\n" + [
  "天刚亮，南城的旧书铺就开了门。林遥推开木窗，街角第一声车铃穿过薄雾，落在摊开的书页上。",
  "那封信是在昨夜送来的。信封上没有署名，只有一枚褪色的蓝色邮戳，以及一行她再熟悉不过的字。",
  "她将信纸压在台灯下面，没有急着拆开。窗外的梧桐轻轻摇晃，像是在提醒她，有些答案终究需要亲自去找。",
  "门口响起脚步声。来人收起雨伞，抬头看了看门楣，又把目光落在她手边的信封上。",
  "“你也收到了？”他问。",
  "林遥没有回答。她翻过信封，终于看见背面那一道细小的划痕。十年前，她曾在另一封信上见过它。",
  "时钟走到七点。她取下门后的外套，把信放进内袋，然后把那本尚未读完的书留在了窗边。"
].join("\n\n");

async function fixture(request: APIRequestContext, name = "雾中的来信 · UI 验收作品") {
  const response = await request.post("/api/projects", { data: { name } });
  expect(response.status()).toBe(201);
  const id = (await response.json()).project.id as string;
  for (const [path, content] of [[chapterPath, story], ["大纲/故事总纲.md", "# 故事总纲\n\n寻找一封旧信的来处。"], ["章节提交/第1章.md", "# 测试提交记录"]]) {
    const saved = await request.put(`/api/document?projectId=${id}&path=${encodeURIComponent(path)}`, { data: { content, expectedRevision: "" } });
    expect(saved.ok()).toBeTruthy();
  }
  return { id, name };
}

async function appearance(page: Page, name: "浅色" | "深色" | "跟随系统") {
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toContainText("天刚亮", { timeout: 15_000 });
}

test("主题继承系统、手动覆盖、刷新保持，切换不重建编辑器或清空撤销", async ({ page, request }) => {
  await fixture(request);
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page);
  await expect(page.locator("html")).toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass("dark");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await editor.evaluate((element) => element.setAttribute("data-retained-editor", "yes"));
  await editor.fill("主题切换时保留的未保存草稿");
  await appearance(page, "深色");
  await expect(editor).toHaveAttribute("data-retained-editor", "yes");
  await expect(editor).toContainText("主题切换时保留的未保存草稿");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass("dark");
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toContainText("天刚亮");
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
  await appearance(page, "跟随系统");
  await expect(page.locator("html")).not.toHaveClass("dark");
});

test("旧主题兼容与存储被禁用时仍能编辑和切换主题", async ({ page, request }) => {
  await fixture(request);
  await page.addInitScript(() => {
    localStorage.setItem("novel-theme", "light");
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page);
  await expect(page.locator("html")).not.toHaveClass("dark");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass("dark");
  await appearance(page, "浅色");
  await expect(page.locator("html")).not.toHaveClass("dark");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("textbox", { name: "小说正文编辑器" }).fill("存储禁用时仍可编辑");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
});

test("按作品恢复最近文档，文档缺失时列出章节，搜索与高级资料可达", async ({ page, request }) => {
  const first = await fixture(request, "最近使用 A");
  await ready(page);
  await page.getByRole("button", { name: "故事总纲 故事总纲.md" }).click();
  await expect(page.locator(".document-title")).toContainText("故事总纲.md");
  await page.reload();
  await expect(page.locator(".document-title")).toContainText("故事总纲.md");
  const second = await fixture(request, "最近使用 B");
  await page.reload();
  await expect(page.locator(".document-title")).toContainText("第1章-风起之时.md");
  await page.getByRole("button", { name: second.name, exact: true }).click();
  await page.getByRole("menuitemradio", { name: first.name, exact: true }).click();
  await expect(page.locator(".document-title")).toContainText("故事总纲.md");
  await page.getByRole("button", { name: "历史与高级资料" }).click();
  await expect(page.getByRole("button", { name: /章节提交/ })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索当前小说资料" }).fill("梧桐");
  await expect(page.locator(".search-results")).toContainText("风起之时");
  await page.getByRole("textbox", { name: "搜索当前小说资料" }).fill("");
  await page.evaluate((id) => localStorage.setItem(`novel-recent-document:${id}`, "正文/已删除.md"), first.id);
  await page.reload();
  await expect(page.getByText("选择一个章节，继续创作")).toBeVisible();
  await expect(page.locator(".empty-chapter-list")).toContainText("风起之时");
});

test("专注模式保留草稿，菜单与弹窗可通过键盘关闭并返回焦点", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await fixture(request);
  await ready(page);
  await page.getByRole("button", { name: "专注模式", exact: true }).click();
  await expect(page.locator(".library-sidebar")).toBeHidden();
  await expect(page.locator(".right-workbench")).toHaveCount(0);
  const rect = await page.locator(".document-workspace").boundingBox();
  expect(rect!.width).toBe(1440);
  await page.keyboard.press("Escape");
  await expect(page.locator(".library-sidebar")).toBeVisible();
  await expect(page.locator(".right-workbench")).toBeVisible();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "深色", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "外观", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "历史与回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("当前文档历史");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "文档操作", exact: true })).toBeFocused();
});

test("批注定位与采纳、历史恢复和回收站通过新入口完成", async ({ page, request }) => {
  const project = await fixture(request);
  const initial = await request.get(`/api/document?projectId=${project.id}&path=${encodeURIComponent(chapterPath)}`);
  const initialDoc = await initial.json();
  const mockContent = "# 第1章 风起之时\n\n她非常认真地说道，今天一定会找到答案。";
  await request.put(`/api/document?projectId=${project.id}&path=${encodeURIComponent(chapterPath)}`, { data: { content: mockContent, expectedRevision: initialDoc.revision } });
  await page.goto("/");
  await page.getByRole("button", { name: "第 3 行：创建或选择批注", exact: true }).click();
  await expect(page.locator(".right-tabs").getByRole("button", { name: "审校", exact: true })).toHaveAttribute("aria-pressed", "true");
  const annotation = page.locator(".annotation-card").first();
  await annotation.locator("textarea").fill("请润色这句话，不改变事实。");
  await annotation.getByRole("button", { name: "调用 AI", exact: true }).click();
  await expect(annotation.getByRole("button", { name: "采用这版", exact: true })).toBeVisible();
  await annotation.getByRole("button", { name: "采用这版", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toContainText("格外认真地说");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "历史与回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "请先保存当前草稿" })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".document-stats")).toHaveText("已保存");
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "历史与回收站", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const version = dialog.locator(".workflow-card").filter({ hasText: "当前文档历史" }).locator(".recovery-row").first();
  await expect(version).toBeVisible();
  await version.getByRole("button", { name: "差异", exact: true }).click();
  await expect(dialog.locator(".diff-preview")).toBeVisible();
  page.once("dialog", (confirmation) => confirmation.accept());
  await version.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "历史版本已恢复" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toContainText("非常认真地说道");
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "移到回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "历史与回收站", exact: true }).click();
  const trash = page.getByRole("dialog").locator(".workflow-card").filter({ has: page.getByText("回收站", { exact: true }) });
  await trash.getByRole("button", { name: "恢复", exact: true }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "已恢复：" })).toBeVisible();
  const restored = await request.get(`/api/document?projectId=${project.id}&path=${encodeURIComponent(chapterPath)}`);
  expect((await restored.json()).content).toBe(mockContent);
});

test("未保存切换可取消，手机搜索可用，抽屉关闭与放大后正文恢复操作", async ({ page, request }) => {
  await fixture(request);
  await ready(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await editor.fill("必须保留的未保存内容");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "故事总纲 故事总纲.md" }).click();
  await expect(editor).toContainText("必须保留的未保存内容");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索当前小说资料" })).toBeFocused();
  await page.getByRole("textbox", { name: "搜索当前小说资料" }).fill("梧桐");
  await expect(page.locator(".search-results")).toContainText("风起之时");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await expect(page.locator(".document-workspace")).toHaveJSProperty("inert", false);
  await page.getByRole("button", { name: "打开资料库", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".document-workspace")).toHaveJSProperty("inert", false);
  await expect(editor).toContainText("必须保留的未保存内容");
});

test("未保存时新建、导入及删除均不会发送业务写入", async ({ page, request }) => {
  const project = await fixture(request);
  await ready(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await editor.fill("这些内容还没有保存，必须保留。");
  const writes: string[] = [];
  page.on("request", (event) => {
    if (["POST", "DELETE"].includes(event.method()) && /api\/(projects|document)/.test(event.url()) && !event.url().endsWith("/preview")) writes.push(event.url());
  });
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "文档操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建文档", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: project.name, exact: true }).click();
  await page.getByRole("menuitem", { name: "管理作品 · 新建与导入", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("输入新小说名称").fill("不应创建的作品");
  await dialog.getByRole("button", { name: "新建小说", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请先保存当前草稿");
  await dialog.locator(".project-row.active").getByRole("button", { name: "移到回收站", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移动", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("删除当前作品");
  await page.route("**/api/projects/import/preview", (route) => route.fulfill({ json: { schemaVersion: 1, token: "test-preview", projectName: "导入测试", sourceProjectId: "test-source", fileCount: 1, totalBytes: 10, warnings: [] } }));
  await dialog.locator('input[type="file"]').setInputFiles({ name: "preview.zip", mimeType: "application/zip", buffer: Buffer.from("UI fixture") });
  await dialog.getByRole("button", { name: "确认并创建新项目", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("导入作品");
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("这些内容还没有保存，必须保留。");
  expect(writes).toEqual([]);
});

test("保存响应延迟期间切走再回到同一文档，不会套用旧响应版本", async ({ page, request }) => {
  const project = await fixture(request);
  await ready(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let firstSave = true;
  await page.route("**/api/document?**", async (route) => {
    if (route.request().method() === "PUT" && firstSave) { firstSave = false; await waiting; }
    await route.continue();
  });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await editor.fill("第一次保存的内容");
  const pendingRequest = page.waitForRequest((event) => event.method() === "PUT" && event.url().includes("/api/document?"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await pendingRequest;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "故事总纲 故事总纲.md" }).click();
  await expect(page.locator(".markdown-preview")).toContainText("寻找一封旧信");
  await page.getByRole("button", { name: "第1章 风起之时 第1章-风起之时.md", exact: true }).click();
  await expect(editor).toContainText("天刚亮");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.fill("返回之后新输入的内容");
  const finished = page.waitForResponse((event) => event.request().method() === "PUT" && event.url().includes("/api/document?"));
  release();
  await finished;
  const conflict = page.waitForResponse((event) => event.request().method() === "PUT" && event.url().includes("/api/document?"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(editor).toContainText("返回之后新输入的内容");
  const saved = await request.get(`/api/document?projectId=${project.id}&path=${encodeURIComponent(chapterPath)}`);
  expect((await saved.json()).content).toBe("第一次保存的内容");
});

test("加载与失败状态仍有可恢复入口", async ({ page, request }, testInfo) => {
  await fixture(request);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/library?**", async (route) => { await waiting; await route.continue(); });
  await page.goto("/");
  await expect(page.getByText("正在读取文档…", { exact: true })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("loading-light.png") });
  release();
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toBeVisible();
  await page.route("**/api/workflow/status?**", (route) => route.fulfill({ status: 503, json: { error: "测试：工作流暂时不可用" } }));
  await page.reload();
  await expect(page.locator(".creation-scroll").getByRole("button", { name: "重新诊断", exact: true })).toBeVisible();
  await appearance(page, "深色");
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("workflow-error-dark.png") });
  await page.unroute("**/api/workflow/status?**");
  await page.locator(".creation-scroll").getByRole("button", { name: "重新诊断", exact: true }).click();
  await expect(page.locator(".workflow-primary-action")).toBeVisible();
});

for (const width of [1440, 1280, 1024, 390]) {
  test(`${width}px 日夜布局、长标题、面板和弹窗截图`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await fixture(request, "雾中的来信 · 一个用于验证长标题不会挤压操作入口的作品名称");
    await ready(page);
    for (const [theme, label] of [["light", "浅色"], ["dark", "深色"]] as const) {
      await appearance(page, label);
      await expect(page.locator(".document-workspace")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const area = await page.locator(".document-workspace").boundingBox();
      expect(area!.x + area!.width).toBeLessThanOrEqual(width);
      if (width >= 1024) expect(area!.width).toBeGreaterThanOrEqual(480);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`workspace-${width}-${theme}.png`) });
    }
    if (width < 1200) {
      await page.getByRole("button", { name: "打开资料库", exact: true }).click();
      await expect(page.locator(".library-sidebar")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".library-sidebar")).toBeHidden();
    }
    if (width < 1024) {
      await page.getByRole("button", { name: "创作助手", exact: true }).click();
      await expect(page.locator(".right-workbench")).toBeVisible();
      await expect(page.locator(".library-sidebar")).toBeHidden();
    }
    await page.locator(".right-tabs").getByRole("button", { name: "审校", exact: true }).click();
    await expect(page.locator(".review-panel")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`review-${width}-dark.png`) });
    if (width < 1024) await page.locator(".right-tabs").getByRole("button", { name: "关闭右栏" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("menuitem", { name: "启动预检", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(dialog!.x).toBeGreaterThanOrEqual(0);
    expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`dialog-${width}-dark.png`) });
  });
}
