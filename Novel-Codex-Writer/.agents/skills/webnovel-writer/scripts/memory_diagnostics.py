"""Legacy migration helpers and actionable memory diagnostics."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Iterable, Mapping

from memory_index import build_index_data, index_stale
from memory_paths import assert_project_path, discover_arc_outlines, memory_source_files, parse_chapter_number, project_files
from memory_patch_schema import (
    MARKER_PREFIX,
    MARKER_RE,
    MemoryRecord,
    finalization_manifest_freshness,
    load_all_records,
    load_finalization_manifest,
    render_record,
)
from memory_transactions import MemorySystemError, inspect_transactions, read_text

CATEGORY_FILES = {
    "character": "当前人物状态.md",
    "relationship": "当前关系状态.md",
    "foreshadowing": "当前伏笔状态.md",
    "world": "当前世界状态.md",
    "setting": "当前世界状态.md",
    "scene": "当前世界状态.md",
    "timeline": "当前时间线.md",
    "asset": "当前物资与资产.md",
    "hard_fact": "不可违背事实.md",
    "workflow": "写作状态.md",
    "note": "其他当前状态.md",
}

def category_for_path(path: Path) -> str:
    name = path.name
    if "人物" in name or "角色" in name:
        return "character"
    if "关系" in name:
        return "relationship"
    if "伏笔" in name:
        return "foreshadowing"
    if "时间" in name:
        return "timeline"
    if "物资" in name or "资产" in name:
        return "asset"
    if "不可违背" in name or "事实" in name:
        return "hard_fact"
    if "世界" in name or "设定" in name:
        return "world"
    return "note"


def _extract_entities(text: str, heading: str) -> list[str]:
    entities: set[str] = set()
    if heading and not any(word in heading for word in ("当前", "其他", "规则", "状态", "时间", "资产", "伏笔", "事实")):
        entities.add(heading.strip())
    for match in re.finditer(r"(?:^|[，。；、\s-])([\u4e00-\u9fff]{2,4})[：:]", text):
        entities.add(match.group(1))
    return sorted(entities)


def _extract_tags(text: str, heading: str, category: str) -> list[str]:
    tags = {category}
    if heading:
        tags.add(heading.strip())
    tags.update(match.group(1).strip() for match in re.finditer(r"【([^】]{1,20})】", text))
    return sorted(tag for tag in tags if tag)


def add_legacy_markers(path: Path, project_root: Path) -> tuple[str, int]:
    path = assert_project_path(project_root, path, "旧记忆迁移来源")
    text = read_text(path)
    if not text:
        return text, 0
    relative = path.resolve().relative_to(project_root.resolve()).as_posix()
    category = category_for_path(path)
    lines = text.splitlines(keepends=True)
    output: list[str] = []
    heading = ""
    count = 0
    previous_was_marker = False
    for line in lines:
        heading_match = re.match(r"^#{2,6}\s+(.+?)\s*$", line.rstrip("\r\n"))
        if heading_match:
            heading = heading_match.group(1).strip()
        item = re.match(r"^(?:[-*+] |\d+\.\s+)(.+?)\s*$", line.rstrip("\r\n"))
        if item and not previous_was_marker:
            content = item.group(1).strip()
            digest = hashlib.sha1(f"{relative}\n{heading}\n{content}".encode("utf-8")).hexdigest()[:12]
            importance = "high" if category == "hard_fact" or any(word in content for word in ("不得", "必须", "不使用旧版")) else "normal"
            metadata = {
                "id": f"legacy-{digest}",
                "category": category,
                "status": "tentative" if any(word in content for word in ("计划", "待确认", "尚未")) else "active",
                "importance": importance,
                "valid_from": 1,
                "valid_to": None,
                "entities": _extract_entities(content, heading),
                "tags": _extract_tags(content, heading, category),
                "source_chapter": 0,
                "updated_by_patch": "legacy-migration-v1",
                "title": heading,
            }
            marker = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
            output.append(f"<!-- {MARKER_PREFIX} {marker} -->\n")
            count += 1
        output.append(line)
        previous_was_marker = bool(MARKER_RE.match(line.rstrip("\r\n")))
    return "".join(output), count


def workflow_blocker_text() -> str:
    metadata = {
        "id": "workflow.story-reset",
        "category": "workflow",
        "status": "active",
        "importance": "critical",
        "valid_from": 1,
        "valid_to": None,
        "entities": [],
        "tags": ["工作流阻断", "旧细纲", "正文重构"],
        "source_chapter": 0,
        "updated_by_patch": "legacy-migration-v1",
        "title": "旧细纲暂停使用",
    }
    content = (
        "当前正文已清空，新第001章尚未开始。旧第001—005章细纲与重构篇纲冲突，"
        "在这些细纲按新第一篇逐章重写并通过确认前，不得用它们生成正文。"
    )
    return "# 写作状态\n\n## 当前阻断\n\n" + render_record(metadata, content) + "\n"


def blocked_taskbook_from_legacy(legacy_text: str = "") -> str:
    if legacy_text.strip():
        converted = legacy_text.replace("本章上下文包", "本章写作任务书")
        converted = converted.replace("新的本章上下文包", "新的本章写作任务书")
        return converted.rstrip() + "\n\n## 记忆来源\n\n- `workflow.story-reset`\n"
    return (
        "# 本章写作任务书：暂停生成正文\n\n"
        "> 当前正文已清空，故事尚未从第001章重新开始。\n\n"
        "## 暂停原因\n\n"
        "- 旧第001—005章细纲尚未按重构版重写，不得用于生成新正文。\n\n"
        "## 下一步\n\n"
        "先按新第一篇重写并确认第001—005章细纲，再关闭 `workflow.story-reset`。\n\n"
        "## 记忆来源\n\n- `workflow.story-reset`\n"
    )

def append_record_to_text(text: str, record_text: str) -> str:
    base = text.rstrip()
    if "## 自动维护条目" not in base:
        base += "\n\n## 自动维护条目"
    return base + "\n\n" + record_text.strip() + "\n"


def remove_record_blocks(text: str, records: Iterable[MemoryRecord]) -> str:
    result = text
    for record in sorted(records, key=lambda item: item.start, reverse=True):
        result = result[:record.start] + result[record.end:]
    return re.sub(r"\n{4,}", "\n\n\n", result).rstrip() + "\n"


def prepare_record_file_changes(
    project_root: Path,
    removals: Mapping[Path, Iterable[MemoryRecord]],
    additions: Mapping[Path, Iterable[str]],
) -> dict[Path, str | None]:
    """Build canonical record-file updates without reading through an escaping link."""

    changes: dict[Path, str | None] = {}
    for path, records in removals.items():
        safe_path = assert_project_path(project_root, path, "记忆记录路径")
        changes[safe_path] = remove_record_blocks(read_text(safe_path), records)
    for target, blocks in additions.items():
        safe_target = assert_project_path(project_root, target, "记忆记录目标")
        content = changes.get(safe_target, read_text(safe_target))
        if not content.strip():
            content = f"# {safe_target.stem}\n"
        for block in blocks:
            content = append_record_to_text(content, block)
        changes[safe_target] = content
    return changes


def archive_path_for(project_root: Path, category: str) -> Path:
    safe_category = re.sub(r"[^a-z0-9_-]+", "-", category.lower()).strip("-") or "note"
    return project_root / "档案库" / "记忆历史" / f"{safe_category}.md"


def current_path_for(project_root: Path, category: str) -> Path:
    return project_root / "记忆库" / "current" / CATEGORY_FILES.get(category, CATEGORY_FILES["note"])


def diagnostics(project_root: Path, chapter: int | None = None) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    try:
        pending_transactions = inspect_transactions(project_root)
    except MemorySystemError as exc:
        pending_transactions = []
        findings.append({"severity": "error", "code": "TRANSACTION_INVALID", "message": str(exc)})
    for transaction in pending_transactions:
        severity = "error" if transaction["status"] == "missing_manifest" else "blocked"
        findings.append(
            {
                "severity": severity,
                "code": "TRANSACTION_PENDING",
                "message": f"发现未完成事务 {transaction['id']}；默认不会自动恢复，请显式执行 --recover。",
            }
        )
    try:
        discover_arc_outlines(project_root)
    except MemorySystemError as exc:
        findings.append({"severity": "error", "code": "OUTLINE_INVALID", "message": str(exc)})
    try:
        records = load_all_records(project_root)
    except MemorySystemError as exc:
        findings.append({"severity": "error", "code": "MEMORY_INVALID", "message": str(exc)})
        records = []
    for record in records:
        if record.metadata.get("category") == "workflow" and record.metadata.get("status") == "active":
            findings.append(
                {
                    "severity": "blocked",
                    "code": "WORKFLOW_BLOCKED",
                    "message": f"{record.record_id}：{record.content}",
                }
            )
    try:
        stale_index = index_stale(project_root)
    except MemorySystemError as exc:
        stale_index = True
        findings.append({"severity": "blocked", "code": "INDEX_SOURCE_INVALID", "message": str(exc)})
    if stale_index:
        findings.append(
            {"severity": "warning", "code": "INDEX_STALE", "message": "memory_index.json 缺失或已过期，可安全重建。"}
        )
    try:
        index_data = build_index_data(project_root)
    except MemorySystemError as exc:
        index_data = None
        findings.append({"severity": "blocked", "code": "PATCH_HISTORY_BLOCKED", "message": str(exc)})
    try:
        diagnostic_sources = memory_source_files(project_root)
    except MemorySystemError as exc:
        diagnostic_sources = []
        findings.append({"severity": "error", "code": "MEMORY_PATH_INVALID", "message": str(exc)})
    for path in diagnostic_sources:
        if "current" not in path.parts and path.name != "不可违背事实.md":
            continue
        text = read_text(path)
        unmarked = 0
        previous_marker = False
        for line in text.splitlines():
            item = re.match(r"^(?:[-*+] |\d+\.\s+).+", line)
            if item and not previous_marker:
                unmarked += 1
            previous_marker = bool(MARKER_RE.match(line))
        if unmarked:
            findings.append(
                {
                    "severity": "warning",
                    "code": "LEGACY_UNMARKED",
                    "message": f"{path.relative_to(project_root).as_posix()} 有 {unmarked} 条未结构化记忆。",
                }
            )
    conflict_groups: dict[str, list[MemoryRecord]] = {}
    for record in records:
        meta = record.metadata
        if meta.get("status") != "active" or record.archived:
            continue
        conflict_key = meta.get("conflict_key")
        if isinstance(conflict_key, str) and conflict_key.strip():
            conflict_groups.setdefault(conflict_key.strip(), []).append(record)
    for group in conflict_groups.values():
        contents = {item.content for item in group}
        if len(group) > 1 and len(contents) > 1:
            findings.append(
                {
                    "severity": "warning",
                    "code": "POTENTIAL_CONFLICT",
                    "message": "以下 active 条目可能描述同一事实但内容不同：" + ", ".join(item.record_id for item in group),
                }
            )
    for record in records:
        if record.metadata.get("source_chapter") is None:
            findings.append(
                {
                    "severity": "warning",
                    "code": "MISSING_SOURCE",
                    "message": f"记忆 {record.record_id} 缺少 source_chapter。",
                }
            )
    for manifest_path in project_files(
        project_root,
        project_root / "章节提交",
        "第*章_finalization.json",
        label="最终化 manifest 路径",
    ):
        try:
            manifest = load_finalization_manifest(manifest_path)
            fresh, reasons = finalization_manifest_freshness(project_root, manifest)
        except MemorySystemError as exc:
            findings.append({"severity": "error", "code": "MANIFEST_INVALID", "message": str(exc)})
            continue
        if not fresh:
            findings.append(
                {
                    "severity": "blocked",
                    "code": "FINALIZATION_STALE",
                    "message": f"第{manifest['chapter']:03d}章最终化产物已失效：" + "；".join(reasons),
                }
            )
    if chapter and chapter > 1 and index_data is not None:
        summaries = {int(item["chapter"]) for item in index_data["chapter_summaries"]}
        previous_chapter = chapter - 1
        previous_exists = any(
            parse_chapter_number(path, read_text(path)) == previous_chapter
            for path in project_files(project_root, project_root / "正文", "*.md", label="正文路径")
        )
        if previous_exists and previous_chapter not in summaries:
            findings.append(
                {
                    "severity": "error",
                    "code": "MISSING_PREVIOUS_SUMMARY",
                    "message": f"第{previous_chapter:03d}章已有正文，但缺少结构化 memory_patch。",
                }
            )
    return findings
