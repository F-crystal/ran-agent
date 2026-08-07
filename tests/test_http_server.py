"""Unit tests for backend HTTP controller contract."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.http_server import BackendHttpController, PersonalAgentHttpServer
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
        self.config = make_test_config(base_dir)
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

    def test_memory_recall_surfaces_bounded_vault_knowledge(self) -> None:
        wiki = self.config.vault_dir / "wiki"
        wiki.mkdir(parents=True, exist_ok=True)
        (wiki / "hermes.md").write_text(
            "# Hermes 决策\n升级 v0.20 是为了统一前台运行时。\n",
            encoding="utf-8",
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )
        controller = BackendHttpController(service, self.logger, self.config)

        status_code, payload = controller.handle_tools(
            "/tools/memory/recall",
            {"user_text": "为什么升级 Hermes v0.20"},
        )

        self.assertEqual(status_code, 200)
        self.assertTrue(payload["should_inject"])
        self.assertEqual(payload["source_status"]["vault_knowledge"], "hit")
        self.assertIn("vault_knowledge", payload["used_sources"])
        self.assertEqual(payload["knowledge_hits"][0]["path"], "wiki/hermes.md")
        self.assertIn("统一前台运行时", payload["rendered_context"])

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

    def test_ingest_durable_event_id_is_network_idempotent_without_leaking_private_input(self) -> None:
        """A retried Node outbox ingest must not create a second backend exchange."""

        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        event_id = "outbox_" + "a" * 32
        payload = {
            "channel": "wechat",
            "sender_id": "private-sender-id-should-not-appear-in-logs",
            "user_text": "private-user-text-should-not-appear-in-logs",
            "reply_text": "private-reply-text-should-not-appear-in-logs",
            "source": "private-source-should-not-appear-in-logs",
            "event_id": event_id,
        }
        captured_messages: list[str] = []

        class CaptureHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                captured_messages.append(self.format(record))

        capture = CaptureHandler()
        self.logger.addHandler(capture)
        try:
            first_status, first_payload = invoke_handler(
                server,
                method="POST",
                path="/ingest",
                body=payload,
                secret=None,
                extra_headers={"X-Ran-Agent-Event-Id": event_id},
            )
            second_status, second_payload = invoke_handler(
                server,
                method="POST",
                path="/ingest",
                body=payload,
                secret=None,
                extra_headers={"X-Ran-Agent-Event-Id": event_id},
            )
        finally:
            self.logger.removeHandler(capture)

        events = self.database.fetch_timeline_events()
        serialized = json.dumps([first_payload, second_payload])
        logs = "\n".join(captured_messages)
        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual(len(events), 2)
        self.assertEqual([event["event_type"] for event in events], ["user_message", "agent_reply"])
        for private_value in (
            event_id,
            payload["sender_id"],
            payload["user_text"],
            payload["reply_text"],
            payload["source"],
        ):
            self.assertNotIn(private_value, serialized)
            self.assertNotIn(private_value, logs)

    def test_ingest_malformed_event_id_remains_legacy_compatible_without_deduplication_claim(self) -> None:
        """Old callers keep working, but malformed identifiers must not suppress a real exchange."""

        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        payload = {
            "channel": "wechat",
            "sender_id": "legacy-user",
            "user_text": "legacy request",
            "reply_text": "legacy reply",
            "source": "external",
            "event_id": "not-a-durable-event-id",
        }
        first_status, first_payload = invoke_handler(
            server,
            method="POST",
            path="/ingest",
            body=payload,
            secret=None,
            extra_headers={"X-Ran-Agent-Event-Id": "not-a-durable-event-id"},
        )
        second_status, second_payload = invoke_handler(
            server,
            method="POST",
            path="/ingest",
            body=payload,
            secret=None,
            extra_headers={"X-Ran-Agent-Event-Id": "not-a-durable-event-id"},
        )

        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual((first_payload, second_payload), ({"ok": True}, {"ok": True}))
        self.assertEqual(len(self.database.fetch_timeline_events()), 4)

    def test_ingest_reused_durable_event_id_with_a_different_actor_conflicts(self) -> None:
        """An event ID cannot silently bind a later exchange to a different actor."""

        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        event_id = "outbox_" + "b" * 32
        first_body = {
            "channel": "wechat",
            "sender_id": "first-actor",
            "user_text": "same text",
            "reply_text": "same reply",
            "source": "external",
            "event_id": event_id,
        }
        second_body = {**first_body, "sender_id": "second-private-actor"}
        first_status, _ = invoke_handler(
            server,
            method="POST",
            path="/ingest",
            body=first_body,
            secret=None,
            extra_headers={"X-Ran-Agent-Event-Id": event_id},
        )
        second_status, second_payload = invoke_handler(
            server,
            method="POST",
            path="/ingest",
            body=second_body,
            secret=None,
            extra_headers={"X-Ran-Agent-Event-Id": event_id},
        )

        self.assertEqual(first_status, 200)
        self.assertEqual(second_status, 409)
        self.assertEqual(len(self.database.fetch_timeline_events()), 2)
        self.assertNotIn(event_id, json.dumps(second_payload))
        self.assertNotIn(second_body["sender_id"], json.dumps(second_payload))

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

    def test_private_durable_job_post_and_get_return_exact_camel_case_receipt(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        create_status, create_payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            body={
                "actorKey": "actor:" + "a" * 32,
                "goalDigest": "b" * 64,
                "jobKind": "core.reflection",
                "payloadRef": "payload:reflection",
                "nextRunAt": "2026-07-10T10:00:00.000Z",
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )

        self.assertEqual(create_status, 200)
        self.assertEqual(set(create_payload), {"ok", "receipt"})
        self.assertTrue(create_payload["ok"])
        receipt = create_payload["receipt"]
        self.assertEqual(
            set(receipt),
            {"jobId", "actorKey", "goalDigest", "status", "nextRunAt", "terminalStates"},
        )
        self.assertEqual(receipt["status"], "active")
        self.assertEqual(receipt["terminalStates"], ["completed", "blocked", "stopped", "expired"])

        get_status, get_payload = invoke_handler(
            server,
            method="GET",
            path=f"/internal/durable-jobs/{receipt['jobId']}",
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        self.assertEqual(get_status, 200)
        self.assertEqual(get_payload, create_payload)

    def test_private_durable_jobs_are_not_exposed_as_tools_or_prefix_routes(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        for method, path in (
            ("POST", "/tools/internal/durable-jobs"),
            ("POST", "/internal/durable-jobs/"),
            ("GET", "/internal/durable-jobs/job_missing?debug=1"),
        ):
            status, _ = invoke_handler(
                server,
                method=method,
                path=path,
                body={} if method == "POST" else None,
                authorization=f"Bearer {secret}",
                secret=secret,
            )
            self.assertEqual(status, 404, path)

    def test_private_durable_job_missing_secret_fails_closed_before_reading_body(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        status, payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            raw_body=b'Bearer must-not-echo /private/path {',
            authorization="Bearer supplied-secret",
            secret=None,
        )
        self.assertEqual(status, 503)
        self.assertEqual(payload, {"ok": False, "error": "private control unavailable"})
        self.assertNotIn("must-not-echo", json.dumps(payload))

    def test_private_durable_job_rejects_wrong_bearer_and_non_loopback_client(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        wrong_status, wrong_payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            body={},
            authorization="Bearer wrong-secret",
            secret=secret,
        )
        remote_status, remote_payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            body={},
            authorization=f"Bearer {secret}",
            secret=secret,
            client_address="192.0.2.44",
            extra_headers={"X-Forwarded-For": "127.0.0.1"},
        )
        self.assertEqual((wrong_status, wrong_payload), (401, {"ok": False, "error": "unauthorized"}))
        self.assertEqual((remote_status, remote_payload), (403, {"ok": False, "error": "loopback required"}))

    def test_private_durable_job_validation_and_lookup_errors_do_not_echo_private_input(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        invalid_status, invalid_payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            body={
                "actorKey": "actor:" + "a" * 32,
                "goalDigest": "Bearer leaked-secret /private/path",
                "jobKind": "core.reflection",
                "payloadRef": "payload:reflection",
                "nextRunAt": "2026-07-10T10:00:00.000Z",
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        missing_status, missing_payload = invoke_handler(
            server,
            method="GET",
            path="/internal/durable-jobs/job_private_missing",
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        self.assertEqual(invalid_status, 400)
        self.assertEqual(invalid_payload, {"ok": False, "error": "invalid durable job request"})
        self.assertEqual(missing_status, 404)
        self.assertEqual(missing_payload, {"ok": False, "error": "durable job not found"})
        serialized = json.dumps([invalid_payload, missing_payload])
        self.assertNotIn("leaked-secret", serialized)
        self.assertNotIn("private_missing", serialized)

    def test_private_durable_job_rejects_an_unregistered_kind_before_persisting(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        status, payload = invoke_handler(
            server,
            method="POST",
            path="/internal/durable-jobs",
            body={
                "actorKey": "actor:" + "a" * 32,
                "goalDigest": "b" * 64,
                "jobKind": "core.unreviewed-network-work",
                "payloadRef": "payload:untrusted",
                "nextRunAt": "2026-07-10T10:00:00.000Z",
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        self.assertEqual((status, payload), (400, {"ok": False, "error": "invalid durable job request"}))

    def test_private_personal_learning_actions_use_one_authenticated_lifecycle(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        common = {
            "operationId": "op_" + "a" * 32,
            "actionType": "memory.remember",
            "scope": {
                "kind": "preference",
                "subject_key": "reply:structure",
                "statement": "复杂问题先说结论再解释依据",
                "evidence_digest": "b" * 64,
                "confidence": 1.0,
            },
        }
        remember_status, remembered = invoke_handler(
            server,
            method="POST",
            path="/internal/personal-learning/actions",
            body=common,
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        query_status, queried = invoke_handler(
            server,
            method="POST",
            path="/internal/personal-learning/actions",
            body={
                "operationId": "op_" + "c" * 32,
                "actionType": "memory.query",
                "scope": {"subject_prefix": "reply:", "limit": 5},
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )
        forget_status, forgotten = invoke_handler(
            server,
            method="POST",
            path="/internal/personal-learning/actions",
            body={
                "operationId": "op_" + "d" * 32,
                "actionType": "memory.forget",
                "scope": {"subject_key": "reply:structure"},
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )

        self.assertEqual((remember_status, query_status, forget_status), (200, 200, 200))
        for operation_id, payload in (
            (common["operationId"], remembered),
            ("op_" + "c" * 32, queried),
            ("op_" + "d" * 32, forgotten),
        ):
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["authenticated"])
            self.assertEqual(payload["operationId"], operation_id)
            self.assertTrue(payload["effectId"])
        self.assertEqual(queried["result"]["records"][0]["subject_key"], "reply:structure")
        self.assertEqual(forgotten["result"], {"forgotten_count": 1})

    def test_private_personal_learning_rejects_unauthenticated_or_widened_requests(self) -> None:
        server = PersonalAgentHttpServer(self.config, self.service, self.logger)
        secret = "owner-control-secret"
        unauthorized_status, _ = invoke_handler(
            server,
            method="POST",
            path="/internal/personal-learning/actions",
            body={},
            authorization="Bearer wrong",
            secret=secret,
        )
        invalid_status, invalid = invoke_handler(
            server,
            method="POST",
            path="/internal/personal-learning/actions",
            body={
                "operationId": "op_" + "e" * 32,
                "actionType": "memory.remember",
                "scope": {
                    "kind": "preference",
                    "subject_key": "reply:tone",
                    "statement": "Bearer leaked /private/path",
                    "evidence_digest": "f" * 64,
                    "confidence": 1,
                    "privateCapability": "forged",
                },
            },
            authorization=f"Bearer {secret}",
            secret=secret,
        )

        self.assertEqual(unauthorized_status, 401)
        self.assertEqual(invalid_status, 400)
        self.assertEqual(invalid, {"ok": False, "error": "invalid personal learning request"})
        self.assertNotIn("leaked", json.dumps(invalid))

    def test_ai_daily_digest_action_uses_bounded_facts_and_manual_delivery_receipt(self) -> None:
        """The private executor may send only through the existing digest outbox path."""

        operation_id = "op_" + "a" * 32
        with (
            patch("personal_agent.http_server.load_aihot_facts", return_value="一条已验证事实"),
            patch.object(
                self.service,
                "send_ai_daily_digest",
                return_value={"delivery_status": "sent", "outbox_id": "outbox_" + "b" * 32},
            ) as send_digest,
        ):
            status, payload = self.controller.handle_ai_daily_digest_action(
                {
                    "operationId": operation_id,
                    "actionType": "ai_daily_digest.send",
                    "scope": {"mode": "manual", "date": "current_local_date"},
                }
            )

        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["operationId"], operation_id)
        self.assertEqual(payload["result"], {"delivery_status": "sent", "partial": False})
        self.assertTrue(payload["effectId"].startswith("ai-daily-digest:"))
        sent_prompt = send_digest.call_args.args[0]
        self.assertIn("一条已验证事实", sent_prompt)
        self.assertEqual(send_digest.call_args.kwargs, {"mode": "manual", "operation_id": operation_id})

    def test_ai_daily_digest_action_never_confirms_an_uncommitted_delivery(self) -> None:
        operation_id = "op_" + "c" * 32
        with (
            patch("personal_agent.http_server.load_aihot_facts", return_value="一条事实"),
            patch.object(self.service, "send_ai_daily_digest", return_value={"delivery_status": "ambiguous"}),
        ):
            status, payload = self.controller.handle_ai_daily_digest_action(
                {
                    "operationId": operation_id,
                    "actionType": "ai_daily_digest.send",
                    "scope": {"mode": "manual", "date": "current_local_date"},
                }
            )

        self.assertEqual(status, 502)
        self.assertEqual(payload, {"ok": False, "error": "digest delivery unconfirmed"})


class _FakeSocket:
    def __init__(self, request_bytes: bytes) -> None:
        self._request = BytesIO(request_bytes)
        self.response = BytesIO()

    def makefile(self, mode: str, _buffering: int | None = None):
        if "r" in mode:
            return self._request
        return self.response

    def sendall(self, data: bytes) -> None:
        self.response.write(data)

    def close(self) -> None:
        pass


def invoke_handler(
    server: PersonalAgentHttpServer,
    *,
    method: str,
    path: str,
    body: dict[str, object] | None = None,
    raw_body: bytes | None = None,
    authorization: str = "",
    secret: str | None,
    client_address: str = "127.0.0.1",
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, object]]:
    encoded_body = raw_body
    if encoded_body is None:
        encoded_body = json.dumps(body).encode("utf-8") if body is not None else b""
    headers = {
        "Host": "127.0.0.1",
        "Connection": "close",
        **({"Authorization": authorization} if authorization else {}),
        **(extra_headers or {}),
    }
    if method == "POST":
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(encoded_body))
    request = "\r\n".join(
        [f"{method} {path} HTTP/1.1", *(f"{name}: {value}" for name, value in headers.items()), "", ""]
    ).encode("ascii") + encoded_body
    fake_socket = _FakeSocket(request)
    env = os.environ.copy()
    if secret is None:
        env.pop("RAN_AGENT_INTERNAL_CONTROL_SECRET", None)
    else:
        env["RAN_AGENT_INTERNAL_CONTROL_SECRET"] = secret
    with patch.dict(os.environ, env, clear=True):
        server._build_handler_class()(fake_socket, (client_address, 12345), object())
    response = fake_socket.response.getvalue()
    status_line = response.split(b"\r\n", 1)[0]
    response_body = response.split(b"\r\n\r\n", 1)[1]
    return int(status_line.split()[1]), json.loads(response_body.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
