"""Focused regression tests for inbox sync and life-loop execution."""

from __future__ import annotations

import logging
import tempfile
import unittest
import dataclasses
from datetime import datetime
from pathlib import Path

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.jobs import reminder_check_job
from personal_agent.interfaces.model import ModelRequest, ModelResponse, PlaceholderModelClient
from personal_agent.life_loop import LifeOpportunity
from personal_agent.service import PersonalAgentService


class FixedReplyModelClient:
    """Return one fixed reply for deterministic proactive message generation."""

    def __init__(self, text: str) -> None:
        self._text = text

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        del request
        return ModelResponse(text=self._text, provider="test")


class StubOutboundClient:
    """Record outbound proactive texts and avoid real network I/O."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.events: list[dict[str, object]] = []

    def send_text(self, text: str, **_: object) -> dict[str, object]:
        self.sent.append(text)
        return {"ok": True}

    def send_proactive_event(self, event: dict[str, object]) -> dict[str, object]:
        self.events.append(event)
        return {"ok": True, "status": "sent", "notified": True}


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("personal_agent.tests.inbox_sync_and_life_loop")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class InboxSyncAndLifeLoopTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = make_test_config(
            base_dir,
            proactive_enabled=True,
            reminder_delivery_enabled=True,
        )
        self.logger = _build_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_record_external_exchange_syncs_to_vault_inbox(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )

        service.record_external_exchange(
            channel="wechat",
            sender_id="user-42",
            user_text="今天我想把论文提纲写完",
            reply_text="好呀，我晚点提醒你回顾提纲。",
            source="hermes",
        )

        inbox_items = sorted((self.config.vault_dir / "inbox" / "chat").glob("chat_sync_*.md"))
        self.assertTrue(inbox_items)
        note_text = inbox_items[-1].read_text(encoding="utf-8")
        self.assertIn("## User Message", note_text)
        self.assertIn("今天我想把论文提纲写完", note_text)
        self.assertIn("category: chat", note_text)
        self.assertIn("## Agent Reply", note_text)
        self.assertIn("好呀，我晚点提醒你回顾提纲。", note_text)

    def test_record_external_exchange_routes_image_media_to_images_folder(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )

        service.record_external_exchange(
            channel="wechat",
            sender_id="user-42",
            user_text="这张图你看下",
            reply_text="看到了，是一张白色猫咪照片。",
            source="hermes",
            media_refs=("https://example.com/cat.png",),
        )

        inbox_items = sorted((self.config.vault_dir / "inbox" / "images").glob("images_sync_*.md"))
        self.assertTrue(inbox_items)
        note_text = inbox_items[-1].read_text(encoding="utf-8")
        self.assertIn("category: images", note_text)
        self.assertIn("https://example.com/cat.png", note_text)

    def test_record_external_exchange_routes_audio_media_to_audio_folder(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )

        service.record_external_exchange(
            channel="wechat",
            sender_id="user-42",
            user_text="这段语音帮我留档",
            reply_text="已归档。",
            source="hermes",
            media_refs=("filePath=/tmp/voice-note.m4a mimeType=audio/mp4 type=audio",),
        )

        inbox_items = sorted((self.config.vault_dir / "inbox" / "audio").glob("audio_sync_*.md"))
        self.assertTrue(inbox_items)
        note_text = inbox_items[-1].read_text(encoding="utf-8")
        self.assertIn("category: audio", note_text)
        self.assertIn("voice-note.m4a", note_text)

    def test_evaluate_life_opportunities_does_not_send_retired_companion_message(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="我今天在改论文",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"论文","state":"投入中","summary":"用户最近在改论文"}',
            "working",
            importance=1,
        )
        model_client = FixedReplyModelClient("刚想到你在改论文，进展还顺吗？")
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
        )
        outbound = StubOutboundClient()
        service._outbound_client = outbound  # type: ignore[attr-defined]

        batch = service.evaluate_life_opportunities(
            (
                LifeOpportunity(
                    id="companion-1",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="natural opening available",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={"opener_clue": "你在改论文", "seed": "论文"},
                    created_at="2026-04-13 11:00:00",
                    expires_at="2026-04-13 11:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 13, 11, 10, 0),
        )

        self.assertEqual(len(batch.outbound_messages), 0)
        self.assertEqual(outbound.sent, [])
        self.assertEqual(batch.judgments[0].reason, "legacy_companion_proactive_retired")

        events = self.database.fetch_timeline_events()
        self.assertNotEqual(events[-1]["event_type"], "agent_proactive")

    def test_evaluate_life_opportunities_retires_low_value_companion_path_before_generation(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="我今天在改论文",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"论文","state":"投入中","summary":"用户最近在改论文"}',
            "working",
            importance=1,
        )
        model_client = FixedReplyModelClient("刚想到你最近挺忙的，今天还顺吗。")
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
        )
        outbound = StubOutboundClient()
        service._outbound_client = outbound  # type: ignore[attr-defined]

        batch = service.evaluate_life_opportunities(
            (
                LifeOpportunity(
                    id="companion-low-value",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="natural opening available",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={"opener_clue": "你在改论文", "seed": "论文"},
                    created_at="2026-04-13 11:00:00",
                    expires_at="2026-04-13 11:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 13, 11, 10, 0),
        )

        self.assertEqual(len(batch.outbound_messages), 0)
        self.assertEqual(outbound.sent, [])
        self.assertEqual(batch.judgments[0].reason, "legacy_companion_proactive_retired")

    def test_reminder_check_job_sends_persisted_due_reminder_after_restart(self) -> None:
        reminder_config = dataclasses.replace(
            self.config,
            proactive_enabled=False,
            reminder_delivery_enabled=True,
        )
        first_database = Database(reminder_config, self.logger)
        first_database.initialize()
        todo_id = first_database.create_todo(
            content="交房租",
            reminder_at="2000-01-01 09:00:00",
            source="user",
        )

        restarted_database = Database(reminder_config, self.logger)
        restarted_database.initialize()
        restarted_service = PersonalAgentService(
            database=restarted_database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=reminder_config,
        )
        outbound = StubOutboundClient()
        restarted_service._outbound_client = outbound  # type: ignore[attr-defined]

        reminder_check_job(
            config=reminder_config,
            database=restarted_database,
            message_service=restarted_service,
            logger=self.logger,
        )

        self.assertEqual(outbound.sent, [])
        self.assertEqual(len(outbound.events), 1)
        self.assertEqual(outbound.events[0]["kind"], "reminder")
        self.assertEqual(outbound.events[0]["watch_scope"], f"todo:{todo_id}")
        self.assertEqual(outbound.events[0]["evidence_refs"], [f"todo:{todo_id}"])
        self.assertIn("交房租", str(outbound.events[0]["reason"]))

        events = restarted_database.fetch_timeline_events()
        self.assertEqual(events[-1]["event_type"], "reminder_batch_sent")
        self.assertIn('"sent_count": 1', events[-1]["content"])
        self.assertIn('"due_count": 1', events[-1]["content"])

        todo = restarted_database.get_todo_by_id(todo_id)
        self.assertIsNotNone(todo)
        assert todo is not None
        self.assertEqual(todo["status"], "pending")

    def test_reminder_check_job_skips_due_reminders_when_delivery_disabled(self) -> None:
        config = dataclasses.replace(
            self.config,
            proactive_enabled=True,
            reminder_delivery_enabled=False,
        )
        todo_id = self.database.create_todo(
            content="交房租",
            reminder_at="2000-01-01 09:00:00",
            source="user",
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=config,
        )
        outbound = StubOutboundClient()
        service._outbound_client = outbound  # type: ignore[attr-defined]

        reminder_check_job(
            config=config,
            database=self.database,
            message_service=service,
            logger=self.logger,
        )

        self.assertEqual(outbound.sent, [])
        self.assertEqual(outbound.events, [])
        todo = self.database.get_todo_by_id(todo_id)
        self.assertIsNotNone(todo)
        assert todo is not None
        self.assertIsNone(todo["last_reminded_at"])

    def test_reminder_check_job_deduplicates_same_due_todo_message_in_recent_window(self) -> None:
        todo_id = self.database.create_todo(
            content="交房租",
            reminder_at="2000-01-01 09:00:00",
            source="user",
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )
        self.database.record_timeline_event(
            source="agent",
            event_type="agent_proactive",
            content="夜深了，提醒一下：交房租",
            tags=f"message,proactive,feishu,seed:reminder:{todo_id}:20000101T090000",
            importance=1,
        )

        outbound = StubOutboundClient()
        service._outbound_client = outbound  # type: ignore[attr-defined]

        reminder_check_job(
            config=self.config,
            database=self.database,
            message_service=service,
            logger=self.logger,
        )

        self.assertEqual(outbound.sent, [])
        self.assertEqual(outbound.events, [])
        events = self.database.fetch_timeline_events()
        self.assertEqual(events[-1]["event_type"], "reminder_batch_sent")
        self.assertIn('"sent_count": 0', events[-1]["content"])

        todo = self.database.get_todo_by_id(todo_id)
        self.assertIsNotNone(todo)


if __name__ == "__main__":
    unittest.main()
