import { describe, expect, it } from "vitest";
import { matchSearchTerms, parseSearchTerms, stripWebnovelMemoryMetadata } from "./search-utils";

const document = {
  title: "当前伏笔状态",
  path: "记忆库/current/当前伏笔状态.md",
  content: `# 当前伏笔状态
<!-- webnovel-memory: {"id":"legacy-hidden","tags":["雷囊"]} -->
林序发现手机可能引发危险。`
};

describe("当前小说资料检索", () => {
  it("支持单个汉字关键词", () => {
    expect(matchSearchTerms(parseSearchTerms("林"), document)?.snippet).toContain("林序");
  });

  it("支持空格分隔的多个关键词，并忽略重复词", () => {
    expect(parseSearchTerms(" 林序   手机 林序 ")).toEqual(["林序", "手机"]);
    expect(matchSearchTerms(parseSearchTerms("林序 手机"), document)).not.toBeNull();
    expect(matchSearchTerms(parseSearchTerms("林序 不存在"), document)).toBeNull();
  });

  it("普通阅读和检索都会忽略机器元数据", () => {
    expect(stripWebnovelMemoryMetadata(document.content)).not.toContain("webnovel-memory");
    expect(matchSearchTerms(parseSearchTerms("legacy-hidden"), document)).toBeNull();
  });

  it("标题命中的排序分数高于只命中正文", () => {
    const titleMatch = matchSearchTerms(parseSearchTerms("伏笔"), document);
    const contentOnly = matchSearchTerms(parseSearchTerms("危险"), document);
    expect(titleMatch?.score).toBeGreaterThan(contentOnly?.score ?? 0);
  });

  it("限制查询词数量并支持复用预解析词", () => {
    const terms = parseSearchTerms(Array.from({ length: 30 }, (_, index) => `词${index}`).join(" "));
    expect(terms).toHaveLength(16);
    expect(matchSearchTerms(["林序", "手机"], document)).not.toBeNull();
    expect(matchSearchTerms(["", "   "], document)).toBeNull();
    expect(matchSearchTerms(Array.from({ length: 30 }, (_, index) => `词${index}`), document)).toBeNull();
  });
});
