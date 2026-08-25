import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjects, parseAiStreamEvent, parseChapterReviewStreamEvent, streamAiSuggestion } from "./api";

afterEach(() => vi.unstubAllGlobals());

const completeRun = {
  id: "run-1",
  documentRevision: "revision-1",
  engine: "codex",
  status: "completed",
  verdict: "pass",
  summary: "通过",
  findings: [],
  contextManifest: [],
  promptVersion: "v1",
  createdAt: "2026-08-26T00:00:00.000Z"
};

describe("stream event validation", () => {
  it("validates successful JSON response schemas before exposing them to the UI", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        libraryRoot: "C:/novels",
        activeProjectId: null,
        projects: []
      }), { status: 200 })));

    await expect(fetchProjects()).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE_SCHEMA"
    });
    await expect(fetchProjects()).resolves.toEqual({
      libraryRoot: "C:/novels",
      activeProjectId: null,
      projects: []
    });
  });

  it("accepts complete AI events and rejects unknown or partial events", () => {
    expect(parseAiStreamEvent({ type: "progress", annotationId: "a1", message: "处理中" })).toEqual({
      type: "progress",
      annotationId: "a1",
      message: "处理中"
    });
    expect(() => parseAiStreamEvent({ type: "result", annotationId: "a1" })).toThrow("无效事件");
    expect(() => parseAiStreamEvent({ type: "started", annotationId: "a1", engine: "gpt" })).toThrow("无效事件");
    expect(() => parseAiStreamEvent({
      type: "result",
      annotationId: "a1",
      engine: "codex",
      reply: "ok",
      anchorHash: "hash",
      suggestion: { decision: "change" }
    })).toThrow("无效事件");
    expect(() => parseAiStreamEvent({ type: "future_event" })).toThrow("无效事件");
  });

  it("requires a run for non-error chapter review events", () => {
    expect(() => parseChapterReviewStreamEvent({ type: "result", message: "完成" })).toThrow("无效事件");
    expect(() => parseChapterReviewStreamEvent({ type: "error", message: "失败" })).toThrow("无效事件");
    expect(parseChapterReviewStreamEvent({ type: "error", code: "PROVIDER_ERROR", message: "失败" })).toEqual({
      type: "error",
      code: "PROVIDER_ERROR",
      message: "失败"
    });
    expect(parseChapterReviewStreamEvent({ type: "result", message: "完成", run: completeRun })).toEqual({
      type: "result",
      message: "完成",
      run: completeRun
    });
    expect(() => parseChapterReviewStreamEvent({
      type: "result",
      message: "完成",
      run: { ...completeRun, engine: "gpt" }
    })).toThrow("无效事件");
    expect(() => parseChapterReviewStreamEvent({
      type: "result",
      message: "完成",
      run: { ...completeRun, status: "error", verdict: "pass" }
    })).toThrow("无效事件");
    expect(() => parseChapterReviewStreamEvent({
      type: "result",
      message: "完成",
      run: {
        ...completeRun,
        verdict: "needs_changes",
        findings: [{
          id: "f1",
          source: "local",
          severity: "S2",
          category: "continuity",
          title: "区间错误",
          fromLine: 5,
          toLine: 3,
          evidence: "证据",
          impact: "影响",
          fixSuggestion: "建议",
          verification: "not_needed",
          lookupTerms: [],
          sourceRefs: [],
          status: "open"
        }]
      }
    })).toThrow("无效事件");
  });

  it("preserves stable server error codes for JSON and streaming requests", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "REVISION_CONFLICT", error: "版本冲突" }), {
        status: 409,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "PROVIDER_ERROR", error: "模型失败" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      })));

    await expect(fetchProjects()).rejects.toMatchObject({
      status: 409,
      code: "REVISION_CONFLICT",
      message: "版本冲突"
    });
    await expect(streamAiSuggestion({
      projectId: "project-1",
      documentPath: "正文/第1章.md",
      content: "正文",
      fromLine: 1,
      toLine: 1,
      comment: "检查",
      engine: "codex",
      annotationId: "a1",
      history: [],
      expectedRevision: "revision-1",
      requestId: "request-1"
    }, () => undefined)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_ERROR",
      message: "模型失败"
    });
  });
});
