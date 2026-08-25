import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRevision } from "./review-utils";
import { validateAiContentRevision, validateAiSelectionSize, withAiRequest } from "./novel-library-plugin";
import { redactErrorMessage } from "./http-error";
import { isDerivedFromIssuedRun, persistReviewSessionVersioned } from "./review-session-service";
import type { ChapterReviewRun } from "./chapter-review";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AI provider safety boundary", () => {
  it("rejects a selected passage that exceeds the prompt budget", () => {
    expect(() => validateAiSelectionSize("x".repeat(50_001))).toThrowError(expect.objectContaining({
      statusCode: 413,
      code: "AI_SELECTION_TOO_LARGE"
    }));
  });

  it("binds submitted content to the exact saved disk revision", () => {
    const content = "# 第001章\n\n已保存正文。\n";
    const revision = createRevision(content);
    expect(validateAiContentRevision(content, content, revision)).toBe(revision);
    expect(() => validateAiContentRevision(content, `${content}未保存`, revision)).toThrowError(/revision 不一致/);
    expect(() => validateAiContentRevision(content, content, "0".repeat(64))).toThrowError(/revision 不一致/);
  });

  it("rejects a duplicate in-flight request id before a second provider task starts", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withAiRequest(requestId, async () => gate);
    let secondStarted = false;
    await expect(withAiRequest(requestId, async () => { secondStarted = true; })).rejects.toMatchObject({
      statusCode: 409,
      code: "AI_REQUEST_IN_FLIGHT"
    });
    expect(secondStarted).toBe(false);
    release();
    await first;
  });

  it("redacts bearer, API key, token and credential query values", () => {
    const fakeSecret = "sk-test_1234567890abcdef";
    const message = `Authorization: Bearer ${fakeSecret} DEEPSEEK_API_KEY=${fakeSecret} url=https://example.test/?token=${fakeSecret}`;
    const redacted = redactErrorMessage(message);
    expect(redacted).not.toContain(fakeSecret);
    expect(redacted).toContain("<已脱敏>");
  });

  it("does not accept a client-forged completed/pass run as server-issued evidence", () => {
    const issued: ChapterReviewRun = {
      id: "22222222-2222-4222-8222-222222222222",
      documentRevision: "a".repeat(64),
      engine: "deepseek",
      status: "completed",
      verdict: "needs_changes",
      summary: "发现阻塞项",
      findings: [{
        id: "finding-1",
        source: "ai",
        severity: "S2",
        category: "continuity",
        title: "事实冲突",
        evidence: "证据",
        impact: "影响",
        fixSuggestion: "修复",
        verification: "confirmed",
        lookupTerms: [],
        sourceRefs: [],
        status: "open"
      }],
      contextManifest: [],
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T00:01:00.000Z"
    };
    const forged = { ...issued, verdict: "pass" as const, findings: [] };
    expect(isDerivedFromIssuedRun(forged, issued)).toBe(false);
    expect(isDerivedFromIssuedRun({ ...issued, summary: "客户端伪造摘要" }, issued)).toBe(false);
    expect(isDerivedFromIssuedRun({
      ...issued,
      contextManifest: [{ path: "项目外/伪造.md", role: "伪造", characters: 1, truncated: false, missing: false }]
    }, issued)).toBe(false);
    expect(isDerivedFromIssuedRun({ ...issued, findings: [issued.findings[0], issued.findings[0]] }, {
      ...issued,
      findings: [issued.findings[0], { ...issued.findings[0], id: "finding-2" }]
    })).toBe(false);
  });

  it("allows only one concurrent review-session save for one expected revision", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "review-session-race-"));
    temporaryRoots.push(projectRoot);
    const sessionFile = resolve(projectRoot, "审查报告", ".sessions", "chapter.json");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    const baseRevision = "a".repeat(64);
    const body = {
      projectId: "novel-test",
      documentPath: "正文/第001章.md",
      baseRevision,
      expectedRevision: "",
      annotations: [],
      chapterReviewRuns: []
    };
    const save = () => persistReviewSessionVersioned({
      projectRoot,
      sessionFile,
      projectId: "novel-test",
      documentPath: "正文/第001章.md",
      body,
      loadDocumentRevision: async () => baseRevision
    });

    const outcomes = await Promise.allSettled([save(), save()]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason).toMatchObject({ statusCode: 409 });
  });
});
