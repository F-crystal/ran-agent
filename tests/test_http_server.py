"""Unit tests for backend HTTP controller contract."""

from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.http_server import BackendHttpController
from personal_agent.interfaces.model import PlaceholderModelClient
from personal_agent.service import PersonalAgentService


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated HTTP adapter tests."""

    logger = logging.getLogger("personal_agent.tests.http_server")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class BackendHttpControllerTest(unittest.TestCase):
    """Verifies backend-only HTTP capability routes."""

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
        self.service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
        )
        self.controller = BackendHttpController(
            message_service=self.service,
            logger=self.logger,
            config=self.config,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_handle_ingest_records_external_exchange_without_model_generation(self) -> None:
        status_code, response_payload = self.controller.handle_ingest(
            {
                "channel": "wechat",
                "sender_id": "bridge-user-3",
                "user_text": "今晚早点睡",
                "reply_text": "好，早点休息。",
                "source": "external",
            }
        )
        events = self.database.fetch_timeline_events()

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload, {"ok": True})
        self.assertEqual(events[0]["event_type"], "user_message")
        self.assertEqual(events[1]["event_type"], "agent_reply")

    def test_handle_ingest_accepts_optional_image_urls(self) -> None:
        status_code, response_payload = self.controller.handle_ingest(
            {
                "channel": "wechat",
                "sender_id": "bridge-user-4",
                "user_text": "看下这张图",
                "reply_text": "看到了。",
                "source": "external",
                "image_urls": ["https://example.com/image.png"],
            }
        )
        inbox_dir = self.config.vault_dir / "inbox" / "images"
        image_notes = list(inbox_dir.glob("images_sync_*.md"))

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload, {"ok": True})
        self.assertTrue(image_notes)

    def test_handle_ingest_accepts_media_attachments_for_inbox_sync(self) -> None:
        status_code, response_payload = self.controller.handle_ingest(
            {
                "channel": "wechat",
                "sender_id": "bridge-user-5",
                "user_text": "这是一张微信图片",
                "reply_text": "收到了。",
                "source": "external",
                "media": [
                    {
                        "filePath": "/tmp/weixin-agent/media/inbound/demo.bin",
                        "mimeType": "image/*",
                        "type": "image",
                    }
                ],
            }
        )
        inbox_dir = self.config.vault_dir / "inbox" / "images"
        image_notes = list(inbox_dir.glob("images_sync_*.md"))

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload, {"ok": True})
        self.assertTrue(image_notes)
        note_text = image_notes[-1].read_text(encoding="utf-8")
        self.assertIn("image/* image /tmp/weixin-agent/media/inbound/demo.bin", note_text)

    def test_handle_ingest_rejects_missing_required_field(self) -> None:
        status_code, response_payload = self.controller.handle_ingest(
            {
                "channel": "wechat",
                "sender_id": "",
                "user_text": "x",
                "reply_text": "y",
                "source": "external",
            }
        )

        self.assertEqual(status_code, 400)
        self.assertIn("error", response_payload)
        self.assertIn("sender_id", response_payload["error"])

    def test_handle_tools_knowledge_state(self) -> None:
        status_code, response_payload = self.controller.handle_tools("/tools/knowledge/state", {})

        self.assertEqual(status_code, 200)
        self.assertIn("last_status", response_payload)
        self.assertIn("pending_knowledge_maintenance", response_payload)

    def test_handle_tools_knowledge_run(self) -> None:
        class StubKnowledgeService:
            def get_knowledge_state(self) -> dict[str, object]:
                return {"last_status": "ok", "pending_knowledge_maintenance": False}

            def run_knowledge_maintenance(self, *, action: str, trigger: str) -> dict[str, object]:
                return {
                    "action": action,
                    "trigger": trigger,
                    "status": "ok",
                    "started_at": "2026-04-14 09:00:00",
                    "finished_at": "2026-04-14 09:00:01",
                    "inbox_count_before": 2,
                    "inbox_count_after": 1,
                    "processed_inbox_count": 1,
                    "pending_knowledge_maintenance": True,
                    "recent_curated_topics": ["论文"],
                    "recent_source_additions": ["inbox_note"],
                    "output_excerpt": "done",
                    "error": "",
                }

        controller = BackendHttpController(message_service=StubKnowledgeService(), logger=self.logger, config=self.config)
        status_code, response_payload = controller.handle_tools(
            "/tools/knowledge/run",
            {
                "action": "plan",
                "trigger": "manual",
            },
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload["action"], "plan")
        self.assertEqual(response_payload["trigger"], "manual")
        self.assertIn("status", response_payload)
        self.assertIn("inbox_count_before", response_payload)
        self.assertIn("pending_knowledge_maintenance", response_payload)

    def test_handle_tools_knowledge_run_rejects_invalid_action(self) -> None:
        class StubKnowledgeService:
            def get_knowledge_state(self) -> dict[str, object]:
                return {"last_status": "ok", "pending_knowledge_maintenance": False}

            def run_knowledge_maintenance(self, *, action: str, trigger: str) -> dict[str, object]:
                return {"action": action, "trigger": trigger}

        controller = BackendHttpController(message_service=StubKnowledgeService(), logger=self.logger, config=self.config)
        status_code, response_payload = controller.handle_tools(
            "/tools/knowledge/run",
            {
                "action": "delete",
                "trigger": "manual",
            },
        )

        self.assertEqual(status_code, 400)
        self.assertIn("action", response_payload["error"])

    def test_handle_tools_knowledge_run_rejects_invalid_trigger(self) -> None:
        class StubKnowledgeService:
            def get_knowledge_state(self) -> dict[str, object]:
                return {"last_status": "ok", "pending_knowledge_maintenance": False}

            def run_knowledge_maintenance(self, *, action: str, trigger: str) -> dict[str, object]:
                return {"action": action, "trigger": trigger}

        controller = BackendHttpController(message_service=StubKnowledgeService(), logger=self.logger, config=self.config)
        status_code, response_payload = controller.handle_tools(
            "/tools/knowledge/run",
            {
                "action": "auto",
                "trigger": 123,
            },
        )

        self.assertEqual(status_code, 400)
        self.assertIn("trigger", response_payload["error"])

    def test_handle_tools_context_compact(self) -> None:
        class StubCompactService:
            def compact_conversation_context(
                self,
                *,
                channel: str,
                sender_id: str,
                focus: str = "",
                strategy: str = "handoff",
                preserve_recent_turns: int = 2,
            ) -> dict[str, object]:
                return {
                    "session_id": f"{channel}:{sender_id}",
                    "reply_text": f"compacted:{focus}",
                    "status": "compacted",
                    "strategy": strategy,
                    "original_tokens": 100,
                    "compacted_tokens": 40,
                    "summary": "summary",
                    "reason": "",
                    "error": "",
                    "preserved_items": [],
                    "archived_turns": 2,
                    "archive_path": "memory://conversation_archives/test",
                    "compression_ratio": 0.6,
                }

        controller = BackendHttpController(message_service=StubCompactService(), logger=self.logger, config=self.config)
        status_code, response_payload = controller.handle_tools(
            "/tools/context/compact",
            {
                "channel": "wechat",
                "sender_id": "compact-user",
                "focus": "API设计决策",
                "strategy": "handoff",
                "preserve_recent_turns": 2,
            },
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload["reply_text"], "compacted:API设计决策")
        self.assertEqual(response_payload["strategy"], "handoff")
        self.assertEqual(response_payload["session_id"], "wechat:compact-user")

    def test_handle_tools_todo_create_persists_explicit_reminder(self) -> None:
        status_code, response_payload = self.controller.handle_tools(
            "/tools/todo/create",
            {
                "text": "提醒我明天下午三点开会",
                "source": "hermes",
                "extract_time": True,
            },
        )

        self.assertEqual(status_code, 200)
        self.assertTrue(response_payload["success"])
        self.assertTrue(str(response_payload["parsed_time"]).endswith("15:00:00"))
        self.assertIsNotNone(response_payload["todo_id"])

        todo = self.database.get_todo_by_id(int(response_payload["todo_id"]))
        self.assertIsNotNone(todo)
        assert todo is not None
        self.assertIn("开会", str(todo["content"]))
        self.assertTrue(str(todo["reminder_at"]).endswith("15:00:00"))
        self.assertEqual(todo["source"], "hermes")

    def test_handle_tools_returns_not_found_for_unknown_route(self) -> None:
        status_code, response_payload = self.controller.handle_tools("/tools/unknown", {})

        self.assertEqual(status_code, 404)
        self.assertEqual(response_payload["error"], "tool route not found")

    def test_handle_tools_todo_create_requires_parseable_time_when_requested(self) -> None:
        status_code, response_payload = self.controller.handle_tools(
            "/tools/todo/create",
            {
                "text": "提醒我记得交房租",
                "source": "hermes",
                "extract_time": True,
                "require_time": True,
            },
        )

        self.assertEqual(status_code, 422)
        self.assertEqual(response_payload["success"], False)
        self.assertEqual(response_payload["parsed_time"], None)
        self.assertEqual(response_payload["needs_confirmation"], True)

    def test_handle_tools_todo_create_requires_follow_up_for_time_range_without_exact_clock_time(self) -> None:
        status_code, response_payload = self.controller.handle_tools(
            "/tools/todo/create",
            {
                "text": "提醒我周四下午去找老师",
                "source": "hermes",
                "extract_time": True,
                "require_time": True,
            },
        )

        self.assertEqual(status_code, 422)
        self.assertEqual(response_payload["success"], False)
        self.assertEqual(response_payload["parsed_time"], None)
        self.assertEqual(response_payload["needs_confirmation"], True)

    def test_handle_tools_todo_complete_marks_latest_pending_todo_done(self) -> None:
        todo_id = self.database.create_todo(
            content="去单位",
            reminder_at="2026-04-16 13:00:00",
            source="hermes",
        )

        status_code, response_payload = self.controller.handle_tools(
            "/tools/todo/complete",
            {
                "text": "办完了",
                "source": "hermes",
            },
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload["success"], True)
        self.assertEqual(response_payload["todo_id"], todo_id)
        todo = self.database.get_todo_by_id(todo_id)
        self.assertIsNotNone(todo)
        assert todo is not None
        self.assertEqual(todo["status"], "done")

    def test_handle_tools_todo_cancel_marks_latest_pending_todo_cancelled(self) -> None:
        todo_id = self.database.create_todo(
            content="取快递",
            reminder_at="2026-04-16 14:00:00",
            source="hermes",
        )

        status_code, response_payload = self.controller.handle_tools(
            "/tools/todo/cancel",
            {
                "text": "这个提醒不用了",
                "source": "hermes",
            },
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(response_payload["success"], True)
        self.assertEqual(response_payload["todo_id"], todo_id)
        todo = self.database.get_todo_by_id(todo_id)
        self.assertIsNotNone(todo)
        assert todo is not None
        self.assertEqual(todo["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
