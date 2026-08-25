"""Rebuildable memory index and bounded query ranking."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from memory_paths import assert_project_path, memory_source_files, patch_source_files, project_files
from memory_patch_schema import (
    MemoryRecord,
    legacy_patch_classifications_path,
    applied_patch_ledger_path,
    load_applied_patch_ledger,
    load_finalization_manifest,
    load_all_records,
    load_patch_history,
    parse_memory_file,
    patch_classifications_path,
    select_chapter_result_patches,
)
from memory_transactions import MemorySystemError, atomic_write_json, now_iso, project_write_lock, read_text, sha256_file

INDEX_SCHEMA_VERSION = 2
SCHEMA_VERSION = INDEX_SCHEMA_VERSION
INDEX_NAME = "memory_index.json"


def _existing_index_file(project_root: Path) -> Path | None:
    raw_path = index_path(project_root)
    if raw_path.is_symlink() or getattr(raw_path, "is_junction", lambda: False)():
        raise MemorySystemError(f"记忆索引不能是符号链接或 junction：{raw_path}")
    if not raw_path.exists():
        return None
    path = assert_project_path(project_root, raw_path, "记忆索引")
    if not path.is_file():
        raise MemorySystemError(f"记忆索引不是普通文件：{path}")
    return path

def source_hashes(project_root: Path) -> dict[str, str]:
    paths = memory_source_files(project_root) + patch_source_files(project_root)
    for raw_classification_path in (patch_classifications_path(project_root), legacy_patch_classifications_path(project_root)):
        if raw_classification_path.exists() or raw_classification_path.is_symlink():
            if raw_classification_path.is_symlink() or getattr(raw_classification_path, "is_junction", lambda: False)():
                raise MemorySystemError(f"patch 分类文件不能是符号链接或 junction：{raw_classification_path}")
            classification_path = assert_project_path(project_root, raw_classification_path, "patch 分类文件")
            if not classification_path.is_file():
                raise MemorySystemError(f"patch 分类文件不是普通文件：{classification_path}")
            paths.append(classification_path)
    ledger_path = applied_patch_ledger_path(project_root)
    if ledger_path.exists() or ledger_path.is_symlink():
        if ledger_path.is_symlink() or getattr(ledger_path, "is_junction", lambda: False)():
            raise MemorySystemError(f"已应用补丁凭据不能是符号链接或 junction：{ledger_path}")
        safe_ledger_path = assert_project_path(project_root, ledger_path, "已应用补丁凭据")
        if not safe_ledger_path.is_file():
            raise MemorySystemError(f"已应用补丁凭据不是普通文件：{safe_ledger_path}")
        paths.append(safe_ledger_path)
    manifest_paths = project_files(
        project_root,
        project_root / "章节提交",
        "第*章_finalization.json",
        label="最终化 manifest 路径",
    )
    paths.extend(manifest_paths)
    for manifest_path in manifest_paths:
        manifest = load_finalization_manifest(manifest_path)
        evidence = [*manifest["sources"], manifest["patch"]]
        for item in evidence:
            target = assert_project_path(project_root, project_root / item["path"], "最终化索引来源")
            if target.is_file():
                paths.append(target)
    return {
        path.resolve().relative_to(project_root.resolve()).as_posix(): sha256_file(path)
        for path in sorted(set(paths))
    }


def build_index_data(project_root: Path) -> dict[str, Any]:
    records = load_all_records(project_root)
    patches = load_patch_history(project_root)
    chapter_results = select_chapter_result_patches(patches)
    applied_patch_ids = set(load_applied_patch_ledger(project_root)["patches"])
    serialized_records = []
    for record in records:
        metadata = record.metadata
        serialized_records.append(
            {
                "id": record.record_id,
                "category": metadata.get("category"),
                "status": metadata.get("status", "active"),
                "importance": metadata.get("importance", "normal"),
                "valid_from": metadata.get("valid_from"),
                "valid_to": metadata.get("valid_to"),
                "entities": metadata.get("entities", []),
                "tags": metadata.get("tags", []),
                "source_chapter": metadata.get("source_chapter"),
                "updated_by_patch": metadata.get("updated_by_patch"),
                "title": metadata.get("title", ""),
                "file": record.path.relative_to(project_root.resolve()).as_posix(),
                "line": record.line,
                "archived": record.archived,
            }
        )
    chapter_summaries = [
        {
            "chapter": patch["chapter"],
            "patch_id": patch["patch_id"],
            "kind": patch.get("effective_kind", patch.get("kind", "legacy_unknown")),
            "chapter_revision": patch.get("chapter_revision"),
            "summary": patch["summary"],
            "ending_state": patch["ending_state"],
        }
        for patch in chapter_results
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "source_hashes": source_hashes(project_root),
        "records": sorted(serialized_records, key=lambda item: item["id"]),
        "chapter_summaries": chapter_summaries,
        "applied_patch_ids": [
            patch["patch_id"]
            for patch in patches
            if patch.get("schema_version") == 1
            or patch.get("selected_by_manifest") is True
            or patch["patch_id"] in applied_patch_ids
        ],
    }


def index_path(project_root: Path) -> Path:
    root = project_root.resolve()
    raw_index_root = root / "记忆库" / "index"
    if raw_index_root.is_symlink() or getattr(raw_index_root, "is_junction", lambda: False)():
        raise MemorySystemError(f"记忆索引目录不能是符号链接或 junction：{raw_index_root}")
    safe_index_root = assert_project_path(root, raw_index_root, "记忆索引目录")
    raw_index_path = safe_index_root / INDEX_NAME
    if raw_index_path.is_symlink() or getattr(raw_index_path, "is_junction", lambda: False)():
        raise MemorySystemError(f"记忆索引不能是符号链接或 junction：{raw_index_path}")
    return raw_index_path


def _index_shape_valid(data: Any) -> bool:
    def relative_markdown_file_valid(value: Any) -> bool:
        if not isinstance(value, str) or not value or "\\" in value:
            return False
        path = PurePosixPath(value)
        return (
            not path.is_absolute()
            and path.suffix.lower() == ".md"
            and bool(path.parts)
            and all(part not in {"", ".", ".."} for part in path.parts)
        )

    def record_valid(item: Any) -> bool:
        return (
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and relative_markdown_file_valid(item.get("file"))
            and isinstance(item.get("entities"), list)
            and all(isinstance(value, str) for value in item["entities"])
            and isinstance(item.get("tags"), list)
            and all(isinstance(value, str) for value in item["tags"])
        )

    def summary_valid(item: Any) -> bool:
        return (
            isinstance(item, dict)
            and type(item.get("chapter")) is int
            and item["chapter"] > 0
            and all(isinstance(item.get(field), str) for field in ("patch_id", "kind", "summary", "ending_state"))
        )

    return (
        isinstance(data, dict)
        and type(data.get("schema_version")) is int
        and data["schema_version"] == SCHEMA_VERSION
        and isinstance(data.get("source_hashes"), dict)
        and all(isinstance(path, str) and isinstance(revision, str) for path, revision in data["source_hashes"].items())
        and isinstance(data.get("records"), list)
        and all(record_valid(item) for item in data["records"])
        and isinstance(data.get("chapter_summaries"), list)
        and all(summary_valid(item) for item in data["chapter_summaries"])
        and isinstance(data.get("applied_patch_ids"), list)
        and all(isinstance(item, str) for item in data["applied_patch_ids"])
    )


def _rebuild_index_unlocked(project_root: Path) -> dict[str, Any]:
    data = build_index_data(project_root)
    atomic_write_json(index_path(project_root), data)
    return data


def rebuild_index(project_root: Path) -> dict[str, Any]:
    with project_write_lock(project_root):
        return _rebuild_index_unlocked(project_root)


def index_stale(project_root: Path, data: dict[str, Any] | None = None) -> bool:
    path = _existing_index_file(project_root)
    if data is None:
        if path is None:
            return True
        try:
            data = json.loads(read_text(path))
        except (json.JSONDecodeError, OSError):
            return True
    return not _index_shape_valid(data) or data["source_hashes"] != source_hashes(project_root)


def _ensure_index_unlocked(project_root: Path, *, persist: bool = True) -> dict[str, Any]:
    path = _existing_index_file(project_root)
    if path is not None:
        try:
            data = json.loads(read_text(path))
        except json.JSONDecodeError:
            data = None
        except OSError as exc:
            raise MemorySystemError(f"无法读取记忆索引：{path}") from exc
        if isinstance(data, dict) and not index_stale(project_root, data):
            return data
    data = build_index_data(project_root)
    if persist:
        atomic_write_json(index_path(project_root), data)
    return data


def ensure_index(project_root: Path, *, persist: bool = True) -> dict[str, Any]:
    if not persist:
        return _ensure_index_unlocked(project_root, persist=False)
    with project_write_lock(project_root):
        return _ensure_index_unlocked(project_root, persist=True)


def _record_is_valid(metadata: dict[str, Any], chapter: int) -> bool:
    if metadata.get("status", "active") not in {"active", "tentative"}:
        return False
    valid_from = metadata.get("valid_from")
    valid_to = metadata.get("valid_to")
    if isinstance(valid_from, int) and chapter < valid_from:
        return False
    if isinstance(valid_to, int) and chapter > valid_to:
        return False
    return True


def rank_index_records(
    index: dict[str, Any],
    chapter: int,
    entities: Iterable[str] = (),
    tags: Iterable[str] = (),
    query_text: str = "",
    limit: int = 20,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not _index_shape_valid(index):
        raise MemorySystemError("memory_index.json 结构损坏，请重建索引。")
    wanted_entities = {value.strip() for value in entities if value.strip()}
    wanted_tags = {value.strip() for value in tags if value.strip()}
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    for item in index.get("records", []):
        if not _record_is_valid(item, chapter):
            continue
        score = 0
        importance = item.get("importance", "normal")
        category = item.get("category", "note")
        item_entities = set(item.get("entities", []))
        item_tags = set(item.get("tags", []))
        explicit_match = bool(wanted_entities & item_entities or wanted_tags & item_tags)
        if (wanted_entities or wanted_tags) and not explicit_match:
            if importance != "critical" and category != "workflow":
                continue
        if importance == "critical":
            score += 1000
        elif importance == "high":
            score += 60
        if category == "workflow":
            score += 900
        if wanted_entities & item_entities:
            score += 300
        if wanted_tags & item_tags:
            score += 240
        score += 120 * sum(1 for value in item_entities if value and value in query_text)
        score += 80 * sum(1 for value in item_tags if value and value in query_text)
        valid_to = item.get("valid_to")
        if category == "foreshadowing" and isinstance(valid_to, int) and chapter <= valid_to <= chapter + 5:
            score += 180
        if not item.get("archived"):
            score += 35
        source_chapter = item.get("source_chapter")
        if isinstance(source_chapter, int) and source_chapter <= chapter:
            score += max(0, 20 - min(20, chapter - source_chapter))
        # Do not treat every old current record as relevant merely because it is
        # still in current. A record must be critical/high, explicitly matched,
        # due soon, or recently changed to enter the bounded candidate set.
        if score > 35:
            ranked.append((score, str(item.get("id", "")), item))
    ranked.sort(key=lambda value: (-value[0], value[1]))
    critical_count = sum(1 for _, _, item in ranked if item.get("importance") == "critical")
    selected_count = max(limit, critical_count)
    selected = [item for _, _, item in ranked[:selected_count]]
    omitted = [item for _, _, item in ranked[selected_count:]]
    return selected, omitted


def load_indexed_records(project_root: Path, items: Iterable[dict[str, Any]]) -> list[MemoryRecord]:
    wanted = {str(item["id"]) for item in items}
    files = {
        assert_project_path(project_root, project_root / str(item["file"]), "索引来源")
        for item in items
    }
    found: dict[str, MemoryRecord] = {}
    for path in files:
        if not path.is_file():
            raise MemorySystemError(f"索引来源不是文件：{path}")
        for record in parse_memory_file(path, project_root):
            if record.record_id in wanted:
                found[record.record_id] = record
    missing = wanted - found.keys()
    if missing:
        raise MemorySystemError(f"索引指向的记忆条目不存在：{', '.join(sorted(missing))}。请重建索引。")
    return [found[str(item["id"])] for item in items]
