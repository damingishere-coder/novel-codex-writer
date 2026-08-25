#!/usr/bin/env python3
"""Diagnose and safely migrate the Markdown memory library."""

from __future__ import annotations

import argparse
import json
from contextlib import nullcontext
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
    inspect_transactions,
    normalize_chapter,
    project_write_lock,
    read_text,
    rebuild_index,
    recover_transactions,
    assert_project_path,
    project_files,
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
    parser.add_argument("--recover", action="store_true", help="显式恢复未完成事务；默认只报告，不修改。")
    parser.add_argument(
        "--force-legacy-recovery",
        action="store_true",
        help="确认旧事务没有外部修改后，允许恢复缺少 hash 的旧事务。",
    )
    parser.add_argument("--dry-run", action="store_true", help="只显示会做什么，不修改文件。")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出诊断结果。")
    return parser.parse_args()


def checked_optional_file(project_root: Path, candidate: Path, label: str) -> Path:
    if candidate.is_symlink() or getattr(candidate, "is_junction", lambda: False)():
        raise MemorySystemError(f"{label}不能是符号链接或 junction：{candidate}")
    target = assert_project_path(project_root, candidate, label)
    if target.exists() and not target.is_file():
        raise MemorySystemError(f"{label}不是普通文件：{target}")
    return target


def active_hard_fact_path(project_root: Path) -> Path | None:
    candidate = checked_optional_file(
        project_root,
        project_root / "档案库" / "事实历史" / "不可违背事实.md",
        "不可违背事实路径",
    )
    return candidate if candidate.exists() else None


def plan_migration(project_root: Path) -> tuple[dict[Path, str | None], int]:
    changes: dict[Path, str | None] = {}
    migrated_count = 0
    current_dir = project_root / "记忆库" / "current"
    candidates = [
        path
        for path in project_files(project_root, current_dir, "*.md", label="旧记忆迁移路径")
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

    legacy_path = checked_optional_file(project_root, current_dir / LEGACY_CONTEXT_NAME, "旧上下文路径")
    taskbook_path = checked_optional_file(project_root, current_dir / TASKBOOK_NAME, "任务书路径")
    hard_fact_path = checked_optional_file(
        project_root,
        project_root / "档案库" / "事实历史" / "不可违背事实.md",
        "不可违背事实路径",
    )
    timeline_path = checked_optional_file(project_root, current_dir / "当前时间线.md", "当前时间线路径")
    reset_evidence = "\n".join(
        (
            read_text(legacy_path),
            read_text(hard_fact_path),
            read_text(timeline_path),
        )
    )
    needs_story_reset = (
        "正文已清空" in reset_evidence
        or "暂停生成正文" in reset_evidence
        or ("旧细纲" in reset_evidence and ("尚未重写" in reset_evidence or "不得用于生成" in reset_evidence))
    )
    workflow_path = checked_optional_file(project_root, current_dir / "写作状态.md", "写作状态路径")
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
    legacy_path = assert_project_path(
        project_root,
        project_root / "记忆库" / "current" / LEGACY_CONTEXT_NAME,
        "旧上下文路径",
    )
    if not legacy_path.exists():
        return None
    project_id = project_root.name
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    resolved_library = library_root.resolve()
    trash_root = (resolved_library / ".trash").resolve()
    if trash_root != resolved_library and resolved_library not in trash_root.parents:
        raise MemorySystemError(f"回收站目录越出作品库：{trash_root}")
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
        mutates = not args.dry_run and (args.recover or args.migrate_legacy or args.rebuild_index)
        lock_context = project_write_lock(project_root) if mutates else nullcontext()
        with lock_context:
            pending_before = inspect_transactions(project_root)
            recovered: list[str] = []
            if args.force_legacy_recovery and not args.recover:
                raise MemorySystemError("--force-legacy-recovery 必须与 --recover 一起使用。")
            if args.recover and not args.dry_run:
                recovered = recover_transactions(project_root, force_legacy=args.force_legacy_recovery)
            elif pending_before and (args.migrate_legacy or args.rebuild_index) and not args.dry_run:
                raise MemorySystemError("存在未完成事务。请先运行 memory_doctor.py --recover，再执行写操作。")
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
            pending_after = inspect_transactions(project_root)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2
    except OSError:
        print("错误：记忆诊断或迁移所需文件无法稳定读取或写入。")
        return 2

    result = {
        "project_root": str(project_root),
        "dry_run": args.dry_run,
        "pending_transactions": pending_after,
        "recovery_planned": bool(args.recover and args.dry_run and pending_before),
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
        elif args.recover and args.dry_run and pending_before:
            print("dry-run：以下事务将在显式恢复时处理：" + "、".join(item["id"] for item in pending_before))
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
    return 2 if any(item["severity"] in {"error", "blocked"} for item in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
