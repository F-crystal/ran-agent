"""Tests for orchestrator-agent judgment over life opportunities."""

from __future__ import annotations

import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.orchestrator_agent import OrchestratorAgent
from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.interfaces.model import ModelRequest, ModelResponse, PlaceholderModelClient
from personal_agent.knowledge_agent import KnowledgeState, save_knowledge_state
from personal_agent.life_loop import LifeOpportunity
from personal_agent.memory_specialist import MemorySpecialist


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated chat-agent opportunity tests."""

    logger = logging.getLogger("personal_agent.tests.chat_agent_opportunities")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class ChatAgentOpportunityTest(unittest.TestCase):
    """Covers lightweight subjective judgments over surfaced life opportunities."""

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
        self.memory_specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
        )
        self.chat_agent = OrchestratorAgent(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="test prompt",
            memory_specialist=self.memory_specialist,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _build_chat_agent_with_fixed_reply(self, reply_text: str) -> OrchestratorAgent:
        class FixedModelClient:
            def generate_reply(self, request: ModelRequest) -> ModelResponse:
                del request
                return ModelResponse(text=reply_text, provider="test")

        return OrchestratorAgent(
            database=self.database,
            model_client=FixedModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="test prompt",
            memory_specialist=self.memory_specialist,
        )

    def test_chat_agent_marks_maintenance_and_reflection_as_silent(self) -> None:
        batch = self.chat_agent.evaluate_opportunities(
            (
                LifeOpportunity(
                    id="maintenance-1",
                    kind="maintenance",
                    source="life_loop",
                    consumer="memory_specialist",
                    attention_hint="background",
                    reason="maintenance due",
                    context={},
                    signals={},
                    payload={},
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
                LifeOpportunity(
                    id="reflection-1",
                    kind="reflection",
                    source="life_loop",
                    consumer="reflection_specialist",
                    attention_hint="background",
                    reason="reflection due",
                    context={},
                    signals={},
                    payload={},
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 11, 21, 10, 0),
        )

        self.assertEqual([item.action for item in batch.judgments], ["silent", "silent"])

    def test_chat_agent_companion_can_request_local_inspect_more(self) -> None:
        batch = self.chat_agent.evaluate_opportunities(
            (
                LifeOpportunity(
                    id="companion-1",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="maybe reach out",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={},
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 11, 21, 10, 0),
        )

        self.assertEqual(batch.judgments[0].action, "inspect_more")
        self.assertTrue(batch.judgments[0].uses_local_context)

    def test_chat_agent_companion_can_choose_message_when_context_is_available(self) -> None:
        self.chat_agent = self._build_chat_agent_with_fixed_reply(
            "刚想到你最近一直在忙论文，今天还顺吗。"
        )
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
        self.database.store_memory(
            '{"type":"profile","category":"study","trait":"写论文","summary":"用户长期在学术写作上投入较多"}',
            "profile",
            importance=2,
        )

        batch = self.chat_agent.evaluate_opportunities(
            (
                LifeOpportunity(
                    id="companion-2",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="natural opening available",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={"opener_clue": "最近一直在忙论文"},
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 11, 21, 10, 0),
        )

        self.assertEqual(batch.judgments[0].action, "message")
        self.assertIn("论文", batch.judgments[0].suggested_text)
        self.assertEqual(len(batch.outbound_messages), 1)
        self.assertIn("论文", batch.outbound_messages[0].text)

    def test_chat_agent_defers_thin_companion_when_knowledge_pending(self) -> None:
        save_knowledge_state(
            self.config,
            KnowledgeState(
                updated_at="2026-04-11 20:00:00",
                pending_knowledge_maintenance=True,
                recent_curated_topics=("论文",),
                recent_source_additions=("source-a",),
            ),
        )

        batch = self.chat_agent.evaluate_opportunities(
            (
                LifeOpportunity(
                    id="companion-knowledge-pending",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="maybe reach out",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={},
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 11, 21, 10, 0),
        )

        self.assertEqual(batch.judgments[0].action, "defer")
        self.assertEqual(
            batch.judgments[0].reason,
            "knowledge_pending_and_local_context_too_thin",
        )


if __name__ == "__main__":
    unittest.main()
