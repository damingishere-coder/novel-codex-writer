#!/usr/bin/env python3
"""Archive inactive current records and create an end-of-arc snapshot."""

from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path

from memory_common import (
    ArcOutline,
    MemoryRecord,
    MemorySystemError,
    append_record_to_text,
    apply_transaction,
    archive_path_for,
    diagnostics,
    discover_arc_outlines,
    load_all_records,
    load_patch_history,
    read_text,
    rebuild_index,
    recover_transactions,
    remove_record_blocks,
    render_record,
    resolve_library_root,
    resolve_project_root,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="压缩 current、归档失效条目，并只在篇末生成摘要。")
    parser.add_argument("--library-root", default="小说项目", help="作品库目录。")
    parser.add_argument("--project-root", default=None, help="小说目录；默认读取 activeProjectId。")
    parser.add_argument("--range", default="", help="章节范围，例如 001-030。")
    parser.add_argument("--dry-run", action="store_true", help="只显示诊断和计划，不修改文件。")
    return parser.parse_args()


def parse_range(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"\s*0*(\d+)\s*[-—–~～至到]+\s*0*(\d+)\s*", value)
    if not match:
        raise MemorySystemError("--range 必须是类似 001-030 的章节范围。")
    start, end = int(match.group(1)), int(match.group(2))
    if start <= 0 or end < start:
        raise MemorySystemError(f"章节范围无效：{value}")
    return start, end


def exact_arc(arcs: list[ArcOutline], start: int, end: int) -> ArcOutline | None:
    return next((arc for arc in arcs if arc.start == start and arc.end == end), None)


def prepare_archive_changes(
    project_root: Path, records: list[MemoryRecord]
) -> tuple[dict[Path, str | None], list[str]]:
    inactive = [
        record
        for record in records
        if not record.archived and record.metadata.get("status") in {"closed", "outdated", "contradicted"}
    ]
    removals: dict[Path, list[MemoryRecord]] = defaultdict(list)
    additions: dict[Path, list[str]] = defaultdict(list)
    report: list[str] = []
    for record in inactive:
        removals[record.path].append(record)
        target = archive_path_for(project_root, str(record.metadata.get("category", "note"))).resolve()
        additions[target].append(render_record(record.metadata, record.content))
        report.append(f"归档 {record.record_id} -> {target.relative_to(project_root).as_posix()}")

    changes: dict[Path, str | None] = {}
    for path, items in removals.items():
        changes[path.resolve()] = remove_record_blocks(read_text(path), items)
    for target, blocks in additions.items():
        content = changes.get(target, read_text(target))
        if not content.strip():
            content = f"# {target.stem}\n"
        for block in blocks:
            content = append_record_to_text(content, block)
        changes[target] = content
    return changes, report


def snapshot_text(
    project_root: Path,
    arc: ArcOutline,
    patches: list[dict],
    records: list[MemoryRecord],
) -> str:
    lines = [
        f"# 第{arc.start:03d}—{arc.end:03d}章 篇末摘要",
        "",
        f"> 对应篇纲：`大纲/{arc.path.name}`",
        "> 本文件只在完整篇章范围结束时生成；每章事实仍以正文和 memory_patch 为准。",
        "",
        "## 章节摘要",
        "",
    ]
    scoped = [patch for patch in patches if arc.start <= int(patch["chapter"]) <= arc.end]
    if scoped:
        for patch in scoped:
            lines.extend(
                [
                    f"### 第{int(patch['chapter']):03d}章",
                    "",
                    f"- 摘要：{patch['summary']}",
                    f"- 章末状态：{patch['ending_state']}",
                    f"- 补丁：`{patch['patch_id']}`",
                    "",
                ]
            )
    else:
        lines.extend(["- 本范围内尚无结构化章节摘要。", ""])

    lines.extend(["## 重大变化", ""])
    changes: list[str] = []
    for patch in scoped:
        for operation in patch["operations"]:
            if operation["action"] == "upsert":
                record = operation["record"]
                changes.append(
                    f"- 第{int(patch['chapter']):03d}章 `{operation['action']}` `{record['id']}`：{record['content']}"
                )
            else:
                reason = operation.get("reason") or "未填写原因"
                changes.append(
                    f"- 第{int(patch['chapter']):03d}章 `{operation['action']}` `{operation['id']}`：{reason}"
                )
    lines.extend(changes or ["- 本范围内尚无结构化记忆变化。"])

    lines.extend(["", "## 未闭合伏笔", ""])
    open_loops = [
        record
        for record in records
        if record.metadata.get("category") == "foreshadowing"
        and record.metadata.get("status") in {"active", "tentative"}
        and not record.archived
    ]
    if open_loops:
        lines.extend(f"- `{record.record_id}`：{record.content}" for record in open_loops)
    else:
        lines.append("- 当前没有结构化的未闭合伏笔。")

    lines.extend(["", "## 篇末状态", ""])
    if scoped:
        latest = max(scoped, key=lambda item: int(item["chapter"]))
        lines.append(f"- {latest['ending_state']}")
    else:
        lines.append("- 尚无可用章末状态。")
    lines.extend(["", "## 来源", "", f"- `大纲/{arc.path.name}`"])
    lines.extend(f"- `{patch['patch_id']}`" for patch in scoped)
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    try:
        if not args.range:
            raise MemorySystemError("请使用 --range 指定章节范围，例如 001-030。")
        start, end = parse_range(args.range)
        library_root = resolve_library_root(args.library_root)
        project_root = resolve_project_root(library_root, args.project_root)
        recovered = recover_transactions(project_root)
        arcs = discover_arc_outlines(project_root)
        arc = exact_arc(arcs, start, end)
        findings = diagnostics(project_root, end)
        if arc is None:
            print(f"章节范围 {start:03d}-{end:03d} 不是任何篇纲的完整范围。")
            print("本次按非篇末诊断处理：不会归档、不会生成 snapshot。")
            for finding in findings:
                print(f"- [{finding['severity']}] {finding['code']}：{finding['message']}")
            return 2 if any(item["severity"] == "error" for item in findings) else 0

        records = load_all_records(project_root)
        patches = load_patch_history(project_root)
        if any(item["severity"] == "blocked" for item in findings):
            raise MemorySystemError("当前存在 workflow blocker，不能生成篇末摘要。请先解决并关闭阻断记录。")
        completed_chapters = {
            int(patch["chapter"])
            for patch in patches
            if start <= int(patch["chapter"]) <= end
        }
        missing_chapters = [number for number in range(start, end + 1) if number not in completed_chapters]
        if missing_chapters:
            visible = "、".join(f"{number:03d}" for number in missing_chapters[:10])
            suffix = f"，另有 {len(missing_chapters) - 10} 章" if len(missing_chapters) > 10 else ""
            raise MemorySystemError(
                f"篇章尚未完成：缺少第 {visible}{suffix} 章的结构化 memory_patch，不能生成篇末摘要。"
            )
        changes, report = prepare_archive_changes(project_root, records)
        snapshot_path = project_root / "记忆库" / "snapshots" / f"第{start:03d}-{end:03d}章_篇末摘要.md"
        changes[snapshot_path.resolve()] = snapshot_text(project_root, arc, patches, records)
        if not args.dry_run:
            apply_transaction(project_root, changes)
            rebuild_index(project_root)
            findings = diagnostics(project_root, end)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2

    print(f"小说目录：{project_root}")
    print(f"篇纲：{arc.path.name}（第{start:03d}-{end:03d}章）")
    if recovered:
        print("已恢复未完成事务：" + "、".join(recovered))
    print("执行模式：" + ("dry-run，只诊断不写入" if args.dry_run else "已完成篇末压缩"))
    for item in report:
        print(f"- {item}")
    print(f"- 篇末摘要：{snapshot_path.relative_to(project_root).as_posix()}")
    for finding in findings:
        print(f"- [{finding['severity']}] {finding['code']}：{finding['message']}")
    return 2 if any(item["severity"] == "error" for item in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
