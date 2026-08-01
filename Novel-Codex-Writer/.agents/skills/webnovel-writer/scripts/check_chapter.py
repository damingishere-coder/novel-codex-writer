#!/usr/bin/env python3
"""Check a saved chapter without rewriting it."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


WORD_COUNT_MIN = 2000
WORD_COUNT_MAX = 2500

ENGINEERING_TERMS = [
    "本章",
    "细纲",
    "章节蓝图",
    "读者",
    "伏笔",
    "爽点",
    "剧情推进",
    "章节目标",
    "人设",
    "叙事节奏",
    "结尾钩子",
]

AI_STYLE_PATTERNS = [
    "空气仿佛凝固",
    "全场死寂",
    "倒吸一口凉气",
    "嘴角微微上扬",
    "眼神复杂",
    "眸光一闪",
    "心中一凛",
    "淡淡道",
    "意味深长",
]


@dataclass
class Finding:
    severity: str
    title: str
    evidence: str
    impact: str
    fix: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="检查章节字数、章节号、工程词泄漏、AI 腔、重复段落和标点问题；只报告，不自动改写。"
    )
    parser.add_argument("chapter_file", nargs="?", help="要检查的章节 Markdown 文件。")
    parser.add_argument("--chapter", default=None, help="期望章节号，例如 1 或 001。")
    parser.add_argument(
        "--library-root",
        default="小说项目",
        help="作品库目录，默认是当前项目下的 小说项目。",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="当前小说目录；未指定时从 小说项目/projects.json 的 activeProjectId 自动解析。",
    )
    parser.add_argument("--output", default=None, help="报告输出路径；不指定时打印到屏幕。")
    parser.add_argument("--min", type=int, default=WORD_COUNT_MIN, help="最低字数，默认 2000。")
    parser.add_argument("--max", type=int, default=WORD_COUNT_MAX, help="最高字数，默认 2500。")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="严格模式：存在 S1 或 S2 时返回失败码。默认只有 S1 返回失败码。",
    )
    return parser.parse_args()


def skill_repo_root() -> Path | None:
    resolved = Path(__file__).resolve()
    return resolved.parents[4] if len(resolved.parents) > 4 else None


def resolve_library_root(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or candidate.exists():
        return candidate.resolve()

    root = skill_repo_root()
    if root:
        rooted = root / value
        if rooted.exists():
            return rooted.resolve()

    return candidate.resolve()


def normalize_chapter(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.search(r"\d+", value)
    if not match:
        raise SystemExit(f"章节号必须包含数字，例如 1 或 001。当前输入：{value}")
    number = int(match.group(0))
    if number <= 0:
        raise SystemExit("章节号必须大于 0。")
    return number


def resolve_project_root(library_root: Path, project_root: str | None) -> Path:
    if project_root:
        path = Path(project_root)
        return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()

    index_path = library_root / "projects.json"
    if not index_path.exists():
        raise SystemExit(f"找不到作品库清单：{index_path}")

    index = json.loads(index_path.read_text(encoding="utf-8-sig"))
    active_project_id = index.get("activeProjectId")
    if not active_project_id:
        raise SystemExit("当前没有选中的小说。请先在网页端新建或选择小说。")

    project_root_path = library_root / "作品" / active_project_id
    if not project_root_path.exists():
        raise SystemExit(f"找不到当前小说目录：{project_root_path}")

    return project_root_path.resolve()


def read_text(path: Path) -> str:
    if not path.exists():
        raise SystemExit(f"找不到章节文件：{path}")
    return path.read_text(encoding="utf-8-sig")


def strip_markdown(content: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", content)
    text = re.sub(r"^#{1,6}\s+.*$", " ", text, flags=re.MULTILINE)
    text = re.sub(r"!\[[^\]]*]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return text


def count_readable_words(content: str) -> int:
    text = strip_markdown(content)
    cjk_pattern = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
    cjk_count = len(cjk_pattern.findall(text))
    latin_text = cjk_pattern.sub(" ", text)
    latin_count = len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", latin_text))
    return cjk_count + latin_count


def extract_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if re.match(r"^#{1,6}\s+", stripped):
            return re.sub(r"^#{1,6}\s+", "", stripped).strip()
    return fallback


def extract_chapter_number(path: Path, content: str) -> int | None:
    haystacks = [path.stem, extract_title(content, "")]
    for value in haystacks:
        match = re.search(r"第\s*0*(\d+)\s*章", value)
        if match:
            return int(match.group(1))
        match = re.search(r"(?:chapter|chap|ch)[_\s-]*0*(\d+)", value, re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def resolve_chapter_file(project_root: Path, expected_chapter: int | None, explicit_file: str | None) -> Path:
    if explicit_file:
        path = Path(explicit_file)
        return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()

    if expected_chapter is None:
        raise SystemExit("请提供章节文件，或使用 --chapter 指定要从当前小说正文目录中查找的章节。")

    chapters_dir = project_root / "正文"
    if not chapters_dir.exists():
        raise SystemExit(f"找不到正文目录：{chapters_dir}")

    for path in sorted(chapters_dir.glob("*.md")):
        content = path.read_text(encoding="utf-8-sig")
        if extract_chapter_number(path, content) == expected_chapter:
            return path.resolve()

    raise SystemExit(f"在正文目录中找不到第 {expected_chapter:03d} 章 Markdown 文件。")


def line_excerpt(content: str, term: str) -> str:
    for line in content.splitlines():
        if term in line:
            stripped = line.strip()
            return stripped[:120] + ("..." if len(stripped) > 120 else "")
    return term


def add_word_count_finding(findings: list[Finding], count: int, minimum: int, maximum: int) -> None:
    if count < minimum:
        findings.append(
            Finding(
                "S1",
                "章节字数不足",
                f"当前约 {count} 字，低于最低要求 {minimum} 字。",
                "低于项目硬性范围，不能视为合格章节。",
                "扩写有效冲突、选择、行动后果或承接信息，避免只补解释性废话。",
            )
        )
    elif count > maximum:
        findings.append(
            Finding(
                "S1",
                "章节字数超出",
                f"当前约 {count} 字，高于最高要求 {maximum} 字。",
                "超过项目硬性范围，后续审查和提交记录会失真。",
                "压缩重复解释、弱冲突段落和不影响后续的闲笔。",
            )
        )


def add_chapter_number_finding(
    findings: list[Finding], actual: int | None, expected: int | None, path: Path
) -> None:
    if actual is None:
        findings.append(
            Finding(
                "S2",
                "无法识别章节号",
                f"文件名或标题中没有识别到 `第XXX章`：{path.name}",
                "网页端和脚本可能无法把正文、审查报告、commit、memory_patch 对齐。",
                "把文件名或一级标题改成类似 `第001章_章节标题.md`。",
            )
        )
    elif expected is not None and actual != expected:
        findings.append(
            Finding(
                "S1",
                "章节号不匹配",
                f"期望第 {expected:03d} 章，实际识别为第 {actual:03d} 章。",
                "可能导致上下文包和正文错章。",
                "修正文件名、标题或命令里的 --chapter 参数。",
            )
        )


def add_engineering_term_findings(findings: list[Finding], content: str) -> None:
    for term in ENGINEERING_TERMS:
        if term in content:
            findings.append(
                Finding(
                    "S2",
                    f"工程词泄漏：{term}",
                    line_excerpt(content, term),
                    "读者会看到写作工程痕迹，沉浸感会被打断。",
                    f"把“{term}”改成角色能感知到的线索、行动、对话或场景细节。",
                )
            )


def add_ai_style_findings(findings: list[Finding], content: str) -> None:
    for phrase in AI_STYLE_PATTERNS:
        if phrase in content:
            findings.append(
                Finding(
                    "S3",
                    f"疑似套路表达：{phrase}",
                    line_excerpt(content, phrase),
                    "这类表达容易显得模板化，但不一定必须删除。",
                    "按人物身份、场景压力和具体动作改写，让反应更有角色辨识度。",
                )
            )


def add_repetition_findings(findings: list[Finding], content: str) -> None:
    paragraphs = [line.strip() for line in content.splitlines() if len(line.strip()) >= 12]
    seen: dict[str, int] = {}
    for paragraph in paragraphs:
        seen[paragraph] = seen.get(paragraph, 0) + 1

    duplicates = [paragraph for paragraph, count in seen.items() if count >= 2]
    for paragraph in duplicates[:5]:
        findings.append(
            Finding(
                "S3",
                "重复段落",
                paragraph[:120] + ("..." if len(paragraph) > 120 else ""),
                "重复段落会造成节奏拖沓或像生成退化。",
                "保留信息量更高的一处，另一处改成新的动作、反应或后果。",
            )
        )


def add_punctuation_findings(findings: list[Finding], content: str) -> None:
    checks = [
        (r"。。+", "连续句号"),
        (r"，{2,}", "连续逗号"),
        (r"！{3,}", "过多感叹号"),
        (r"？{3,}", "过多问号"),
        (r"\.{4,}", "英文省略号过长"),
    ]
    for pattern, title in checks:
        match = re.search(pattern, content)
        if match:
            findings.append(
                Finding(
                    "S4",
                    title,
                    match.group(0),
                    "标点问题会降低正文完成度。",
                    "按中文正文习惯统一为合适标点，例如 `……` 或单个句读。",
                )
            )


def render_report(path: Path, content: str, word_count: int, findings: list[Finding]) -> str:
    title = extract_title(content, path.stem)
    status = "通过" if not any(f.severity in {"S1", "S2"} for f in findings) else "需修改"
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        f"# 章节检查报告：{title}",
        "",
        f"- 生成时间：{generated_at}",
        f"- 检查文件：`{path}`",
        f"- 字数：{word_count}",
        f"- 结果：{status}",
        "",
        "## Findings",
        "",
    ]

    if not findings:
        lines.append("未发现确定性问题。仍建议按正文语感做人工审读。")
        return "\n".join(lines) + "\n"

    severity_order = {"S1": 1, "S2": 2, "S3": 3, "S4": 4}
    for index, finding in enumerate(sorted(findings, key=lambda item: severity_order[item.severity]), start=1):
        lines.extend(
            [
                f"### {finding.severity}-{index:03d} {finding.title}",
                "",
                f"- 证据：{finding.evidence}",
                f"- 影响：{finding.impact}",
                f"- 修法：{finding.fix}",
                "",
            ]
        )

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    expected_chapter = normalize_chapter(args.chapter)
    library_root = resolve_library_root(args.library_root)
    project_root = None if args.chapter_file else resolve_project_root(library_root, args.project_root)
    chapter_file = resolve_chapter_file(project_root, expected_chapter, args.chapter_file)
    content = read_text(chapter_file)

    findings: list[Finding] = []
    word_count = count_readable_words(content)
    actual_chapter = extract_chapter_number(chapter_file, content)

    add_word_count_finding(findings, word_count, args.min, args.max)
    add_chapter_number_finding(findings, actual_chapter, expected_chapter, chapter_file)
    add_engineering_term_findings(findings, content)
    add_ai_style_findings(findings, content)
    add_repetition_findings(findings, content)
    add_punctuation_findings(findings, content)

    report = render_report(chapter_file, content, word_count, findings)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(report, encoding="utf-8")
        print(f"已生成章节检查报告：{output.resolve()}")
    else:
        print(report)

    has_s1 = any(finding.severity == "S1" for finding in findings)
    has_s2 = any(finding.severity == "S2" for finding in findings)
    if has_s1 or (args.strict and has_s2):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
