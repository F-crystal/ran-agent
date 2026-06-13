"""Tests for nightly rollover and next-day carry-over artifacts."""

from __future__ import annotations

import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.night_cycle import LATEST_REFLECTION_DIGEST_KEY, NightCycle


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated night-cycle tests."""

    logger = logging.getLogger("personal_agent.tests.night_cycle")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class NightCycleTest(unittest.TestCase):
    """Covers nightly cleanup, carry-over writing, and next-day continuity assets."""

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
            night_cycles_dir=base_dir / "debug" / "night_cycles",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()
        self.memory_specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_night_cycle_writes_artifacts_and_clears_session_state(self) -> None:
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
            recent_turn_summary="话题:论文；意图:有点烦",
            time_of_day="evening",
            user_message="今天有点烦",
            first_draft="哈哈，那你可以先别急着想太多。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["blacklisted_opening","casual_became_advisory"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )
        self.database.set_handoff_value(
            "conversation_session_state:wechat:user-1",
            '{"session_id":"wechat:user-1","current_topic":"论文"}',
        )
        with self.database.connection() as conn:
            conn.execute(
                "UPDATE timeline_events SET created_at = ? WHERE event_type = 'user_message'",
                ("2026-04-11 21:30:00",),
            )
            conn.commit()

        def runner(action: str):
            if action == "daily_carryover":
                inbox_note = self.config.vault_dir / "inbox" / "night_cycle_2026-04-11.md"
                raw_dir = self.config.vault_dir / "raw" / "night_cycle"
                raw_dir.mkdir(parents=True, exist_ok=True)
                if inbox_note.exists():
                    inbox_note.rename(raw_dir / inbox_note.name)
            return __import__("subprocess").CompletedProcess(args=[action], returncode=0, stdout=action, stderr="")

        result = NightCycle(
            config=self.config,
            database=self.database,
            memory_specialist=self.memory_specialist,
            logger=self.logger,
            knowledge_agent=KnowledgeAgent(
                config=self.config,
                logger=self.logger,
                command_runner=runner,
            ),
        ).run(now_local=datetime(2026, 4, 12, 0, 5, 0))

        self.assertEqual(result.summary_date, "2026-04-11")
        self.assertTrue(Path(result.summary_output_path).exists())
        self.assertTrue(Path(result.knowledge_inbox_path).exists())
        self.assertGreaterEqual(result.cleared_session_count, 1)
        self.assertEqual(result.knowledge_action, "daily_carryover")
        self.assertEqual(result.knowledge_status, "ok")
        self.assertTrue(Path(result.persona_proposal_path).exists())
        self.assertTrue((self.config.base_dir / "IDENTITY.md").exists())
        self.assertTrue((self.config.base_dir / "SOUL.md").exists())
        self.assertIn("BEGIN AUTO-IDENTITY", (self.config.base_dir / "IDENTITY.md").read_text(encoding="utf-8"))
        self.assertIn("BEGIN AUTO-SOUL", (self.config.base_dir / "SOUL.md").read_text(encoding="utf-8"))
        self.assertIn("连续感摘要", self.database.get_handoff_value("daily_context:latest") or "")
        self.assertTrue(self.database.get_handoff_value(LATEST_REFLECTION_DIGEST_KEY))
        self.assertIsNone(self.database.get_handoff_value("conversation_session_state:wechat:user-1"))
        raw_state = self.database.get_handoff_value("agent_internal_state")
        assert raw_state is not None
        self.assertIn('"last_night_cycle_at":"2026-04-12 00:05:00"', raw_state)
        self.assertIn('"daily_traces"', raw_state)


if __name__ == "__main__":
    unittest.main()
