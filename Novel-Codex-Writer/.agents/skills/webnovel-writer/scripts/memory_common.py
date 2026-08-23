#!/usr/bin/env python3
"""Shared deterministic memory helpers for the webnovel-writer skill."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


INDEX_SCHEMA_VERSION = 2
PATCH_SCHEMA_VERSION = 2
# Backward-compatible alias used by the rebuildable index.
SCHEMA_VERSION = INDEX_SCHEMA_VERSION
TASKBOOK_NAME = "本章写作任务书.md"
LEGACY_CONTEXT_NAME = "本章上下文包.md"
INDEX_NAME = "memory_index.json"
MARKER_PREFIX = "webnovel-memory:"
MARKER_RE = re.compile(
    r"^[ \t]*<!--\s*webnovel-memory:\s*(\{.*\})\s*-->[ \t]*$",
    re.MULTILINE,
)
ARC_FILE_RE = re.compile(r"^第\d+篇_.+\.md$")
ARC_RANGE_RE = re.compile(
    r"章节范围\s*[：:]\s*第?\s*0*(\d+)\s*[—–－\-~～至到]+\s*第?\s*0*(\d+)\s*章"
)
CHAPTER_RE = re.compile(r"第\s*0*(\d+)\s*章")
VALID_STATUSES = {"active", "tentative", "closed", "outdated", "contradicted"}
VALID_IMPORTANCE = {"critical", "high", "normal", "low"}
VALID_ACTIONS = {"upsert", "close", "archive"}
VALID_PATCH_KINDS = {"chapter_result", "outline_baseline", "migration", "legacy_unknown"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,80}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
PATCH_CLASSIFICATIONS_NAME = "patch_classifications.json"
PATCH_COMPAT_DIR_NAME = "compat"
FINALIZATION_MANIFEST_SCHEMA_VERSION = 1
FINALIZATION_MANIFEST_RE = re.compile(r"^第(\d+)章_finalization\.json$")

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


class MemorySystemError(RuntimeError):
    """A user-facing validation error."""


@dataclass(frozen=True)
class ArcOutline:
    path: Path
    start: int
    end: int
    title: str


@dataclass(frozen=True)
class MemoryRecord:
    metadata: dict[str, Any]
    content: str
    path: Path
    start: int
    end: int
    line: int
    archived: bool

    @property
    def record_id(self) -> str:
        return str(self.metadata["id"])


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig") if path.exists() else ""


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(content, encoding="utf-8", newline="")
    os.replace(temporary, path)


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def skill_repo_root() -> Path | None:
    resolved = Path(__file__).resolve()
    return resolved.parents[4] if len(resolved.parents) > 4 else None


def resolve_library_root(value: str | Path) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or candidate.exists():
        return candidate.resolve()
    root = skill_repo_root()
    if root and (root / candidate).exists():
        return (root / candidate).resolve()
    return candidate.resolve()


def load_project_registry(library_root: Path) -> dict[str, Any]:
    library_root = library_root.resolve()
    index_path = library_root / "projects.json"
    if not index_path.exists():
        raise MemorySystemError(f"找不到作品库清单：{index_path}")
    try:
        index = json.loads(read_text(index_path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"作品库清单不是有效 JSON：{index_path}（{exc}）") from exc
    if not isinstance(index, dict) or not isinstance(index.get("projects"), list):
        raise MemorySystemError(f"作品库清单格式不正确：{index_path}")
    return index


def registered_project_roots(library_root: Path) -> dict[str, Path]:
    index = load_project_registry(library_root)
    roots: dict[str, Path] = {}
    projects_root = (library_root.resolve() / "作品").resolve()
    for item in index.get("projects", []):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        project_id = item["id"].strip()
        if not project_id or Path(project_id).name != project_id:
            continue
        resolved = (projects_root / project_id).resolve()
        try:
            resolved.relative_to(projects_root)
        except ValueError:
            continue
        if resolved == projects_root:
            continue
        roots[project_id] = resolved
    return roots


def resolve_project_root(library_root: Path, project_root: str | Path | None) -> Path:
    library_root = library_root.resolve()
    index = load_project_registry(library_root)
    roots = registered_project_roots(library_root)
    if project_root:
        candidate = Path(project_root)
        candidate = candidate if candidate.is_absolute() else Path.cwd() / candidate
        resolved = candidate.resolve()
        registered = next((path for path in roots.values() if path == resolved), None)
        if registered is None:
            raise MemorySystemError(f"拒绝访问未登记在 projects.json 中的小说目录：{resolved}")
        if not registered.exists():
            raise MemorySystemError(f"找不到小说目录：{registered}")
        return registered

    active_project_id = index.get("activeProjectId")
    if not active_project_id:
        raise MemorySystemError("当前没有选中的小说。请先在网页端新建或选择小说。")
    resolved = roots.get(str(active_project_id))
    if resolved is None:
        raise MemorySystemError(f"activeProjectId 未登记在 projects.json：{active_project_id}")
    if not resolved.exists():
        raise MemorySystemError(f"找不到当前小说目录：{resolved}")
    return resolved


def project_root_from_current(current_dir: Path, library_root: Path | None = None) -> Path:
    resolved = current_dir.resolve()
    if resolved.name != "current" or resolved.parent.name != "记忆库":
        raise MemorySystemError(
            f"--current-dir 必须指向小说的 记忆库/current 目录：{resolved}"
        )
    project_root = resolved.parents[1]
    if library_root is not None:
        return resolve_project_root(library_root, project_root)
    return project_root


def assert_project_path(project_root: Path, candidate: Path, label: str = "路径") -> Path:
    root = project_root.resolve()
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise MemorySystemError(f"{label}越出当前小说目录：{resolved}")
    return resolved


def resolve_project_path(project_root: Path, value: str | Path, label: str = "路径") -> Path:
    candidate = Path(value)
    resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
    return assert_project_path(project_root, resolved, label)


def normalize_chapter(value: str | int) -> tuple[int, str]:
    match = re.search(r"\d+", str(value))
    if not match:
        raise MemorySystemError(f"章节号必须包含数字，例如 1 或 001。当前输入：{value}")
    number = int(match.group(0))
    if number <= 0:
        raise MemorySystemError("章节号必须大于 0。")
    return number, f"{number:03d}"


def extract_markdown_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return fallback


def discover_arc_outlines(project_root: Path) -> list[ArcOutline]:
    outline_dir = project_root / "大纲"
    candidates = sorted(
        path for path in outline_dir.glob("*.md") if ARC_FILE_RE.match(path.name)
    )
    if not candidates:
        raise MemorySystemError(f"没有找到篇纲：{outline_dir / '第NN篇_篇名.md'}")

    arcs: list[ArcOutline] = []
    missing_ranges: list[str] = []
    for path in candidates:
        content = read_text(path)
        match = ARC_RANGE_RE.search(content)
        if not match:
            missing_ranges.append(path.name)
            continue
        start, end = int(match.group(1)), int(match.group(2))
        if start <= 0 or end < start:
            raise MemorySystemError(f"篇纲章节范围无效：{path.name}（{start}-{end}）")
        arcs.append(ArcOutline(path, start, end, extract_markdown_title(content, path.stem)))

    if missing_ranges:
        joined = "、".join(missing_ranges)
        raise MemorySystemError(f"以下篇纲缺少“章节范围”声明：{joined}")

    ordered = sorted(arcs, key=lambda item: (item.start, item.end, item.path.name))
    for previous, current in zip(ordered, ordered[1:]):
        if current.start <= previous.end:
            raise MemorySystemError(
                "篇纲章节范围重叠："
                f"{previous.path.name}（{previous.start:03d}-{previous.end:03d}）与 "
                f"{current.path.name}（{current.start:03d}-{current.end:03d}）"
            )
    return ordered


def select_arc_outline(project_root: Path, chapter: int) -> ArcOutline:
    matches = [arc for arc in discover_arc_outlines(project_root) if arc.start <= chapter <= arc.end]
    if not matches:
        raise MemorySystemError(f"没有篇纲覆盖第{chapter:03d}章。请检查各篇纲的章节范围。")
    if len(matches) != 1:
        names = "、".join(item.path.name for item in matches)
        raise MemorySystemError(f"第{chapter:03d}章同时匹配多个篇纲：{names}")
    return matches[0]


def parse_chapter_number(path: Path, content: str = "") -> int | None:
    for value in (path.stem, extract_markdown_title(content, "")):
        match = CHAPTER_RE.search(value)
        if match:
            return int(match.group(1))
        match = re.search(r"(?:chapter|chap|ch)[_\s-]*0*(\d+)", value, re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def find_blueprint(project_root: Path, chapter: int) -> Path | None:
    label = f"{chapter:03d}"
    outline_dir = project_root / "大纲"
    candidates = (
        outline_dir / f"细纲_第{label}章.md",
        outline_dir / f"细纲_第{chapter}章.md",
        outline_dir / f"第{label}章_细纲.md",
        outline_dir / f"第{chapter}章_细纲.md",
    )
    return next((path for path in candidates if path.exists()), None)


def memory_source_files(project_root: Path) -> list[Path]:
    current_dir = project_root / "记忆库" / "current"
    paths = [
        path
        for path in current_dir.glob("*.md")
        if path.name not in {TASKBOOK_NAME, LEGACY_CONTEXT_NAME}
    ]
    archive_root = project_root / "档案库"
    if archive_root.exists():
        paths.extend(archive_root.rglob("*.md"))
    return sorted({path.resolve() for path in paths})


def patch_source_files(project_root: Path) -> list[Path]:
    commit_dir = project_root / "章节提交"
    return sorted(commit_dir.glob("memory_patch_*.md")) if commit_dir.exists() else []


def _validate_metadata(metadata: dict[str, Any], path: Path) -> None:
    record_id = metadata.get("id")
    if not isinstance(record_id, str) or not ID_RE.fullmatch(record_id):
        raise MemorySystemError(f"记忆 ID 无效：{record_id!r}（{path}）")
    status = metadata.get("status", "active")
    if status not in VALID_STATUSES:
        raise MemorySystemError(f"记忆状态无效：{status!r}（{record_id}）")
    importance = metadata.get("importance", "normal")
    if importance not in VALID_IMPORTANCE:
        raise MemorySystemError(f"记忆重要度无效：{importance!r}（{record_id}）")
    if not isinstance(metadata.get("category"), str) or not metadata["category"].strip():
        raise MemorySystemError(f"记忆缺少 category：{record_id}")
    for field in ("entities", "tags"):
        value = metadata.get(field, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise MemorySystemError(f"记忆字段 {field} 必须是字符串数组：{record_id}")
    for field in ("valid_from", "valid_to", "source_chapter"):
        value = metadata.get(field)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise MemorySystemError(f"记忆字段 {field} 必须是非负整数或 null：{record_id}")


def parse_memory_file(path: Path, project_root: Path) -> list[MemoryRecord]:
    text = read_text(path)
    matches = list(MARKER_RE.finditer(text))
    records: list[MemoryRecord] = []
    for index, match in enumerate(matches):
        try:
            metadata = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            raise MemorySystemError(f"记忆元数据不是有效 JSON：{path}:{text.count(chr(10), 0, match.start()) + 1}") from exc
        if not isinstance(metadata, dict):
            raise MemorySystemError(f"记忆元数据必须是 JSON 对象：{path}")
        _validate_metadata(metadata, path)
        content_start = match.end()
        if text[content_start:content_start + 2] == "\r\n":
            content_start += 2
        elif text[content_start:content_start + 1] == "\n":
            content_start += 1
        candidate_end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        segment = text[content_start:candidate_end]
        heading = re.search(r"(?m)^#{1,6}\s+", segment)
        content_end = content_start + (heading.start() if heading else len(segment))
        content = text[content_start:content_end].strip()
        if not content:
            raise MemorySystemError(f"记忆条目没有正文：{metadata['id']}（{path}）")
        line = text.count("\n", 0, match.start()) + 1
        records.append(
            MemoryRecord(
                metadata=metadata,
                content=content,
                path=path.resolve(),
                start=match.start(),
                end=content_end,
                line=line,
                archived="档案库" in path.resolve().relative_to(project_root.resolve()).parts,
            )
        )
    return records


def load_all_records(project_root: Path) -> list[MemoryRecord]:
    records: list[MemoryRecord] = []
    seen: dict[str, Path] = {}
    for path in memory_source_files(project_root):
        for record in parse_memory_file(path, project_root):
            if record.record_id in seen:
                raise MemorySystemError(
                    f"重复记忆 ID：{record.record_id}（{seen[record.record_id]} 与 {record.path}）"
                )
            seen[record.record_id] = record.path
            records.append(record)
    return records


def render_record(metadata: dict[str, Any], content: str) -> str:
    normalized = dict(metadata)
    normalized.setdefault("status", "active")
    normalized.setdefault("importance", "normal")
    normalized.setdefault("valid_from", 0)
    normalized.setdefault("valid_to", None)
    normalized.setdefault("entities", [])
    normalized.setdefault("tags", [])
    marker = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    return f"<!-- {MARKER_PREFIX} {marker} -->\n{content.strip()}"


def load_patch(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise MemorySystemError(f"找不到 memory_patch：{path}")
    text = read_text(path).strip()
    fenced = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL | re.IGNORECASE)
    payload = fenced.group(1) if fenced else text
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"memory_patch 不是有效 JSON：{path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise MemorySystemError("memory_patch 顶层必须是 JSON 对象。")
    return data


def _validate_revision_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise MemorySystemError("source_revisions 必须是“项目内相对路径 -> SHA-256”的对象。")
    normalized: dict[str, str] = {}
    for raw_path, raw_revision in value.items():
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise MemorySystemError("source_revisions 的路径必须是非空字符串。")
        path = Path(raw_path.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise MemorySystemError(f"source_revisions 包含越界路径：{raw_path}")
        if not isinstance(raw_revision, str) or not SHA256_RE.fullmatch(raw_revision.lower()):
            raise MemorySystemError(f"source_revisions 的 revision 不是 SHA-256：{raw_path}")
        normalized[path.as_posix()] = raw_revision.lower()
    return normalized


def validate_patch(patch: dict[str, Any]) -> dict[str, Any]:
    required = ("schema_version", "patch_id", "chapter", "summary", "ending_state", "operations")
    missing = [field for field in required if field not in patch]
    if missing:
        raise MemorySystemError(f"memory_patch 缺少字段：{', '.join(missing)}")
    schema_version = patch["schema_version"]
    if schema_version not in {1, PATCH_SCHEMA_VERSION}:
        raise MemorySystemError(
            f"不支持的 schema_version：{schema_version}，当前支持 1 和 {PATCH_SCHEMA_VERSION}。"
        )
    patch_id = patch["patch_id"]
    if not isinstance(patch_id, str) or not ID_RE.fullmatch(patch_id):
        raise MemorySystemError(f"patch_id 无效：{patch_id!r}")
    if not isinstance(patch["chapter"], int) or patch["chapter"] <= 0:
        raise MemorySystemError("chapter 必须是大于 0 的整数。")
    if not isinstance(patch["summary"], str) or not patch["summary"].strip():
        raise MemorySystemError("summary 必须是非空字符串。")
    if not isinstance(patch["ending_state"], str) or not patch["ending_state"].strip():
        raise MemorySystemError("ending_state 必须是非空字符串。")
    operations = patch["operations"]
    if not isinstance(operations, list):
        raise MemorySystemError("operations 必须是数组。")

    normalized = dict(patch)
    if schema_version == 1:
        normalized["kind"] = "legacy_unknown"
        normalized["chapter_revision"] = None
        normalized["source_revisions"] = {}
    else:
        kind = patch.get("kind")
        if kind not in VALID_PATCH_KINDS - {"legacy_unknown"}:
            raise MemorySystemError(f"memory_patch kind 无效：{kind!r}")
        chapter_revision = patch.get("chapter_revision")
        if kind == "chapter_result":
            if not isinstance(chapter_revision, str) or not SHA256_RE.fullmatch(chapter_revision.lower()):
                raise MemorySystemError("chapter_result 必须提供正文 SHA-256：chapter_revision。")
            normalized["chapter_revision"] = chapter_revision.lower()
        elif chapter_revision is not None:
            if not isinstance(chapter_revision, str) or not SHA256_RE.fullmatch(chapter_revision.lower()):
                raise MemorySystemError("chapter_revision 必须是 SHA-256 或 null。")
            normalized["chapter_revision"] = chapter_revision.lower()
        else:
            normalized["chapter_revision"] = None
        normalized["kind"] = kind
        normalized["source_revisions"] = _validate_revision_map(patch.get("source_revisions", {}))
        if kind == "chapter_result" and not normalized["source_revisions"]:
            raise MemorySystemError("chapter_result 必须提供非空 source_revisions。")
    normalized_operations: list[dict[str, Any]] = []
    touched: set[str] = set()
    for position, operation in enumerate(operations, start=1):
        if not isinstance(operation, dict):
            raise MemorySystemError(f"第 {position} 个 operation 必须是对象。")
        action = operation.get("action")
        if action not in VALID_ACTIONS:
            raise MemorySystemError(f"第 {position} 个 operation 的 action 无效：{action!r}")
        if action == "upsert":
            record = operation.get("record")
            if not isinstance(record, dict):
                raise MemorySystemError(f"第 {position} 个 upsert 缺少 record 对象。")
            record = dict(record)
            if not isinstance(record.get("content"), str) or not record["content"].strip():
                raise MemorySystemError(f"第 {position} 个 upsert 缺少非空 content。")
            metadata = {key: value for key, value in record.items() if key != "content"}
            metadata.setdefault("status", "active")
            metadata.setdefault("importance", "normal")
            metadata.setdefault("valid_from", patch["chapter"])
            metadata.setdefault("valid_to", None)
            metadata.setdefault("entities", [])
            metadata.setdefault("tags", [])
            metadata.setdefault("source_chapter", patch["chapter"])
            metadata["updated_by_patch"] = patch_id
            _validate_metadata(metadata, Path(f"operation[{position}]"))
            normalized_operation = {"action": action, "record": {**metadata, "content": record["content"].strip()}}
            record_id = metadata["id"]
        else:
            record_id = operation.get("id")
            if not isinstance(record_id, str) or not ID_RE.fullmatch(record_id):
                raise MemorySystemError(f"第 {position} 个 {action} 的 id 无效：{record_id!r}")
            reason = operation.get("reason", "")
            if reason is not None and not isinstance(reason, str):
                raise MemorySystemError(f"第 {position} 个 {action} 的 reason 必须是字符串。")
            normalized_operation = {"action": action, "id": record_id, "reason": reason or ""}
        if record_id in touched:
            raise MemorySystemError(f"同一个补丁不能重复操作记忆 ID：{record_id}")
        touched.add(record_id)
        normalized_operations.append(normalized_operation)
    normalized["operations"] = normalized_operations
    normalized["summary"] = normalized["summary"].strip()
    normalized["ending_state"] = normalized["ending_state"].strip()
    return normalized


def render_patch_markdown(patch: dict[str, Any]) -> str:
    chapter = int(patch["chapter"])
    return (
        f"# 第{chapter:03d}章 memory_patch\n\n"
        f"> patch_id：`{patch['patch_id']}`\n\n"
        "```json\n"
        f"{json.dumps(patch, ensure_ascii=False, indent=2)}\n"
        "```\n"
    )


def patch_classifications_path(project_root: Path) -> Path:
    return project_root / "章节提交" / PATCH_COMPAT_DIR_NAME / PATCH_CLASSIFICATIONS_NAME


def legacy_patch_classifications_path(project_root: Path) -> Path:
    return project_root / "章节提交" / PATCH_CLASSIFICATIONS_NAME


def patch_classifications_read_path(project_root: Path) -> Path:
    current = patch_classifications_path(project_root)
    return current if current.exists() else legacy_patch_classifications_path(project_root)


def load_patch_classifications(project_root: Path) -> dict[str, str]:
    path = patch_classifications_read_path(project_root)
    if not path.exists():
        return {}
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"patch 分类文件不是有效 JSON：{path}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise MemorySystemError(f"patch 分类文件格式不正确：{path}")
    values = payload.get("classifications", {})
    if not isinstance(values, dict):
        raise MemorySystemError(f"patch 分类列表格式不正确：{path}")
    result: dict[str, str] = {}
    for patch_id, kind in values.items():
        if not isinstance(patch_id, str) or not ID_RE.fullmatch(patch_id):
            raise MemorySystemError(f"patch 分类包含无效 patch_id：{patch_id!r}")
        if kind not in VALID_PATCH_KINDS - {"legacy_unknown"}:
            raise MemorySystemError(f"patch 分类包含无效 kind：{kind!r}")
        result[patch_id] = kind
    return result


def patch_classification_payload(classifications: dict[str, str]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "updated_at": now_iso(),
        "classifications": dict(sorted(classifications.items())),
    }


def finalization_manifest_path(project_root: Path, chapter: int) -> Path:
    return project_root / "章节提交" / f"第{chapter:03d}章_finalization.json"


def _revision_source_paths(project_root: Path, patch: dict[str, Any]) -> dict[str, Path]:
    resolved: dict[str, Path] = {}
    for relative, expected_revision in patch.get("source_revisions", {}).items():
        target = assert_project_path(project_root, project_root / relative, "revision 来源")
        if not target.is_file():
            raise MemorySystemError(f"revision 来源不存在：{relative}")
        actual_revision = sha256_file(target)
        if actual_revision != expected_revision:
            raise MemorySystemError(
                f"revision 来源已变化：{relative}（期望 {expected_revision[:12]}，实际 {actual_revision[:12]}）"
            )
        resolved[relative] = target
    return resolved


def validate_patch_source_revisions(project_root: Path, patch: dict[str, Any]) -> dict[str, Path]:
    """Validate chapter-result evidence without changing any project file."""

    if patch.get("kind") != "chapter_result":
        return _revision_source_paths(project_root, patch)

    chapter = int(patch["chapter"])
    sources = _revision_source_paths(project_root, patch)
    source_paths = set(sources)
    body_sources = [
        (relative, path)
        for relative, path in sources.items()
        if Path(relative).parts[:1] == ("正文",)
        and parse_chapter_number(path, read_text(path)) == chapter
    ]
    if len(body_sources) != 1:
        raise MemorySystemError(f"chapter_result 必须且只能绑定一份第{chapter:03d}章正文。")
    body_relative, body_path = body_sources[0]
    if sha256_file(body_path) != patch.get("chapter_revision"):
        raise MemorySystemError(f"chapter_revision 与正文 {body_relative} 不一致。")

    blueprint = find_blueprint(project_root, chapter)
    if blueprint is None:
        raise MemorySystemError(f"第{chapter:03d}章缺少细纲，不能最终化。")
    blueprint_relative = blueprint.relative_to(project_root).as_posix()
    if blueprint_relative not in source_paths:
        raise MemorySystemError(f"source_revisions 缺少细纲：{blueprint_relative}")

    taskbook_relative = f"记忆库/current/{TASKBOOK_NAME}"
    if taskbook_relative not in source_paths:
        raise MemorySystemError(f"source_revisions 缺少任务书：{taskbook_relative}")

    review_sources = [
        path
        for relative, path in sources.items()
        if Path(relative).parts[:1] == ("审查报告",)
        and parse_chapter_number(path, read_text(path)) == chapter
    ]
    if len(review_sources) != 1:
        raise MemorySystemError(f"chapter_result 必须且只能绑定一份第{chapter:03d}章审查报告。")

    commit_sources = [
        path
        for relative, path in sources.items()
        if Path(relative).parts[:1] == ("章节提交",)
        and path.suffix.lower() == ".md"
        and not path.name.startswith("memory_patch_")
        and parse_chapter_number(path, read_text(path)) == chapter
    ]
    if len(commit_sources) != 1:
        raise MemorySystemError(f"chapter_result 必须且只能绑定一份第{chapter:03d}章提交记录。")

    chapter_revision = str(patch["chapter_revision"])
    for label, evidence_path in (("审查报告", review_sources[0]), ("章节提交", commit_sources[0])):
        if chapter_revision not in read_text(evidence_path):
            relative = evidence_path.relative_to(project_root).as_posix()
            raise MemorySystemError(f"{label}未记录正文 revision，不能证明对应当前正文：{relative}")
    return sources


def build_finalization_manifest(
    project_root: Path,
    patch: dict[str, Any],
    patch_path: Path,
    patch_content: str,
) -> dict[str, Any]:
    sources = validate_patch_source_revisions(project_root, patch)
    return {
        "schema_version": FINALIZATION_MANIFEST_SCHEMA_VERSION,
        "chapter": int(patch["chapter"]),
        "status": "finalized",
        "patch_id": patch["patch_id"],
        "finalized_at": now_iso(),
        "chapter_revision": patch.get("chapter_revision"),
        "sources": [
            {"path": relative, "revision": patch["source_revisions"][relative]}
            for relative in sorted(sources)
        ],
        "patch": {
            "path": patch_path.relative_to(project_root).as_posix(),
            "revision": sha256_text(patch_content),
        },
    }


def load_finalization_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"章节最终化 manifest 不是有效 JSON：{path}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != FINALIZATION_MANIFEST_SCHEMA_VERSION:
        raise MemorySystemError(f"章节最终化 manifest 版本不受支持：{path}")
    if not isinstance(manifest.get("chapter"), int) or manifest["chapter"] <= 0:
        raise MemorySystemError(f"章节最终化 manifest 缺少有效 chapter：{path}")
    return manifest


def finalization_manifest_freshness(project_root: Path, manifest: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    evidence = list(manifest.get("sources", []))
    patch = manifest.get("patch")
    if isinstance(patch, dict):
        evidence.append({"path": patch.get("path"), "revision": patch.get("revision")})
    else:
        reasons.append("缺少 patch 绑定")
    for item in evidence:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            reasons.append("存在无效来源记录")
            continue
        relative = item["path"]
        expected = item.get("revision")
        try:
            target = assert_project_path(project_root, project_root / relative, "manifest 来源")
        except MemorySystemError as exc:
            reasons.append(str(exc))
            continue
        if not target.is_file():
            reasons.append(f"文件已缺失：{relative}")
        elif not isinstance(expected, str) or sha256_file(target) != expected:
            reasons.append(f"文件已变化：{relative}")
    return not reasons, reasons


def chapter_finalization_status(project_root: Path, chapter: int) -> dict[str, Any]:
    path = finalization_manifest_path(project_root, chapter)
    if not path.exists():
        return {"status": "missing", "path": path.relative_to(project_root).as_posix(), "reasons": []}
    manifest = load_finalization_manifest(path)
    fresh, reasons = finalization_manifest_freshness(project_root, manifest)
    return {
        "status": "finalized" if fresh else "stale",
        "path": path.relative_to(project_root).as_posix(),
        "reasons": reasons,
        "manifest": manifest,
    }


def load_patch_history(project_root: Path) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    ids: set[str] = set()
    classifications = load_patch_classifications(project_root)
    manifest_selection: dict[int, str] = {}
    for manifest_path in sorted((project_root / "章节提交").glob("第*章_finalization.json")):
        manifest = load_finalization_manifest(manifest_path)
        if isinstance(manifest.get("patch_id"), str):
            manifest_selection[int(manifest["chapter"])] = str(manifest["patch_id"])
    for path in patch_source_files(project_root):
        patch = validate_patch(load_patch(path))
        patch_id = patch["patch_id"]
        if patch_id in ids:
            raise MemorySystemError(f"章节提交中存在重复 patch_id：{patch_id}")
        ids.add(patch_id)
        if patch["kind"] == "legacy_unknown" and patch_id in classifications:
            patch = {**patch, "kind": classifications[patch_id]}
        if manifest_selection.get(int(patch["chapter"])) == patch_id:
            patch = {**patch, "selected_by_manifest": True}
        history.append(patch)
    return sorted(history, key=lambda item: (int(item["chapter"]), str(item["patch_id"])))


def select_chapter_result_patches(patches: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for patch in patches:
        grouped.setdefault(int(patch["chapter"]), []).append(patch)
    selected: list[dict[str, Any]] = []
    for chapter, items in sorted(grouped.items()):
        explicit = [item for item in items if item.get("kind") == "chapter_result"]
        if len(explicit) > 1:
            selected_by_manifest = [item for item in explicit if item.get("selected_by_manifest") is True]
            if len(selected_by_manifest) == 1:
                selected.append(selected_by_manifest[0])
                continue
            labels = "、".join(str(item["patch_id"]) for item in explicit)
            raise MemorySystemError(f"第{chapter:03d}章存在多个 chapter_result patch 且 manifest 未唯一选定：{labels}")
        if explicit:
            selected.append(explicit[0])
            continue
        legacy = [item for item in items if item.get("kind") == "legacy_unknown"]
        if len(legacy) > 1:
            labels = "、".join(str(item["patch_id"]) for item in legacy)
            raise MemorySystemError(
                f"第{chapter:03d}章存在多个未分类旧 patch：{labels}。请先确认哪一个是 chapter_result。"
            )
        if legacy:
            selected.append({**legacy[0], "effective_kind": "chapter_result"})
    return selected


def source_hashes(project_root: Path) -> dict[str, str]:
    paths = memory_source_files(project_root) + patch_source_files(project_root)
    for classification_path in (patch_classifications_path(project_root), legacy_patch_classifications_path(project_root)):
        if classification_path.exists():
            paths.append(classification_path)
    paths.extend(sorted((project_root / "章节提交").glob("第*章_finalization.json")))
    return {
        path.resolve().relative_to(project_root.resolve()).as_posix(): sha256_file(path)
        for path in sorted(paths)
    }


def build_index_data(project_root: Path) -> dict[str, Any]:
    records = load_all_records(project_root)
    patches = load_patch_history(project_root)
    chapter_results = select_chapter_result_patches(patches)
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
        "applied_patch_ids": [patch["patch_id"] for patch in patches],
    }


def index_path(project_root: Path) -> Path:
    return project_root / "记忆库" / "index" / INDEX_NAME


def rebuild_index(project_root: Path) -> dict[str, Any]:
    data = build_index_data(project_root)
    atomic_write_json(index_path(project_root), data)
    return data


def index_stale(project_root: Path, data: dict[str, Any] | None = None) -> bool:
    path = index_path(project_root)
    if data is None:
        if not path.exists():
            return True
        try:
            data = json.loads(read_text(path))
        except (json.JSONDecodeError, OSError):
            return True
    return data.get("schema_version") != SCHEMA_VERSION or data.get("source_hashes") != source_hashes(project_root)


def ensure_index(project_root: Path, *, persist: bool = True) -> dict[str, Any]:
    path = index_path(project_root)
    if path.exists():
        try:
            data = json.loads(read_text(path))
        except json.JSONDecodeError:
            data = None
        if data is not None and not index_stale(project_root, data):
            return data
    data = build_index_data(project_root)
    if persist:
        atomic_write_json(path, data)
    return data


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
    files = {project_root / str(item["file"]) for item in items}
    found: dict[str, MemoryRecord] = {}
    for path in files:
        for record in parse_memory_file(path, project_root):
            if record.record_id in wanted:
                found[record.record_id] = record
    missing = wanted - found.keys()
    if missing:
        raise MemorySystemError(f"索引指向的记忆条目不存在：{', '.join(sorted(missing))}。请重建索引。")
    return [found[str(item["id"])] for item in items]


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


def inspect_transactions(project_root: Path) -> list[dict[str, Any]]:
    transaction_root = project_root / "记忆库" / ".transactions"
    if not transaction_root.exists():
        return []
    pending: list[dict[str, Any]] = []
    for directory in sorted(path for path in transaction_root.iterdir() if path.is_dir()):
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            pending.append({"id": directory.name, "status": "missing_manifest", "legacy": True, "files": []})
            continue
        try:
            manifest = json.loads(read_text(manifest_path))
        except json.JSONDecodeError:
            raise MemorySystemError(f"事务恢复清单损坏，请人工检查：{manifest_path}")
        if manifest.get("status") == "complete":
            continue
        files = manifest.get("files", []) if isinstance(manifest.get("files"), list) else []
        pending.append(
            {
                "id": directory.name,
                "status": str(manifest.get("status", "unknown")),
                "legacy": any("before_hash" not in item or "staged_hash" not in item for item in files if isinstance(item, dict)),
                "files": [str(item.get("target", "")) for item in files if isinstance(item, dict)],
            }
        )
    return pending


def recover_transactions(project_root: Path, *, force_legacy: bool = False) -> list[str]:
    transaction_root = project_root / "记忆库" / ".transactions"
    recovered: list[str] = []
    if not transaction_root.exists():
        return recovered
    for directory in sorted(path for path in transaction_root.iterdir() if path.is_dir()):
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            raise MemorySystemError(f"事务目录缺少 manifest.json，请人工检查：{directory}")
        try:
            manifest = json.loads(read_text(manifest_path))
        except json.JSONDecodeError as exc:
            raise MemorySystemError(f"事务恢复清单损坏，请人工检查：{manifest_path}") from exc
        if manifest.get("status") == "complete":
            shutil.rmtree(directory, ignore_errors=True)
            continue
        files = manifest.get("files", [])
        if not isinstance(files, list):
            raise MemorySystemError(f"事务恢复清单 files 格式不正确：{manifest_path}")
        legacy = any(
            not isinstance(item, dict) or "before_hash" not in item or "staged_hash" not in item
            for item in files
        )
        if legacy and not force_legacy:
            raise MemorySystemError(
                f"旧事务缺少 hash，不能自动确认外部改动：{directory.name}。"
                "确认没有人工修改后再使用 --force-legacy-recovery。"
            )
        for item in files:
            if not isinstance(item, dict):
                raise MemorySystemError(f"事务文件记录格式不正确：{manifest_path}")
            target = assert_project_path(project_root, project_root / str(item.get("target", "")), "事务目标")
            if legacy:
                continue
            actual_hash = sha256_file(target) if target.exists() else None
            allowed_hashes = {item.get("before_hash"), item.get("staged_hash")}
            if actual_hash not in allowed_hashes:
                raise MemorySystemError(
                    f"事务恢复检测到外部修改，已停止：{target.relative_to(project_root).as_posix()}"
                )
        for item in reversed(manifest.get("files", [])):
            target = assert_project_path(project_root, project_root / str(item["target"]), "事务目标")
            backup = directory / item["backup"]
            if item.get("had_original"):
                if not backup.exists():
                    raise MemorySystemError(f"事务备份缺失，请人工检查：{backup}")
                if not legacy and sha256_file(backup) != item.get("before_hash"):
                    raise MemorySystemError(f"事务备份 hash 不匹配，请人工检查：{backup}")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
            elif target.exists():
                target.unlink()
        recovered.append(directory.name)
        shutil.rmtree(directory, ignore_errors=True)
    return recovered


def apply_transaction(project_root: Path, changes: dict[Path, str | None]) -> None:
    if not changes:
        return
    project_root = project_root.resolve()
    transaction_root = project_root / "记忆库" / ".transactions"
    transaction_root.mkdir(parents=True, exist_ok=True)
    directory = transaction_root / f"txn-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    backup_dir = directory / "backup"
    staged_dir = directory / "staged"
    backup_dir.mkdir(parents=True)
    staged_dir.mkdir(parents=True)
    files: list[dict[str, Any]] = []
    ordered = sorted(changes.items(), key=lambda item: str(item[0]))
    for position, (target_value, content) in enumerate(ordered):
        target = target_value.resolve()
        if project_root not in target.parents:
            raise MemorySystemError(f"拒绝修改小说目录外的文件：{target}")
        had_original = target.exists()
        before_hash = sha256_file(target) if had_original else None
        backup_name = f"backup/{position}.bak"
        staged_name = f"staged/{position}.new"
        if had_original:
            shutil.copy2(target, directory / backup_name)
        if content is not None:
            (directory / staged_name).write_text(content, encoding="utf-8", newline="")
        staged_hash = sha256_file(directory / staged_name) if content is not None else None
        files.append(
            {
                "target": target.relative_to(project_root).as_posix(),
                "had_original": had_original,
                "backup": backup_name,
                "staged": staged_name if content is not None else None,
                "before_hash": before_hash,
                "staged_hash": staged_hash,
            }
        )
    manifest = {"status": "writing", "created_at": now_iso(), "files": files}
    manifest_path = directory / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    try:
        for item in files:
            target = project_root / item["target"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if item["staged"] is None:
                if target.exists():
                    target.unlink()
            else:
                os.replace(directory / item["staged"], target)
        manifest["status"] = "complete"
        atomic_write_json(manifest_path, manifest)
    except Exception:
        for item in reversed(files):
            target = project_root / item["target"]
            if item["had_original"]:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(directory / item["backup"], target)
            elif target.exists():
                target.unlink()
        raise
    finally:
        if manifest.get("status") == "complete":
            shutil.rmtree(directory, ignore_errors=True)


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
    if index_stale(project_root):
        findings.append(
            {"severity": "warning", "code": "INDEX_STALE", "message": "memory_index.json 缺失或已过期，可安全重建。"}
        )
    try:
        index_data = build_index_data(project_root)
    except MemorySystemError as exc:
        index_data = None
        findings.append({"severity": "blocked", "code": "PATCH_HISTORY_BLOCKED", "message": str(exc)})
    for path in memory_source_files(project_root):
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
    for manifest_path in sorted((project_root / "章节提交").glob("第*章_finalization.json")):
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
            for path in (project_root / "正文").glob("*.md")
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
