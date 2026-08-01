import { describe, expect, it } from "vitest";
import {
  countReadableWords,
  createTextAnchor,
  getLineText,
  replaceLineRange,
  stripWebnovelMemoryMetadata
} from "./format";

describe("小说正文工具", () => {
  it("按中文字符和英文单词统计可读字数，并忽略 Markdown 标题", () => {
    expect(countReadableWords("# 标题\n你好 world-test 123")).toBe(4);
  });

  it("读取并替换连续行", () => {
    const source = "第一行\n第二行\n第三行";
    expect(getLineText(source, 2, 3)).toBe("第二行\n第三行");
    expect(replaceLineRange(source, 2, 2, "新的第二行\n补充行")).toBe("第一行\n新的第二行\n补充行\n第三行");
  });

  it("同一行文本生成稳定锚点，文本变化后锚点变化", () => {
    const source = "甲\n乙\n丙";
    expect(createTextAnchor(source, 2, 2)).toBe(createTextAnchor(source, 2, 2));
    expect(createTextAnchor(source, 2, 2)).not.toBe(createTextAnchor("甲\n已修改\n丙", 2, 2));
  });

  it("预览时隐藏 webnovel-memory 机器元数据但保留可读内容", () => {
    const source = "<!-- webnovel-memory: {\"id\":\"memory-1\"} -->\n- 林序仍在五金店。";
    expect(stripWebnovelMemoryMetadata(source)).toBe("- 林序仍在五金店。");
  });
});
