from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / ".agents" / "skills" / "webnovel-writer" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from memory_common import (  # noqa: E402
    MemorySystemError,
    index_path,
    render_record,
    select_arc_outline,
)


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
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
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
                "schema_version": 1,
                "patch_id": "chapter-001-v1",
                "chapter": 1,
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
            patch_path = Path(temporary) / "patch.json"
            write(patch_path, json.dumps(patch_one, ensure_ascii=False))
            first = run_script("update_memory.py", "--patch", str(patch_path), "--library-root", str(library))
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            current_after = read(current_path)
            self.assertIn("手工说明必须保留", current_after)
            self.assertIn("新状态完整写入", current_after)
            self.assertNotIn("旧状态。", current_after)
            digest = hashlib.sha256(current_path.read_bytes()).hexdigest()

            second = run_script("update_memory.py", "--patch", str(patch_path), "--library-root", str(library))
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("幂等跳过", second.stdout)
            self.assertEqual(digest, hashlib.sha256(current_path.read_bytes()).hexdigest())

            patch_two = {
                "schema_version": 1,
                "patch_id": "chapter-002-v1",
                "chapter": 2,
                "summary": "状态结束。",
                "ending_state": "该状态已经归档。",
                "operations": [{"action": "archive", "id": "character-test", "reason": "后续事实替换"}],
            }
            patch_two_path = Path(temporary) / "patch-two.json"
            write(patch_two_path, json.dumps(patch_two, ensure_ascii=False))
            archived = run_script("update_memory.py", "--patch", str(patch_two_path), "--library-root", str(library))
            self.assertEqual(archived.returncode, 0, archived.stdout + archived.stderr)
            self.assertNotIn("character-test", read(current_path))
            archive_text = read(project / "档案库" / "记忆历史" / "character.md")
            self.assertIn("character-test", archive_text)
            self.assertIn('"status":"outdated"', archive_text)

            invalid_path = Path(temporary) / "invalid.json"
            write(invalid_path, '{"schema_version":1}')
            before = hashlib.sha256(current_path.read_bytes()).hexdigest()
            invalid = run_script("update_memory.py", "--patch", str(invalid_path), "--library-root", str(library))
            self.assertEqual(invalid.returncode, 2)
            self.assertEqual(before, hashlib.sha256(current_path.read_bytes()).hexdigest())

    def test_query_rebuilds_deleted_index(self) -> None:
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
            index_path(project).unlink()
            rebuilt = run_script(
                "query_memory.py", "--chapter", "1", "--entity", "林序", "--library-root", str(library)
            )
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stdout + rebuilt.stderr)
            self.assertTrue(index_path(project).exists())

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
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
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


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


if __name__ == "__main__":
    unittest.main()
