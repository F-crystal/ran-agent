"""Unit tests for the chat-side memory facade."""

from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.memory_llm import MemoryExtractionResult


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated memory specialist tests."""

    logger = logging.getLogger("personal_agent.tests.memory_specialist")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class NoopFallbackMemoryExtractor:
    """Skip LLM memory writes and force the local rule fallback path."""

    def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
        del user_text, recent_history
        return MemoryExtractionResult(
            decision="skip",
            memory=None,
            source="test",
            should_fallback=True,
        )


class StaticProfileMemoryExtractor:
    """Return one stable profile memory payload."""

    def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
        del user_text, recent_history
        return MemoryExtractionResult(
            decision="profile",
            memory={
                "type": "profile",
                "layer": "profile",
                "category": "preference",
                "topic": "安静环境",
                "summary": "对安静一点的环境会更舒服",
                "evidence": "我还是喜欢安静一点的环境",
                "confidence": 0.81,
                "ttl_days": 90,
            },
            source="llm",
            should_fallback=False,
        )


class MemorySpecialistTest(unittest.TestCase):
    """Covers the first-phase local-memory facade behavior."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_recall_for_turn_uses_local_short_and_profile_memory(self) -> None:
        self.database.store_memory(
            '{"type":"profile","category":"preference","trait":"安静环境","summary":"用户喜欢安静一点的环境"}',
            "profile",
            importance=2,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"today","topic":"处理论文","state":"情绪有些烦躁","summary":"用户今天在处理论文，情绪有些烦躁"}',
            "working",
            importance=1,
        )
        specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        recall = specialist.recall_for_turn(
            user_text="今天还在改论文。",
            route="text_chat",
            response_mode="casual_chat",
        )

        self.assertTrue(recall.should_inject)
        self.assertIn("local_short_memory", recall.used_sources)
        self.assertIn("local_profile_memory", recall.used_sources)
        self.assertIn("【你对用户的了解】", recall.rendered_context)
        self.assertIn("【用户当前状态（近期）】", recall.rendered_context)

    def test_update_from_user_turn_falls_back_to_rule_based_memory(self) -> None:
        specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        result = specialist.update_from_user_turn("今天一直在改论文，越改越烦")

        self.assertTrue(result.working_written)
        self.assertTrue(result.fallback_used)
        working_memories = self.database.get_working_memories(limit=5)
        self.assertEqual(len(working_memories), 1)

    def test_update_from_user_turn_keeps_profile_as_local_long_term_compat_layer(self) -> None:
        specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
            memory_extractor=StaticProfileMemoryExtractor(),
        )

        result = specialist.update_from_user_turn("我还是喜欢安静一点的环境")

        self.assertTrue(result.profile_written)
        self.assertIsNotNone(result.long_term_candidate)
        profile_memories = self.database.get_profile_memories(limit=5)
        self.assertEqual(len(profile_memories), 1)

    def test_maybe_store_core_stays_noop_in_phase_one(self) -> None:
        specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        decision = specialist.maybe_store_core(
            {"type": "core", "summary": "很重要的核心线索"}
        )

        self.assertEqual(decision.action, "skip")


if __name__ == "__main__":
    unittest.main()
