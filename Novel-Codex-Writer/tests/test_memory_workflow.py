from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch as mock_patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / ".agents" / "skills" / "webnovel-writer" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from build_context import build_taskbook_metadata, chapter_plan_target, chapter_section  # noqa: E402
from memory_common import (  # noqa: E402
    MemorySystemError,
    apply_transaction,
    chapter_finalization_status,
    index_path,
    ensure_index,
    inspect_transactions,
    load_applied_patch_ledger,
    load_finalization_manifest,
    load_indexed_records,
    load_patch,
    load_patch_classifications,
    load_review_proof,
    memory_source_files,
    normalize_chapter,
    rank_index_records,
    recover_transactions,
    prepare_record_file_changes,
    render_record,
    select_arc_outline,
    validate_patch,
    validate_patch_source_revisions,
    validate_transaction_targets,
)
from memory_paths import project_files  # noqa: E402
from memory_transactions import _reclaim_lock  # noqa: E402


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def make_project(base: Path, ranges: list[tuple[int, int]]) -> tuple[Path, Path]:
    library = base / "小说项目"
    project = library / "作品" / "novel-test"
    write(
        library / "projects.json",
        json.dumps(
            {
                "activeProjectId": "novel-test",
                "projects": [{"id": "novel-test", "name": "测试小说", "root": "作品/novel-test"}],
            },
            ensure_ascii=False,
        ),
    )
    for name in ("大纲", "正文", "章节提交", "档案库", "审查报告"):
        (project / name).mkdir(parents=True, exist_ok=True)
    for name in ("current", "index", "snapshots"):
        (project / "记忆库" / name).mkdir(parents=True, exist_ok=True)
    write(project / "大纲" / "总纲.md", "# 总纲\n")
    plan_lines = ["# 章节规划"]
    for arc_number, (start, end) in enumerate(ranges, start=1):
        arc = (
            f"# 第{arc_number}篇 测试篇\n\n"
            f"> 章节范围：第{start:03d}—{end:03d}章\n\n"
            "## 本篇必须遵守的底层规则\n\n"
            f"- 第{arc_number}篇规则必须完整保留。\n\n"
            f"## 第一节（第{start:03d}—{end:03d}章）\n\n"
            f"### 第{start:03d}章 开始\n\n- 推进第{arc_number}篇。\n\n"
            f"### 第{end:03d}章 收束\n\n- 收束第{arc_number}篇。\n"
        )
        write(project / "大纲" / f"第{arc_number:02d}篇_测试篇.md", arc)
        plan_lines.append(f"- 第{start:03d}章：开始第{arc_number}篇。")
        plan_lines.append(f"- 第{end:03d}章：结束第{arc_number}篇。")
    write(project / "大纲" / "章节规划.md", "\n".join(plan_lines) + "\n")
    return library, project


def write_blueprint(project: Path, chapter: int, extra_hard_rule: str = "") -> Path:
    path = project / "大纲" / f"细纲_第{chapter:03d}章.md"
    hard = extra_hard_rule or "测试中的关键事实不得被改写。"
    write(
        path,
        f"# 细纲_第{chapter:03d}章\n\n"
        "## 本章目标\n\n- 推进一个明确目标。\n\n"
        "## 情节点与字数预算\n\n"
        "| 序号 | 情节点 | 必须产生的变化 |\n"
        "| --- | --- | --- |\n"
        "| 1 | 完整事件 | 角色状态发生完整变化 |\n\n"
        "## 不可违背事实\n\n"
        f"- {hard}\n\n"
        "## 结尾钩子\n\n> 新问题出现。\n",
    )
    return path


def run_script(name: str, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / name), *args],
        cwd=str(cwd or REPO_ROOT),
        env=environment,
        text=True,
        capture_output=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )


def marker(
    record_id: str,
    content: str,
    *,
    category: str = "character",
    importance: str = "normal",
    status: str = "active",
    source_chapter: int = 0,
    entities: list[str] | None = None,
    tags: list[str] | None = None,
) -> str:
    metadata = {
        "id": record_id,
        "category": category,
        "status": status,
        "importance": importance,
        "valid_from": 1,
        "valid_to": None,
        "entities": entities or [],
        "tags": tags or [],
        "source_chapter": source_chapter,
        "updated_by_patch": "fixture",
    }
    return render_record(metadata, content)


def write_patch_history(project: Path, start: int, end: int) -> None:
    for chapter in range(start, end + 1):
        patch = {
            "schema_version": 1,
            "patch_id": f"chapter-{chapter:03d}-v1",
            "chapter": chapter,
            "summary": f"第{chapter:03d}章测试摘要。",
            "ending_state": f"第{chapter:03d}章测试章末状态。",
            "operations": [],
        }
        write(
            project / "章节提交" / f"memory_patch_第{chapter:03d}章_chapter-{chapter:03d}-v1.md",
            f"# 第{chapter:03d}章 memory_patch\n\n```json\n"
            + json.dumps(patch, ensure_ascii=False, indent=2)
            + "\n```\n",
        )


def write_chapters(project: Path, start: int, end: int) -> None:
    for chapter in range(start, end + 1):
        write(
            project / "正文" / f"第{chapter:03d}章_测试正文.md",
            f"# 第{chapter:03d}章 测试正文\n\n这是第{chapter:03d}章当前保存的正文。\n",
        )


def tree_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    }


def write_interrupted_transaction(project: Path, *, external_change: bool = False) -> tuple[Path, Path, str]:
    target = project / "记忆库" / "current" / "当前人物状态.md"
    original = "# 当前人物状态\n\n原始内容。\n"
    staged = "# 当前人物状态\n\n事务写入内容。\n"
    write(target, staged)
    transaction = project / "记忆库" / ".transactions" / "txn-test"
    write(transaction / "backup" / "0.bak", original)
    write(transaction / "staged" / "0.new", staged)
    before_hash = hashlib.sha256((transaction / "backup" / "0.bak").read_bytes()).hexdigest()
    staged_hash = hashlib.sha256((transaction / "staged" / "0.new").read_bytes()).hexdigest()
    manifest = {
        "status": "writing",
        "created_at": "2026-08-22T00:00:00+08:00",
        "files": [
            {
                "target": "记忆库/current/当前人物状态.md",
                "had_original": True,
                "backup": "backup/0.bak",
                "staged": "staged/0.new",
                "before_hash": before_hash,
                "staged_hash": staged_hash,
            }
        ],
    }
    write(transaction / "manifest.json", json.dumps(manifest, ensure_ascii=False))
    if external_change:
        write(target, "# 当前人物状态\n\n事务后人工修改。\n")
    return transaction, target, original


class MemoryWorkflowTests(unittest.TestCase):
    def test_arc_matching_and_range_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _, project = make_project(Path(temporary), [(1, 30), (31, 60), (61, 90), (271, 300)])
            self.assertEqual(select_arc_outline(project, 1).start, 1)
            self.assertEqual(select_arc_outline(project, 30).end, 30)
            self.assertEqual(select_arc_outline(project, 31).start, 31)
            self.assertEqual(select_arc_outline(project, 300).end, 300)

            overlap = project / "大纲" / "第02篇_测试篇.md"
            overlap.write_text(overlap.read_text(encoding="utf-8").replace("第031—060章", "第030—060章"), encoding="utf-8")
            with self.assertRaises(MemorySystemError):
                select_arc_outline(project, 30)

    def test_taskbook_stays_bounded_at_three_scales(self) -> None:
        for count in (3, 100, 300):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temporary:
                library, project = make_project(Path(temporary), [(1, 300)])
                write_blueprint(project, 300)
                write_chapters(project, 295, 299)
                write_patch_history(project, 299, 299)
                records = ["# 当前人物状态", ""]
                for number in range(count):
                    records.extend(
                        [
                            marker(
                                f"state-{number:03d}",
                                f"完整状态{number:03d}：这一条记忆必须作为整体选择。",
                                source_chapter=300,
                            ),
                            "",
                        ]
                    )
                write(project / "记忆库" / "current" / "当前人物状态.md", "\n".join(records))
                result = run_script(
                    "build_context.py",
                    "--chapter",
                    "300",
                    "--library-root",
                    str(library),
                    "--budget-chars",
                    "1500",
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                taskbook = read(project / "记忆库" / "current" / "本章写作任务书.md")
                self.assertLessEqual(len(taskbook), 1500)
                self.assertNotIn("中间省略", taskbook)
                self.assertNotIn("最近 3 章", taskbook)

    def test_taskbook_lists_exact_previous_five_current_chapters(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write_blueprint(project, 7)
            write_chapters(project, 1, 6)
            write_patch_history(project, 1, 6)
            write(
                project / "旧版正文备份" / "正文" / "第999章_不能读取.md",
                "# 第999章 旧版正文\n\n不能进入当前任务书。\n",
            )

            result = run_script("build_context.py", "--chapter", "7", "--library-root", str(library))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            taskbook = read(project / "记忆库" / "current" / "本章写作任务书.md")

            self.assertIn("前置正文（必须全文读取）", taskbook)
            for chapter in range(2, 7):
                self.assertIn(f"正文/第{chapter:03d}章_测试正文.md", taskbook)
            self.assertNotIn("正文/第001章_测试正文.md", taskbook)
            self.assertNotIn("第999章_不能读取.md", taskbook)
            self.assertIn("以文件当前保存内容为准", taskbook)

    def test_taskbook_stops_when_continuous_previous_chapter_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write_blueprint(project, 2)

            result = run_script("build_context.py", "--chapter", "2", "--library-root", str(library))

            self.assertEqual(result.returncode, 2)
            self.assertIn("缺少正文：第001章", result.stdout)
            self.assertFalse((project / "记忆库" / "current" / "本章写作任务书.md").exists())

    def test_workflow_blocker_does_not_read_stale_blueprint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write_blueprint(project, 1, "旧细纲危险内容")
            write(
                project / "记忆库" / "current" / "写作状态.md",
                "# 写作状态\n\n"
                + marker(
                    "workflow.story-reset",
                    "旧细纲尚未重写，不得生成正文。",
                    category="workflow",
                    importance="critical",
                )
                + "\n",
            )
            result = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            taskbook = read(project / "记忆库" / "current" / "本章写作任务书.md")
            self.assertIn("暂停", taskbook)
            self.assertIn("workflow.story-reset", taskbook)
            self.assertNotIn("旧细纲危险内容", taskbook)

    def test_update_is_idempotent_and_archives(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            current_path = project / "记忆库" / "current" / "当前人物状态.md"
            write(
                current_path,
                "# 当前人物状态\n\n这段手工说明必须保留。\n\n"
                + marker("character-test", "旧状态。", entities=["林序"], tags=["职业"])
                + "\n",
            )
            patch_one = {
                "schema_version": 2,
                "patch_id": "chapter-001-v1",
                "kind": "migration",
                "chapter": 1,
                "chapter_revision": None,
                "source_revisions": {},
                "summary": "测试摘要。",
                "ending_state": "测试章末状态。",
                "operations": [
                    {
                        "action": "upsert",
                        "record": {
                            "id": "character-test",
                            "category": "character",
                            "status": "active",
                            "importance": "high",
                            "valid_from": 1,
                            "valid_to": None,
                            "entities": ["林序"],
                            "tags": ["职业"],
                            "source_chapter": 1,
                            "content": "新状态完整写入。",
                        },
                    }
                ],
            }
            patch_path = project / "章节提交" / "pending-patch.json"
            write(patch_path, json.dumps(patch_one, ensure_ascii=False))
            first = run_script("update_memory.py", "--patch", str(patch_path), "--library-root", str(library))
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            current_after = read(current_path)
            self.assertIn("手工说明必须保留", current_after)
            self.assertIn("新状态完整写入", current_after)
            self.assertNotIn("旧状态。", current_after)
            digest = hashlib.sha256(current_path.read_bytes()).hexdigest()
            memory_index = project / "记忆库" / "index" / "memory_index.json"
            self.assertTrue(memory_index.exists())
            memory_index.unlink()

            second = run_script("update_memory.py", "--patch", str(patch_path), "--library-root", str(library))
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("幂等跳过", second.stdout)
            self.assertEqual(digest, hashlib.sha256(current_path.read_bytes()).hexdigest())
            self.assertTrue(memory_index.exists())
            healthy_index_digest = hashlib.sha256(memory_index.read_bytes()).hexdigest()

            third = run_script("update_memory.py", "--patch", str(patch_path), "--library-root", str(library))
            self.assertEqual(third.returncode, 0, third.stdout + third.stderr)
            self.assertIn("幂等跳过", third.stdout)
            self.assertEqual(healthy_index_digest, hashlib.sha256(memory_index.read_bytes()).hexdigest())

            patch_two = {
                "schema_version": 2,
                "patch_id": "chapter-002-v1",
                "kind": "migration",
                "chapter": 2,
                "chapter_revision": None,
                "source_revisions": {},
                "summary": "状态结束。",
                "ending_state": "该状态已经归档。",
                "operations": [{"action": "archive", "id": "character-test", "reason": "后续事实替换"}],
            }
            patch_two_path = project / "章节提交" / "pending-patch-two.json"
            write(patch_two_path, json.dumps(patch_two, ensure_ascii=False))
            archived = run_script("update_memory.py", "--patch", str(patch_two_path), "--library-root", str(library))
            self.assertEqual(archived.returncode, 0, archived.stdout + archived.stderr)
            self.assertNotIn("character-test", read(current_path))
            archive_text = read(project / "档案库" / "记忆历史" / "character.md")
            self.assertIn("character-test", archive_text)
            self.assertIn('"status":"outdated"', archive_text)

            invalid_path = project / "章节提交" / "invalid.json"
            write(invalid_path, '{"schema_version":1}')
            before = hashlib.sha256(current_path.read_bytes()).hexdigest()
            invalid = run_script("update_memory.py", "--patch", str(invalid_path), "--library-root", str(library))
            self.assertEqual(invalid.returncode, 2)
            self.assertEqual(before, hashlib.sha256(current_path.read_bytes()).hexdigest())

    def test_concurrent_update_processes_serialize_and_second_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            patch = {
                "schema_version": 2,
                "patch_id": "concurrent-migration-v1",
                "kind": "migration",
                "chapter": 1,
                "chapter_revision": None,
                "source_revisions": {},
                "summary": "并发写入测试。",
                "ending_state": "只允许生成一次结果。",
                "operations": [
                    {
                        "action": "upsert",
                        "record": {
                            "id": "character-concurrent",
                            "category": "character",
                            "status": "active",
                            "importance": "high",
                            "valid_from": 1,
                            "valid_to": None,
                            "entities": ["并发角色"],
                            "tags": ["并发"],
                            "source_chapter": 1,
                            "content": "并发结果只应存在一份。",
                        },
                    }
                ],
            }
            patch_path = project / "章节提交" / "concurrent-patch.json"
            write(patch_path, json.dumps(patch, ensure_ascii=False))
            environment = os.environ.copy()
            environment["PYTHONUTF8"] = "1"
            command = [
                sys.executable,
                str(SCRIPTS_DIR / "update_memory.py"),
                "--patch",
                str(patch_path),
                "--library-root",
                str(library),
            ]
            processes = [
                subprocess.Popen(
                    command,
                    cwd=str(REPO_ROOT),
                    env=environment,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                )
                for _ in range(2)
            ]
            results = [process.communicate(timeout=30) for process in processes]

            self.assertEqual([process.returncode for process in processes], [0, 0], results)
            combined_stdout = "\n".join(stdout for stdout, _ in results)
            self.assertEqual(combined_stdout.count("幂等跳过"), 1, combined_stdout)
            current = read(project / "记忆库" / "current" / "当前人物状态.md")
            self.assertEqual(current.count("character-concurrent"), 1)
            self.assertEqual(inspect_transactions(project), [])

    def test_query_rebuilds_index_only_in_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write(
                project / "记忆库" / "current" / "当前人物状态.md",
                "# 当前人物状态\n\n"
                + marker(
                    "character-linxu-career",
                    "林序职业仍为未定。",
                    importance="high",
                    entities=["林序"],
                    tags=["职业"],
                )
                + "\n",
            )
            query = run_script(
                "query_memory.py",
                "--chapter",
                "1",
                "--entity",
                "林序",
                "--tag",
                "职业",
                "--library-root",
                str(library),
                "--json",
            )
            self.assertEqual(query.returncode, 0, query.stdout + query.stderr)
            self.assertIn("character-linxu-career", query.stdout)
            query_payload = json.loads(query.stdout)
            self.assertEqual(query_payload["omitted_count"], len(query_payload["omitted_ids"]))
            self.assertFalse(query_payload["omitted_truncated"])
            self.assertFalse(index_path(project).exists())
            rebuilt = run_script(
                "query_memory.py", "--chapter", "1", "--entity", "林序", "--library-root", str(library)
            )
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stdout + rebuilt.stderr)
            self.assertFalse(index_path(project).exists())

    def test_query_refuses_pending_transaction_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            (project / "记忆库" / ".transactions" / "txn-pending").mkdir(parents=True)
            query = run_script("query_memory.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(query.returncode, 2, query.stdout + query.stderr)
            self.assertIn("未完成事务", query.stdout)

    def test_query_limit_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, _project = make_project(Path(temporary), [(1, 30)])
            query = run_script(
                "query_memory.py", "--chapter", "1", "--limit", "101", "--library-root", str(library)
            )
            self.assertEqual(query.returncode, 2, query.stdout + query.stderr)
            self.assertIn("1-100", query.stdout)

    def test_taskbook_budget_has_a_hard_upper_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, _project = make_project(Path(temporary), [(1, 30)])
            result = run_script(
                "build_context.py",
                "--chapter",
                "1",
                "--budget-chars",
                "12001",
                "--library-root",
                str(library),
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("不能高于 12000", result.stdout)

    def test_compaction_only_writes_snapshot_at_arc_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30), (31, 60)])
            non_end = run_script(
                "compact_memory.py", "--range", "001-005", "--library-root", str(library)
            )
            self.assertEqual(non_end.returncode, 0, non_end.stdout + non_end.stderr)
            self.assertFalse(any((project / "记忆库" / "snapshots").glob("第001-005章_*.md")))

            incomplete = run_script(
                "compact_memory.py", "--range", "001-030", "--library-root", str(library), "--dry-run"
            )
            self.assertEqual(incomplete.returncode, 2)
            self.assertIn("篇章尚未完成", incomplete.stdout)
            write_patch_history(project, 1, 30)

            dry = run_script(
                "compact_memory.py", "--range", "001-030", "--library-root", str(library), "--dry-run"
            )
            self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
            snapshot = project / "记忆库" / "snapshots" / "第001-030章_篇末摘要.md"
            self.assertFalse(snapshot.exists())

            applied = run_script(
                "compact_memory.py", "--range", "001-030", "--library-root", str(library)
            )
            self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
            self.assertTrue(snapshot.exists())

    def test_schema2_candidate_without_fresh_manifest_is_not_a_completed_chapter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 1)])
            patch = {
                "schema_version": 2,
                "patch_id": "chapter-001-candidate",
                "kind": "chapter_result",
                "chapter": 1,
                "chapter_revision": "0" * 64,
                "source_revisions": {"正文/第001章_候选.md": "0" * 64},
                "summary": "这只是尚未应用的候选摘要。",
                "ending_state": "不应进入篇末摘要。",
                "operations": [],
            }
            write(
                project / "章节提交" / "memory_patch_第001章_chapter-001-candidate.md",
                json.dumps(patch, ensure_ascii=False),
            )
            compacted = run_script(
                "compact_memory.py", "--range", "001-001", "--library-root", str(library), "--dry-run"
            )
            self.assertEqual(compacted.returncode, 2, compacted.stdout + compacted.stderr)
            self.assertIn("篇章尚未完成", compacted.stdout)

    def test_compaction_refuses_pending_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 1)])
            (project / "记忆库" / ".transactions" / "txn-pending").mkdir(parents=True)
            before = tree_snapshot(project)
            compacted = run_script("compact_memory.py", "--range", "001-001", "--library-root", str(library))
            self.assertEqual(compacted.returncode, 2, compacted.stdout + compacted.stderr)
            self.assertIn("事务、数据或 workflow 阻断", compacted.stdout)
            self.assertEqual(before, tree_snapshot(project))

    def test_critical_over_budget_stops_without_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write_blueprint(project, 1)
            write(
                project / "记忆库" / "current" / "不可违背事实.md",
                "# 不可违背事实\n\n"
                + marker(
                    "hard-fact-large",
                    "关键事实" + "不能删减" * 260,
                    category="hard_fact",
                    importance="critical",
                )
                + "\n",
            )
            result = run_script(
                "build_context.py",
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--budget-chars",
                "800",
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("超过预算", result.stdout)
            self.assertFalse((project / "记忆库" / "current" / "本章写作任务书.md").exists())

    def test_taskbook_rejects_missing_change_column_and_external_outline_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            blueprint = write_blueprint(project, 1)
            write(blueprint, read(blueprint).replace("必须产生的变化", "备注"))
            missing_column = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(missing_column.returncode, 2, missing_column.stdout + missing_column.stderr)
            self.assertIn("缺少“必须产生的变化”列", missing_column.stdout)

            outside = Path(temporary) / "outside-outline.md"
            write(outside, "# 项目外总纲\n")
            total_outline = project / "大纲" / "总纲.md"
            total_outline.unlink()
            try:
                os.symlink(outside, total_outline)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            linked = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(linked.returncode, 2, linked.stdout + linked.stderr)
            self.assertIn("越出当前小说目录", linked.stdout)

    def test_legacy_migration_preserves_text_and_moves_context_to_trash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            current = project / "记忆库" / "current" / "当前人物状态.md"
            write(current, "# 当前人物状态\n\n## 林序\n\n- 原有事实必须原样保留。\n")
            write(
                project / "记忆库" / "current" / "本章上下文包.md",
                "# 本章上下文包：暂停生成正文\n\n- 旧细纲尚未重写。\n",
            )
            result = run_script(
                "memory_doctor.py",
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--migrate-legacy",
                "--rebuild-index",
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            migrated = read(current)
            self.assertIn("原有事实必须原样保留", migrated)
            self.assertIn("webnovel-memory", migrated)
            self.assertFalse((project / "记忆库" / "current" / "本章上下文包.md").exists())
            self.assertTrue((project / "记忆库" / "current" / "本章写作任务书.md").exists())
            self.assertIn("workflow.story-reset", read(project / "记忆库" / "current" / "写作状态.md"))
            trashed = list((library / ".trash").rglob("本章上下文包.md"))
            self.assertEqual(len(trashed), 1)

    def test_normal_legacy_project_does_not_gain_story_reset_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write(
                project / "记忆库" / "current" / "当前人物状态.md",
                "# 当前人物状态\n\n- 林序正在准备下一次行动。\n",
            )
            write(
                project / "记忆库" / "current" / "本章上下文包.md",
                "# 第010章 本章上下文包\n\n- 这是普通旧上下文，不是正文重置。\n",
            )
            result = run_script(
                "memory_doctor.py",
                "--chapter",
                "10",
                "--library-root",
                str(library),
                "--migrate-legacy",
                "--rebuild-index",
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((project / "记忆库" / "current" / "写作状态.md").exists())
            self.assertFalse((project / "记忆库" / "current" / "本章写作任务书.md").exists())
            self.assertFalse((project / "记忆库" / "current" / "本章上下文包.md").exists())

    def test_dry_run_is_zero_write_even_with_pending_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            transaction, _, _ = write_interrupted_transaction(project)
            before = tree_snapshot(project)
            result = run_script(
                "memory_doctor.py",
                "--library-root",
                str(library),
                "--recover",
                "--rebuild-index",
                "--dry-run",
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("dry-run", result.stdout)
            self.assertTrue(transaction.exists())
            self.assertEqual(before, tree_snapshot(project))

    def test_explicit_recovery_restores_and_conflict_preserves_external_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            transaction, target, original = write_interrupted_transaction(project)
            recovered = run_script("memory_doctor.py", "--library-root", str(library), "--recover", "--json")
            self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
            recovered_payload = json.loads(recovered.stdout)
            self.assertEqual(recovered_payload["pending_transactions"], [])
            self.assertEqual(recovered_payload["recovered_transactions"], [transaction.name])
            self.assertEqual(read(target), original)
            self.assertFalse(transaction.exists())

        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            transaction, target, _ = write_interrupted_transaction(project, external_change=True)
            changed = read(target)
            conflicted = run_script("memory_doctor.py", "--library-root", str(library), "--recover")
            self.assertEqual(conflicted.returncode, 2)
            self.assertIn("外部修改", conflicted.stdout)
            self.assertEqual(read(target), changed)
            self.assertTrue(transaction.exists())

        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            transaction, target, _ = write_interrupted_transaction(project)
            manifest_path = transaction / "manifest.json"
            payload = json.loads(read(manifest_path))
            payload["files"][0]["backup"] = str(Path(temporary) / "outside-backup.md")
            write(manifest_path, json.dumps(payload, ensure_ascii=False))
            before = read(target)
            rejected = run_script("memory_doctor.py", "--library-root", str(library), "--recover")
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("事务备份", rejected.stdout)
            self.assertEqual(read(target), before)

    def test_registered_project_and_output_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            write_blueprint(project, 1)
            unregistered = library / "作品" / "not-registered"
            unregistered.mkdir(parents=True)
            rejected = run_script(
                "build_context.py",
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--project-root",
                str(unregistered),
            )
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("未登记", rejected.stdout)

            escaped = run_script(
                "build_context.py",
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--output",
                str(Path(temporary) / "outside.md"),
            )
            self.assertEqual(escaped.returncode, 2)
            self.assertIn("越出当前小说目录", escaped.stdout)

            overwrite_source = run_script(
                "build_context.py",
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--output",
                str(project / "大纲" / "总纲.md"),
            )
            self.assertEqual(overwrite_source.returncode, 2)
            self.assertIn("只能写入规范路径", overwrite_source.stdout)

        with tempfile.TemporaryDirectory() as temporary:
            library, _project = make_project(Path(temporary), [(1, 30)])
            projects_root = library / "作品"
            outside_projects = Path(temporary) / "outside-projects"
            projects_root.rename(outside_projects)
            try:
                os.symlink(outside_projects, projects_root, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建作品目录链接：{exc}")
            rejected = run_script("query_memory.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(rejected.returncode, 2, rejected.stdout + rejected.stderr)
            self.assertIn("作品目录不能是符号链接或 junction", rejected.stdout)

    def test_multiple_legacy_patches_require_explicit_classification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            for patch_id in ("chapter-001-v1", "outline-rewrite-001-v1"):
                payload = {
                    "schema_version": 1,
                    "patch_id": patch_id,
                    "chapter": 1,
                    "summary": patch_id,
                    "ending_state": patch_id,
                    "operations": [],
                }
                write(
                    project / "章节提交" / f"memory_patch_第001章_{patch_id}.md",
                    f"```json\n{json.dumps(payload, ensure_ascii=False)}\n```\n",
                )
            blocked = run_script("memory_doctor.py", "--chapter", "2", "--library-root", str(library))
            self.assertEqual(blocked.returncode, 2)
            self.assertIn("多个未分类旧 patch", blocked.stdout)
            write(
                project / "章节提交" / "patch_classifications.json",
                json.dumps(
                    {
                        "schema_version": 1,
                        "classifications": {
                            "chapter-001-v1": "chapter_result",
                            "outline-rewrite-001-v1": "outline_baseline",
                        },
                    },
                    ensure_ascii=False,
                ),
            )
            ready = run_script("memory_doctor.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(ready.returncode, 0, ready.stdout + ready.stderr)
            (project / "章节提交" / "patch_classifications.json").unlink()
            write(
                project / "章节提交" / "compat" / "patch_classifications.json",
                json.dumps(
                    {
                        "schema_version": 1,
                        "classifications": {
                            "chapter-001-v1": "chapter_result",
                            "outline-rewrite-001-v1": "outline_baseline",
                        },
                    },
                    ensure_ascii=False,
                ),
            )
            compatible = run_script("memory_doctor.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(compatible.returncode, 0, compatible.stdout + compatible.stderr)

    def test_chapter_finalization_manifest_becomes_stale_after_body_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            blueprint = write_blueprint(project, 1)
            task = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(task.returncode, 0, task.stdout + task.stderr)
            body = project / "正文" / "第001章_测试正文.md"
            write(body, "# 第001章 测试正文\n\n正文版本一。\n")
            body_revision = hashlib.sha256(body.read_bytes()).hexdigest()
            review = project / "审查报告" / "第001章_审查报告.md"
            review_proof = project / "审查报告" / "第001章_审查报告.review.json"
            commit = project / "章节提交" / "第001章_章节提交.md"
            write(review, f"# 第001章 审查报告\n\n- 正文 revision：`{body_revision}`\n- 结果：通过\n")
            write(
                review_proof,
                json.dumps(
                    {
                        "schema_version": 2,
                        "kind": "chapter_review_proof",
                        "chapter": 1,
                        "document_path": "正文/第001章_测试正文.md",
                        "document_revision": body_revision,
                        "disk_revision": body_revision,
                        "content_revision": body_revision,
                        "run_id": "review-run-001",
                        "status": "completed",
                        "verdict": "pass",
                        "blocking_findings": 0,
                        "verification": {"required": 0, "resolved": 0, "unverified": 0},
                        "findings_digest": "0" * 64,
                        "context_revisions": {"正文/第001章_测试正文.md": body_revision},
                        "prompt_version": "chapter-audit@v1 + finding-verify@v1",
                    },
                    ensure_ascii=False,
                ),
            )
            write(commit, f"# 第001章 章节提交\n\n- 正文 revision：`{body_revision}`\n")
            sources = [
                body,
                blueprint,
                project / "记忆库" / "current" / "本章写作任务书.md",
                review,
                review_proof,
                commit,
            ]
            patch = {
                "schema_version": 2,
                "patch_id": "chapter-001-final-v1",
                "kind": "chapter_result",
                "chapter": 1,
                "chapter_revision": body_revision,
                "source_revisions": {
                    path.relative_to(project).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in sources
                },
                "summary": "第一章已完成。",
                "ending_state": "人物进入下一步行动。",
                "operations": [],
            }
            pending = project / "章节提交" / "pending-finalization.json"
            write(pending, json.dumps(patch, ensure_ascii=False))
            applied = run_script("update_memory.py", "--patch", str(pending), "--library-root", str(library))
            self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
            manifest = project / "章节提交" / "第001章_finalization.json"
            self.assertTrue(manifest.exists())

            original_manifest = json.loads(read(manifest))
            with mock_patch("memory_patch_schema.sha256_file", side_effect=PermissionError("locked")):
                unreadable = chapter_finalization_status(project, 1)
            self.assertEqual(unreadable["status"], "stale")
            self.assertTrue(any("无法稳定读取" in reason for reason in unreadable["reasons"]))

            tampered_manifest = dict(original_manifest)
            tampered_manifest["patch_id"] = "chapter-001-repointed"
            write(manifest, json.dumps(tampered_manifest, ensure_ascii=False))
            repointed = run_script("memory_doctor.py", "--chapter", "2", "--library-root", str(library))
            self.assertEqual(repointed.returncode, 2)
            self.assertIn("FINALIZATION_STALE", repointed.stdout)
            write(manifest, json.dumps(original_manifest, ensure_ascii=False))

            write(body, "# 第001章 测试正文\n\n正文版本二，旧审查不再有效。\n")
            stale = run_script("memory_doctor.py", "--chapter", "2", "--library-root", str(library))
            self.assertEqual(stale.returncode, 2)
            self.assertIn("FINALIZATION_STALE", stale.stdout)

    def test_chapter_finalization_status_rejects_external_manifest_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside-finalization.json"
            write(outside, json.dumps({"schema_version": 1}))
            link = project / "章节提交" / "第001章_finalization.json"
            try:
                os.symlink(outside, link)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "不能是符号链接"):
                chapter_finalization_status(project, 1)

    def test_chapter_finalization_rejects_missing_partial_and_stale_review_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            blueprint = write_blueprint(project, 1)
            task = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(task.returncode, 0, task.stdout + task.stderr)
            body = project / "正文" / "第001章_测试正文.md"
            write(body, "# 第001章 测试正文\n\n正文版本一。\n")
            body_revision = hashlib.sha256(body.read_bytes()).hexdigest()
            review = project / "审查报告" / "第001章_审查报告.md"
            proof = project / "审查报告" / "第001章_审查报告.review.json"
            commit = project / "章节提交" / "第001章_章节提交.md"
            write(review, f"# 第001章 审查报告\n\n- 正文 revision：`{body_revision}`\n- 结果：通过\n")
            write(commit, f"# 第001章 章节提交\n\n- 正文 revision：`{body_revision}`\n")
            base_sources = [
                body,
                blueprint,
                project / "记忆库" / "current" / "本章写作任务书.md",
                review,
                commit,
            ]

            def make_patch(include_proof: bool = True) -> dict[str, object]:
                sources = [*base_sources, *([proof] if include_proof else [])]
                return {
                    "schema_version": 2,
                    "patch_id": "chapter-001-proof-test",
                    "kind": "chapter_result",
                    "chapter": 1,
                    "chapter_revision": body_revision,
                    "source_revisions": {
                        path.relative_to(project).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                        for path in sources
                    },
                    "summary": "第一章已完成。",
                    "ending_state": "人物进入下一步行动。",
                    "operations": [],
                }

            with self.assertRaisesRegex(MemorySystemError, "机器可读审阅证明"):
                validate_patch_source_revisions(project, make_patch(False))

            write(proof, "{}")
            with self.assertRaisesRegex(MemorySystemError, "版本不受支持"):
                validate_patch_source_revisions(project, make_patch())

            for bad_value, expected_message in (
                ({"status": "error", "verdict": "needs_changes", "blocking_findings": 0}, "未通过"),
                ({"status": "completed", "verdict": "pass", "blocking_findings": 1}, "阻塞 finding"),
                ({"status": "completed", "verdict": "pass", "blocking_findings": False}, "阻塞 finding"),
                ({"status": "completed", "verdict": "pass", "blocking_findings": 0, "verification": {"required": True, "resolved": True, "unverified": False}}, "核验"),
                ({"status": "completed", "verdict": "pass", "blocking_findings": 0, "document_revision": "0" * 64}, "revision 已过期"),
                ({"context_revisions": {}}, "必须在 context_revisions"),
                ({"context_revisions": {"正文/第001章_测试正文.md": body_revision, "大纲/未绑定.md": "0" * 64}}, "未绑定到 source_revisions"),
            ):
                payload = {
                    "schema_version": 2,
                    "kind": "chapter_review_proof",
                    "chapter": 1,
                    "document_path": "正文/第001章_测试正文.md",
                    "document_revision": body_revision,
                    "disk_revision": body_revision,
                    "content_revision": body_revision,
                    "run_id": "review-run-001",
                    "status": "completed",
                    "verdict": "pass",
                    "blocking_findings": 0,
                    "verification": {"required": 0, "resolved": 0, "unverified": 0},
                    "findings_digest": "0" * 64,
                    "context_revisions": {"正文/第001章_测试正文.md": body_revision},
                    "prompt_version": "chapter-audit@v1 + finding-verify@v1",
                    **bad_value,
                }
                write(proof, json.dumps(payload, ensure_ascii=False))
                with self.assertRaisesRegex(MemorySystemError, expected_message):
                    validate_patch_source_revisions(project, make_patch())

    def test_memory_scan_rejects_symlink_or_junction_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside"
            outside.mkdir()
            write(outside / "sentinel.md", "项目外哨兵。")
            link = project / "档案库" / "外部资料"
            try:
                os.symlink(outside, link, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建目录链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "档案库路径越出当前小说目录"):
                memory_source_files(project)

    def test_memory_doctor_migration_rejects_external_file_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside.md"
            write(outside, "项目外哨兵。")
            link = project / "记忆库" / "current" / "外部资料.md"
            try:
                os.symlink(outside, link)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            migrated = run_script(
                "memory_doctor.py", "--library-root", str(library), "--migrate-legacy", "--dry-run"
            )
            self.assertEqual(migrated.returncode, 2, migrated.stdout + migrated.stderr)
            self.assertIn("越出当前小说目录", migrated.stdout)

    def test_tampered_memory_index_cannot_read_outside_project(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside.md"
            write(outside, "项目外哨兵。")
            with self.assertRaisesRegex(MemorySystemError, "索引来源越出当前小说目录"):
                load_indexed_records(project, [{"id": "outside-record", "file": "../../outside.md"}])

    def test_non_object_memory_index_is_rebuilt_instead_of_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            target = index_path(project)
            write(target, "[]")
            rebuilt = ensure_index(project)
            self.assertIsInstance(rebuilt, dict)
            self.assertEqual(rebuilt["schema_version"], 2)

            rebuilt["records"] = ["damaged"]
            write(target, json.dumps(rebuilt, ensure_ascii=False))
            repaired = ensure_index(project)
            self.assertTrue(all(isinstance(item, dict) for item in repaired["records"]))
            with self.assertRaisesRegex(MemorySystemError, "结构损坏"):
                rank_index_records({**repaired, "records": [None]}, 1)

            repaired["records"] = [{"id": "broken", "file": "记忆库/current/当前人物状态.md", "entities": None, "tags": []}]
            write(target, json.dumps(repaired, ensure_ascii=False))
            self.assertEqual(ensure_index(project)["records"], [])

            repaired["schema_version"] = 2.0
            write(target, json.dumps(repaired, ensure_ascii=False))
            self.assertIs(type(ensure_index(project)["schema_version"]), int)

            repaired["schema_version"] = 2
            repaired["records"] = [{"id": "broken", "file": ".", "entities": [], "tags": []}]
            write(target, json.dumps(repaired, ensure_ascii=False))
            self.assertEqual(ensure_index(project)["records"], [])

    def test_memory_index_rejects_external_index_directory_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            index_dir = project / "记忆库" / "index"
            index_dir.rmdir()
            outside = Path(temporary) / "outside-index"
            outside.mkdir()
            try:
                os.symlink(outside, index_dir, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建目录链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "记忆索引目录不能是符号链接或 junction"):
                ensure_index(project)

    def test_memory_index_rejects_a_link_at_the_index_file_leaf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside-index.json"
            write(outside, "{}")
            leaf = project / "记忆库" / "index" / "memory_index.json"
            try:
                os.symlink(outside, leaf)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建索引文件链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "记忆索引不能是符号链接或 junction"):
                ensure_index(project)

    def test_transaction_manifest_must_be_json_object(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            transaction = project / "记忆库" / ".transactions" / "txn-invalid"
            write(transaction / "manifest.json", "[]")
            with self.assertRaisesRegex(MemorySystemError, "顶层必须是对象"):
                inspect_transactions(project)

    def test_taskbook_source_and_chapter_selection_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            with self.assertRaisesRegex(MemorySystemError, "必需来源不存在"):
                build_taskbook_metadata(project, 1, [project / "大纲" / "missing.md"], "ready", "任务书")
            with self.assertRaisesRegex(MemorySystemError, "重复标题"):
                chapter_section("# 第001章 A\n\nA\n\n# 第001章 B\n\nB\n", 1)
            with self.assertRaisesRegex(MemorySystemError, "多个候选"):
                chapter_plan_target("- 第001章：A\n- 第001章：B\n", 1)

    def test_taskbook_requires_canonical_blueprint_and_required_sections(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            blueprint = write_blueprint(project, 1)
            legacy = project / "大纲" / "第1章_细纲.md"
            blueprint.rename(legacy)
            noncanonical = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(noncanonical.returncode, 2, noncanonical.stdout + noncanonical.stderr)
            self.assertIn("必须唯一且使用规范路径", noncanonical.stdout)

            legacy.rename(blueprint)
            write(blueprint, read(blueprint).replace("## 本章目标\n\n- 推进一个明确目标。\n\n", ""))
            missing_section = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(missing_section.returncode, 2, missing_section.stdout + missing_section.stderr)
            self.assertIn("缺少非空的“本章目标”", missing_section.stdout)

            write_blueprint(project, 1)
            write(blueprint, read(blueprint).replace("- 推进一个明确目标。", "- "))
            empty_list_item = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(empty_list_item.returncode, 2, empty_list_item.stdout + empty_list_item.stderr)
            self.assertIn("缺少非空的“本章目标”", empty_list_item.stdout)

            write_blueprint(project, 1)
            write(blueprint, read(blueprint).replace("> 新问题出现。", ">"))
            empty_quote = run_script("build_context.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(empty_quote.returncode, 2, empty_quote.stdout + empty_quote.stderr)
            self.assertIn("缺少非空的“结尾钩子”", empty_quote.stdout)

            scan_target = project / "不是目录"
            write(scan_target, "普通文件")
            with self.assertRaisesRegex(MemorySystemError, "不是目录"):
                project_files(project, scan_target, "*.md", recursive=True, label="测试扫描路径")

    def test_transaction_recovery_rejects_invalid_file_record(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            transaction = project / "记忆库" / ".transactions" / "txn-invalid-target"
            write(
                transaction / "manifest.json",
                json.dumps({
                    "status": "writing",
                    "files": [{"target": "", "backup": "backup/0.bak", "had_original": False}],
                }),
            )
            with self.assertRaisesRegex(MemorySystemError, "有效 target"):
                recover_transactions(project, force_legacy=True)

    def test_transaction_root_file_and_staging_failure_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            transaction_root = project / "记忆库" / ".transactions"
            write(transaction_root, "普通文件占位")
            with self.assertRaisesRegex(MemorySystemError, "普通文件占用"):
                inspect_transactions(project)

        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            target = project / "记忆库" / "current" / "当前人物状态.md"
            write(target, "原始内容")
            with mock_patch("memory_transactions.shutil.copy2", side_effect=OSError("staging failed")):
                with self.assertRaisesRegex(OSError, "staging failed"):
                    apply_transaction(project, {target: "新内容"})
            transaction_root = project / "记忆库" / ".transactions"
            self.assertTrue(transaction_root.is_dir())
            self.assertEqual(list(transaction_root.iterdir()), [])
            self.assertEqual(read(target), "原始内容")

    def test_transaction_rejects_linked_target_without_touching_external_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside-transaction.md"
            write(outside, "外部哨兵内容")
            target = project / "记忆库" / "current" / "当前人物状态.md"
            target.unlink(missing_ok=True)
            try:
                os.symlink(outside, target)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "不能经过符号链接"):
                apply_transaction(project, {target: "越界内容"})
            self.assertEqual(outside.read_text(encoding="utf-8"), "外部哨兵内容")

    def test_dry_run_transaction_preflight_rejects_directory_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            target = project / "章节提交" / "memory_patch_第001章_dry-run.md"
            target.mkdir(parents=True)
            with self.assertRaisesRegex(MemorySystemError, "不是普通文件"):
                validate_transaction_targets(project, {target: "候选内容"})

    def test_memory_doctor_reports_non_file_legacy_input_stably(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            invalid = project / "档案库" / "事实历史" / "不可违背事实.md"
            invalid.mkdir(parents=True)
            result = run_script(
                "memory_doctor.py",
                "--library-root",
                str(library),
                "--migrate-legacy",
                "--dry-run",
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("不是普通文件", result.stdout)

    def test_released_lock_owned_by_live_process_is_not_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock_file = Path(temporary) / "project-write.lock"
            write(lock_file, json.dumps({
                "owner": f"{os.getpid()}-live",
                "pid": os.getpid(),
                "host": socket.gethostname(),
                "released": True,
            }))
            old = 60.0
            stat = lock_file.stat()
            os.utime(lock_file, (stat.st_atime - old, stat.st_mtime - old))
            self.assertFalse(_reclaim_lock(lock_file, stale_seconds=0.01))
            self.assertTrue(lock_file.exists())

    def test_chapter_number_parser_rejects_partial_or_negative_values(self) -> None:
        for value in ("-1", "1.5", "chapter-001", "第1章附录"):
            with self.subTest(value=value), self.assertRaises(MemorySystemError):
                normalize_chapter(value)
        self.assertEqual(normalize_chapter("第001章"), (1, "001"))

    def test_patch_schema_version_rejects_boolean_or_float(self) -> None:
        for schema_version in (True, 1.0):
            patch = {
                "schema_version": schema_version,
                "patch_id": "chapter-001-invalid-schema",
                "chapter": 1,
                "summary": "摘要",
                "ending_state": "状态",
                "operations": [],
            }
            with self.subTest(schema_version=schema_version), self.assertRaisesRegex(MemorySystemError, "schema_version"):
                validate_patch(patch)

    def test_patch_source_revisions_reject_normalized_duplicates_and_internal_links(self) -> None:
        duplicate = {
            "schema_version": 2,
            "patch_id": "migration-duplicate-paths",
            "kind": "migration",
            "chapter": 1,
            "chapter_revision": None,
            "source_revisions": {"大纲\\来源.md": "0" * 64, "大纲/来源.md": "1" * 64},
            "summary": "迁移",
            "ending_state": "完成",
            "operations": [],
        }
        with self.assertRaisesRegex(MemorySystemError, "重复的规范路径"):
            validate_patch(duplicate)

        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            source = project / "大纲" / "真实来源.md"
            alias = project / "大纲" / "链接来源.md"
            write(source, "真实来源")
            try:
                os.symlink(source, alias)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            patch = validate_patch({
                "schema_version": 2,
                "patch_id": "migration-linked-source",
                "kind": "migration",
                "chapter": 1,
                "chapter_revision": None,
                "source_revisions": {"大纲/链接来源.md": hashlib.sha256(source.read_bytes()).hexdigest()},
                "summary": "迁移",
                "ending_state": "完成",
                "operations": [],
            })
            with self.assertRaisesRegex(MemorySystemError, "不能经过符号链接"):
                validate_patch_source_revisions(project, patch)

    def test_persisted_schema_versions_reject_boolean_or_float(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            ledger_path = project / "章节提交" / "applied_patches.json"
            classifications_path = project / "章节提交" / "patch_classifications.json"
            proof_path = project / "审查报告" / "第001章.review.json"
            manifest_path = project / "章节提交" / "第001章_finalization.json"
            for schema_version in (True, 1.0):
                with self.subTest(loader="ledger", schema_version=schema_version):
                    write(ledger_path, json.dumps({"schema_version": schema_version, "patches": {}}))
                    with self.assertRaisesRegex(MemorySystemError, "格式无效"):
                        load_applied_patch_ledger(project)
                with self.subTest(loader="classifications", schema_version=schema_version):
                    write(classifications_path, json.dumps({"schema_version": schema_version, "classifications": {}}))
                    with self.assertRaisesRegex(MemorySystemError, "格式不正确"):
                        load_patch_classifications(project)
                with self.subTest(loader="review", schema_version=schema_version):
                    write(proof_path, json.dumps({"schema_version": schema_version}))
                    with self.assertRaisesRegex(MemorySystemError, "版本不受支持"):
                        load_review_proof(proof_path)
                with self.subTest(loader="manifest", schema_version=schema_version):
                    write(manifest_path, json.dumps({"schema_version": schema_version}))
                    with self.assertRaisesRegex(MemorySystemError, "版本不受支持"):
                        load_finalization_manifest(manifest_path)

    def test_record_change_builder_rejects_external_target_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside-memory.md"
            write(outside, "外部哨兵内容")
            target = project / "记忆库" / "current" / "当前人物状态.md"
            try:
                os.symlink(outside, target)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            with self.assertRaisesRegex(MemorySystemError, "越出当前小说目录"):
                prepare_record_file_changes(project, {}, {target: ["新记录"]})
            self.assertEqual(outside.read_text(encoding="utf-8"), "外部哨兵内容")

    def test_query_rejects_external_patch_classification_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            outside = Path(temporary) / "outside-classification.json"
            write(outside, json.dumps({"schema_version": 1, "classifications": {}}, ensure_ascii=False))
            link = project / "章节提交" / "patch_classifications.json"
            try:
                os.symlink(outside, link)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建文件链接：{exc}")
            query = run_script("query_memory.py", "--chapter", "1", "--library-root", str(library))
            self.assertEqual(query.returncode, 2, query.stdout + query.stderr)
            self.assertIn("越出当前小说目录", query.stdout)

    def test_dangling_ledger_and_classification_links_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            for name, loader, message in (
                ("applied_patches.json", load_applied_patch_ledger, "符号链接"),
                ("patch_classifications.json", load_patch_classifications, "符号链接"),
            ):
                link = project / "章节提交" / name
                try:
                    os.symlink(Path(temporary) / f"missing-{name}", link)
                except OSError as exc:
                    self.skipTest(f"当前环境不能创建文件链接：{exc}")
                with self.subTest(name=name), self.assertRaisesRegex(MemorySystemError, message):
                    loader(project)
                link.unlink()

    def test_persisted_memory_json_paths_must_be_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _library, project = make_project(Path(temporary), [(1, 30)])
            cases = (
                (project / "章节提交" / "applied_patches.json", load_applied_patch_ledger),
                (project / "章节提交" / "patch_classifications.json", load_patch_classifications),
                (project / "记忆库" / "index" / "memory_index.json", ensure_index),
            )
            for target, loader in cases:
                with self.subTest(path=target.name):
                    target.mkdir()
                    with self.assertRaisesRegex(MemorySystemError, "不是普通文件"):
                        loader(project)
                    target.rmdir()
            patch_path = project / "章节提交" / "memory_patch_第001章.md"
            patch_path.mkdir()
            with self.assertRaisesRegex(MemorySystemError, "不是普通文件"):
                load_patch(patch_path)

    def test_check_chapter_s2_always_returns_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            chapter = project / "正文" / "第001章_过短.md"
            write(chapter, "# 第001章 过短\n\n只有很短的正文。\n")
            result = run_script(
                "check_chapter.py",
                str(chapter),
                "--chapter",
                "1",
                "--library-root",
                str(library),
            )
            self.assertEqual(result.returncode, 1)

    def test_check_chapter_rejects_invalid_word_count_range(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            chapter = project / "正文" / "第001章_测试.md"
            write(chapter, "# 第001章 测试\n\n正文。\n")
            result = run_script(
                "check_chapter.py",
                str(chapter),
                "--chapter",
                "1",
                "--min",
                "3000",
                "--max",
                "1000",
                "--library-root",
                str(library),
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("0 <= --min <= --max", result.stdout)

    def test_check_chapter_rejects_duplicate_candidates_and_body_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            first = project / "正文" / "第001章_A.md"
            second = project / "正文" / "第001章_B.md"
            write(first, "# 第001章 A\n\n正文。\n")
            write(second, "# 第001章 B\n\n正文。\n")
            duplicate = run_script(
                "check_chapter.py", "--chapter", "1", "--library-root", str(library)
            )
            self.assertEqual(duplicate.returncode, 2, duplicate.stdout + duplicate.stderr)
            self.assertIn("存在多个正文文件", duplicate.stdout)

            overwrite = run_script(
                "check_chapter.py",
                str(first),
                "--chapter",
                "1",
                "--library-root",
                str(library),
                "--output",
                str(first),
            )
            self.assertEqual(overwrite.returncode, 2, overwrite.stdout + overwrite.stderr)
            self.assertIn("不能覆盖正文", overwrite.stdout)

            outline = project / "大纲" / "第001章_细纲.md"
            write(outline, "# 第001章 细纲\n")
            wrong_input = run_script(
                "check_chapter.py", str(outline), "--chapter", "1", "--library-root", str(library)
            )
            self.assertEqual(wrong_input.returncode, 2, wrong_input.stdout + wrong_input.stderr)
            self.assertIn("正文 目录内", wrong_input.stdout)

    def test_check_chapter_refuses_pending_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            library, project = make_project(Path(temporary), [(1, 30)])
            chapter = project / "正文" / "第001章_测试.md"
            write(chapter, "# 第001章 测试\n\n正文。\n")
            (project / "记忆库" / ".transactions" / "txn-pending").mkdir(parents=True)
            checked = run_script(
                "check_chapter.py", str(chapter), "--chapter", "1", "--library-root", str(library)
            )
            self.assertEqual(checked.returncode, 2, checked.stdout + checked.stderr)
            self.assertIn("未完成事务", checked.stdout)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


if __name__ == "__main__":
    unittest.main()
