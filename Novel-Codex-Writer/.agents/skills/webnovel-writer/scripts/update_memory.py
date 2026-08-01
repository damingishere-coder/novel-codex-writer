#!/usr/bin/env python3
"""Apply a validated memory_patch to current Markdown and archives."""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
from typing import Any

from memory_common import (
    MemoryRecord,
    MemorySystemError,
    append_record_to_text,
    apply_transaction,
    archive_path_for,
    current_path_for,
    load_all_records,
    load_patch,
    load_patch_history,
    project_root_from_current,
    read_text,
    rebuild_index,
    recover_transactions,
    remove_record_blocks,
    render_patch_markdown,
    render_record,
    resolve_library_root,
    resolve_project_root,
    validate_patch,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="根据结构化 memory_patch 更新 current、档案和索引。")
    parser.add_argument("--patch", required=True, help="memory_patch JSON 或含 JSON 代码块的 Markdown 文件。")
    parser.add_argument("--library-root", default="小说项目", help="作品库目录。")
    parser.add_argument(
        "--current-dir",
        default=None,
        help="current 投影目录；未指定时从 projects.json 的 activeProjectId 自动解析。",
    )
    parser.add_argument("--dry-run", action="store_true", help="完成全部校验并显示变化，但不修改文件。")
    return parser.parse_args()


def resolve_roots(library_root: Path, current_dir: str | None) -> tuple[Path, Path]:
    if current_dir:
        candidate = Path(current_dir)
        resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
        project_root = project_root_from_current(resolved)
        return project_root, resolved
    project_root = resolve_project_root(library_root, None)
    return project_root, project_root / "记忆库" / "current"


def patch_source_path(project_root: Path, patch: dict[str, Any]) -> Path:
    chapter = int(patch["chapter"])
    return project_root / "章节提交" / f"memory_patch_第{chapter:03d}章_{patch['patch_id']}.md"


def prepare_changes(
    project_root: Path,
    patch: dict[str, Any],
    records: list[MemoryRecord],
) -> tuple[dict[Path, str | None], list[str]]:
    existing = {record.record_id: record for record in records}
    removals: dict[Path, list[MemoryRecord]] = defaultdict(list)
    additions: dict[Path, list[str]] = defaultdict(list)
    report: list[str] = []
    chapter = int(patch["chapter"])
    patch_id = str(patch["patch_id"])

    for operation in patch["operations"]:
        action = operation["action"]
        if action == "upsert":
            payload = dict(operation["record"])
            content = str(payload.pop("content")).strip()
            record_id = str(payload["id"])
            previous = existing.get(record_id)
            if previous:
                removals[previous.path].append(previous)
            archived = payload.get("status") in {"closed", "outdated", "contradicted"}
            target = archive_path_for(project_root, str(payload["category"])) if archived else current_path_for(project_root, str(payload["category"]))
            additions[target.resolve()].append(render_record(payload, content))
            report.append(f"upsert {record_id} -> {target.relative_to(project_root).as_posix()}")
            continue

        record_id = str(operation["id"])
        previous = existing.get(record_id)
        if previous is None:
            raise MemorySystemError(f"{action} 找不到记忆 ID：{record_id}")
        removals[previous.path].append(previous)
        metadata = dict(previous.metadata)
        metadata["status"] = "closed" if action == "close" else "outdated"
        metadata["valid_to"] = chapter
        metadata["updated_by_patch"] = patch_id
        if operation.get("reason"):
            metadata["archive_reason"] = operation["reason"]
        target = archive_path_for(project_root, str(metadata["category"]))
        additions[target.resolve()].append(render_record(metadata, previous.content))
        report.append(f"{action} {record_id} -> {target.relative_to(project_root).as_posix()}")

    changes: dict[Path, str | None] = {}
    for path, removed_records in removals.items():
        changes[path.resolve()] = remove_record_blocks(read_text(path), removed_records)
    for target, blocks in additions.items():
        content = changes.get(target, read_text(target))
        if not content.strip():
            content = f"# {target.stem}\n"
        for block in blocks:
            content = append_record_to_text(content, block)
        changes[target] = content

    patch_path = patch_source_path(project_root, patch).resolve()
    changes[patch_path] = render_patch_markdown(patch)
    report.append(f"记录补丁 -> {patch_path.relative_to(project_root).as_posix()}")
    return changes, report


def main() -> int:
    args = parse_args()
    try:
        library_root = resolve_library_root(args.library_root)
        project_root, current_dir = resolve_roots(library_root, args.current_dir)
        recovered = recover_transactions(project_root)
        patch_path = Path(args.patch)
        patch_path = patch_path if patch_path.is_absolute() else (Path.cwd() / patch_path)
        patch = validate_patch(load_patch(patch_path.resolve()))

        history = load_patch_history(project_root)
        previous_patch = next((item for item in history if item["patch_id"] == patch["patch_id"]), None)
        if previous_patch is not None:
            if previous_patch != patch:
                raise MemorySystemError(
                    f"patch_id {patch['patch_id']} 已经使用过，但内容不同。请更换 patch_id。"
                )
            rebuild_index(project_root)
            print(f"补丁 {patch['patch_id']} 已应用过，本次幂等跳过。")
            return 0

        records = load_all_records(project_root)
        changes, report = prepare_changes(project_root, patch, records)
        if not args.dry_run:
            apply_transaction(project_root, changes)
            rebuild_index(project_root)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2

    print(f"小说目录：{project_root}")
    print(f"current 目录：{current_dir}")
    if recovered:
        print("已恢复未完成事务：" + "、".join(recovered))
    print(f"补丁：{patch['patch_id']}（第{int(patch['chapter']):03d}章）")
    print("执行模式：" + ("dry-run，只校验不写入" if args.dry_run else "已写入"))
    for item in report:
        print(f"- {item}")
    if not args.dry_run:
        print("已更新 current、档案、补丁记录和可重建索引。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

