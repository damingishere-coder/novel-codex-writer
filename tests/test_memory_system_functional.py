from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def find_single(filename: str) -> Path:
    excluded_parts = {".git", "tmp", "node_modules", "dist"}
    matches = [
        path
        for path in ROOT.rglob(filename)
        if not excluded_parts.intersection(path.parts)
    ]
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
MEMORY_TRANSACTIONS = sys.modules["memory_transactions"]
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
    def test_project_lock_never_recreates_a_missing_project_and_recovers_stale_delete_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing-project"
            with self.assertRaises(MEMORY.MemorySystemError):
                with MEMORY_TRANSACTIONS.project_write_lock(missing):
                    self.fail("missing project lock must not be acquired")
            self.assertFalse(missing.exists())

            project_root = Path(temp_dir) / "existing-project"
            project_root.mkdir()
            marker = project_root / ".deleting"
            marker.write_text("interrupted", encoding="utf-8")
            with MEMORY_TRANSACTIONS.project_write_lock(project_root):
                self.assertFalse(marker.exists())

    def test_project_lock_recovers_a_crashed_unique_reclaim_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            lock_root = project_root / ".locks"
            lock_root.mkdir(parents=True)
            dead_process = subprocess.Popen([sys.executable, "-c", "pass"])
            self.assertEqual(dead_process.wait(), 0)
            dead_pid = dead_process.pid
            lock_file = lock_root / "project-write.lock"
            lock_file.write_text(json.dumps({
                "owner": "dead-lock",
                "pid": dead_pid,
                "host": MEMORY_TRANSACTIONS.socket.gethostname(),
            }), encoding="utf-8")
            host_key = MEMORY_TRANSACTIONS._host_identity(MEMORY_TRANSACTIONS.socket.gethostname())
            orphan = Path(f"{lock_file}.reclaim.{host_key}.{dead_pid}-dead-candidate")
            orphan.write_text("", encoding="utf-8")
            acquire_orphan = Path(f"{lock_file}.acquire.{host_key}.{dead_pid}-dead-acquire")
            acquire_orphan.write_text("", encoding="utf-8")
            old = 1_000_000_000
            os.utime(lock_file, (old, old))
            os.utime(orphan, (old, old))

            with MEMORY_TRANSACTIONS.project_write_lock(
                project_root, timeout_seconds=1.0, stale_seconds=0.01
            ):
                self.assertFalse(orphan.exists())
                self.assertFalse(acquire_orphan.exists())

    def test_inherited_project_lock_keeps_heartbeat_and_detects_lease_loss(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            lock_root = project_root / ".locks"
            lock_root.mkdir(parents=True)
            lock_file = lock_root / "project-write.lock"
            parent_pid = os.getppid()
            owner = f"{parent_pid}-delegated-test"
            lock_file.write_text(json.dumps({
                "owner": owner,
                "pid": parent_pid,
                "host": MEMORY_TRANSACTIONS.socket.gethostname(),
            }), encoding="utf-8")
            heartbeat_seen = threading.Event()
            real_utime = os.utime

            def observe_heartbeat(path: Path, times: object = None) -> None:
                real_utime(path, times)
                if Path(path) == lock_file:
                    heartbeat_seen.set()

            inherited_env = {
                "NOVEL_PARENT_PROJECT_LOCK_OWNER": owner,
                "NOVEL_PARENT_PROJECT_LOCK_PID": str(parent_pid),
            }
            with (
                mock.patch.dict(os.environ, inherited_env, clear=False),
                mock.patch.object(MEMORY_TRANSACTIONS.os, "utime", side_effect=observe_heartbeat),
            ):
                with self.assertRaisesRegex(MEMORY.MemorySystemError, "写入锁已丢失"):
                    with MEMORY_TRANSACTIONS.project_write_lock(project_root, stale_seconds=0.09):
                        self.assertTrue(heartbeat_seen.wait(0.5), "继承锁必须由 Python 子进程续租")
                        lock_file.write_text(json.dumps({
                            "owner": "replacement-owner",
                            "pid": os.getpid(),
                            "host": MEMORY_TRANSACTIONS.socket.gethostname(),
                        }), encoding="utf-8")

    def test_owned_project_lock_marks_a_failed_heartbeat_as_lost(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            project_root.mkdir()
            heartbeat_attempted = threading.Event()

            def fail_heartbeat(_path: Path, _times: object = None) -> None:
                heartbeat_attempted.set()
                raise OSError("simulated heartbeat failure")

            with mock.patch.object(MEMORY_TRANSACTIONS.os, "utime", side_effect=fail_heartbeat):
                with self.assertRaisesRegex(MEMORY.MemorySystemError, "写入锁已丢失"):
                    with MEMORY_TRANSACTIONS.project_write_lock(project_root, stale_seconds=0.03):
                        self.assertTrue(heartbeat_attempted.wait(1.2), "普通持锁者必须监测续租失败")

    def test_transaction_stops_before_the_next_file_when_lease_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            first = project_root / "记忆库" / "current" / "第一项.md"
            second = project_root / "记忆库" / "current" / "第二项.md"
            first.parent.mkdir(parents=True)
            first.write_text("原一\n", encoding="utf-8")
            second.write_text("原二\n", encoding="utf-8")
            lock_file = project_root / ".locks" / "project-write.lock"
            real_replace = os.replace
            staged_replaces = 0

            def replace_then_steal(source: Path, target: Path) -> None:
                nonlocal staged_replaces
                real_replace(source, target)
                if Path(source).parent.name == "staged":
                    staged_replaces += 1
                    if staged_replaces == 1:
                        lock_file.write_text(json.dumps({
                            "owner": "replacement-owner",
                            "pid": os.getpid(),
                            "host": MEMORY_TRANSACTIONS.socket.gethostname(),
                        }), encoding="utf-8")

            with mock.patch.object(MEMORY_TRANSACTIONS.os, "replace", side_effect=replace_then_steal):
                with self.assertRaisesRegex(MEMORY.MemorySystemError, "保留事务目录等待显式恢复"):
                    MEMORY.apply_transaction(project_root, {first: "新一\n", second: "新二\n"})

            self.assertEqual(first.read_text(encoding="utf-8"), "新一\n")
            self.assertEqual(second.read_text(encoding="utf-8"), "原二\n")
            self.assertEqual(staged_replaces, 1)
            self.assertEqual(len(MEMORY.inspect_transactions(project_root)), 1)

    def test_transaction_rechecks_source_hash_before_first_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            target = project / "记忆库" / "current" / "当前人物状态.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("原始内容\n", encoding="utf-8")
            real_atomic_write_json = MEMORY_TRANSACTIONS.atomic_write_json

            def mutate_after_manifest(path: Path, data: object) -> None:
                real_atomic_write_json(path, data)
                if path.name == "manifest.json" and isinstance(data, dict) and data.get("status") == "writing":
                    target.write_text("外部修改\n", encoding="utf-8")

            with mock.patch.object(MEMORY_TRANSACTIONS, "atomic_write_json", side_effect=mutate_after_manifest):
                with self.assertRaisesRegex(MEMORY.MemorySystemError, "提交前检测到外部修改"):
                    MEMORY.apply_transaction(project, {target: "事务内容\n"})

            self.assertEqual(target.read_text(encoding="utf-8"), "外部修改\n")
            pending = MEMORY.inspect_transactions(project)
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["status"], "conflict")

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
            library_root = Path(temp_dir) / "小说项目"
            project_root = library_root / "作品" / "demo"
            current_dir = project_root / "记忆库" / "current"
            current_dir.mkdir(parents=True)
            (project_root / "章节提交").mkdir(parents=True)
            (library_root / "projects.json").write_text(
                json.dumps(
                    {"activeProjectId": "demo", "projects": [{"id": "demo"}]},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            patch_path = project_root / "章节提交" / "patch.json"
            patch = valid_patch()
            patch.update(
                {
                    "schema_version": 2,
                    "kind": "migration",
                    "chapter_revision": None,
                    "source_revisions": {},
                }
            )
            patch_path.write_text(
                json.dumps(patch, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            command = [
                sys.executable,
                str(UPDATE_MEMORY_PATH),
                "--library-root",
                str(library_root),
                "--current-dir",
                str(current_dir),
                "--patch",
                str(patch_path),
            ]
            first = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(first.returncode, 0, msg=first.stdout + first.stderr)
            first_snapshot = snapshot_tree(project_root)

            second = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(second.returncode, 0, msg=second.stdout + second.stderr)
            self.assertEqual(first_snapshot, snapshot_tree(project_root))

            changed = dict(patch)
            changed["summary"] = "同一 patch_id 被替换成了不同内容。"
            patch_path.write_text(json.dumps(changed, ensure_ascii=False, indent=2), encoding="utf-8")
            conflict = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertNotEqual(conflict.returncode, 0, msg=conflict.stdout + conflict.stderr)

    def test_candidate_patch_in_history_is_applied_before_it_becomes_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            library_root = Path(temp_dir) / "小说项目"
            project_root = library_root / "作品" / "demo"
            current_dir = project_root / "记忆库" / "current"
            current_dir.mkdir(parents=True)
            (project_root / "章节提交").mkdir(parents=True)
            (library_root / "projects.json").write_text(
                json.dumps({"activeProjectId": "demo", "projects": [{"id": "demo"}]}),
                encoding="utf-8",
            )
            patch = valid_patch("candidate-history-v1")
            patch.update(
                {
                    "schema_version": 2,
                    "kind": "migration",
                    "chapter_revision": None,
                    "source_revisions": {},
                }
            )
            patch_path = project_root / "章节提交" / "memory_patch_第001章_candidate-history-v1.md"
            patch_path.write_text(MEMORY.render_patch_markdown(MEMORY.validate_patch(patch)), encoding="utf-8")
            command = [
                sys.executable,
                str(UPDATE_MEMORY_PATH),
                "--library-root",
                str(library_root),
                "--current-dir",
                str(current_dir),
                "--patch",
                str(patch_path),
            ]

            first = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(first.returncode, 0, msg=first.stdout + first.stderr)
            self.assertNotIn("幂等跳过", first.stdout)
            self.assertIn("林舟位于雾港旧邮局", (current_dir / "当前人物状态.md").read_text(encoding="utf-8"))
            ledger = json.loads((project_root / "章节提交" / "applied_patches.json").read_text(encoding="utf-8"))
            self.assertIn("candidate-history-v1", ledger["patches"])

            second = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(second.returncode, 0, msg=second.stdout + second.stderr)
            self.assertIn("幂等跳过", second.stdout)

            noncanonical = project_root / "章节提交" / "memory_patch_第001章_wrong-name.md"
            changed_id = dict(patch)
            changed_id["patch_id"] = "candidate-history-v2"
            noncanonical.write_text(
                MEMORY.render_patch_markdown(MEMORY.validate_patch(changed_id)), encoding="utf-8"
            )
            rejected = subprocess.run(
                [*command[:-1], str(noncanonical)], capture_output=True, text=True, check=False
            )
            self.assertEqual(rejected.returncode, 2, msg=rejected.stdout + rejected.stderr)
            self.assertFalse(
                (project_root / "章节提交" / "memory_patch_第001章_candidate-history-v2.md").exists()
            )


if __name__ == "__main__":
    unittest.main()
