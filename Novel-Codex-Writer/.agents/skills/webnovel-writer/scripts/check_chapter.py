#!/usr/bin/env python3
"""Check a saved chapter without rewriting it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from memory_common import (
    MemorySystemError,
    assert_project_path,
    atomic_write_text,
    inspect_transactions,
    project_files,
    project_write_lock,
    resolve_library_root as registered_library_root,
    resolve_project_path,
    resolve_project_root as registered_project_root,
    sha256_file,
)


RULES_PATH = Path(__file__).resolve().parents[4] / "chapter-check-rules.json"


@dataclass(frozen=True)
class CheckRules:
    word_count_minimum: int
    word_count_maximum: int
    engineering_terms: tuple[str, ...]
    ai_style_patterns: tuple[str, ...]


_CHECK_RULES: CheckRules | None = None


def load_check_rules(path: Path = RULES_PATH) -> CheckRules:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ValueError("unsupported schema")
        word_count = value.get("wordCount")
        if not isinstance(word_count, dict):
            raise ValueError("wordCount must be an object")
        minimum = word_count.get("minimum")
        maximum = word_count.get("maximum")
        if (
            isinstance(minimum, bool)
            or isinstance(maximum, bool)
            or not isinstance(minimum, int)
            or not isinstance(maximum, int)
            or minimum < 0
            or maximum < minimum
        ):
            raise ValueError("invalid wordCount range")
        engineering_terms = value.get("engineeringTerms")
        ai_style_patterns = value.get("aiStylePatterns")
        if (
            not isinstance(engineering_terms, list)
            or not engineering_terms
            or not all(isinstance(item, str) and item for item in engineering_terms)
            or not isinstance(ai_style_patterns, list)
            or not ai_style_patterns
            or not all(isinstance(item, str) and item for item in ai_style_patterns)
        ):
            raise ValueError("invalid chapter rule list")
        return CheckRules(
            word_count_minimum=minimum,
            word_count_maximum=maximum,
            engineering_terms=tuple(engineering_terms),
            ai_style_patterns=tuple(ai_style_patterns),
        )
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise MemorySystemError("章节检查规则文件损坏、缺失或版本不受支持。") from exc


def get_check_rules() -> CheckRules:
    global _CHECK_RULES
    if _CHECK_RULES is None:
        _CHECK_RULES = load_check_rules()
    return _CHECK_RULES


@dataclass
class Finding:
    severity: str
    title: str
    evidence: str
    impact: str
    fix: str


def parse_args(rules: CheckRules) -> argparse.Namespace:
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
    parser.add_argument(
        "--min",
        type=int,
        default=rules.word_count_minimum,
        help=f"最低字数，默认 {rules.word_count_minimum}。",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=rules.word_count_maximum,
        help=f"最高字数，默认 {rules.word_count_maximum}。",
    )
    return parser.parse_args()


def normalize_chapter(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.fullmatch(r"\s*(?:第\s*)?0*(\d+)(?:\s*章)?\s*", value)
    if not match:
        raise MemorySystemError(f"章节号必须是 1、001 或第001章。当前输入：{value}")
    try:
        number = int(match.group(1))
    except ValueError as exc:
        raise MemorySystemError(f"章节号超出可解析范围：{value}") from exc
    if number <= 0:
        raise MemorySystemError("章节号必须大于 0。")
    return number


def read_text(path: Path) -> str:
    if not path.exists():
        raise MemorySystemError(f"找不到章节文件：{path}")
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


def extract_chapter_number_from_text(value: str) -> int | None:
    match = re.search(r"第\s*0*(\d+)\s*章", value, re.IGNORECASE)
    if match is None:
        match = re.search(r"(?:chapter|chap|ch)[_\s-]*0*(\d+)", value, re.IGNORECASE)
    return int(match.group(1)) if match else None


def extract_chapter_numbers(path: Path, content: str) -> tuple[int | None, int | None]:
    return (
        extract_chapter_number_from_text(path.stem),
        extract_chapter_number_from_text(extract_title(content, "")),
    )


def extract_chapter_number(path: Path, content: str) -> int | None:
    path_chapter, title_chapter = extract_chapter_numbers(path, content)
    return path_chapter if path_chapter is not None else title_chapter


def assert_no_link_components(project_root: Path, candidate: Path) -> None:
    lexical_root = Path(os.path.abspath(project_root))
    lexical_candidate = Path(os.path.abspath(candidate))
    try:
        relative_candidate = lexical_candidate.relative_to(lexical_root)
    except ValueError:
        return
    current = lexical_root
    for part in relative_candidate.parts:
        current /= part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise MemorySystemError(f"正文输入路径不能经过符号链接或 junction：{current}")


def resolve_chapter_file(project_root: Path, expected_chapter: int | None, explicit_file: str | None) -> Path:
    if explicit_file:
        path = Path(explicit_file)
        candidate = path if path.is_absolute() else Path.cwd() / path
        assert_no_link_components(project_root, candidate)
        resolved = candidate.resolve()
        checked = assert_project_path(project_root, resolved, "正文输入")
        body_candidate = project_root / "正文"
        assert_no_link_components(project_root, body_candidate)
        body_root = assert_project_path(project_root, project_root / "正文", "正文目录")
        if not checked.is_file() or checked.suffix.lower() != ".md" or body_root not in checked.parents:
            raise MemorySystemError(f"正文输入必须是当前小说 正文 目录内的 Markdown 文件：{checked}")
        return checked

    if expected_chapter is None:
        raise MemorySystemError("请提供章节文件，或使用 --chapter 指定要从当前小说正文目录中查找的章节。")

    chapters_dir = project_root / "正文"
    if not chapters_dir.exists():
        raise MemorySystemError(f"找不到正文目录：{chapters_dir}")

    matches: list[Path] = []
    for path in project_files(project_root, chapters_dir, "*.md", label="正文路径"):
        content = read_text(path)
        if extract_chapter_number(path, content) == expected_chapter:
            matches.append(path)

    if len(matches) > 1:
        labels = "、".join(path.name for path in matches)
        raise MemorySystemError(f"第 {expected_chapter:03d} 章存在多个正文文件，无法确定检查对象：{labels}")
    if matches:
        return matches[0]

    raise MemorySystemError(f"在正文目录中找不到第 {expected_chapter:03d} 章 Markdown 文件。")


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
    findings: list[Finding], path_chapter: int | None, title_chapter: int | None, expected: int | None, path: Path
) -> None:
    actual = path_chapter if path_chapter is not None else title_chapter
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
    elif path_chapter is not None and title_chapter is not None and path_chapter != title_chapter:
        findings.append(
            Finding(
                "S1",
                "章节号不匹配",
                f"文件路径为第 {path_chapter:03d} 章，标题为第 {title_chapter:03d} 章。",
                "可能导致上下文、正文和审查报告错章。",
                "统一文件名和正文标题中的章节号。",
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


def add_engineering_term_findings(
    findings: list[Finding], content: str, terms: tuple[str, ...] | None = None
) -> None:
    for term in terms if terms is not None else get_check_rules().engineering_terms:
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


def add_ai_style_findings(
    findings: list[Finding], content: str, patterns: tuple[str, ...] | None = None
) -> None:
    for phrase in patterns if patterns is not None else get_check_rules().ai_style_patterns:
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


def render_report(path: Path, content: str, content_revision: str, word_count: int, findings: list[Finding]) -> str:
    title = extract_title(content, path.stem)
    status = "通过" if not any(f.severity in {"S1", "S2"} for f in findings) else "需修改"
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        f"# 章节检查报告：{title}",
        "",
        f"- 生成时间：{generated_at}",
        f"- 检查文件：`{path}`",
        f"- 正文 revision：`{content_revision}`",
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


def run_check(args: argparse.Namespace, rules: CheckRules) -> int:
    if args.min < 0 or args.max < 0 or args.min > args.max:
        raise MemorySystemError("字数范围必须满足 0 <= --min <= --max。")
    expected_chapter = normalize_chapter(args.chapter)
    library_root = registered_library_root(args.library_root)
    project_root = registered_project_root(library_root, args.project_root)
    with project_write_lock(project_root):
        try:
            pending_transactions = inspect_transactions(project_root)
        except MemorySystemError as exc:
            raise MemorySystemError(f"事务状态无效，已拒绝检查章节：{exc}") from exc
        if pending_transactions:
            raise MemorySystemError("存在未完成事务。请先运行 memory_doctor.py --recover，再检查章节。")
        chapter_file = resolve_chapter_file(project_root, expected_chapter, args.chapter_file)
        source_bytes = chapter_file.read_bytes()
        content = source_bytes.decode("utf-8-sig")
        content_revision = hashlib.sha256(source_bytes).hexdigest()

        findings: list[Finding] = []
        word_count = count_readable_words(content)
        path_chapter, title_chapter = extract_chapter_numbers(chapter_file, content)

        add_word_count_finding(findings, word_count, args.min, args.max)
        add_chapter_number_finding(findings, path_chapter, title_chapter, expected_chapter, chapter_file)
        add_engineering_term_findings(findings, content, rules.engineering_terms)
        add_ai_style_findings(findings, content, rules.ai_style_patterns)
        add_repetition_findings(findings, content)
        add_punctuation_findings(findings, content)

        report = render_report(chapter_file, content, content_revision, word_count, findings)
        if not chapter_file.is_file() or sha256_file(chapter_file) != content_revision:
            raise MemorySystemError("正文在检查期间发生变化，已拒绝生成绑定错误 revision 的报告。")
        if args.output:
            output = resolve_project_path(project_root, args.output, "审查报告输出")
            review_root = assert_project_path(project_root, project_root / "审查报告", "审查报告目录")
            if output == chapter_file or output.suffix.lower() != ".md" or review_root not in output.parents:
                raise MemorySystemError("审查报告只能写入当前小说的 审查报告 目录，且不能覆盖正文。")
            atomic_write_text(output, report)
            print(f"已生成章节检查报告：{output.resolve()}")
        else:
            print(report)

    has_s1 = any(finding.severity == "S1" for finding in findings)
    has_s2 = any(finding.severity == "S2" for finding in findings)
    if has_s1 or has_s2:
        return 1
    return 0


def main() -> int:
    try:
        rules = get_check_rules()
        args = parse_args(rules)
        return run_check(args, rules)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2
    except (OSError, UnicodeError):
        print("错误：章节检查所需文件无法稳定读取或写入。")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
