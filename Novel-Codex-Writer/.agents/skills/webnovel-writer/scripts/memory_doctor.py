#!/usr/bin/env python3
"""Diagnose and safely migrate the Markdown memory library."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from memory_common import (
    LEGACY_CONTEXT_NAME,
    TASKBOOK_NAME,
    MARKER_RE,
    MemorySystemError,
    add_legacy_markers,
    apply_transaction,
    atomic_write_text,
    blocked_taskbook_from_legacy,
    diagnostics,
    normalize_chapter,
    read_text,
    rebuild_index,
    recover_transactions,
    resolve_library_root,
    resolve_project_root,
    workflow_blocker_text,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="检查篇纲、记忆条目、索引、上一章摘要和工作流阻断。")
    parser.add_argument("--chapter", default=None, help="准备写的章节号，例如 1 或 001。")
    parser.add_argument("--library-root", default="小说项目", help="作品库目录。")
    parser.add_argument("--project-root", default=None, help="小说目录；默认读取 activeProjectId。")
    parser.add_argument("--migrate-legacy", action="store_true", help="为现有 Markdown 条目补充元数据并迁移旧上下文包。")
    parser.add_argument("--rebuild-index", action="store_true", help="从 Markdown 事实源重建 memory_index.json。")
    parser.add_argument("--dry-run", action="store_true", help="只显示会做什么，不修改文件。")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出诊断结果。")
    return parser.parse_args()


def active_hard_fact_path(project_root: Path) -> Path | None:
    candidate = project_root / "档案库" / "事实历史" / "不可违背事实.md"
    return candidate if candidate.exists() else None


def plan_migration(project_root: Path) -> tuple[dict[Path, str | None], int]:
    changes: dict[Path, str | None] = {}
    migrated_count = 0
    current_dir = project_root / "记忆库" / "current"
    candidates = [
        path
        for path in current_dir.glob("*.md")
        if path.name not in {LEGACY_CONTEXT_NAME, TASKBOOK_NAME, "写作状态.md"}
    ]
    hard_facts = active_hard_fact_path(project_root)
    if hard_facts:
        candidates.append(hard_facts)
    for path in sorted(candidates):
        converted, count = add_legacy_markers(path, project_root)
        if count:
            changes[path.resolve()] = converted
            migrated_count += count

    legacy_path = current_dir / LEGACY_CONTEXT_NAME
    taskbook_path = current_dir / TASKBOOK_NAME
    reset_evidence = "\n".join(
        (
            read_text(legacy_path),
            read_text(project_root / "档案库" / "事实历史" / "不可违背事实.md"),
            read_text(current_dir / "当前时间线.md"),
        )
    )
    needs_story_reset = (
        "正文已清空" in reset_evidence
        or "暂停生成正文" in reset_evidence
        or ("旧细纲" in reset_evidence and ("尚未重写" in reset_evidence or "不得用于生成" in reset_evidence))
    )
    workflow_path = current_dir / "写作状态.md"
    workflow_content = read_text(workflow_path)
    if needs_story_reset and "workflow.story-reset" not in workflow_content:
        if workflow_content.strip():
            workflow_content = workflow_content.rstrip() + "\n\n" + workflow_blocker_text().split("\n", 2)[-1]
        else:
            workflow_content = workflow_blocker_text()
        changes[workflow_path.resolve()] = workflow_content

    if legacy_path.exists():
        if needs_story_reset and not taskbook_path.exists():
            changes[taskbook_path.resolve()] = blocked_taskbook_from_legacy(read_text(legacy_path))
        changes[legacy_path.resolve()] = None
    return changes, migrated_count


def trash_legacy_context(library_root: Path, project_root: Path) -> Path | None:
    legacy_path = project_root / "记忆库" / "current" / LEGACY_CONTEXT_NAME
    if not legacy_path.exists():
        return None
    project_id = project_root.name
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    trash_root = (library_root / ".trash").resolve()
    target = (trash_root / project_id / timestamp / "记忆库" / "current" / LEGACY_CONTEXT_NAME).resolve()
    if trash_root not in target.parents:
        raise MemorySystemError(f"回收站目标无效：{target}")
    atomic_write_text(target, read_text(legacy_path))
    return target


def main() -> int:
    args = parse_args()
    try:
        library_root = resolve_library_root(args.library_root)
        project_root = resolve_project_root(library_root, args.project_root)
        chapter = normalize_chapter(args.chapter)[0] if args.chapter else None
        recovered = recover_transactions(project_root)
        migration_summary = None
        trash_target = None
        if args.migrate_legacy:
            changes, migrated_count = plan_migration(project_root)
            migration_summary = {
                "records": migrated_count,
                "files": [path.relative_to(project_root).as_posix() for path in changes],
            }
            if not args.dry_run and changes:
                trash_target = trash_legacy_context(library_root, project_root)
                apply_transaction(project_root, changes)
        index_rebuilt = False
        if (args.rebuild_index or (args.migrate_legacy and not args.dry_run)) and not args.dry_run:
            rebuild_index(project_root)
            index_rebuilt = True
        findings = diagnostics(project_root, chapter)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2

    result = {
        "project_root": str(project_root),
        "dry_run": args.dry_run,
        "recovered_transactions": recovered,
        "migration": migration_summary,
        "trash_target": str(trash_target) if trash_target else None,
        "index_rebuilt": index_rebuilt,
        "findings": findings,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"小说目录：{project_root}")
        if recovered:
            print("已恢复未完成事务：" + "、".join(recovered))
        if migration_summary:
            verb = "预计迁移" if args.dry_run else "已迁移"
            print(f"{verb} {migration_summary['records']} 条旧记忆，涉及 {len(migration_summary['files'])} 个文件。")
        if trash_target:
            print(f"旧上下文包已移入可恢复回收站：{trash_target}")
        if index_rebuilt:
            print("已从 Markdown 事实源重建 memory_index.json。")
        if not findings:
            print("诊断通过：未发现问题。")
        else:
            print("诊断结果：")
            for finding in findings:
                print(f"- [{finding['severity']}] {finding['code']}：{finding['message']}")
    return 2 if any(item["severity"] == "error" for item in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
