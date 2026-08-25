#!/usr/bin/env python3
"""Apply a validated memory_patch to current Markdown and archives."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from memory_common import (
    MemoryRecord,
    MemorySystemError,
    apply_transaction,
    archive_path_for,
    build_finalization_manifest,
    applied_patch_ledger_path,
    current_path_for,
    finalization_manifest_path,
    inspect_transactions,
    load_all_records,
    load_patch,
    load_applied_patch_ledger,
    load_patch_history,
    now_iso,
    prepare_record_file_changes,
    project_write_lock,
    project_root_from_current,
    rebuild_index,
    render_patch_markdown,
    render_record,
    resolve_library_root,
    resolve_project_path,
    resolve_project_root,
    sha256_text,
    validate_transaction_targets,
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
        project_root = project_root_from_current(resolved, library_root)
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

    changes = prepare_record_file_changes(project_root, removals, additions)

    patch_path = patch_source_path(project_root, patch).resolve()
    changes[patch_path] = render_patch_markdown(patch)
    report.append(f"记录补丁 -> {patch_path.relative_to(project_root).as_posix()}")
    return changes, report


def main() -> int:
    args = parse_args()
    try:
        library_root = resolve_library_root(args.library_root)
        project_root, current_dir = resolve_roots(library_root, args.current_dir)
        lock_context = nullcontext() if args.dry_run else project_write_lock(project_root)
        with lock_context:
            pending_transactions = inspect_transactions(project_root)
            if pending_transactions:
                raise MemorySystemError("存在未完成事务。请先运行 memory_doctor.py --recover。")
            patch_path = resolve_project_path(project_root, args.patch, "memory_patch 输入")
            patch = validate_patch(load_patch(patch_path))
            canonical_patch_path = patch_source_path(project_root, patch).resolve()
            if (
                patch["schema_version"] == 2
                and patch_path.parent == (project_root / "章节提交").resolve()
                and patch_path.name.startswith("memory_patch_")
                and patch_path.name != canonical_patch_path.name
            ):
                raise MemorySystemError(
                    f"schema v2 patch 文件名必须为规范路径：{canonical_patch_path.relative_to(project_root).as_posix()}"
                )

            # Patch files in 章节提交 are candidates, not proof that their
            # operations committed. Only the ledger written in the same
            # transaction as current/archive changes is an application proof.
            load_patch_history(project_root)
            ledger = load_applied_patch_ledger(project_root)
            patch_content = render_patch_markdown(patch)
            patch_revision = sha256_text(patch_content)
            previous_application = ledger["patches"].get(patch["patch_id"])
            if previous_application is not None:
                if not isinstance(previous_application, dict) or previous_application.get("revision") != patch_revision:
                    raise MemorySystemError(
                        f"patch_id {patch['patch_id']} 已经使用过，但内容不同。请更换 patch_id。"
                    )
                if not args.dry_run:
                    # The applied ledger and current files are authoritative;
                    # the index is a rebuildable projection. A previous run
                    # may have committed the transaction and then failed while
                    # rebuilding the index, so every real idempotent retry must
                    # repair that projection before reporting success.
                    rebuild_index(project_root)
                print(f"补丁 {patch['patch_id']} 已应用过，本次幂等跳过；索引已校验。")
                return 0

            if patch["schema_version"] != 2:
                raise MemorySystemError("旧版 patch 仅支持向后读取；新应用请生成 schema v2 patch。")

            records = load_all_records(project_root)
            changes, report = prepare_changes(project_root, patch, records)
            ledger["patches"][patch["patch_id"]] = {
                "revision": patch_revision,
                "kind": patch["kind"],
                "chapter": int(patch["chapter"]),
                "applied_at": now_iso(),
            }
            ledger_path = applied_patch_ledger_path(project_root).resolve()
            changes[ledger_path] = json.dumps(ledger, ensure_ascii=False, indent=2) + "\n"
            report.append(f"应用凭据 -> {ledger_path.relative_to(project_root).as_posix()}")
            if patch["kind"] == "chapter_result":
                stored_patch_path = patch_source_path(project_root, patch).resolve()
                stored_patch_content = changes[stored_patch_path]
                assert isinstance(stored_patch_content, str)
                manifest = build_finalization_manifest(
                    project_root,
                    patch,
                    stored_patch_path,
                    stored_patch_content,
                )
                manifest_path = finalization_manifest_path(project_root, int(patch["chapter"])).resolve()
                changes[manifest_path] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
                report.append(f"最终化 manifest -> {manifest_path.relative_to(project_root).as_posix()}")
            if args.dry_run:
                validate_transaction_targets(project_root, changes)
            else:
                apply_transaction(project_root, changes)
                rebuild_index(project_root)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2
    except OSError:
        print("错误：记忆补丁所需文件无法稳定读取或写入。")
        return 2

    print(f"小说目录：{project_root}")
    print(f"current 目录：{current_dir}")
    print(f"补丁：{patch['patch_id']}（第{int(patch['chapter']):03d}章）")
    print("执行模式：" + ("dry-run，只校验不写入" if args.dry_run else "已写入"))
    for item in report:
        print(f"- {item}")
    if not args.dry_run:
        print("已更新 current、档案、补丁记录和可重建索引。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
