from __future__ import annotations

import subprocess
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]


def tracked_files() -> list[str]:
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [item for item in output.decode("utf-8").split("\0") if item]


class RepositorySafetyTests(unittest.TestCase):
    def test_gitignore_contains_personal_data_rules(self) -> None:
        content = (ROOT / ".gitignore").read_text(encoding="utf-8")
        required = {
            "小说项目/projects.json",
            "小说项目/作品/*",
            "!小说项目/作品/.gitkeep",
            "小说项目/.trash/*",
            "!小说项目/.trash/.gitkeep",
        }
        missing = sorted(rule for rule in required if rule not in content.splitlines())
        self.assertFalse(missing, f".gitignore 缺少个人数据保护规则：{missing}")

    def test_personal_novel_data_is_not_tracked(self) -> None:
        violations: list[str] = []
        for path in tracked_files():
            normalized = path.replace("\\", "/")
            if normalized == "小说项目/projects.json":
                violations.append(normalized)
            elif normalized.startswith("小说项目/作品/") and not normalized.endswith("/.gitkeep"):
                violations.append(normalized)
            elif normalized.startswith("小说项目/.trash/") and not normalized.endswith("/.gitkeep"):
                violations.append(normalized)
        self.assertFalse(
            violations,
            "公共仓库跟踪了用户小说数据，请迁出后再提交：\n" + "\n".join(violations),
        )

    def test_secret_like_files_are_not_tracked(self) -> None:
        violations: list[str] = []
        for path in tracked_files():
            posix = PurePosixPath(path.replace("\\", "/"))
            name = posix.name
            if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
                violations.append(path)
            if ".sessions" in posix.parts or "__pycache__" in posix.parts:
                violations.append(path)
            if name.endswith(".log") or name.endswith((".pyc", ".pyo")):
                violations.append(path)
        self.assertFalse(
            sorted(set(violations)),
            "公共仓库跟踪了密钥、会话或运行产物：\n" + "\n".join(sorted(set(violations))),
        )

    def test_demo_is_separate_from_personal_library(self) -> None:
        demo = ROOT / "examples" / "demo-novel"
        self.assertTrue(demo.is_dir())
        self.assertFalse(str(demo.relative_to(ROOT)).startswith("小说项目/作品/"))


if __name__ == "__main__":
    unittest.main()
