import { expect, test, type APIRequestContext } from "@playwright/test";

async function fixture(request: APIRequestContext, name = "搜索验收") {
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).project.id;
  for (const [path, content] of [["正文/第1章-旧信.md", "# 第1章 旧信\n\n窗边的梧桐树下，林遥找到了旧信。"], ["大纲/故事总纲.md", "# 故事总纲\n\n梧桐与旧信是关键线索。"]]) {
    expect((await request.put(`/api/document?projectId=${id}&path=${encodeURIComponent(path)}`, { data: { content, expectedRevision: "" } })).ok()).toBeTruthy();
  }
  return id;
}

test("下拉结果展示数量与命中片段，键盘打开、关闭及未保存取消均可用", async ({ page, request }, testInfo) => {
  await fixture(request);
  await page.addInitScript(() => localStorage.setItem("novel-left-collapsed", "true"));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toBeVisible();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "搜索当前小说资料" });
  await expect(search).toBeFocused();
  await search.fill("梧桐");
  await expect(page.locator(".search-summary")).toHaveText("找到 2 份文档");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.locator(".search-snippet mark").first()).toHaveText("梧桐");
  await expect(page.getByRole("complementary", { name: "已收起的资料侧栏" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-results-light.png"), animations: "disabled" });
  await search.press("ArrowDown");
  const chosen = await page.getByRole("option", { selected: true }).locator("strong").innerText();
  await search.press("Enter");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toContainText(chosen);
  await search.fill("完全不存在的词");
  await expect(page.locator(".search-summary")).toHaveText("没有找到匹配内容");
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("search-empty.png"), animations: "disabled" });
  await search.press("Escape");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "清空搜索" }).click();
  await expect(search).toHaveValue("");
  await page.locator(".app-brand").click();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "小说正文编辑器" });
  await editor.fill("未保存的草稿");
  await search.fill("梧桐");
  await expect(page.getByRole("option")).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option").filter({ hasNotText: chosen }).click();
  await expect(editor).toContainText("未保存的草稿");
});

test("快速改词清除旧结果，失败可重试，手机搜索不打开资料抽屉", async ({ page, request }, testInfo) => {
  await fixture(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  const search = page.getByRole("combobox", { name: "搜索当前小说资料" });
  await expect(search).toBeFocused();
  await search.fill("梧桐");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.route("**/api/search?**", (route) => route.fulfill({ status: 500, json: { error: "测试网络失败" } }));
  await search.fill("旧信");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(page.locator(".search-summary")).toHaveText("搜索失败");
  await page.screenshot({ path: testInfo.outputPath("search-failure-mobile.png"), animations: "disabled" });
  await page.unroute("**/api/search?**");
  await page.getByRole("button", { name: "重试搜索" }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  const area = await page.locator(".search-dropdown").boundingBox();
  expect(area!.x).toBeGreaterThanOrEqual(0);
  expect(area!.x + area!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".document-workspace")).toHaveJSProperty("inert", false);
  await page.screenshot({ path: testInfo.outputPath("search-results-mobile-dark.png"), animations: "disabled" });
  await search.focus();
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "搜索资料", exact: true })).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
});

test("旧查询的延迟响应不会覆盖新词或其他作品的结果", async ({ page, request }) => {
  const firstProject = await fixture(request, "作品甲");
  await fixture(request, "作品乙");
  await page.goto("/");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let received!: () => void;
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/search?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "梧桐") { const response = await route.fetch(); received(); await held; await route.fulfill({ response }).catch(() => {}); }
    else await route.continue();
  });
  const search = page.getByRole("combobox", { name: "搜索当前小说资料" });
  await search.fill("梧桐"); await started;
  await expect(page.locator(".search-summary")).toHaveText("正在搜索…");
  await search.fill("不存在的词");
  await expect(page.locator(".search-summary")).toHaveText("没有找到匹配内容");
  release();
  await page.getByRole("button", { name: "作品乙", exact: true }).click();
  const switchedSearch = page.waitForResponse((response) => response.url().includes("/api/search?") && new URL(response.url()).searchParams.get("projectId") === firstProject);
  await page.getByRole("menuitemradio", { name: "作品甲", exact: true }).click();
  expect((await switchedSearch).ok()).toBeTruthy();
  await expect(page.getByRole("button", { name: "作品甲", exact: true })).toBeVisible();
  await expect(search).toHaveValue("不存在的词");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await search.focus();
  await expect(page.locator(".search-summary")).toHaveText("没有找到匹配内容");
});
