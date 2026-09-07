import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { safeSessionName } from "../server/review-utils.ts";

test("旧版无来源版本的审阅可以打开、自动保存和刷新，保留历史而不恢复已核实结论", async ({ page, request }) => {
  const created = await request.post("/api/projects", { data: { name: "旧版审阅兼容验收" } });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).project.id as string;
  const documentPath = "正文/第1章-旧信.md";
  const query = `projectId=${projectId}&path=${encodeURIComponent(documentPath)}`;
  const documentResponse = await request.put(`/api/document?${query}`, {
    data: { content: "# 第1章 旧信\n\n清晨，她在书桌上找到一封旧信。", expectedRevision: "" }
  });
  expect(documentResponse.ok()).toBeTruthy();
  const documentRevision = (await documentResponse.json()).revision as string;
  const sessionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".e2e-library", "作品", projectId, "审查报告", ".sessions");
  await mkdir(sessionRoot, { recursive: true });
  const sessionFile = resolve(sessionRoot, safeSessionName(documentPath));
  const original = JSON.stringify({
    schemaVersion: 3, projectId, documentPath, baseRevision: "legacy-revision", annotations: [],
    chapterReviewRuns: [{
      id: "00000000-0000-4000-8000-000000000021", documentRevision: "legacy-revision",
      engine: "deepseek", status: "stale", verdict: "stale", summary: "旧版审阅建议", promptVersion: "chapter-audit@v1",
      createdAt: "2026-07-20T00:00:00.000Z", findings: [{
        id: "legacy-finding", source: "ai", severity: "S2", category: "continuity", title: "旧线索需要核对",
        evidence: "旧版来源摘要", verification: "confirmed", status: "open",
        sourceRefs: [{ path: "档案库/事实.md", snippet: "记录中的线索" }]
      }]
    }]
  });
  await writeFile(sessionFile, original, "utf8");
  const sessionResponse = await request.get(`/api/review-session?${query}`);
  expect(sessionResponse.ok()).toBeTruthy();
  expect(await readFile(sessionFile, "utf8")).toBe(original);
  expect((await sessionResponse.json()).chapterReviewRuns[0].findings[0].verification).toBe("unverified");

  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/review-session") && response.status() >= 400) failures.push(String(response.status()));
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = page.waitForResponse((response) => response.url().includes("/api/review-session") && response.request().method() === "PUT");
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "小说正文编辑器" })).toContainText("清晨", { timeout: 15_000 });
    expect((await saved).ok()).toBeTruthy();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const persisted = JSON.parse(await readFile(sessionFile, "utf8"));
    expect(persisted.baseRevision).toBe(documentRevision);
    expect(persisted.chapterReviewRuns).toHaveLength(1);
    expect(persisted.chapterReviewRuns[0].findings).toHaveLength(1);
    expect(persisted.chapterReviewRuns[0].findings[0]).toMatchObject({ id: "legacy-finding", verification: "unverified", status: "open" });
  }
  expect(failures).toEqual([]);
});
