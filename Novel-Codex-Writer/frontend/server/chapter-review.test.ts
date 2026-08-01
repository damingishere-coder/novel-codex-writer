import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyVerification,
  assembleChapterReviewContext,
  collectVerificationSources,
  deduplicateFindings,
  normalizeChapterReviewRun,
  parseChapterAudit,
  runDeterministicChapterChecks,
  type ReviewFinding
} from "./chapter-review";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createProjectRoot() {
  const root = await mkdtemp(join(tmpdir(), "novel-review-"));
  temporaryRoots.push(root);
  for (const path of ["大纲", "记忆库/current", "正文", "写作规范", "档案库"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  return root;
}

async function write(root: string, path: string, content: string) {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

function candidate(id = "finding-1"): ReviewFinding {
  return {
    id,
    source: "ai",
    severity: "S2",
    category: "continuity",
    title: "物资数量疑似冲突",
    fromLine: 2,
    toLine: 2,
    before: "阿宁拿出四枚钥匙。",
    evidence: "本章写成四枚。",
    impact: "会破坏连续性。",
    fixSuggestion: "核对历史数量。",
    verification: "pending",
    lookupTerms: ["阿宁", "钥匙"],
    sourceRefs: [],
    status: "open"
  };
}

describe("整章体检核心", () => {
  it("本地规则覆盖字数、章节号、工程词、AI 套路、重复和标点", () => {
    const repeated = "这是一个长度足够用于测试重复段落的完整句子。";
    const content = `# 第002章 测试\n\n本章${"甲".repeat(1970)}空气仿佛凝固。。\n${repeated}\n${repeated}`;
    const findings = runDeterministicChapterChecks("正文/第001章_测试.md", content);
    expect(findings.map((item) => item.title)).toEqual(expect.arrayContaining([
      "章节号不匹配",
      "工程词泄漏：本章",
      "疑似套路表达：空气仿佛凝固",
      "重复段落",
      "连续句号"
    ]));
  });

  it("按章节装配固定上下文，不读取旧上下文包，且总预算不超过 32000 字符", async () => {
    const root = await createProjectRoot();
    await write(root, "大纲/细纲_第002章.md", `# 细纲 第002章\n${"纲".repeat(7000)}`);
    await write(root, "记忆库/current/本章写作任务书.md", `# 第002章 本章写作任务书\n${"任".repeat(6000)}`);
    await write(root, "记忆库/current/本章上下文包.md", "这是不应被读取的旧文件");
    await write(root, "正文/第001章_上一章.md", `# 第001章\n${"前".repeat(6000)}`);
    await write(root, "写作规范/文风指南.md", `# 文风指南\n${"风".repeat(5000)}`);
    const context = await assembleChapterReviewContext(root, "正文/第002章_当前章.md", `# 第002章\n${"正".repeat(13000)}`);
    expect(context.blocks.map((item) => item.path)).not.toContain("记忆库/current/本章上下文包.md");
    expect(context.blocks.map((item) => item.label)).toEqual(expect.arrayContaining(["当前草稿", "本章细纲", "本章写作任务书", "上一章正文", "文风指南"]));
    expect(context.manifest.reduce((sum, item) => sum + item.characters, 0)).toBeLessThanOrEqual(32_000);
    expect(context.manifest.some((item) => item.truncated)).toBe(true);
  });

  it("错章任务书不会混入送审资料，并生成阻塞 S1", async () => {
    const root = await createProjectRoot();
    await write(root, "大纲/细纲_第002章.md", "# 第002章 细纲");
    await write(root, "记忆库/current/本章写作任务书.md", "# 第003章 本章写作任务书");
    await write(root, "正文/第001章_上一章.md", "# 第001章");
    await write(root, "写作规范/文风指南.md", "# 文风指南");
    const context = await assembleChapterReviewContext(root, "正文/第002章_当前章.md", "# 第002章\n正文");
    expect(context.blocks.some((item) => item.label === "本章写作任务书")).toBe(false);
    expect(context.findings.some((item) => item.severity === "S1" && item.title.includes("错章"))).toBe(true);
  });

  it("严格校验精确原文、行号和替换长度，错误内容不能被采用", () => {
    const base = {
      severity: "S2",
      category: "language",
      title: "措辞问题",
      before: "第二行",
      after: "新的第二行",
      evidence: "证据",
      impact: "影响",
      fixSuggestion: "修法",
      verificationNeeded: false,
      lookupTerms: []
    };
    const valid = parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 2, toLine: 2 }] }, "第一行\n第二行\n第三行");
    expect(valid.findings[0]).toMatchObject({ fromLine: 2, toLine: 2, before: "第二行", after: "新的第二行" });

    const wrongLine = parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 3, toLine: 3 }] }, "第一行\n第二行\n第三行");
    expect(wrongLine.findings[0].before).toBeUndefined();
    expect(wrongLine.findings[0].after).toBeUndefined();

    const overlong = parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 2, toLine: 2, after: "新".repeat(5001) }] }, "第一行\n第二行\n第三行");
    expect(overlong.findings[0].after).toBeUndefined();
  });

  it("二次核查支持确认、移除误报和无法确认降为 S3", () => {
    const confirmed = candidate("confirmed");
    const unsupported = candidate("unsupported");
    const unverified = candidate("unverified");
    const bundles = [confirmed, unsupported, unverified].map((item) => ({ findingId: item.id, sources: [{ path: "档案库/事实.md", snippet: "历史记录" }] }));
    const result = applyVerification({ decisions: [
      { findingId: "confirmed", decision: "confirmed", sourcePaths: ["档案库/事实.md"] },
      { findingId: "unsupported", decision: "unsupported", sourcePaths: [] },
      { findingId: "unverified", decision: "unverified", sourcePaths: [] }
    ] }, [confirmed, unsupported, unverified], bundles);
    expect(result.find((item) => item.id === "confirmed")).toMatchObject({ verification: "confirmed", severity: "S2" });
    expect(result.some((item) => item.id === "unsupported")).toBe(false);
    expect(result.find((item) => item.id === "unverified")).toMatchObject({ verification: "unverified", severity: "S3" });
  });

  it("二次检索只使用当前小说允许目录，并排除备份与回收站", async () => {
    const root = await createProjectRoot();
    await write(root, "记忆库/current/当前事实.md", "阿宁始终只有三枚钥匙。");
    await write(root, "档案库/.trash/已删除.md", "阿宁有四枚钥匙。");
    await write(root, "档案库/旧版备份/旧事实.md", "阿宁有五枚钥匙。");
    const [bundle] = await collectVerificationSources(root, 3, [candidate()]);
    expect(bundle.sources.map((item) => item.path)).toContain("记忆库/current/当前事实.md");
    expect(bundle.sources.some((item) => item.path.includes(".trash") || item.path.includes("旧版"))).toBe(false);
  });

  it("finding 去重和旧版运行记录兼容不会破坏数据", () => {
    const one = candidate("one");
    const duplicate = { ...candidate("two"), before: one.before, evidence: one.evidence };
    expect(deduplicateFindings([one, duplicate])).toHaveLength(1);
    const normalized = normalizeChapterReviewRun({
      id: "legacy-run",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: [{ ...one, sourceRefs: undefined, lookupTerms: undefined }],
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(normalized).toMatchObject({ id: "legacy-run", status: "completed" });
    expect(normalized?.findings[0].sourceRefs).toEqual([]);

    const missingReason = normalizeChapterReviewRun({
      id: "missing-reason",
      documentRevision: "revision",
      status: "completed",
      findings: [{ ...one, status: "dismissed", dismissalReason: undefined }]
    });
    expect(missingReason?.findings[0].status).toBe("open");
    expect(missingReason?.verdict).toBe("needs_changes");
  });
});
