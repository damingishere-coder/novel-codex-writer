from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "examples" / "demo-novel"
PATCH_PATH = DEMO / "章节提交" / "memory_patch_第001章.md"
MARKER_RE = re.compile(r"<!--\s*webnovel-memory:\s*(\{.*\})\s*-->")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,80}$")


def load_patch() -> dict:
    text = PATCH_PATH.read_text(encoding="utf-8")
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not match:
        raise AssertionError("演示 memory patch 缺少 JSON 代码块")
    return json.loads(match.group(1))


class DemoNovelTests(unittest.TestCase):
    def test_required_demo_files_exist(self) -> None:
        required = [
            "README.md",
            "大纲/原始大纲.md",
            "大纲/细纲_第001章.md",
            "正文/第001章_雾港来信.md",
            "审查报告/第001章_审查报告.md",
            "章节提交/第001章_commit.md",
            "章节提交/memory_patch_第001章.md",
            "记忆库/current/当前人物状态.md",
            "记忆库/current/当前关系状态.md",
            "记忆库/current/当前伏笔状态.md",
            "记忆库/current/当前时间线.md",
        ]
        missing = [path for path in required if not (DEMO / path).is_file()]
        self.assertFalse(missing, f"演示工程缺少文件：{missing}")

    def test_memory_patch_has_valid_shape(self) -> None:
        patch = load_patch()
        required = {"schema_version", "patch_id", "chapter", "summary", "ending_state", "operations"}
        self.assertEqual(required - set(patch), set())
        self.assertEqual(patch["schema_version"], 1)
        self.assertRegex(patch["patch_id"], ID_RE)
        self.assertGreater(patch["chapter"], 0)
        self.assertTrue(patch["summary"].strip())
        self.assertTrue(patch["ending_state"].strip())
        self.assertIsInstance(patch["operations"], list)
        self.assertGreater(len(patch["operations"]), 0)

    def test_upsert_records_are_unique_and_complete(self) -> None:
        patch = load_patch()
        ids: list[str] = []
        for operation in patch["operations"]:
            self.assertEqual(operation.get("action"), "upsert")
            record = operation.get("record")
            self.assertIsInstance(record, dict)
            record_id = record.get("id", "")
            self.assertRegex(record_id, ID_RE)
            self.assertTrue(record.get("category"))
            self.assertIn(record.get("status", "active"), {"active", "tentative", "closed", "outdated", "contradicted"})
            self.assertIn(record.get("importance", "normal"), {"critical", "high", "normal", "low"})
            self.assertIsInstance(record.get("entities", []), list)
            self.assertIsInstance(record.get("tags", []), list)
            self.assertTrue(record.get("content", "").strip())
            ids.append(record_id)
        self.assertEqual(len(ids), len(set(ids)), "同一补丁内出现重复记忆 ID")

    def test_current_projection_matches_patch_ids(self) -> None:
        patch_ids = {
            operation["record"]["id"]
            for operation in load_patch()["operations"]
            if operation.get("action") == "upsert"
        }
        current_ids: set[str] = set()
        for path in (DEMO / "记忆库" / "current").glob("*.md"):
            for match in MARKER_RE.finditer(path.read_text(encoding="utf-8")):
                metadata = json.loads(match.group(1))
                current_ids.add(metadata["id"])
                self.assertEqual(metadata.get("updated_by_patch"), "chapter-001-v1")
        self.assertEqual(current_ids, patch_ids)

    def test_demo_chapter_is_explicitly_marked_as_shortened(self) -> None:
        guide = (DEMO / "README.md").read_text(encoding="utf-8")
        self.assertIn("刻意缩短", guide)
        self.assertIn("2000–2500", guide)


if __name__ == "__main__":
    unittest.main()
