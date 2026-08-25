import { describe, expect, it } from "vitest";
import type { ReviewAnnotation } from "../types";
import { processableAnnotationCount } from "./ReviewPanel";

function annotation(status: ReviewAnnotation["status"], comment = "测试"): ReviewAnnotation {
  return {
    id: status,
    fromLine: 1,
    toLine: 1,
    comment,
    originalText: "原文",
    engine: "codex",
    status,
    anchorHash: "anchor",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z"
  };
}

describe("processableAnnotationCount", () => {
  it("只统计批处理实际会处理的状态", () => {
    expect(processableAnnotationCount([
      annotation("draft"),
      annotation("pending"),
      annotation("error"),
      annotation("stale"),
      annotation("ready"),
      annotation("accepted"),
      annotation("ignored"),
      annotation("running"),
      annotation("draft", ""),
      annotation("stale", "")
    ])).toBe(4);
  });

  it("允许错误批注用已有用户消息重试", () => {
    const retry = {
      ...annotation("error", ""),
      messages: [{
        id: "user-1",
        role: "user" as const,
        content: "请重试",
        createdAt: "2026-08-26T00:00:00.000Z"
      }]
    };
    expect(processableAnnotationCount([retry])).toBe(1);
  });
});
