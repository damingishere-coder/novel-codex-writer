import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import chapterCheckRules from "../../chapter-check-rules.json" with { type: "json" };
import {
  applyVerification,
  assertVerificationSourcesCurrent,
  assembleChapterReviewContext,
  buildVerificationPrompt,
  collectVerificationSources,
  deduplicateFindings,
  extractChapterNumber,
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
  it("与脚本共用章节号一致性样例", () => {
    for (const fixture of chapterCheckRules.chapterNumberFixtures) {
      const pathChapter = extractChapterNumber(fixture.documentPath);
      const titleChapter = extractChapterNumber(fixture.heading);
      expect(pathChapter ?? null).toBe(fixture.pathChapter);
      expect(titleChapter ?? null).toBe(fixture.titleChapter);
      const findings = runDeterministicChapterChecks(fixture.documentPath, fixture.heading);
      expect(findings.some((item) => item.title === "章节号不匹配")).toBe(fixture.expectsMismatch);
    }
  });

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

  it("按章节装配固定上下文，连续读取最多五章完整前文并记录 revision", async () => {
    const root = await createProjectRoot();
    await write(root, "大纲/细纲_第007章.md", `# 细纲 第007章\n${"纲".repeat(7000)}`);
    await write(root, "记忆库/current/本章写作任务书.md", `# 第007章 本章写作任务书\n${"任".repeat(6000)}`);
    await write(root, "记忆库/current/本章上下文包.md", "这是不应被读取的旧文件");
    for (let chapter = 1; chapter <= 6; chapter += 1) {
      await write(root, `正文/第${String(chapter).padStart(3, "0")}章_前文.md`, `# 第${String(chapter).padStart(3, "0")}章\n${String(chapter).repeat(6000)}`);
    }
    await write(root, "写作规范/文风指南.md", `# 文风指南\n${"风".repeat(5000)}`);
    const context = await assembleChapterReviewContext(root, "正文/第007章_当前章.md", `# 第007章\n${"正".repeat(13000)}`);
    expect(context.blocks.map((item) => item.path)).not.toContain("记忆库/current/本章上下文包.md");
    expect(context.blocks.filter((item) => item.label.startsWith("前置正文"))).toHaveLength(5);
    expect(context.blocks.map((item) => item.label)).not.toContain("前置正文 第001章");
    expect(context.blocks.find((item) => item.label === "前置正文 第002章")?.content.length).toBeGreaterThan(5000);
    expect(context.manifest.filter((item) => !item.missing).every((item) => Boolean(item.revision))).toBe(true);
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

  it("把空细纲和空前章视为缺失并生成阻塞 S1", async () => {
    const root = await createProjectRoot();
    await write(root, "大纲/细纲_第002章.md", "   \n");
    await write(root, "记忆库/current/本章写作任务书.md", "# 第002章 本章写作任务书");
    await write(root, "正文/第001章_上一章.md", "\n\t");
    await write(root, "写作规范/文风指南.md", "# 文风指南");

    const context = await assembleChapterReviewContext(root, "正文/第002章_当前章.md", "# 第002章\n正文");
    expect(context.blocks.some((item) => item.label === "本章细纲")).toBe(false);
    expect(context.blocks.some((item) => item.label.startsWith("前置正文"))).toBe(false);
    expect(context.findings.filter((item) => item.severity === "S1")).toHaveLength(2);
    expect(context.manifest.filter((item) => item.role === "本章细纲" || item.role.startsWith("前置正文"))
      .every((item) => item.missing && Boolean(item.revision))).toBe(true);
  });

  it("同一章节存在多个候选文件时阻断，不静默选取上下文", async () => {
    const root = await createProjectRoot();
    await write(root, "大纲/细纲_第002章_A.md", "# 第002章 细纲 A");
    await write(root, "大纲/细纲_第002章_B.md", "# 第002章 细纲 B");
    await expect(assembleChapterReviewContext(root, "正文/第002章_当前章.md", "# 第002章\n正文"))
      .rejects.toMatchObject({ statusCode: 409, code: "CHAPTER_FILE_AMBIGUOUS" });
  });

  it("严格校验精确原文、行号和替换长度，任何畸形 finding 都让整次审阅失败", () => {
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

    expect(() => parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 3, toLine: 3 }] }, "第一行\n第二行\n第三行"))
      .toThrow("原文或行号");
    expect(() => parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 2, toLine: 1 }] }, "第一行\n第二行\n第三行"))
      .toThrow("原文或行号");
    expect(() => parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 2, toLine: 2, after: "新".repeat(5001) }] }, "第一行\n第二行\n第三行"))
      .toThrow("替换文本过长");
    expect(() => parseChapterAudit({ summary: "完成", findings: [{ ...base, fromLine: 2, toLine: 2, after: { text: "新第二行" } }] }, "第一行\n第二行\n第三行"))
      .toThrow("字符串或 null");
    expect(() => parseChapterAudit({}, "第一行")).toThrow("summary");
    expect(() => parseChapterAudit({ summary: "完成" }, "第一行")).toThrow("findings");
    expect(() => parseChapterAudit({ summary: "完成", findings: [{ ...base, severity: "unknown", fromLine: 2, toLine: 2 }] }, "第一行\n第二行"))
      .toThrow("severity");
  });

  it("二次核查支持确认、移除误报，并让无法确认的 S2 保持阻塞", () => {
    const confirmed = candidate("confirmed");
    const unsupported = candidate("unsupported");
    const unverified = candidate("unverified");
    const bundles = [confirmed, unsupported, unverified].map((item) => ({ findingId: item.id, sources: [{ path: "档案库/事实.md", snippet: "历史记录", revision: "source-revision" }] }));
    const result = applyVerification({ decisions: [
      { findingId: "confirmed", decision: "confirmed", reason: "来源明确矛盾", sourcePaths: ["档案库/事实.md"] },
      { findingId: "unsupported", decision: "unsupported", reason: "来源证明没有冲突", sourcePaths: ["档案库/事实.md"] },
      { findingId: "unverified", decision: "unverified", reason: "证据不足", sourcePaths: [] }
    ] }, [confirmed, unsupported, unverified], bundles);
    expect(result.find((item) => item.id === "confirmed")).toMatchObject({ verification: "confirmed", severity: "S2" });
    expect(result.some((item) => item.id === "unsupported")).toBe(false);
    expect(result.find((item) => item.id === "unverified")).toMatchObject({ verification: "unverified", severity: "S2" });
    expect(normalizeChapterReviewRun({
      id: "blocked-run",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: result,
      summary: "核查完成",
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-07-20T00:00:00.000Z"
    })?.verdict).toBe("needs_changes");
  });

  it("二次核查缺项、重复 ID、错误枚举或伪造来源时全部失败", () => {
    const item = candidate();
    const bundles = [{ findingId: item.id, sources: [{ path: "档案库/事实.md", snippet: "历史记录" }] }];
    expect(() => applyVerification({ decisions: [] }, [item], bundles)).toThrow("每个待核查");
    expect(() => applyVerification({ decisions: [
      { findingId: item.id, decision: "confirmed", reason: "依据", sourcePaths: ["档案库/事实.md"] },
      { findingId: item.id, decision: "confirmed", reason: "依据", sourcePaths: ["档案库/事实.md"] }
    ] }, [item], bundles)).toThrow();
    expect(() => applyVerification({ decisions: [
      { findingId: item.id, decision: "maybe", reason: "依据", sourcePaths: [] }
    ] }, [item], bundles)).toThrow("枚举");
    expect(() => applyVerification({ decisions: [
      { findingId: item.id, decision: "confirmed", reason: "依据", sourcePaths: ["项目外/伪造.md"] }
    ] }, [item], bundles)).toThrow("未提供的来源");
    expect(() => applyVerification({ decisions: [
      { findingId: item.id, decision: "unsupported", reason: "排除", sourcePaths: [] }
    ] }, [item], bundles)).toThrow("必须提供来源");
  });

  it("只核查前五个候选时，其余待核查项会安全转为 unverified", () => {
    const findings = Array.from({ length: 6 }, (_, index) => candidate(`finding-${index + 1}`));
    const bundles = findings.slice(0, 5).map((item) => ({ findingId: item.id, sources: [] }));
    const decisions = findings.slice(0, 5).map((item) => ({
      findingId: item.id,
      decision: "unverified",
      reason: "证据不足",
      sourcePaths: []
    }));
    const result = applyVerification({ decisions }, findings, bundles);
    expect(result).toHaveLength(6);
    expect(result.every((item) => item.verification === "unverified")).toBe(true);
    expect(buildVerificationPrompt(findings, bundles).user).not.toContain("finding-6");
  });

  it("二次检索只使用当前小说允许目录，并排除备份与回收站", async () => {
    const root = await createProjectRoot();
    await write(root, "记忆库/current/当前事实.md", "阿宁始终只有三枚钥匙。");
    await write(root, "档案库/.trash/已删除.md", "阿宁有四枚钥匙。");
    await write(root, "档案库/旧版备份/旧事实.md", "阿宁有五枚钥匙。");
    const [bundle] = await collectVerificationSources(root, 3, [candidate()]);
    expect(bundle.sources.map((item) => item.path)).toContain("记忆库/current/当前事实.md");
    expect(bundle.sources.every((item) => Boolean(item.revision))).toBe(true);
    expect(bundle.sources.some((item) => item.path.includes(".trash") || item.path.includes("旧版"))).toBe(false);
  });

  it("二次核查返回期间来源发生变化时拒绝接受旧证据", async () => {
    const root = await createProjectRoot();
    await write(root, "档案库/事实.md", "阿宁始终只有三枚钥匙。");
    const bundles = await collectVerificationSources(root, 3, [candidate()]);
    await write(root, "档案库/事实.md", "阿宁现在有四枚钥匙。");
    await expect(assertVerificationSourcesCurrent(root, bundles)).rejects.toMatchObject({
      statusCode: 409,
      code: "VERIFICATION_SOURCE_STALE"
    });
  });

  it("二次检索在读取前限制每个来源根目录的文件数", async () => {
    const root = await createProjectRoot();
    for (let index = 0; index <= 500; index += 1) {
      await write(root, `记忆库/current/事实-${String(index).padStart(3, "0")}.md`, "阿宁有三枚钥匙。");
    }
    await expect(collectVerificationSources(root, 3, [candidate()])).rejects.toMatchObject({
      code: "SCAN_FILE_LIMIT"
    });
  });

  it("上下文和二次检索拒绝跟随越出项目的目录链接", async () => {
    const root = await createProjectRoot();
    const outside = await temporaryProjectOutside();
    await writeFile(join(outside, "sentinel.md"), "阿宁有项目外的五枚钥匙。", "utf8");
    try {
      await symlink(outside, join(root, "档案库", "外部资料"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(collectVerificationSources(root, 3, [candidate()])).rejects.toThrow("符号链接");
  });

  it("finding 去重和旧版运行记录兼容不会破坏数据", () => {
    const one = candidate("one");
    const duplicate = { ...candidate("two"), before: one.before, evidence: one.evidence };
    expect(deduplicateFindings([one, duplicate])).toHaveLength(1);
    expect(deduplicateFindings([one, { ...duplicate, id: "other-line", fromLine: 8, toLine: 8 }])).toHaveLength(2);
    const normalized = normalizeChapterReviewRun({
      id: "legacy-run",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: [{ ...one, sourceRefs: undefined, lookupTerms: undefined }],
      summary: "旧记录",
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(normalized).toMatchObject({ id: "legacy-run", status: "completed" });
    expect(normalized?.findings[0].sourceRefs).toEqual([]);

    const missingReason = normalizeChapterReviewRun({
      id: "missing-reason",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: [{ ...one, status: "dismissed", dismissalReason: undefined }],
      summary: "缺少驳回理由",
      promptVersion: "chapter-audit@v1",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(missingReason?.findings[0].status).toBe("open");
    expect(missingReason?.verdict).toBe("needs_changes");

    const damaged = normalizeChapterReviewRun({
      id: "damaged-run",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: [{ title: "缺少 id" }]
    });
    expect(damaged).toBeNull();
    expect(normalizeChapterReviewRun({
      id: "unknown-enum",
      documentRevision: "revision",
      engine: "other",
      status: "completed",
      findings: [one],
      createdAt: "2026-07-20T00:00:00.000Z"
    })).toBeNull();
    expect(normalizeChapterReviewRun({
      id: "duplicate-findings",
      documentRevision: "revision",
      engine: "deepseek",
      status: "completed",
      findings: [one, one],
      createdAt: "2026-07-20T00:00:00.000Z"
    })).toBeNull();
  });
});

async function temporaryProjectOutside() {
  const root = await mkdtemp(join(tmpdir(), "novel-review-outside-"));
  temporaryRoots.push(root);
  return root;
}
