from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_checker():
    matches = [path for path in ROOT.rglob("check_chapter.py") if ".git" not in path.parts]
    if len(matches) != 1:
        raise AssertionError(f"期望找到一个 check_chapter.py，实际找到：{matches}")
    path = matches[0]
    spec = importlib.util.spec_from_file_location("novel_codex_check_chapter", path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"无法加载章节检查器：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CHECKER = load_checker()


class ChapterCheckerSmokeTests(unittest.TestCase):
    def test_counts_cjk_and_latin_tokens(self) -> None:
        self.assertEqual(CHECKER.count_readable_words("江湖 abc-123"), 3)

    def test_extracts_chapter_number_from_filename(self) -> None:
        number = CHECKER.extract_chapter_number(Path("第001章_雾港来信.md"), "")
        self.assertEqual(number, 1)

    def test_extracts_chapter_number_from_heading(self) -> None:
        number = CHECKER.extract_chapter_number(Path("draft.md"), "# 第012章 风雨夜")
        self.assertEqual(number, 12)

    def test_chinese_numeral_heading_is_not_silently_misread(self) -> None:
        number = CHECKER.extract_chapter_number(Path("draft.md"), "# 第十二章 风雨夜")
        self.assertIsNone(number)

    def test_engineering_term_is_reported(self) -> None:
        findings = []
        CHECKER.add_engineering_term_findings(findings, "本章需要推进剧情。")
        self.assertTrue(any(item.severity == "S2" and "本章" in item.title for item in findings))

    def test_clean_short_text_does_not_raise(self) -> None:
        findings = []
        CHECKER.add_ai_style_findings(findings, "雨落在旧港的石阶上。")
        CHECKER.add_punctuation_findings(findings, "雨落在旧港的石阶上。")
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
