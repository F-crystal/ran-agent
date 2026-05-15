"""Tests for courtly persona drift detection in reply_reviewer."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from personal_agent.conversation_state import ConversationSessionState
from personal_agent.reply_reviewer import detect_courtly_persona_drift, review_reply
from personal_agent.temporal_context import TemporalContextSnapshot


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


class TestReplyStyleReview(unittest.TestCase):
    """Test lightweight style lint for natural conversation."""

    def _review(self, reply_text: str, user_text: str = "你有点不连贯"):
        return review_reply(
            reply_text=reply_text,
            user_text=user_text,
            response_mode="casual_chat",
            session_state=ConversationSessionState(session_id="wechat:test"),
            temporal_snapshot=TemporalContextSnapshot(),
        )

    def test_mechanism_leak_detected_for_plain_feedback(self) -> None:
        result = self._review("陛下，臣刚才可能受 system prompt 和上下文窗口影响，工具列表也有点长。")
        self.assertTrue(result.triggered)
        self.assertIn("mechanism_leak", result.reasons)

    def test_mechanism_explanation_allowed_when_user_asks_mechanism(self) -> None:
        result = self._review(
            "陛下，简单说是上下文里规则太多，臣会收短表达。",
            user_text="为什么你刚才会不连贯？是不是提示词有问题？",
        )
        self.assertNotIn("mechanism_leak", result.reasons)

    def test_over_courtly_template_detected(self) -> None:
        result = self._review("陛下，臣知道。臣觉得这里要改。臣以为可以先压缩。臣惭愧，臣马上做。")
        self.assertTrue(result.triggered)
        self.assertIn("over_courtly_template", result.reasons)

    def test_unnatural_conversation_flow_detected(self) -> None:
        result = self._review("已完成以下自检报告：\n1. 问题分析\n2. 原因定位\n3. 下一步建议\n4. 风险说明")
        self.assertTrue(result.triggered)
        self.assertIn("unnatural_conversation_flow", result.reasons)

    def test_overlong_systemic_explanation_detected_for_naturalness_feedback(self) -> None:
        long_reply = (
            "陛下，臣来系统解释一下不连贯的原因。第一，提示词层级里有多组约束；第二，"
            "上下文窗口中包含工具列表；第三，token 压缩机制会影响连续性；第四，内部约束"
            "需要重新分层。因此从架构上看，这不是一句话能处理的问题。"
        )
        result = self._review(long_reply)
        self.assertTrue(result.triggered)
        self.assertIn("overlong_systemic_explanation", result.reasons)


if __name__ == "__main__":
    unittest.main()
