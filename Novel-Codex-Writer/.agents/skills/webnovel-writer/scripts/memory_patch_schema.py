"""Memory record and patch schemas, validation, and finalization manifests."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from memory_paths import (
    TASKBOOK_NAME,
    assert_project_path,
    find_blueprint,
    memory_source_files,
    parse_chapter_number,
    patch_source_files,
    project_files,
)
from memory_transactions import MemorySystemError, now_iso, read_text, sha256_file, sha256_text

PATCH_SCHEMA_VERSION = 2
MARKER_PREFIX = "webnovel-memory:"
MARKER_RE = re.compile(
    r"^[ \t]*<!--\s*webnovel-memory:\s*(\{.*\})\s*-->[ \t]*$",
    re.MULTILINE,
)
VALID_STATUSES = {"active", "tentative", "closed", "outdated", "contradicted"}
VALID_IMPORTANCE = {"critical", "high", "normal", "low"}
VALID_ACTIONS = {"upsert", "close", "archive"}
VALID_PATCH_KINDS = {"chapter_result", "outline_baseline", "migration", "legacy_unknown"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,80}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
PATCH_CLASSIFICATIONS_NAME = "patch_classifications.json"
PATCH_COMPAT_DIR_NAME = "compat"
FINALIZATION_MANIFEST_SCHEMA_VERSION = 1
REVIEW_PROOF_SCHEMA_VERSION = 2
APPLIED_PATCH_LEDGER_SCHEMA_VERSION = 1
APPLIED_PATCH_LEDGER_NAME = "applied_patches.json"

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
        if value is not None and (type(value) is not int or value < 0):
            raise MemorySystemError(f"记忆字段 {field} 必须是非负整数或 null：{record_id}")


def parse_memory_file(path: Path, project_root: Path) -> list[MemoryRecord]:
    path = assert_project_path(project_root, path, "记忆来源")
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
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise MemorySystemError(f"memory_patch 不能是符号链接或 junction：{path}")
    if not path.is_file():
        raise MemorySystemError(f"memory_patch 不是普通文件：{path}")
    try:
        text = read_text(path).strip()
    except OSError as exc:
        raise MemorySystemError(f"无法读取 memory_patch：{path}") from exc
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
    identities: set[str] = set()
    for raw_path, raw_revision in value.items():
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise MemorySystemError("source_revisions 的路径必须是非空字符串。")
        path = Path(raw_path.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise MemorySystemError(f"source_revisions 包含越界路径：{raw_path}")
        if not isinstance(raw_revision, str) or not SHA256_RE.fullmatch(raw_revision.lower()):
            raise MemorySystemError(f"source_revisions 的 revision 不是 SHA-256：{raw_path}")
        normalized_path = unicodedata.normalize("NFC", path.as_posix())
        identity = normalized_path.casefold()
        if identity in identities:
            raise MemorySystemError(f"source_revisions 包含重复的规范路径：{raw_path}")
        identities.add(identity)
        normalized[normalized_path] = raw_revision.lower()
    return normalized


def validate_patch(patch: dict[str, Any]) -> dict[str, Any]:
    required = ("schema_version", "patch_id", "chapter", "summary", "ending_state", "operations")
    missing = [field for field in required if field not in patch]
    if missing:
        raise MemorySystemError(f"memory_patch 缺少字段：{', '.join(missing)}")
    schema_version = patch["schema_version"]
    if type(schema_version) is not int or schema_version not in {1, PATCH_SCHEMA_VERSION}:
        raise MemorySystemError(
            f"不支持的 schema_version：{schema_version}，当前支持 1 和 {PATCH_SCHEMA_VERSION}。"
        )
    patch_id = patch["patch_id"]
    if not isinstance(patch_id, str) or not ID_RE.fullmatch(patch_id):
        raise MemorySystemError(f"patch_id 无效：{patch_id!r}")
    if type(patch["chapter"]) is not int or patch["chapter"] <= 0:
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


def applied_patch_ledger_path(project_root: Path) -> Path:
    return project_root / "章节提交" / APPLIED_PATCH_LEDGER_NAME


def load_applied_patch_ledger(project_root: Path) -> dict[str, Any]:
    raw_path = applied_patch_ledger_path(project_root)
    if raw_path.is_symlink() or getattr(raw_path, "is_junction", lambda: False)():
        raise MemorySystemError(f"已应用补丁凭据不能是符号链接或 junction：{raw_path}")
    if not raw_path.exists():
        return {"schema_version": APPLIED_PATCH_LEDGER_SCHEMA_VERSION, "patches": {}}
    path = assert_project_path(project_root, raw_path, "已应用补丁凭据")
    if not path.is_file():
        raise MemorySystemError(f"已应用补丁凭据不是普通文件：{path}")
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"已应用补丁凭据不是有效 JSON：{path}") from exc
    except OSError as exc:
        raise MemorySystemError(f"无法读取已应用补丁凭据：{path}") from exc
    if (
        not isinstance(value, dict)
        or type(value.get("schema_version")) is not int
        or value["schema_version"] != APPLIED_PATCH_LEDGER_SCHEMA_VERSION
        or not isinstance(value.get("patches"), dict)
    ):
        raise MemorySystemError(f"已应用补丁凭据格式无效：{path}")
    for patch_id, item in value["patches"].items():
        if (
            not isinstance(patch_id, str)
            or not ID_RE.fullmatch(patch_id)
            or not isinstance(item, dict)
            or not isinstance(item.get("revision"), str)
            or not SHA256_RE.fullmatch(item["revision"].lower())
            or item.get("kind") not in VALID_PATCH_KINDS - {"legacy_unknown"}
            or type(item.get("chapter")) is not int
            or item["chapter"] <= 0
            or not isinstance(item.get("applied_at"), str)
        ):
            raise MemorySystemError(f"已应用补丁凭据包含无效条目：{patch_id!r}")
    return value


def patch_classifications_read_path(project_root: Path) -> Path:
    current = patch_classifications_path(project_root)
    return current if current.exists() or current.is_symlink() else legacy_patch_classifications_path(project_root)


def load_patch_classifications(project_root: Path) -> dict[str, str]:
    path = patch_classifications_read_path(project_root)
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise MemorySystemError(f"patch 分类文件不能是符号链接或 junction：{path}")
    if not path.exists():
        return {}
    path = assert_project_path(project_root, path, "patch 分类文件")
    if not path.is_file():
        raise MemorySystemError(f"patch 分类文件不是普通文件：{path}")
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"patch 分类文件不是有效 JSON：{path}") from exc
    except OSError as exc:
        raise MemorySystemError(f"无法读取 patch 分类文件：{path}") from exc
    if (
        not isinstance(payload, dict)
        or type(payload.get("schema_version")) is not int
        or payload["schema_version"] != 1
    ):
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
        raw_target = project_root / relative
        current = project_root
        for part in Path(relative).parts:
            current /= part
            if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
                raise MemorySystemError(f"revision 来源不能经过符号链接或 junction：{relative}")
        target = assert_project_path(project_root, raw_target, "revision 来源")
        if not target.is_file():
            raise MemorySystemError(f"revision 来源不存在：{relative}")
        actual_revision = sha256_file(target)
        if actual_revision != expected_revision:
            raise MemorySystemError(
                f"revision 来源已变化：{relative}（期望 {expected_revision[:12]}，实际 {actual_revision[:12]}）"
            )
        resolved[relative] = target
    return resolved


def load_review_proof(path: Path) -> dict[str, Any]:
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise MemorySystemError(f"机器可读审阅证明不能是符号链接或 junction：{path}")
    if not path.is_file():
        raise MemorySystemError(f"机器可读审阅证明不是普通文件：{path}")
    try:
        proof = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"机器可读审阅证明不是有效 JSON：{path}") from exc
    except OSError as exc:
        raise MemorySystemError(f"无法读取机器可读审阅证明：{path}") from exc
    if (
        not isinstance(proof, dict)
        or type(proof.get("schema_version")) is not int
        or proof["schema_version"] != REVIEW_PROOF_SCHEMA_VERSION
    ):
        raise MemorySystemError(f"机器可读审阅证明版本不受支持：{path}")
    if proof.get("kind") != "chapter_review_proof":
        raise MemorySystemError(f"机器可读审阅证明 kind 无效：{path}")
    return proof


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
        and path.suffix.lower() == ".md"
        and parse_chapter_number(path, read_text(path)) == chapter
    ]
    if len(review_sources) != 1:
        raise MemorySystemError(f"chapter_result 必须且只能绑定一份第{chapter:03d}章审查报告。")

    review_proof_sources = [
        path
        for relative, path in sources.items()
        if Path(relative).parts[:1] == ("审查报告",)
        and path.name.lower().endswith(".review.json")
        and parse_chapter_number(path) == chapter
    ]
    if len(review_proof_sources) != 1:
        raise MemorySystemError(f"chapter_result 必须且只能绑定一份第{chapter:03d}章机器可读审阅证明。")
    proof_path = review_proof_sources[0]
    proof = load_review_proof(proof_path)
    chapter_revision = str(patch["chapter_revision"])
    if proof.get("chapter") != chapter or proof.get("document_path") != body_relative:
        raise MemorySystemError("机器可读审阅证明未绑定当前章节正文。")
    if any(proof.get(field) != chapter_revision for field in ("document_revision", "disk_revision", "content_revision")):
        raise MemorySystemError("机器可读审阅证明的正文 revision 已过期。")
    if proof.get("status") != "completed" or proof.get("verdict") != "pass":
        raise MemorySystemError("机器可读审阅证明未通过。")
    if type(proof.get("blocking_findings")) is not int or proof.get("blocking_findings") != 0:
        raise MemorySystemError("机器可读审阅证明仍包含阻塞 finding。")
    verification = proof.get("verification")
    if (
        not isinstance(verification, dict)
        or not all(type(verification.get(field)) is int for field in ("required", "resolved", "unverified"))
        or verification["unverified"] != 0
        or verification["required"] != verification["resolved"]
    ):
        raise MemorySystemError("机器可读审阅证明仍有未完成的 finding 核验。")
    if not isinstance(proof.get("run_id"), str) or not proof["run_id"].strip():
        raise MemorySystemError("机器可读审阅证明缺少 run_id。")
    if not isinstance(proof.get("prompt_version"), str) or not proof["prompt_version"].strip():
        raise MemorySystemError("机器可读审阅证明缺少 prompt_version。")
    if not isinstance(proof.get("findings_digest"), str) or not SHA256_RE.fullmatch(proof["findings_digest"].lower()):
        raise MemorySystemError("机器可读审阅证明的 findings_digest 无效。")
    if not isinstance(proof.get("context_revisions"), dict):
        raise MemorySystemError("机器可读审阅证明的 context_revisions 无效。")
    context_revisions = _validate_revision_map(proof["context_revisions"])
    if not context_revisions or body_relative not in context_revisions:
        raise MemorySystemError("机器可读审阅证明必须在 context_revisions 中绑定当前正文。")
    for relative, revision in context_revisions.items():
        if patch["source_revisions"].get(relative) != revision:
            raise MemorySystemError(f"机器可读审阅证明的上下文未绑定到 source_revisions：{relative}")

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
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise MemorySystemError(f"章节最终化 manifest 不能是符号链接或 junction：{path}")
    if not path.is_file():
        raise MemorySystemError(f"章节最终化 manifest 不是普通文件：{path}")
    try:
        manifest = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"章节最终化 manifest 不是有效 JSON：{path}") from exc
    except OSError as exc:
        raise MemorySystemError(f"无法读取章节最终化 manifest：{path}") from exc
    if (
        not isinstance(manifest, dict)
        or type(manifest.get("schema_version")) is not int
        or manifest["schema_version"] != FINALIZATION_MANIFEST_SCHEMA_VERSION
    ):
        raise MemorySystemError(f"章节最终化 manifest 版本不受支持：{path}")
    if type(manifest.get("chapter")) is not int or manifest["chapter"] <= 0:
        raise MemorySystemError(f"章节最终化 manifest 缺少有效 chapter：{path}")
    if manifest.get("status") != "finalized":
        raise MemorySystemError(f"章节最终化 manifest status 无效：{path}")
    if not isinstance(manifest.get("patch_id"), str) or not ID_RE.fullmatch(manifest["patch_id"]):
        raise MemorySystemError(f"章节最终化 manifest patch_id 无效：{path}")
    chapter_revision = manifest.get("chapter_revision")
    if not isinstance(chapter_revision, str) or not SHA256_RE.fullmatch(chapter_revision.lower()):
        raise MemorySystemError(f"章节最终化 manifest chapter_revision 无效：{path}")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise MemorySystemError(f"章节最终化 manifest sources 无效：{path}")
    source_paths: set[str] = set()
    for source in sources:
        if (
            not isinstance(source, dict)
            or not isinstance(source.get("path"), str)
            or not source["path"]
            or not isinstance(source.get("revision"), str)
            or not SHA256_RE.fullmatch(source["revision"].lower())
            or source["path"] in source_paths
        ):
            raise MemorySystemError(f"章节最终化 manifest 包含无效或重复来源：{path}")
        source_paths.add(source["path"])
    patch = manifest.get("patch")
    if (
        not isinstance(patch, dict)
        or not isinstance(patch.get("path"), str)
        or not isinstance(patch.get("revision"), str)
        or not SHA256_RE.fullmatch(patch["revision"].lower())
    ):
        raise MemorySystemError(f"章节最终化 manifest patch 绑定无效：{path}")
    return manifest


def finalization_manifest_freshness(project_root: Path, manifest: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    evidence = list(manifest.get("sources", []))
    patch = manifest.get("patch")
    for item in evidence:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            reasons.append("存在无效来源记录")
            continue
        relative = item["path"]
        expected = item.get("revision")
        try:
            target = assert_project_path(project_root, project_root / relative, "manifest 来源")
            if not target.is_file():
                reasons.append(f"文件已缺失：{relative}")
            elif not isinstance(expected, str) or sha256_file(target) != expected:
                reasons.append(f"文件已变化：{relative}")
        except MemorySystemError as exc:
            reasons.append(str(exc))
        except OSError:
            reasons.append(f"文件无法稳定读取：{relative}")
    chapter = int(manifest["chapter"])
    patch_id = str(manifest["patch_id"])
    expected_patch_path = f"章节提交/memory_patch_第{chapter:03d}章_{patch_id}.md"
    if not isinstance(patch, dict) or patch.get("path") != expected_patch_path:
        reasons.append("patch 路径不是当前章节和 patch_id 的规范路径")
        return False, reasons
    try:
        patch_target = assert_project_path(project_root, project_root / expected_patch_path, "manifest patch")
        if not patch_target.is_file():
            reasons.append(f"文件已缺失：{expected_patch_path}")
            return False, reasons
        if sha256_file(patch_target) != patch.get("revision"):
            reasons.append(f"文件已变化：{expected_patch_path}")
            return False, reasons
        selected_patch = validate_patch(load_patch(patch_target))
        if (
            selected_patch.get("schema_version") != PATCH_SCHEMA_VERSION
            or selected_patch.get("kind") != "chapter_result"
            or selected_patch.get("patch_id") != patch_id
            or selected_patch.get("chapter") != chapter
            or selected_patch.get("chapter_revision") != manifest.get("chapter_revision")
        ):
            reasons.append("patch 内容未绑定 manifest 声明的章节、类型或正文 revision")
        manifest_sources = {item["path"]: item["revision"] for item in manifest["sources"]}
        if selected_patch.get("source_revisions") != manifest_sources:
            reasons.append("manifest 来源集合与 patch source_revisions 不一致")
        if not reasons:
            validate_patch_source_revisions(project_root, selected_patch)
    except MemorySystemError as exc:
        reasons.append(str(exc))
    except OSError:
        reasons.append(f"文件无法稳定读取：{expected_patch_path}")
    return not reasons, reasons


def chapter_finalization_status(project_root: Path, chapter: int) -> dict[str, Any]:
    raw_path = finalization_manifest_path(project_root, chapter)
    if raw_path.is_symlink():
        raise MemorySystemError(f"最终化 manifest 不能是符号链接：{raw_path}")
    path = assert_project_path(project_root, raw_path, "最终化 manifest 路径")
    if not path.exists():
        return {"status": "missing", "path": path.relative_to(project_root).as_posix(), "reasons": []}
    if not path.is_file():
        raise MemorySystemError(f"最终化 manifest 不是文件：{path}")
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
    for manifest_path in project_files(
        project_root,
        project_root / "章节提交",
        "第*章_finalization.json",
        label="最终化 manifest 路径",
    ):
        if manifest_path.is_symlink():
            raise MemorySystemError(f"最终化 manifest 不能是符号链接：{manifest_path}")
        manifest = load_finalization_manifest(manifest_path)
        canonical_name = f"第{int(manifest['chapter']):03d}章_finalization.json"
        if manifest_path.name != canonical_name:
            raise MemorySystemError(
                f"最终化 manifest 文件名必须为规范路径：章节提交/{canonical_name}"
            )
        fresh, _ = finalization_manifest_freshness(project_root, manifest)
        if fresh:
            chapter = int(manifest["chapter"])
            patch_id = str(manifest["patch_id"])
            previous = manifest_selection.get(chapter)
            if previous is not None and previous != patch_id:
                raise MemorySystemError(f"第{chapter:03d}章存在多个新鲜 finalization manifest。")
            manifest_selection[chapter] = patch_id
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
        selected_by_manifest = [item for item in explicit if item.get("selected_by_manifest") is True]
        if len(selected_by_manifest) == 1:
            selected.append(selected_by_manifest[0])
            continue
        if len(selected_by_manifest) > 1:
            raise MemorySystemError(f"第{chapter:03d}章存在多个被 manifest 选中的 chapter_result patch。")
        legacy_explicit = [item for item in explicit if item.get("schema_version") == 1]
        if len(legacy_explicit) == 1 and len(explicit) == 1:
            selected.append(legacy_explicit[0])
            continue
        if explicit:
            # Schema v2 files are candidates until a fresh finalization
            # manifest proves their operations and evidence were committed.
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
