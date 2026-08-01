import { describe, expect, it } from "vitest";
import type { ReviewAnnotation, ReviewFinding } from "../types";
import { buildLineSelection, computeChapterReviewVerdict, findActiveAnnotationAtLine, reconcileAnnotationsAfterReplacement, reconcileFindingsAfterReplacement } from "./review";

function annotation(id: string, fromLine: number, toLine: number): ReviewAnnotation {
  return {
    id,
    fromLine,
    toLine,
    comment: "测试",
    originalText: "原文",
    engine: "deepseek",
    status: "ready",
    anchorHash: "anchor",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z"
  };
}

function finding(id: string, fromLine: number, toLine: number, severity: ReviewFinding["severity"] = "S2"): ReviewFinding {
  return {
    id,
    source: "ai",
    severity,
    category: "language",
    title: "测试问题",
    fromLine,
    toLine,
    before: "原文",
    after: "新文",
    evidence: "证据",
    impact: "影响",
    fixSuggestion: "修法",
    verification: "not_needed",
    lookupTerms: [],
    sourceRefs: [],
    status: "open"
  };
}

describe("行号选择与批注状态", () => {
  it("普通点击选择单行，Shift 点击选择连续范围", () => {
    expect(buildLineSelection(undefined, 8, false)).toEqual({ fromLine: 8, toLine: 8 });
    expect(buildLineSelection(8, 12, true)).toEqual({ fromLine: 8, toLine: 12 });
    expect(buildLineSelection(12, 8, true)).toEqual({ fromLine: 8, toLine: 12 });
  });

  it("同一行复用未结束的对话，已采用或已忽略后允许新建批注", () => {
    const ready = annotation("ready", 5, 5);
    expect(findActiveAnnotationAtLine([ready], 5)?.id).toBe("ready");
    expect(findActiveAnnotationAtLine([{ ...ready, status: "accepted" }], 5)).toBeUndefined();
    expect(findActiveAnnotationAtLine([{ ...ready, status: "ignored" }], 5)).toBeUndefined();
  });

  it("采用多行建议后移动后方锚点，并把重叠批注标为过期", () => {
    const result = reconcileAnnotationsAfterReplacement(
      [annotation("accepted", 5, 5), annotation("overlap", 5, 6), annotation("after", 10, 10)],
      "accepted",
      5,
      5,
      2
    );
    expect(result[0].status).toBe("accepted");
    expect(result[1].status).toBe("stale");
    expect(result[2].fromLine).toBe(11);
  });

  it("采用整章建议后调整其余 finding 行号，并将重叠项标为过期", () => {
    const result = reconcileFindingsAfterReplacement(
      [finding("accepted", 5, 5), finding("overlap", 5, 6), finding("after", 10, 10)],
      "accepted",
      5,
      5,
      2
    );
    expect(result[0].status).toBe("accepted");
    expect(result[1].status).toBe("stale");
    expect(result[2].fromLine).toBe(11);
  });

  it("只有未解决的 S1/S2 阻止通过", () => {
    expect(computeChapterReviewVerdict([finding("blocking", 1, 1, "S2")])).toBe("needs_changes");
    expect(computeChapterReviewVerdict([{ ...finding("dismissed", 1, 1, "S1"), status: "dismissed", dismissalReason: "误报" }, finding("advice", 2, 2, "S3")])).toBe("pass");
  });
});
