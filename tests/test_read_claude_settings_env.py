from __future__ import annotations

import tempfile
import unittest
import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "read_claude_settings_env.py"
SPEC = importlib.util.spec_from_file_location("read_claude_settings_env", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

read_setting = MODULE.read_setting
strip_line_comments = MODULE.strip_line_comments


class ReadClaudeSettingsEnvTest(unittest.TestCase):
    def test_strip_line_comments_preserves_urls_inside_strings(self) -> None:
        raw = """
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "token" // inline comment
  }
}
"""

        cleaned = strip_line_comments(raw)

        self.assertIn("https://open.bigmodel.cn/api/anthropic", cleaned)
        self.assertNotIn("inline comment", cleaned)

    def test_read_setting_reads_jsonc_env_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / "settings.json"
            settings_path.write_text(
                """
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1", // comment
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  }
}
""",
                encoding="utf-8",
            )

            self.assertEqual(
                read_setting(settings_path, "ANTHROPIC_BASE_URL"),
                "https://open.bigmodel.cn/api/anthropic",
            )
            self.assertEqual(
                read_setting(settings_path, "ANTHROPIC_DEFAULT_OPUS_MODEL"),
                "glm-5.1",
            )
            self.assertEqual(
                read_setting(settings_path, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
                "1",
            )


if __name__ == "__main__":
    unittest.main()
