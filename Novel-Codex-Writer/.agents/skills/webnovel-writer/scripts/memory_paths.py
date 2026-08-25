"""Registered project paths and canonical file discovery for the memory system."""

from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from memory_transactions import MemorySystemError, read_text

TASKBOOK_NAME = "本章写作任务书.md"
LEGACY_CONTEXT_NAME = "本章上下文包.md"
ARC_FILE_RE = re.compile(r"^第\d+篇_.+\.md$")
ARC_RANGE_RE = re.compile(
    r"章节范围\s*[：:]\s*第?\s*0*(\d+)\s*[—–－\-~～至到]+\s*第?\s*0*(\d+)\s*章"
)
CHAPTER_RE = re.compile(r"第\s*0*(\d+)\s*章")

@dataclass(frozen=True)
class ArcOutline:
    path: Path
    start: int
    end: int
    title: str

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
    if index_path.is_symlink() or getattr(index_path, "is_junction", lambda: False)():
        raise MemorySystemError(f"作品库清单不能是符号链接或 junction：{index_path}")
    if not index_path.exists():
        raise MemorySystemError(f"找不到作品库清单：{index_path}")
    if not index_path.is_file():
        raise MemorySystemError(f"作品库清单不是普通文件：{index_path}")
    try:
        index = json.loads(read_text(index_path))
    except json.JSONDecodeError as exc:
        raise MemorySystemError(f"作品库清单不是有效 JSON：{index_path}（{exc}）") from exc
    except OSError as exc:
        raise MemorySystemError(f"无法读取作品库清单：{index_path}") from exc
    if not isinstance(index, dict) or not isinstance(index.get("projects"), list):
        raise MemorySystemError(f"作品库清单格式不正确：{index_path}")
    return index


def registered_project_roots(library_root: Path) -> dict[str, Path]:
    index = load_project_registry(library_root)
    roots: dict[str, Path] = {}
    raw_projects_root = library_root.resolve() / "作品"
    if raw_projects_root.is_symlink() or getattr(raw_projects_root, "is_junction", lambda: False)():
        raise MemorySystemError(f"作品目录不能是符号链接或 junction：{raw_projects_root}")
    if raw_projects_root.exists() and not raw_projects_root.is_dir():
        raise MemorySystemError(f"作品目录不是目录：{raw_projects_root}")
    projects_root = raw_projects_root.resolve()
    for item in index.get("projects", []):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        project_id = item["id"].strip()
        if not project_id or Path(project_id).name != project_id:
            continue
        raw_project_root = projects_root / project_id
        if raw_project_root.is_symlink() or getattr(raw_project_root, "is_junction", lambda: False)():
            raise MemorySystemError(f"已登记小说目录不能是符号链接或 junction：{raw_project_root}")
        if raw_project_root.exists() and not raw_project_root.is_dir():
            raise MemorySystemError(f"已登记小说路径不是目录：{raw_project_root}")
        resolved = raw_project_root.resolve()
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


def project_files(
    project_root: Path,
    directory: Path,
    pattern: str,
    *,
    recursive: bool = False,
    label: str = "扫描路径",
) -> list[Path]:
    """返回小说目录内的真实文件，并拒绝符号链接或 junction 越界。"""

    if directory.is_symlink() or getattr(directory, "is_junction", lambda: False)():
        raise MemorySystemError(f"{label}不能是符号链接或 junction：{directory}")
    safe_directory = assert_project_path(project_root, directory, label)
    if not safe_directory.exists():
        return []
    if not safe_directory.is_dir():
        raise MemorySystemError(f"{label}不是目录：{directory}")
    results: list[Path] = []

    def visit(current: Path) -> None:
        for raw_path in current.iterdir():
            safe_path = assert_project_path(project_root, raw_path, label)
            if raw_path.is_symlink() or getattr(raw_path, "is_junction", lambda: False)():
                continue
            if safe_path.is_dir():
                if recursive:
                    visit(safe_path)
                continue
            if safe_path.is_file() and fnmatch.fnmatch(safe_path.name, pattern):
                results.append(safe_path)

    visit(safe_directory)
    return sorted(results)


def resolve_project_path(project_root: Path, value: str | Path, label: str = "路径") -> Path:
    candidate = Path(value)
    resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
    return assert_project_path(project_root, resolved, label)


def normalize_chapter(value: str | int) -> tuple[int, str]:
    match = re.fullmatch(r"\s*(?:第\s*)?0*(\d+)(?:\s*章)?\s*", str(value))
    if not match:
        raise MemorySystemError(f"章节号必须是 1、001 或第001章。当前输入：{value}")
    try:
        number = int(match.group(1))
    except ValueError as exc:
        raise MemorySystemError(f"章节号超出可解析范围：{value}") from exc
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
    candidates = [
        path
        for path in project_files(project_root, outline_dir, "*.md", label="篇纲路径")
        if ARC_FILE_RE.match(path.name)
    ]
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
    if outline_dir.is_symlink() or getattr(outline_dir, "is_junction", lambda: False)():
        raise MemorySystemError(f"细纲目录不能是符号链接或 junction：{outline_dir}")
    safe_outline_dir = assert_project_path(project_root, outline_dir, "细纲目录")
    if not safe_outline_dir.exists():
        return None
    canonical = outline_dir / f"细纲_第{label}章.md"
    matches: list[Path] = []
    for raw_path in outline_dir.iterdir():
        if "细纲" not in raw_path.stem or parse_chapter_number(raw_path) != chapter:
            continue
        if raw_path.is_symlink() or getattr(raw_path, "is_junction", lambda: False)():
            raise MemorySystemError(f"细纲文件不能是符号链接或 junction：{raw_path}")
        if not raw_path.is_file():
            raise MemorySystemError(f"细纲路径不是普通文件：{raw_path}")
        matches.append(raw_path)
    if not matches:
        return None
    if len(matches) != 1 or matches[0].name != canonical.name:
        names = "、".join(sorted(path.name for path in matches))
        raise MemorySystemError(
            f"第{label}章细纲必须唯一且使用规范路径 大纲/{canonical.name}；当前候选：{names}"
        )
    return assert_project_path(project_root, matches[0], "细纲路径")


def memory_source_files(project_root: Path) -> list[Path]:
    current_dir = project_root / "记忆库" / "current"
    paths = [
        path
        for path in project_files(project_root, current_dir, "*.md", label="current 记忆路径")
        if path.name not in {TASKBOOK_NAME, LEGACY_CONTEXT_NAME}
    ]
    archive_root = project_root / "档案库"
    paths.extend(project_files(project_root, archive_root, "*.md", recursive=True, label="档案库路径"))
    return sorted(set(paths))


def patch_source_files(project_root: Path) -> list[Path]:
    commit_dir = project_root / "章节提交"
    return project_files(project_root, commit_dir, "memory_patch_*.md", label="memory_patch 路径")
