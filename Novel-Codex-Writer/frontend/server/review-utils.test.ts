import { describe, expect, it } from "vitest";
import {
  createLineAnchor,
  createRevision,
  getLineText,
  parseReviewReply,
  parseSuggestion,
  replaceLineRange,
  readEnvValue,
  setEnvValue,
  safeSessionName
} from "./review-utils";

describe("服务端审校安全工具", () => {
  it("文档版本和行号锚点会随原文变化", () => {
    expect(createRevision("旧稿")).not.toBe(createRevision("新稿"));
    expect(createLineAnchor("甲\n乙", 2, 2)).not.toBe(createLineAnchor("甲\n丙", 2, 2));
  });

  it("批注文件名不包含用户路径，避免路径越界", () => {
    const name = safeSessionName("../../其他小说/秘密.md");
    expect(name).toMatch(/^[a-f0-9]{24}\.json$/);
    expect(name).not.toContain("..");
    expect(safeSessionName("正文\\第001章.md")).toBe(safeSessionName("正文/第001章.md"));
  });

  it("只接受严格的结构化建议", () => {
    expect(parseSuggestion({ decision: "change", severity: "S4", category: "language", before: "旧", after: "新", rationale: "更清楚" }, "旧")).toEqual({
      decision: "change",
      severity: "S4",
      category: "language",
      before: "旧",
      after: "新",
      rationale: "更清楚"
    });
    expect(parseSuggestion({ before: "旧", after: "新" })).toBeNull();
    expect(parseSuggestion({ decision: "change", severity: "S4", category: "language", before: "错位", after: "新", rationale: "更清楚" }, "旧")).toBeNull();
    expect(parseSuggestion({ decision: "change", severity: "S4", category: "language", before: "旧", after: "旧", rationale: "无需修改" }, "旧")).toBeNull();
    expect(parseSuggestion({ decision: "keep", severity: "S4", category: "language", before: "旧", after: "旧", rationale: "原文合适" }, "旧")?.decision).toBe("keep");
  });

  it("允许 AI 直接回答开放问题，不强制生成替换文本", () => {
    expect(parseReviewReply({ reply: "可以考虑《丰壤法典》《四时农书》或《沃土秘典》。", suggestion: null }, "旧")).toEqual({
      reply: "可以考虑《丰壤法典》《四时农书》或《沃土秘典》。",
      suggestion: undefined
    });
  });

  it("保留有效替换建议，并严格拒绝建议结构损坏的回答", () => {
    const validSuggestion = { decision: "change", severity: "S4", category: "language", before: "旧", after: "新", rationale: "更清楚" };
    expect(parseReviewReply({ reply: "我把句子压缩了一些。", suggestion: validSuggestion }, "旧")?.suggestion).toEqual(validSuggestion);
    expect(parseReviewReply({ reply: "这里有三个名字可选。", suggestion: { ...validSuggestion, before: "错位" } }, "旧")).toBeNull();
  });

  it("拒绝已淘汰的顶层 suggestion 旧协议", () => {
    expect(parseReviewReply({ decision: "keep", severity: "S4", category: "language", before: "旧", after: "旧", rationale: "原文合适" }, "旧")).toBeNull();
  });

  it("拒绝把过期行号静默夹到正文末尾", () => {
    expect(() => createLineAnchor("第一行\n第二行", 3, 3)).toThrow(RangeError);
    expect(() => getLineText("第一行\n第二行", 3, 3)).toThrow(RangeError);
    expect(() => replaceLineRange("第一行\n第二行", 2, 3, "替换")).toThrow(RangeError);
  });

  it("更新本机密钥时保留其他环境配置且不会重复写入", () => {
    const original = "# 本机配置\nAI_MOCK_MODE=false\nDEEPSEEK_API_KEY=old\n";
    const updated = setEnvValue(original, "DEEPSEEK_API_KEY", "new-secret");
    expect(updated).toContain("AI_MOCK_MODE=false");
    expect(updated.match(/DEEPSEEK_API_KEY=/g)).toHaveLength(1);
    expect(readEnvValue(updated, "DEEPSEEK_API_KEY")).toBe("new-secret");
  });

  it("拒绝把换行写入本机环境配置", () => {
    expect(() => setEnvValue("", "DEEPSEEK_API_KEY", "safe\nINJECTED=true")).toThrow("不能包含换行");
  });
});
