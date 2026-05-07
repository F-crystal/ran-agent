"""Tests for the lightweight life-loop candidate generation path."""

from __future__ import annotations

import json
import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.life_loop import LifeLoop, serialize_opportunities


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated life-loop tests."""

    logger = logging.getLogger("personal_agent.tests.life_loop")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class LifeLoopTest(unittest.TestCase):
    """Covers opportunity generation without automatic external side effects."""

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
        self.life_loop = LifeLoop(
            config=self.config,
            database=self.database,
            logger=self.logger,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_life_loop_generates_companion_reflection_and_maintenance_opportunities(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="今天一直在改论文，越改越烦",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"处理论文","state":"情绪有些烦躁","summary":"用户最近在处理论文，情绪有些烦躁"}',
            "working",
            importance=1,
        )
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u1",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="论文",
            intimacy_level=0,
            recent_turn_summary="话题:论文；意图:我有点烦",
            time_of_day="afternoon",
            user_message="我有点烦",
            first_draft="哈哈，那你先别急。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["blacklisted_opening"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=False,
        )
        with self.database.connection() as conn:
            conn.execute(
                "UPDATE timeline_events SET created_at = ? WHERE event_type = 'user_message'",
                ("2026-04-10 08:00:00",),
            )
            conn.commit()

        result = self.life_loop.run(
            now_local=datetime(2026, 4, 10, 10, 30, 0),
            now_utc=datetime(2026, 4, 10, 10, 30, 0),
        )

        opportunity_kinds = {opportunity.kind for opportunity in result.opportunities}
        self.assertEqual(
            opportunity_kinds,
            {
                "companion",
                "reflection",
                "maintenance",
                "exploration",
            },
        )
        companion_opportunity = next(
            opportunity for opportunity in result.opportunities if opportunity.kind == "companion"
        )
        self.assertEqual(companion_opportunity.consumer, "orchestrator_agent")
        self.assertEqual(companion_opportunity.source, "life_loop")
        self.assertEqual(companion_opportunity.status, "open")
        self.assertEqual(companion_opportunity.attention_hint, "worth_a_look")
        self.assertIn("opener_clue", companion_opportunity.payload)
        self.assertIn("论文", str(companion_opportunity.payload["opener_clue"]))
        exploration_opportunity = next(
            opportunity for opportunity in result.opportunities if opportunity.kind == "exploration"
        )
        self.assertEqual(exploration_opportunity.consumer, "exploration_specialist")
        self.assertEqual(exploration_opportunity.source, "life_loop")

    def test_life_loop_skips_companion_opportunity_in_silent_window(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="最近有点累",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"处理工作","state":"脑子有些乱","summary":"用户最近在处理工作，脑子有些乱"}',
            "working",
            importance=1,
        )
        with self.database.connection() as conn:
            conn.execute(
                "UPDATE timeline_events SET created_at = ? WHERE event_type = 'user_message'",
                ("2026-04-10 00:00:00",),
            )
            conn.commit()

        result = self.life_loop.run(
            now_local=datetime(2026, 4, 10, 8, 30, 0),
            now_utc=datetime(2026, 4, 10, 8, 30, 0),
        )

        self.assertNotIn("companion", {opportunity.kind for opportunity in result.opportunities})

    def test_serialize_opportunities_returns_json_array(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="最近有点忙",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"处理工作","state":"脑子有些乱","summary":"用户最近在处理工作，脑子有些乱"}',
            "working",
            importance=1,
        )
        with self.database.connection() as conn:
            conn.execute(
                "UPDATE timeline_events SET created_at = ? WHERE event_type = 'user_message'",
                ("2026-04-10 08:00:00",),
            )
            conn.commit()

        result = self.life_loop.run(
            now_local=datetime(2026, 4, 10, 10, 30, 0),
            now_utc=datetime(2026, 4, 10, 10, 30, 0),
        )
        serialized = serialize_opportunities(result.opportunities)
        payload = json.loads(serialized)

        self.assertIsInstance(payload, list)
        self.assertTrue(payload)
        self.assertIn("consumer", payload[0])
        self.assertIn("attention_hint", payload[0])


if __name__ == "__main__":
    unittest.main()
