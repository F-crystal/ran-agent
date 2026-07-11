"""Tests for the offline self-reflection reporting helpers."""

from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.personal_learning import PersonalLearningStore
from personal_agent.reflection_specialist import generate_reflection_report


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated reflection tests."""

    logger = logging.getLogger("personal_agent.tests.self_reflection")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class SelfReflectionTest(unittest.TestCase):
    """Covers the minimal offline reflection report generation path."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            debug_dir=base_dir / "debug",
            reflections_dir=base_dir / "debug" / "reflections",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_generate_reflection_report_aggregates_metrics_and_writes_file(self) -> None:
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u1",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="论文",
            intimacy_level=0,
            recent_turn_summary="话题:论文；意图:我好困",
            time_of_day="late_night",
            user_message="我好困",
            first_draft="你这是最近熬夜把作息弄乱了。",
            final_reply="那先别硬撑了，困就早点歇一会儿。",
            review_triggered=True,
            review_reasons='["recent_state_over_inference"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=False,
        )
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u2",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="聊天",
            intimacy_level=0,
            recent_turn_summary="话题:聊天；意图:今天有点乱",
            time_of_day="evening",
            user_message="今天有点乱",
            first_draft="哈哈，那你可以先别急着想太多。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["blacklisted_opening","casual_became_advisory"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u3",
            route="text_chat",
            response_mode="emotional_support",
            current_topic="答辩",
            intimacy_level=1,
            recent_turn_summary="话题:答辩；意图:我有点慌",
            time_of_day="afternoon",
            user_message="我有点慌",
            first_draft="先别急，我在。",
            final_reply="先别急，我在。",
            review_triggered=False,
            review_reasons="[]",
            retry_performed=False,
            retry_success=False,
            false_positive_candidate=False,
            user_dissatisfaction_signal=False,
        )

        report = generate_reflection_report(self.database, self.config, limit=20)

        self.assertEqual(report.metrics.total_samples, 3)
        self.assertAlmostEqual(report.metrics.reviewer_trigger_rate, 2 / 3)
        self.assertAlmostEqual(report.metrics.first_pass_success_rate, 1 / 3)
        self.assertAlmostEqual(report.metrics.retry_success_rate, 1.0)
        self.assertEqual(report.metrics.rule_counts["blacklisted_opening"], 1)
        self.assertEqual(report.metrics.rule_counts["casual_became_advisory"], 1)
        self.assertEqual(report.metrics.rule_counts["recent_state_over_inference"], 1)
        self.assertTrue(report.output_path.exists())
        self.assertTrue(report.preference_profile.json_path.exists())
        self.assertTrue(report.preference_profile.markdown_path is not None)
        assert report.preference_profile.markdown_path is not None
        self.assertTrue(report.preference_profile.markdown_path.exists())
        self.assertIn("## Metrics", report.report_text)
        self.assertIn("reviewer_trigger_rate", report.report_text)
        self.assertIn("## Failure Patterns", report.report_text)
        self.assertIn("## Preference Signals", report.report_text)
        self.assertIn("## Preference Profile Snapshot", report.report_text)
        self.assertIn("## Suggested Experiments", report.report_text)
        self.assertIn("即时状态", report.report_text)
        self.assertTrue(report.preference_signals.disliked_openings)
        self.assertTrue(report.preference_signals.disliked_inference_patterns)
        self.assertTrue(report.preference_signals.casual_advisory_patterns)
        self.assertEqual(report.preference_profile.version, 1)

    def test_generate_reflection_report_learns_preference_like_dislikes_conservatively(self) -> None:
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u1",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="聊天",
            intimacy_level=0,
            recent_turn_summary="话题:聊天；意图:有点乱",
            time_of_day="evening",
            user_message="我有点乱",
            first_draft="你可以先把事情拆成三部分。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["casual_became_advisory"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u2",
            route="text_chat",
            response_mode="emotional_support",
            current_topic="夜聊",
            intimacy_level=1,
            recent_turn_summary="话题:夜聊；意图:我有点难受",
            time_of_day="late_night",
            user_message="我有点难受",
            first_draft="根据你的描述，这说明你最近压力很大。",
            final_reply="听着就挺难受的，先别硬撑。",
            review_triggered=True,
            review_reasons='["intimate_or_emotional_became_meta","recent_state_over_inference"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )

        report = generate_reflection_report(self.database, self.config, limit=20)

        self.assertTrue(any("你可以" in item for item in report.preference_signals.casual_advisory_patterns))
        self.assertTrue(any("刚表达即时状态" in item for item in report.preference_signals.disliked_inference_patterns))
        self.assertTrue(any("深夜语境" in item for item in report.preference_signals.contextual_risk_patterns))
        self.assertIn("support manual tuning and future adaptive reviewer inputs", report.report_text)
        self.assertTrue(any(item.key.startswith("opening:") for item in report.preference_profile.emerging_patterns))
        self.assertTrue(any(item.key.startswith("context:") for item in report.preference_profile.contextual_risks))

    def test_reflection_promotes_only_repeated_safe_review_rules_through_personal_learning(self) -> None:
        for sender_id in ("u1", "u2"):
            self.database.record_reply_review_observation(
                channel="wechat",
                sender_id=sender_id,
                route="text_chat",
                response_mode="emotional_support",
                current_topic="聊天",
                intimacy_level=0,
                recent_turn_summary="短摘要",
                time_of_day="evening",
                user_message="我有点烦",
                first_draft="这说明你最近压力很大。",
                final_reply="听着确实挺烦。",
                review_triggered=True,
                review_reasons='["recent_state_over_inference"]',
                retry_performed=True,
                retry_success=True,
                false_positive_candidate=False,
                user_dissatisfaction_signal=True,
            )

        generate_reflection_report(self.database, self.config, limit=20)

        records = PersonalLearningStore(database=self.database, config=self.config).list_active()
        self.assertEqual(
            [(record.kind, record.source, record.subject_key, record.statement) for record in records],
            [
                (
                    "operating_lesson",
                    "repeated_observation",
                    "reply_rule:recent_state_over_inference",
                    "用户刚表达即时状态时，回复不要推断长期原因",
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
