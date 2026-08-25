import { describe, expect, it } from "vitest";
import type { ReviewSession } from "../types";
import { mergeSavedSessionRevision, persistencePayload, reviewSessionContentFingerprint } from "./useReviewPersistence";

function session(): ReviewSession {
  return {
    schemaVersion: 4,
    projectId: "novel-a",
    documentPath: "正文/第001章.md",
    baseRevision: "base-1",
    sessionRevision: "session-1",
    status: "active",
    annotations: [],
    chapterReviewRuns: [],
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("mergeSavedSessionRevision", () => {
  it("preserves newer local fields while merging the server revision", () => {
    const latest: ReviewSession = {
      ...session(),
      status: "completed",
      annotations: [{
        id: "newer",
        fromLine: 1,
        toLine: 1,
        comment: "新批注",
        originalText: "原文",
        engine: "deepseek",
        status: "ready",
        anchorHash: "anchor",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }]
    };
    const merged = mergeSavedSessionRevision(latest, {
      projectId: latest.projectId,
      documentPath: latest.documentPath,
      sessionRevision: "session-2",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    expect(merged?.annotations).toEqual(latest.annotations);
    expect(merged?.sessionRevision).toBe("session-2");
  });

  it("does not apply a response to a different document", () => {
    const latest = session();
    expect(mergeSavedSessionRevision(latest, {
      projectId: latest.projectId,
      documentPath: "正文/第002章.md",
      sessionRevision: "wrong",
      updatedAt: latest.updatedAt
    })).toBe(latest);
  });

  it("does not persist an unsigned in-flight review run", () => {
    const current = session();
    current.chapterReviewRuns = [{
      id: "running",
      documentRevision: "base-1",
      engine: "deepseek",
      status: "running",
      verdict: "pass",
      summary: "正在检查",
      findings: [],
      contextManifest: [],
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-01-01T00:00:00.000Z"
    }];
    expect(persistencePayload(current).chapterReviewRuns).toEqual([]);
    expect(current.chapterReviewRuns).toHaveLength(1);
  });

  it("distinguishes local review edits from a server revision-only merge", () => {
    const original = session();
    const revisionOnly = { ...original, sessionRevision: "session-2", updatedAt: "2026-01-02T00:00:00.000Z" };
    const locallyEdited = {
      ...revisionOnly,
      annotations: [{
        id: "newer",
        fromLine: 1,
        toLine: 1,
        comment: "保存期间新增的批注",
        originalText: "原文",
        engine: "deepseek" as const,
        status: "draft" as const,
        anchorHash: "anchor",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }]
    };

    expect(reviewSessionContentFingerprint(revisionOnly)).toBe(reviewSessionContentFingerprint(original));
    expect(reviewSessionContentFingerprint(locallyEdited)).not.toBe(reviewSessionContentFingerprint(original));
  });
});
