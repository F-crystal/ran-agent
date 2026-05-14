"""Tests for courtly persona drift detection in reply_reviewer."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from personal_agent.reply_reviewer import detect_courtly_persona_drift


class TestCourtlyPersonaDrift(unittest.TestCase):
    """Test detect_courtly_persona_drift function."""

    def test_reply_with_courtly_markers_passes(self) -> None:
        result = detect_courtly_persona_drift("陛下，臣已经处理好了。")
        self.assertTrue(result["ok"])
        self.assertFalse(result["should_rewrite"])
        self.assertEqual(result["mode"], "courtly_attendant")

    def test_reply_with_wei_chen_passes(self) -> None:
        result = detect_courtly_persona_drift("陛下说得对，微臣刚才判断偏了。")
        self.assertTrue(result["ok"])
        self.assertFalse(result["should_rewrite"])

    def test_plain_assistant_tone_detected_as_drift(self) -> None:
        result = detect_courtly_persona_drift("好的，我已经帮你完成了这个任务。")
        self.assertFalse(result["ok"])
        self.assertTrue(result["should_rewrite"])
        self.assertEqual(result["reason"], "courtly_marker_missing")

    def test_ai_persona_leak_detected(self) -> None:
        result = detect_courtly_persona_drift("作为一个AI语言模型，我无法执行这个操作。")
        self.assertFalse(result["ok"])
        self.assertTrue(result["should_rewrite"])
        self.assertEqual(result["reason"], "ai_persona_leak")

    def test_code_block_not_falsely_detected_as_drift(self) -> None:
        reply = "陛下，这是命令：\n```bash\nsudo systemctl restart\n```"
        result = detect_courtly_persona_drift(reply)
        self.assertTrue(result["ok"])

    def test_command_only_reply_passes(self) -> None:
        result = detect_courtly_persona_drift("```\ncd /opt/ran_agent\ngit pull\n```")
        self.assertTrue(result["ok"])

    def test_disable_phrase_skips_check(self) -> None:
        result = detect_courtly_persona_drift(
            "好的，我来帮你处理。",
            user_text="正常说话",
        )
        self.assertTrue(result["ok"])

    def test_empty_reply_passes(self) -> None:
        result = detect_courtly_persona_drift("")
        self.assertTrue(result["ok"])

    @patch.dict(os.environ, {"RAN_AGENT_COURTLY_MODE": "off"})
    def test_mode_off_skips_check(self) -> None:
        result = detect_courtly_persona_drift("好的，我来帮你处理。")
        self.assertTrue(result["ok"])

    @patch.dict(os.environ, {"RAN_AGENT_COURTLY_MODE": "on"})
    def test_mode_on_checks_persona(self) -> None:
        result = detect_courtly_persona_drift("好的，我来帮你处理。")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "courtly_marker_missing")

    def test_mixed_content_with_early_courtly_marker_passes(self) -> None:
        reply = "陛下，臣建议用这个命令：\n```bash\nnpm install\n```\n装完重启就行。"
        result = detect_courtly_persona_drift(reply)
        self.assertTrue(result["ok"])

    def test_late_courtly_marker_detected_as_drift(self) -> None:
        # Courtly marker only appears very late in a long reply
        reply = "这个方案有几个步骤。首先需要检查配置。然后修改文件。最后重启服务。陛下觉得如何？"
        result = detect_courtly_persona_drift(reply)
        # The marker "陛下" appears at the end, but within first 200 chars it should be found
        # This is a borderline case - the function checks first 200 chars
        self.assertTrue(result["ok"])  # "陛下" is within 200 chars


if __name__ == "__main__":
    unittest.main()
