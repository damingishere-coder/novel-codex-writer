import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeReviewSession, parseReviewSessionBody, persistIssuedReviewRun, persistReviewSessionVersioned } from "./review-session-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review session storage boundary", () => {
  it("maps malformed session JSON to the stable invalid-session code", () => {
    expect(() => parseReviewSessionBody("{\"broken\":")).toThrowError(expect.objectContaining({
      statusCode: 409,
      code: "REVIEW_SESSION_INVALID"
    }));
  });

  it("normalizes a Windows case-only legacy document path to the canonical session path", () => {
    const canonicalPath = "正文/第001章.md";
    const storedPath = process.platform === "win32" ? "正文/第001章.MD" : canonicalPath;
    expect(normalizeReviewSession({ documentPath: storedPath }, "novel-test", canonicalPath, false).documentPath).toBe(canonicalPath);
  });

  it("rejects damaged stored annotations instead of returning them to the client", () => {
    for (const annotations of [
      [null],
      [{ id: "a1" }],
      [{
        id: "a1",
        fromLine: 2,
        toLine: 1,
        comment: "",
        originalText: "正文",
        engine: "codex",
        status: "ready",
        anchorHash: "hash",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z"
      }]
    ]) {
      expect(() => normalizeReviewSession({ annotations }, "novel-test", "正文.md", false)).toThrowError(expect.objectContaining({
        statusCode: 409,
        code: "REVIEW_SESSION_INVALID"
      }));
    }
  });

  it("rejects an external session path before creating its parent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-session-boundary-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const outsideParent = resolve(root, "outside", "nested");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(resolve(projectRoot, "正文.md"), "正文", "utf8");

    await expect(persistReviewSessionVersioned({
      projectRoot,
      sessionFile: resolve(outsideParent, "session.json"),
      projectId: "novel-test",
      documentPath: "正文.md",
      body: {
        expectedRevision: "",
        baseRevision: "body-revision",
        annotations: [],
        chapterReviewRuns: []
      },
      loadDocumentRevision: async () => "body-revision"
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(existsSync(outsideParent)).toBe(false);
  });

  it("fails closed instead of silently dropping a damaged stored review run", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-session-corrupt-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const sessionFile = resolve(projectRoot, ".review-sessions", "正文.json");
    await mkdir(resolve(projectRoot, ".review-sessions"), { recursive: true });
    await writeFile(resolve(projectRoot, "正文.md"), "正文", "utf8");
    await writeFile(sessionFile, JSON.stringify({
      projectId: "novel-test",
      documentPath: "正文.md",
      baseRevision: "body-revision",
      annotations: [],
      chapterReviewRuns: [{ id: "damaged", engine: "unknown", findings: [] }],
      updatedAt: "2026-08-26T00:00:00.000Z"
    }), "utf8");

    await expect(persistReviewSessionVersioned({
      projectRoot,
      sessionFile,
      projectId: "novel-test",
      documentPath: "正文.md",
      body: { expectedRevision: "", baseRevision: "body-revision", annotations: [], chapterReviewRuns: [] },
      loadDocumentRevision: async () => "body-revision"
    })).rejects.toMatchObject({ statusCode: 409, code: "REVIEW_SESSION_INVALID" });
  });

  it("rejects a structurally valid run that has no server-issued proof", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-session-untrusted-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const sessionFile = resolve(projectRoot, ".review-sessions", "正文.json");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(resolve(projectRoot, "正文.md"), "正文", "utf8");

    await expect(persistReviewSessionVersioned({
      projectRoot,
      sessionFile,
      projectId: "novel-test",
      documentPath: "正文.md",
      body: {
        expectedRevision: "",
        baseRevision: "body-revision",
        annotations: [],
        chapterReviewRuns: [{
          id: "00000000-0000-4000-8000-000000000000",
          documentRevision: "body-revision",
          engine: "deepseek",
          status: "completed",
          findings: [],
          contextManifest: [],
          summary: "伪造记录",
          promptVersion: "chapter-audit@v1",
          createdAt: "2026-08-26T00:00:00.000Z"
        }]
      },
      loadDocumentRevision: async () => "body-revision"
    })).rejects.toMatchObject({ statusCode: 409, code: "REVIEW_RUN_UNTRUSTED" });
  });

  it("rejects a server-issued completed run after the document revision changes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-session-stale-run-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const sessionFile = resolve(projectRoot, ".review-sessions", "正文.json");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(resolve(projectRoot, "正文.md"), "新正文", "utf8");
    const run = {
      id: "00000000-0000-4000-8000-000000000001",
      documentRevision: "old-revision",
      engine: "deepseek" as const,
      status: "completed" as const,
      verdict: "pass" as const,
      summary: "旧审阅",
      findings: [],
      contextManifest: [],
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-08-26T00:00:00.000Z",
      completedAt: "2026-08-26T00:00:01.000Z"
    };
    await persistIssuedReviewRun(projectRoot, "正文.md", run);

    await expect(persistReviewSessionVersioned({
      projectRoot,
      sessionFile,
      projectId: "novel-test",
      documentPath: "正文.md",
      body: {
        expectedRevision: "",
        baseRevision: "new-revision",
        annotations: [],
        chapterReviewRuns: [run]
      },
      loadDocumentRevision: async () => "new-revision"
    })).rejects.toMatchObject({ statusCode: 409, code: "REVIEW_RUN_STALE" });

    await expect(persistReviewSessionVersioned({
      projectRoot,
      sessionFile,
      projectId: "novel-test",
      documentPath: "正文.md",
      body: {
        expectedRevision: "",
        baseRevision: "new-revision",
        annotations: [],
        chapterReviewRuns: [{ ...run, status: "stale", verdict: "stale" }]
      },
      loadDocumentRevision: async () => "new-revision"
    })).resolves.toMatchObject({
      chapterReviewRuns: [{ id: run.id, status: "stale", verdict: "stale" }]
    });
  });
});
