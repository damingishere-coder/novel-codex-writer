#!/usr/bin/env python3
"""Build a bounded chapter taskbook with required recent-chapter sources."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from memory_common import (
    LEGACY_CONTEXT_NAME,
    TASKBOOK_NAME,
    MemoryRecord,
    MemorySystemError,
    atomic_write_text,
    ensure_index,
    find_blueprint,
    load_indexed_records,
    normalize_chapter,
    parse_chapter_number,
    rank_index_records,
    read_text,
    resolve_library_root,
    resolve_project_root,
    select_arc_outline,
)


@dataclass(frozen=True)
class Atom:
    section: str
    text: str
    source_id: str
    priority: int
    critical: bool = False


SECTION_ORDER = (
    "前置正文（必须全文读取）",
    "本章目标与变化",
    "连续性与当前场景",
    "人物状态",
    "不可违背规则与伏笔",
    "结尾与文风提醒",
)

PREVIOUS_CHAPTER_LIMIT = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成不全文加载资料、按完整条目选择的本章写作任务书。")
    parser.add_argument("--chapter", required=True, help="目标章节号，例如 1 或 001。")
    parser.add_argument("--library-root", default="小说项目", help="作品库目录。")
    parser.add_argument("--project-root", default=None, help="小说目录；默认读取 activeProjectId。")
    parser.add_argument("--output", default=None, help=f"输出路径；默认写入 记忆库/current/{TASKBOOK_NAME}。")
    parser.add_argument("--budget-chars", type=int, default=None, help="任务书总字符预算，默认 1500。")
    parser.add_argument(
        "--max-section-chars",
        type=int,
        default=None,
        help="兼容旧参数；现在表示任务书总字符预算，建议改用 --budget-chars。",
    )
    return parser.parse_args()


def resolve_budget(args: argparse.Namespace) -> tuple[int, bool]:
    if args.budget_chars is not None and args.max_section_chars is not None:
        raise MemorySystemError("--budget-chars 与旧参数 --max-section-chars 不能同时使用。")
    legacy = args.max_section_chars is not None
    budget = args.max_section_chars if legacy else args.budget_chars
    budget = 1500 if budget is None else budget
    if budget < 800:
        raise MemorySystemError("任务书预算不能低于 800 字符，否则无法可靠保留关键规则。")
    return budget, legacy


def heading_section(text: str, heading_pattern: str) -> str:
    lines = text.splitlines()
    start = None
    level = None
    pattern = re.compile(heading_pattern)
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match and pattern.search(match.group(2)):
            start = index + 1
            level = len(match.group(1))
            break
    if start is None or level is None:
        return ""
    end = len(lines)
    for index in range(start, len(lines)):
        match = re.match(r"^(#{1,6})\s+", lines[index])
        if match and len(match.group(1)) <= level:
            end = index
            break
    return "\n".join(lines[start:end]).strip()


def chapter_section(text: str, chapter: int) -> str:
    label = f"{chapter:03d}"
    return heading_section(text, rf"^第\s*0*{chapter}\s*章(?:\s|$)|^第{label}章(?:\s|$)")


def complete_list_items(text: str) -> list[str]:
    lines = text.splitlines()
    items: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if re.match(r"^\s*(?:[-*+] |\d+\.\s+)", line):
            if current:
                items.append(current)
            current = [line.strip()]
        elif current and (line.startswith("  ") or line.startswith("\t")) and line.strip():
            current.append(line.strip())
        elif current and not line.strip():
            items.append(current)
            current = None
        elif current:
            items.append(current)
            current = None
    if current:
        items.append(current)
    return [" ".join(item) for item in items]


def paragraph_blocks(text: str) -> list[str]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text) if block.strip()]
    return [block for block in blocks if not block.startswith("|") and not re.match(r"^[-*+] ", block)]


def table_change_atoms(section: str) -> list[str]:
    rows = [line.strip() for line in section.splitlines() if line.strip().startswith("|")]
    if len(rows) < 3:
        return []
    headers = [cell.strip() for cell in rows[0].strip("|").split("|")]
    try:
        change_index = headers.index("必须产生的变化")
    except ValueError:
        return []
    point_index = headers.index("情节点") if "情节点" in headers else None
    results: list[str] = []
    for row in rows[2:]:
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        if len(cells) <= change_index or re.fullmatch(r"[-: ]+", "".join(cells)):
            continue
        change = cells[change_index]
        point = cells[point_index] if point_index is not None and len(cells) > point_index else ""
        if change:
            results.append(f"- {point} → {change}" if point else f"- {change}")
    return results


def normalize_item(value: str) -> str:
    stripped = value.strip()
    if re.match(r"^(?:[-*+] |\d+\.\s+)", stripped):
        return re.sub(r"^\d+\.\s+", "- ", stripped)
    if stripped.startswith(">"):
        return "- " + re.sub(r"^>\s*", "", stripped).replace("\n> ", " / ")
    return "- " + stripped.replace("\n", " ")


def chapter_plan_target(plan_text: str, chapter: int) -> str:
    for line in plan_text.splitlines():
        if re.search(rf"第\s*0*{chapter}\s*章", line):
            return line.strip()
    return chapter_section(plan_text, chapter)


def outline_atoms(project_root: Path, chapter: int, arc_path: Path, blueprint_path: Path) -> list[Atom]:
    atoms: list[Atom] = []
    blueprint = read_text(blueprint_path)
    goals = complete_list_items(heading_section(blueprint, r"^本章目标$"))
    for index, item in enumerate(goals, start=1):
        atoms.append(Atom("本章目标与变化", normalize_item(item), f"blueprint:goal:{index}", 900))

    table_section = heading_section(blueprint, r"^情节点与字数预算$")
    for index, item in enumerate(table_change_atoms(table_section), start=1):
        atoms.append(Atom("本章目标与变化", normalize_item(item), f"blueprint:change:{index}", 850))

    hard_facts = complete_list_items(heading_section(blueprint, r"^不可违背事实$"))
    for index, item in enumerate(hard_facts, start=1):
        atoms.append(
            Atom("不可违背规则与伏笔", normalize_item(item), f"blueprint:hard:{index}", 1000, True)
        )

    hook_section = heading_section(blueprint, r"^结尾钩子$")
    hook_blocks = complete_list_items(hook_section) or paragraph_blocks(hook_section)
    for index, item in enumerate(hook_blocks, start=1):
        atoms.append(Atom("结尾与文风提醒", normalize_item(item), f"blueprint:hook:{index}", 500))

    arc_text = read_text(arc_path)
    arc_rules = complete_list_items(heading_section(arc_text, r"^本篇必须遵守的底层规则$"))
    for index, item in enumerate(arc_rules, start=1):
        atoms.append(Atom("不可违背规则与伏笔", normalize_item(item), f"arc:rule:{index}", 950, True))
    target_arc = chapter_section(arc_text, chapter)
    for index, item in enumerate(complete_list_items(target_arc) or paragraph_blocks(target_arc), start=1):
        atoms.append(Atom("本章目标与变化", normalize_item(item), f"arc:chapter:{index}", 700))

    plan_text = read_text(project_root / "大纲" / "章节规划.md")
    target_plan = chapter_plan_target(plan_text, chapter)
    if target_plan:
        atoms.append(Atom("本章目标与变化", normalize_item(target_plan.strip("| ")), "chapter-plan:target", 650))

    total_outline = read_text(project_root / "大纲" / "总纲.md")
    for section_name in ("不可违背事实", "核心硬规则", "底层规则"):
        section = heading_section(total_outline, rf"^{section_name}$")
        for index, item in enumerate(complete_list_items(section), start=1):
            atoms.append(
                Atom("不可违背规则与伏笔", normalize_item(item), f"master:{section_name}:{index}", 920, True)
            )
    return atoms


def memory_atom(record: MemoryRecord) -> Atom:
    category = str(record.metadata.get("category", "note"))
    if category in {"character", "relationship"}:
        section = "人物状态"
    elif category in {"hard_fact", "foreshadowing", "workflow"}:
        section = "不可违背规则与伏笔"
    else:
        section = "连续性与当前场景"
    importance = str(record.metadata.get("importance", "normal"))
    priority = {"critical": 1100, "high": 620, "normal": 360, "low": 160}.get(importance, 300)
    return Atom(section, normalize_item(record.content), record.record_id, priority, importance == "critical")


def recent_summary_atoms(index: dict, chapter: int) -> list[Atom]:
    previous = [item for item in index.get("chapter_summaries", []) if int(item["chapter"]) < chapter]
    previous = sorted(previous, key=lambda item: int(item["chapter"]))[-2:]
    atoms: list[Atom] = []
    for item in previous:
        number = int(item["chapter"])
        atoms.append(
            Atom(
                "连续性与当前场景",
                f"- 第{number:03d}章摘要：{item['summary']}",
                f"patch:{item['patch_id']}:summary",
                780,
            )
        )
    if previous and int(previous[-1]["chapter"]) == chapter - 1:
        latest = previous[-1]
        atoms.append(
            Atom(
                "连续性与当前场景",
                f"- 上一章结尾状态：{latest['ending_state']}",
                f"patch:{latest['patch_id']}:ending",
                820,
            )
        )
    return atoms


def previous_summary_required(project_root: Path, index: dict, chapter: int) -> None:
    if chapter <= 1:
        return
    previous = chapter - 1
    previous_exists = any(
        parse_chapter_number(path, read_text(path)) == previous
        for path in (project_root / "正文").glob("*.md")
    )
    summaries = {int(item["chapter"]) for item in index.get("chapter_summaries", [])}
    if previous_exists and previous not in summaries:
        raise MemorySystemError(
            f"第{previous:03d}章已有正文，但缺少结构化 memory_patch。请先补齐摘要和章末状态。"
        )


def previous_chapter_paths(
    project_root: Path, chapter: int, limit: int = PREVIOUS_CHAPTER_LIMIT
) -> list[tuple[int, Path]]:
    """Return the exact preceding chapters that must be read in full."""
    if chapter <= 1:
        return []

    first = max(1, chapter - limit)
    required = list(range(first, chapter))
    matches: dict[int, list[Path]] = {number: [] for number in required}
    for path in sorted((project_root / "正文").glob("*.md")):
        number = parse_chapter_number(path)
        if number is None:
            number = parse_chapter_number(path, read_text(path))
        if number in matches:
            matches[number].append(path)

    duplicates = [number for number, paths in matches.items() if len(paths) > 1]
    if duplicates:
        labels = "、".join(f"第{number:03d}章" for number in duplicates)
        raise MemorySystemError(f"以下前置章节存在多个正文文件，无法确定读取哪一个：{labels}")

    missing = [number for number, paths in matches.items() if not paths]
    if missing:
        labels = "、".join(f"第{number:03d}章" for number in missing)
        raise MemorySystemError(
            f"写第{chapter:03d}章前必须全文读取连续前五章（不足五章时读取已有全部前章），"
            f"但缺少正文：{labels}。"
        )

    return [(number, matches[number][0]) for number in required]


def previous_chapter_atoms(project_root: Path, chapter: int) -> list[Atom]:
    atoms: list[Atom] = []
    for number, path in previous_chapter_paths(project_root, chapter):
        relative_path = path.resolve().relative_to(project_root.resolve()).as_posix()
        atoms.append(
            Atom(
                "前置正文（必须全文读取）",
                f"- 写正文前全文读取 `{relative_path}`；以文件当前保存内容为准。",
                f"chapter-text:{number:03d}",
                1200,
                True,
            )
        )
    return atoms


def compact_source_ids(values: list[str], maximum: int = 12) -> str:
    unique = list(dict.fromkeys(values))
    visible = unique[:maximum]
    rendered = "、".join(f"`{value}`" for value in visible)
    if len(unique) > maximum:
        rendered += f"、另 {len(unique) - maximum} 条见 `memory_index.json`"
    return rendered


def source_footer(selected: list[Atom], omitted: list[Atom], extra_omitted_ids: list[str]) -> str:
    used_ids = list(dict.fromkeys(atom.source_id for atom in selected))
    omitted_ids = list(dict.fromkeys([atom.source_id for atom in omitted] + extra_omitted_ids))
    lines = ["## 来源", "", "- 已使用：" + compact_source_ids(used_ids)]
    if omitted_ids:
        lines.append("- 未展开：" + compact_source_ids(omitted_ids))
    return "\n".join(lines)


def render_taskbook(
    chapter: int,
    project_root: Path,
    arc_name: str,
    blueprint_name: str,
    selected: list[Atom],
    omitted: list[Atom],
    extra_omitted_ids: list[str],
) -> str:
    lines = [
        f"# 第{chapter:03d}章 本章写作任务书",
        "",
        f"> 临时文件；生成于 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}，每章覆盖。",
        f"> 篇纲：`大纲/{arc_name}`；细纲：`大纲/{blueprint_name}`。",
    ]
    for section in SECTION_ORDER:
        items = [atom for atom in selected if atom.section == section]
        if not items:
            continue
        lines.extend(["", f"## {section}", ""])
        lines.extend(atom.text for atom in items)
    lines.extend(["", source_footer(selected, omitted, extra_omitted_ids)])
    return "\n".join(lines).rstrip() + "\n"


def choose_atoms(
    atoms: list[Atom],
    budget: int,
    chapter: int,
    project_root: Path,
    arc_name: str,
    blueprint_name: str,
    extra_omitted_ids: list[str],
) -> tuple[str, list[Atom], list[Atom]]:
    deduped: list[Atom] = []
    seen: set[tuple[str, str]] = set()
    for atom in atoms:
        key = (atom.section, atom.text)
        if key not in seen:
            seen.add(key)
            deduped.append(atom)
    ordered = sorted(deduped, key=lambda atom: (-atom.priority, atom.source_id))
    selected = [atom for atom in ordered if atom.critical]
    optional = [atom for atom in ordered if not atom.critical]
    omitted = list(optional)
    initial = render_taskbook(
        chapter, project_root, arc_name, blueprint_name, selected, omitted, extra_omitted_ids
    )
    if len(initial) > budget:
        critical_ids = "、".join(atom.source_id for atom in selected)
        raise MemorySystemError(
            f"关键规则需要 {len(initial)} 字符，超过预算 {budget}。未截断任何关键条目。"
            f"请压缩这些来源或明确提高 --budget-chars：{critical_ids}"
        )
    for atom in optional:
        candidate_selected = selected + [atom]
        candidate_omitted = [item for item in optional if item not in candidate_selected]
        candidate = render_taskbook(
            chapter,
            project_root,
            arc_name,
            blueprint_name,
            candidate_selected,
            candidate_omitted,
            extra_omitted_ids,
        )
        if len(candidate) <= budget:
            selected = candidate_selected
            omitted = candidate_omitted
    final = render_taskbook(
        chapter, project_root, arc_name, blueprint_name, selected, omitted, extra_omitted_ids
    )
    return final, selected, omitted


def blocker_taskbook(chapter: int, records: list[MemoryRecord], budget: int) -> str:
    lines = [
        f"# 第{chapter:03d}章 本章写作任务书：暂停",
        "",
        "> 当前存在关键工作流阻断；本任务书没有读取章节细纲，也不得据此生成正文。",
        "",
        "## 阻断原因",
        "",
    ]
    lines.extend(f"- `{record.record_id}`：{record.content}" for record in records)
    lines.extend(
        [
            "",
            "## 下一步",
            "",
            "- 完成阻断记录要求的资料修订，再通过 memory_patch 关闭对应记录。",
            "",
            "## 来源",
            "",
            "- " + "、".join(f"`{record.record_id}`" for record in records),
        ]
    )
    text = "\n".join(lines).rstrip() + "\n"
    if len(text) > budget:
        raise MemorySystemError(f"工作流阻断说明需要 {len(text)} 字符，超过预算 {budget}。")
    return text


def main() -> int:
    args = parse_args()
    try:
        budget, legacy_budget = resolve_budget(args)
        chapter, _ = normalize_chapter(args.chapter)
        library_root = resolve_library_root(args.library_root)
        project_root = resolve_project_root(library_root, args.project_root)
        current_dir = project_root / "记忆库" / "current"
        output = Path(args.output) if args.output else current_dir / TASKBOOK_NAME
        output = output.resolve() if output.is_absolute() else (Path.cwd() / output).resolve()
        legacy_context = current_dir / LEGACY_CONTEXT_NAME
        if legacy_context.exists():
            raise MemorySystemError(
                f"仍存在旧上下文包：{legacy_context}。请先运行 memory_doctor.py --migrate-legacy。"
            )
        arc = select_arc_outline(project_root, chapter)
        index = ensure_index(project_root)
        blocker_items = [
            item
            for item in index.get("records", [])
            if item.get("category") == "workflow"
            and item.get("status") == "active"
            and not item.get("archived")
        ]
        if blocker_items:
            blockers = load_indexed_records(project_root, blocker_items)
            taskbook = blocker_taskbook(chapter, blockers, budget)
            output.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(output, taskbook)
            print(f"已生成阻断型写作任务书：{output}")
            print("没有读取旧章节细纲，也没有生成正文写作材料。")
            return 0

        blueprint_path = find_blueprint(project_root, chapter)
        if blueprint_path is None:
            raise MemorySystemError(
                f"找不到第{chapter:03d}章细纲。请先创建并确认 大纲/细纲_第{chapter:03d}章.md。"
            )
        index = ensure_index(project_root)
        previous_summary_required(project_root, index, chapter)
        blueprint_text = read_text(blueprint_path)
        arc_chapter_text = chapter_section(read_text(arc.path), chapter)
        plan_text = read_text(project_root / "大纲" / "章节规划.md")
        query_text = "\n".join((blueprint_text, arc_chapter_text, chapter_plan_target(plan_text, chapter)))
        selected_items, omitted_items = rank_index_records(index, chapter, query_text=query_text, limit=20)
        memory_records = load_indexed_records(project_root, selected_items)
        atoms = previous_chapter_atoms(project_root, chapter)
        atoms.extend(outline_atoms(project_root, chapter, arc.path, blueprint_path))
        atoms.extend(memory_atom(record) for record in memory_records)
        atoms.extend(recent_summary_atoms(index, chapter))
        atoms.extend(
            [
                Atom("结尾与文风提醒", "- 正文控制在 2000—2500 字。", "style:length", 260),
                Atom("结尾与文风提醒", "- 本章必须产生压力、选择、代价或可追踪变化。", "style:change", 250),
                Atom("结尾与文风提醒", "- 正文不得出现“细纲、伏笔、读者、本章”等工程词。", "style:immersion", 240),
            ]
        )
        content_atoms = [atom for atom in atoms if atom.text]
        extra_omitted_ids = [str(item["id"]) for item in omitted_items]
        taskbook, selected, omitted = choose_atoms(
            content_atoms,
            budget,
            chapter,
            project_root,
            arc.path.name,
            blueprint_path.name,
            extra_omitted_ids,
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(output, taskbook)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2

    print(f"已生成写作任务书：{output}")
    print(f"篇纲：{arc.path.name}（第{arc.start:03d}-{arc.end:03d}章）")
    print(f"细纲：{blueprint_path.name}")
    print(f"字符数：{len(taskbook)}/{budget}；完整条目 {len(selected)} 条，未展开 {len(omitted) + len(extra_omitted_ids)} 条。")
    if legacy_budget:
        print("提示：--max-section-chars 已兼容执行，后续请改用 --budget-chars。")
    if budget > 2000:
        print("提示：当前预算高于 2000，建议确认是否确实需要更大的单章任务书。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
