from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def find_single(filename: str) -> Path:
    matches = [path for path in ROOT.rglob(filename) if ".git" not in path.parts]
    if len(matches) != 1:
        raise AssertionError(f"期望找到一个 {filename}，实际找到：{matches}")
    return matches[0]


def load_memory_common():
    path = find_single("memory_common.py")
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("novel_codex_memory_common", path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"无法加载记忆模块：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module, path


MEMORY, MEMORY_COMMON_PATH = load_memory_common()
UPDATE_MEMORY_PATH = find_single("update_memory.py")


def valid_record(record_id: str = "character-linzhou-location") -> dict:
    return {
        "id": record_id,
        "category": "character",
        "status": "active",
        "importance": "high",
        "valid_from": 1,
        "valid_to": None,
        "entities": ["林舟"],
        "tags": ["位置"],
        "source_chapter": 1,
        "content": "林舟位于雾港旧邮局。",
    }


def valid_patch(patch_id: str = "chapter-001-v1") -> dict:
    return {
        "schema_version": 1,
        "patch_id": patch_id,
        "chapter": 1,
        "summary": "林舟抵达雾港旧邮局。",
        "ending_state": "林舟留在旧邮局，准备调查来信来源。",
        "operations": [{"action": "upsert", "record": valid_record()}],
    }


def write_patch(project_root: Path, patch: dict) -> Path:
    path = project_root / "章节提交" / "memory_patch_第001章.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# 第001章 memory_patch\n\n```json\n"
        + json.dumps(patch, ensure_ascii=False, indent=2)
        + "\n```\n",
        encoding="utf-8",
    )
    return path


def snapshot_tree(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


class MemorySystemFunctionalTests(unittest.TestCase):
    def test_validate_patch_rejects_duplicate_record_ids(self) -> None:
        patch = valid_patch()
        patch["operations"].append(
            {"action": "upsert", "record": valid_record("character-linzhou-location")}
        )
        with self.assertRaises(MEMORY.MemorySystemError):
            MEMORY.validate_patch(patch)

    def test_validate_patch_rejects_invalid_status(self) -> None:
        patch = valid_patch()
        patch["operations"][0]["record"]["status"] = "unknown"
        with self.assertRaises(MEMORY.MemorySystemError):
            MEMORY.validate_patch(patch)

    def test_index_can_be_rebuilt_from_markdown_and_patch_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "demo"
            current_dir = project_root / "记忆库" / "current"
            current_dir.mkdir(parents=True)
            record = valid_record()
            metadata = {key: value for key, value in record.items() if key != "content"}
            current_file = current_dir / "当前人物状态.md"
            current_file.write_text(
                "# 当前人物状态\n\n"
                + MEMORY.render_record(metadata, record["content"])
                + "\n",
                encoding="utf-8",
            )
            write_patch(project_root, valid_patch())

            index = MEMORY.rebuild_index(project_root)
            index_path = project_root / "记忆库" / "index" / "memory_index.json"

            self.assertTrue(index_path.exists(), msg=f"memory_common: {MEMORY_COMMON_PATH}")
            self.assertEqual(index["applied_patch_ids"], ["chapter-001-v1"])
            self.assertEqual([item["id"] for item in index["records"]], ["character-linzhou-location"])
            self.assertEqual(index["chapter_summaries"][0]["chapter"], 1)

            index_path.unlink()
            rebuilt = MEMORY.ensure_index(project_root)
            self.assertTrue(index_path.exists())
            self.assertEqual(rebuilt["applied_patch_ids"], ["chapter-001-v1"])

    def test_active_project_cannot_escape_library_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            library = base / "小说项目"
            outside = base / "outside-project"
            (library / "作品").mkdir(parents=True)
            outside.mkdir()
            (library / "projects.json").write_text(
                json.dumps({"activeProjectId": "../../outside-project"}, ensure_ascii=False),
                encoding="utf-8",
            )

            with self.assertRaises(
                MEMORY.MemorySystemError,
                msg=f"activeProjectId 必须被限制在 小说项目/作品 内；模块位置：{MEMORY_COMMON_PATH}",
            ):
                MEMORY.resolve_project_root(library, None)

    def test_update_memory_is_idempotent_and_rejects_changed_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "demo"
            (project_root / "记忆库" / "current").mkdir(parents=True)
            (project_root / "章节提交").mkdir(parents=True)
            patch_path = Path(temp_dir) / "patch.json"
            patch_path.write_text(
                json.dumps(valid_patch(), ensure_ascii=False, indent=2), encoding="utf-8"
            )

            command = [
                sys.executable,
                str(UPDATE_MEMORY_PATH),
                "--project-root",
                str(project_root),
                "--patch",
                str(patch_path),
            ]
            first = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(first.returncode, 0, msg=first.stdout + first.stderr)
            first_snapshot = snapshot_tree(project_root)

            second = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(second.returncode, 0, msg=second.stdout + second.stderr)
            self.assertEqual(first_snapshot, snapshot_tree(project_root))

            changed = valid_patch()
            changed["summary"] = "同一 patch_id 被替换成了不同内容。"
            patch_path.write_text(json.dumps(changed, ensure_ascii=False, indent=2), encoding="utf-8")
            conflict = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertNotEqual(conflict.returncode, 0, msg=conflict.stdout + conflict.stderr)


if __name__ == "__main__":
    unittest.main()
