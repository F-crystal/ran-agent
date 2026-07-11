"""Tests for nightly rollover and next-day carry-over artifacts."""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.night_cycle import LATEST_REFLECTION_DIGEST_KEY, NightCycle
from personal_agent.personal_learning import PersonalLearningStore


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
        self.config = make_test_config(base_dir)
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

    def _run_with_note_mutation(self, mutate_note):
        def runner(action: str):
            note = self.config.vault_dir / "inbox" / "night_cycle_2026-04-11.md"
            mutate_note(note)
            return __import__("subprocess").CompletedProcess(
                args=[action], returncode=0, stdout=action, stderr=""
            )

        return NightCycle(
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

    def _assert_knowledge_path_consistent(self, result, expected: str) -> None:
        artifact = json.loads(Path(result.summary_output_path).read_text(encoding="utf-8"))
        raw_state = self.database.get_handoff_value("agent_internal_state")
        assert raw_state is not None
        state = json.loads(raw_state)

        self.assertEqual(result.knowledge_inbox_path, expected)
        self.assertEqual(artifact["knowledge_inbox_path"], expected)
        self.assertEqual(state["daily_traces"][-1]["knowledge_note_path"], expected)

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
        expected_knowledge_path = str(
            (self.config.vault_dir / "raw" / "night_cycle" / "night_cycle_2026-04-11.md").resolve()
        )
        self.assertTrue(Path(expected_knowledge_path).exists())
        self.assertFalse((self.config.vault_dir / "inbox" / "night_cycle_2026-04-11.md").exists())
        self._assert_knowledge_path_consistent(result, expected_knowledge_path)
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

    def test_night_cycle_keeps_unchanged_knowledge_note_path(self) -> None:
        result = self._run_with_note_mutation(lambda _note: None)

        expected = str(
            (self.config.vault_dir / "inbox" / "night_cycle_2026-04-11.md").resolve()
        )
        self._assert_knowledge_path_consistent(result, expected)

    def test_night_cycle_clears_deleted_knowledge_note_path(self) -> None:
        with self.assertLogs(self.logger, level=logging.WARNING) as captured:
            result = self._run_with_note_mutation(lambda note: note.unlink())

        self._assert_knowledge_path_consistent(result, "")
        self.assertTrue(any("night_cycle_2026-04-11.md" in line for line in captured.output))

    def test_night_cycle_runs_the_same_safe_reflection_learning_producer(self) -> None:
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

        self._run_with_note_mutation(lambda _note: None)

        records = PersonalLearningStore(database=self.database, config=self.config).list_active()
        self.assertEqual(
            [record.subject_key for record in records],
            ["reply_rule:recent_state_over_inference"],
        )

    def test_night_cycle_clears_ambiguous_knowledge_note_path(self) -> None:
        def duplicate_note(note: Path) -> None:
            duplicate_dir = self.config.vault_dir / "raw" / "night_cycle"
            duplicate_dir.mkdir(parents=True)
            shutil.copy2(note, duplicate_dir / note.name)

        with self.assertLogs(self.logger, level=logging.WARNING) as captured:
            result = self._run_with_note_mutation(duplicate_note)

        self._assert_knowledge_path_consistent(result, "")
        self.assertTrue(any("2 candidates" in line for line in captured.output))

    def test_night_cycle_rejects_symlink_to_note_outside_canonical_vault(self) -> None:
        def replace_with_outside_symlink(note: Path) -> None:
            outside_note = self.config.base_dir / "outside" / note.name
            outside_note.parent.mkdir(parents=True)
            outside_note.write_text("outside\n", encoding="utf-8")
            note.unlink()
            note.symlink_to(outside_note)

        with self.assertLogs(self.logger, level=logging.WARNING):
            result = self._run_with_note_mutation(replace_with_outside_symlink)

        self._assert_knowledge_path_consistent(result, "")


if __name__ == "__main__":
    unittest.main()
