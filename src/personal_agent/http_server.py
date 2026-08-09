"""HTTP adapter exposing backend capabilities for tool calls."""

from __future__ import annotations

import ipaddress
import hashlib
import json
import logging
import os
import re
import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from personal_agent.ai_daily_digest import build_digest_prompt, load_aihot_facts
from personal_agent.config import AppConfig
from personal_agent.durable_jobs import (
    DurableJobReceipt,
    DurableJobStore,
    is_registered_core_job_kind,
)
from personal_agent.service import PersonalAgentService
from personal_agent.todo_manager import TodoManager


class BackendHttpController:
    """Validates and dispatches backend capability requests."""

    _knowledge_actions = {"auto", "plan", "apply", "cleanup", "daily_carryover"}

    def __init__(self, message_service: PersonalAgentService, logger: logging.Logger, config: AppConfig) -> None:
        self._message_service = message_service
        self._logger = logger
        self._config = config

    def handle_ingest(
        self,
        payload: dict[str, Any],
        *,
        event_id_header: str = "",
    ) -> tuple[int, dict[str, Any]]:
        # Validate required string fields (channel, sender_id, source must be non-empty)
        for field_name in ("channel", "sender_id", "source"):
            value = payload.get(field_name)
            if not isinstance(value, str) or not value.strip():
                self._logger.warning("[ingest] validation failed: field '%s' is missing or empty", field_name)
                return HTTPStatus.BAD_REQUEST, {"error": f"field '{field_name}' must be a non-empty string"}
        
        # user_text and reply_text can be empty if there is media content
        image_urls_raw = payload.get("image_urls")
        media_raw = payload.get("media")
        has_media = (
            (isinstance(image_urls_raw, list) and len(image_urls_raw) > 0) or
            (isinstance(media_raw, list) and len(media_raw) > 0)
        )
        
        user_text = str(payload.get("user_text", ""))
        reply_text = str(payload.get("reply_text", ""))
        
        if not user_text.strip() and not reply_text.strip() and not has_media:
            self._logger.warning("[ingest] validation failed: at least one of user_text, reply_text, or media must be provided")
            return HTTPStatus.BAD_REQUEST, {"error": "at least one of user_text, reply_text, or media must be provided"}
        
        # Preserve structured media from the bridge so inbox sync can classify attachments.
        media_refs = _merge_media_refs(
            _normalize_media_refs(image_urls_raw),
            _normalize_media_items(media_raw),
        )
        event_id = _trusted_ingest_event_id(payload.get("event_id"), event_id_header)
        self._logger.info(
            "[ingest] sender_hash=%s text_length=%s image_urls_count=%s media_count=%s media_refs_count=%s durable=%s",
            _short_private_digest(str(payload["sender_id"])),
            len(user_text),
            len(image_urls_raw) if isinstance(image_urls_raw, list) else 0,
            len(media_raw) if isinstance(media_raw, list) else 0,
            len(media_refs),
            bool(event_id),
        )

        outcome = self._message_service.record_external_exchange(
            channel=str(payload["channel"]),
            sender_id=str(payload["sender_id"]),
            user_text=user_text,
            reply_text=reply_text,
            source=str(payload["source"]),
            media_refs=media_refs,
            event_id=event_id,
        )
        if outcome == "conflict":
            return HTTPStatus.CONFLICT, {"error": "durable event conflicts with prior request"}
        return HTTPStatus.OK, {"ok": True}

    def handle_tools(self, path: str, payload: dict[str, Any] | None) -> tuple[int, dict[str, Any]]:
        body = payload or {}

        if path == "/tools/memory/recall":
            user_text = str(body.get("user_text", "")).strip()
            if not user_text:
                return HTTPStatus.BAD_REQUEST, {"error": "field 'user_text' must be a non-empty string"}
            route = str(body.get("route", "text_chat")).strip() or "text_chat"
            response_mode = str(body.get("response_mode", "chat")).strip() or "chat"
            return HTTPStatus.OK, self._message_service.recall_memory(
                user_text,
                route=route,
                response_mode=response_mode,
            )

        if path == "/tools/memory/update":
            user_text = str(body.get("user_text", "")).strip()
            if not user_text:
                return HTTPStatus.BAD_REQUEST, {"error": "field 'user_text' must be a non-empty string"}
            return HTTPStatus.OK, self._message_service.update_memory(user_text)

        if path == "/tools/memory/maintain":
            return HTTPStatus.OK, self._message_service.run_memory_maintenance()

        if path == "/tools/session/support":
            channel = str(body.get("channel", "wechat")).strip() or "wechat"
            return HTTPStatus.OK, self._message_service.get_session_support(channel)

        if path == "/tools/knowledge/state":
            return HTTPStatus.OK, self._message_service.get_knowledge_state()

        if path == "/tools/knowledge/run":
            action_raw = body.get("action", "auto")
            if not isinstance(action_raw, str):
                return HTTPStatus.BAD_REQUEST, {"error": "field 'action' must be a string"}
            action = action_raw.strip() or "auto"
            if action not in self._knowledge_actions:
                return HTTPStatus.BAD_REQUEST, {
                    "error": "field 'action' must be one of: auto, plan, apply, cleanup, daily_carryover"
                }

            trigger_raw = body.get("trigger", "manual")
            if not isinstance(trigger_raw, str):
                return HTTPStatus.BAD_REQUEST, {"error": "field 'trigger' must be a string"}
            trigger = trigger_raw.strip() or "manual"

            return HTTPStatus.OK, self._message_service.run_knowledge_maintenance(
                action=action,
                trigger=trigger,
            )

        if path == "/tools/context/compact":
            channel = str(body.get("channel", "wechat")).strip() or "wechat"
            sender_id = str(body.get("sender_id", "")).strip()
            if not sender_id:
                return HTTPStatus.BAD_REQUEST, {"error": "field 'sender_id' must be a non-empty string"}
            focus = str(body.get("focus", "")).strip()
            strategy = str(body.get("strategy", "handoff")).strip() or "handoff"
            preserve_recent_turns_raw = body.get("preserve_recent_turns", 2)
            try:
                preserve_recent_turns = int(preserve_recent_turns_raw)
            except (TypeError, ValueError):
                return HTTPStatus.BAD_REQUEST, {"error": "field 'preserve_recent_turns' must be an integer"}
            if preserve_recent_turns <= 0:
                return HTTPStatus.BAD_REQUEST, {"error": "field 'preserve_recent_turns' must be greater than 0"}
            return HTTPStatus.OK, self._message_service.compact_conversation_context(
                channel=channel,
                sender_id=sender_id,
                focus=focus,
                strategy=strategy,
                preserve_recent_turns=preserve_recent_turns,
            )

        if path == "/tools/reflection/run":
            return HTTPStatus.OK, self._message_service.run_reflection()

        if path == "/tools/life-loop/state":
            return HTTPStatus.OK, self._message_service.run_life_loop_state()

        if path == "/tools/night-cycle/run":
            return HTTPStatus.OK, self._message_service.run_night_cycle_state()

        if path == "/tools/todo/create":
            return self._handle_todo_create(body)

        if path == "/tools/todo/list":
            return self._handle_todo_list(body)

        if path == "/tools/todo/get":
            return self._handle_todo_get(body)

        if path == "/tools/todo/ack":
            return self._handle_todo_ack(body)

        if path == "/tools/todo/complete":
            return self._handle_todo_complete(body)

        if path == "/tools/todo/cancel":
            return self._handle_todo_cancel(body)

        if path == "/tools/exploration/store":
            return self._handle_exploration_store(body)

        return HTTPStatus.NOT_FOUND, {"error": "tool route not found"}

    def handle_durable_job_create(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if set(payload) != {"actorKey", "goalDigest", "jobKind", "payloadRef", "nextRunAt"}:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"}
        try:
            if not is_registered_core_job_kind(str(payload["jobKind"])):
                raise ValueError("unregistered durable job kind")
            record = DurableJobStore(self._message_service._database).create_job(
                actor_key=payload["actorKey"],
                goal_digest=payload["goalDigest"],
                job_kind=payload["jobKind"],
                payload_ref=payload["payloadRef"],
                next_run_at=payload["nextRunAt"],
            )
        except ValueError:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"}
        except Exception:
            self._logger.exception("private durable job create failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "durable job unavailable"}
        return HTTPStatus.OK, {"ok": True, "receipt": _serialize_durable_job_receipt(record.receipt())}

    def handle_durable_job_get(self, job_id: str) -> tuple[int, dict[str, Any]]:
        try:
            record = DurableJobStore(self._message_service._database).get_job(job_id)
        except ValueError:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"}
        except Exception:
            self._logger.exception("private durable job query failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "durable job unavailable"}
        if record is None:
            return HTTPStatus.NOT_FOUND, {"ok": False, "error": "durable job not found"}
        return HTTPStatus.OK, {"ok": True, "receipt": _serialize_durable_job_receipt(record.receipt())}

    def handle_durable_job_terminal(self, job_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if set(payload) != {"terminalState", "resultRef"}:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"}
        try:
            record = DurableJobStore(self._message_service._database).terminalize_external_job(
                job_id,
                terminal_state=payload["terminalState"],
                result_ref=payload["resultRef"],
            )
        except (ValueError, KeyError):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"}
        except Exception:
            self._logger.exception("private durable job terminal failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "durable job unavailable"}
        return HTTPStatus.OK, {"ok": True, "receipt": _serialize_durable_job_receipt(record.receipt())}

    def handle_personal_learning_action(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            if set(payload) != {"operationId", "actionType", "scope"}:
                raise ValueError("invalid request fields")
            operation_id = str(payload["operationId"])
            action_type = str(payload["actionType"])
            scope = payload["scope"]
            if not re.fullmatch(r"op_[a-f0-9]{32}", operation_id):
                raise ValueError("invalid operation")
            if not isinstance(scope, dict):
                raise ValueError("invalid scope")

            if action_type in {"memory.remember", "memory.correct"}:
                expected = {"kind", "subject_key", "statement", "evidence_digest", "confidence"}
                if set(scope) != expected or not re.fullmatch(r"[a-f0-9]{64}", str(scope["evidence_digest"])):
                    raise ValueError("invalid learning scope")
                record = self._message_service.observe_personal_learning(
                    kind="correction" if action_type == "memory.correct" else str(scope["kind"]),
                    subject_key=str(scope["subject_key"]),
                    statement=str(scope["statement"]),
                    source="explicit_user",
                    evidence_digests=[str(scope["evidence_digest"])],
                    confidence=float(scope["confidence"]),
                )
                result: dict[str, Any] = record
                effect_id = f"learning:{record['learning_id']}"
            elif action_type == "memory.forget":
                if set(scope) != {"subject_key"}:
                    raise ValueError("invalid forget scope")
                result = self._message_service.forget_personal_learning(str(scope["subject_key"]))
                effect_id = "learning-forget:" + _short_private_digest(
                    f"{scope['subject_key']}:{result['forgotten_count']}"
                )
            elif action_type == "memory.query":
                if not set(scope).issubset({"subject_prefix", "limit"}):
                    raise ValueError("invalid query scope")
                records = self._message_service.query_personal_learning(
                    subject_prefix=str(scope.get("subject_prefix", "")),
                    limit=int(scope.get("limit", 50)),
                )
                result = {"records": records}
                effect_id = "learning-query:" + _short_private_digest(
                    json.dumps([item["learning_id"] for item in records], sort_keys=True)
                )
            else:
                raise ValueError("unsupported personal learning action")
        except (TypeError, ValueError, KeyError):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid personal learning request"}
        except Exception:
            self._logger.exception("private personal learning action failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "personal learning unavailable"}
        return HTTPStatus.OK, {
            "ok": True,
            "authenticated": True,
            "operationId": operation_id,
            "effectId": effect_id,
            "result": result,
        }

    def handle_ai_daily_digest_action(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            if set(payload) != {"operationId", "actionType", "scope"}:
                raise ValueError("invalid request fields")
            operation_id = str(payload["operationId"])
            if not re.fullmatch(r"op_[a-f0-9]{32}", operation_id) or payload["actionType"] != "ai_daily_digest.send":
                raise ValueError("invalid operation")
            if payload["scope"] != {"mode": "manual", "date": "current_local_date"}:
                raise ValueError("invalid digest scope")
            partial = False
            try:
                facts = load_aihot_facts().strip()
            except Exception:
                facts = "事实材料暂时不可用。本期只报告来源获取失败，不补写或猜测新闻内容。"
                partial = True
            if not facts:
                facts = "事实材料暂时不可用。本期只报告来源返回为空，不补写或猜测新闻内容。"
                partial = True
            bridge_result = self._message_service.send_ai_daily_digest(
                build_digest_prompt(facts), mode="manual", operation_id=operation_id
            )
            if str(bridge_result.get("delivery_status") or "") != "sent" or not bridge_result.get("outbox_id"):
                return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "digest delivery unconfirmed"}
        except (TypeError, ValueError, KeyError):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid daily digest request"}
        except Exception:
            self._logger.exception("private AI daily digest action failed")
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "daily digest unavailable"}
        return HTTPStatus.OK, {
            "ok": True, "authenticated": True, "operationId": operation_id,
            "effectId": "ai-daily-digest:" + _short_private_digest(str(bridge_result["outbox_id"])),
            "result": {"delivery_status": "sent", "partial": partial},
        }

    def _handle_todo_create(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Create a new todo from text."""
        text = str(payload.get("text", "")).strip()
        if not text:
            return HTTPStatus.BAD_REQUEST, {"error": "field 'text' must be a non-empty string"}

        source = str(payload.get("source", "tool")).strip() or "tool"
        extract_time = bool(payload.get("extract_time", True))
        require_time = bool(payload.get("require_time", False))

        try:
            todo_manager = TodoManager(
                database=self._message_service._database,
                logger=self._logger,
                config=self._config,
            )
            result = todo_manager.create_todo_from_text(
                text=text,
                source=source,
                extract_time=extract_time,
            )

            if result.success and require_time and not result.parsed_time:
                return HTTPStatus.UNPROCESSABLE_ENTITY, {
                    "success": False,
                    "error": result.explanation or "Failed to parse reminder time",
                    "parsed_time": result.parsed_time,
                    "needs_confirmation": True,
                }

            if result.success:
                todo_content = text
                core_registration = "not_required"
                if result.todo_id is not None:
                    stored_todo = self._message_service._database.get_todo_by_id(result.todo_id)
                    if stored_todo and stored_todo["content"]:
                        todo_content = str(stored_todo["content"])
                if (
                    result.todo_id is not None
                    and result.parsed_time
                    and os.getenv("RAN_AGENT_CORE_ENABLED", "false").strip().lower() == "true"
                ):
                    try:
                        self._message_service.register_core_reminder(
                            todo_id=result.todo_id,
                            scheduled_for=result.parsed_time,
                        )
                        core_registration = "registered"
                    except Exception:
                        self._logger.exception("immediate Core reminder registration pending reconciliation")
                        core_registration = "pending_reconciliation"
                return HTTPStatus.OK, {
                    "success": True,
                    "todo_id": result.todo_id,
                    "content": todo_content,
                    "parsed_time": result.parsed_time,
                    "explanation": result.explanation,
                    "needs_confirmation": result.needs_confirmation,
                    "core_registration": core_registration,
                }
            else:
                return HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "success": False,
                    "error": result.explanation or "Failed to create todo",
                }
        except Exception as exc:
            self._logger.exception("todo creation failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

    def _handle_todo_list(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """List pending todos."""
        try:
            todo_manager = TodoManager(
                database=self._message_service._database,
                logger=self._logger,
                config=self._config,
            )
            todos = todo_manager.list_todos(status="pending", limit=20)
            return HTTPStatus.OK, {
                "success": True,
                "todos": [
                    {
                        "id": t.id,
                        "content": t.content,
                        "reminder_at": t.reminder_at,
                        "last_reminded_at": t.last_reminded_at,
                        "status": t.status,
                    }
                    for t in todos
                ],
            }
        except Exception as exc:
            self._logger.exception("todo list failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

    def _handle_todo_get(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            todo_id = int(payload.get("todo_id", 0))
        except (TypeError, ValueError):
            todo_id = 0
        if todo_id < 1:
            return HTTPStatus.BAD_REQUEST, {"success": False, "error": "todo_id must be a positive integer"}
        todo = self._message_service._database.get_todo_by_id(todo_id)
        if todo is None:
            return HTTPStatus.NOT_FOUND, {"success": False, "error": "todo not found"}
        return HTTPStatus.OK, {
            "success": True,
            "todo": {
                "id": int(todo["id"]),
                "content": str(todo["content"]),
                "reminder_at": todo["reminder_at"],
                "last_reminded_at": todo["last_reminded_at"],
                "status": str(todo["status"]),
            },
        }

    def _handle_todo_ack(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            todo_id = int(payload.get("todo_id", 0))
        except (TypeError, ValueError):
            todo_id = 0
        if todo_id < 1:
            return HTTPStatus.BAD_REQUEST, {"success": False, "error": "todo_id must be a positive integer"}
        todo = self._message_service._database.get_todo_by_id(todo_id)
        if todo is None:
            return HTTPStatus.NOT_FOUND, {"success": False, "error": "todo not found"}
        if todo["last_reminded_at"] is None:
            self._message_service._database.mark_todo_reminded(todo_id)
        return HTTPStatus.OK, {"success": True, "todo_id": todo_id, "acknowledged": True}

    def _handle_todo_complete(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            todo_manager = TodoManager(
                database=self._message_service._database,
                logger=self._logger,
                config=self._config,
            )
            todo = todo_manager.complete_best_pending_todo()
            if todo is None:
                return HTTPStatus.NOT_FOUND, {"success": False, "error": "no pending todo to complete"}
            return HTTPStatus.OK, {
                "success": True,
                "todo_id": todo.id,
                "content": todo.content,
                "status": "done",
            }
        except Exception as exc:
            self._logger.exception("todo complete failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

    def _handle_todo_cancel(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            todo_manager = TodoManager(
                database=self._message_service._database,
                logger=self._logger,
                config=self._config,
            )
            todo = todo_manager.cancel_best_pending_todo()
            if todo is None:
                return HTTPStatus.NOT_FOUND, {"success": False, "error": "no pending todo to cancel"}
            return HTTPStatus.OK, {
                "success": True,
                "todo_id": todo.id,
                "content": todo.content,
                "status": "cancelled",
            }
        except Exception as exc:
            self._logger.exception("todo cancel failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

    def _handle_exploration_store(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Store exploration result as a memory."""
        topic = str(payload.get("topic", "")).strip()
        summary = str(payload.get("summary", "")).strip()

        if not topic or not summary:
            return HTTPStatus.BAD_REQUEST, {
                "error": "fields 'topic' and 'summary' must be non-empty strings"
            }

        source = str(payload.get("source", "web_search")).strip()
        key_insights = payload.get("key_insights", [])
        relevance = str(payload.get("relevance_to_user", "")).strip()

        try:
            result = self._message_service.store_exploration_memory(
                topic=topic,
                source=source,
                summary=summary,
                key_insights=tuple(key_insights) if isinstance(key_insights, list) else (),
                relevance_to_user=relevance,
            )
            if result.get("success"):
                return HTTPStatus.OK, result
            else:
                return HTTPStatus.INTERNAL_SERVER_ERROR, result
        except Exception as exc:
            self._logger.exception("exploration store failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}


class PersonalAgentHttpServer:
    """Runs the threaded HTTP server for backend capability endpoints."""

    def __init__(
        self,
        config: AppConfig,
        message_service: PersonalAgentService,
        logger: logging.Logger,
    ) -> None:
        self._config = config
        self._logger = logger
        self._controller = BackendHttpController(message_service=message_service, logger=logger, config=config)

    def serve_forever(self) -> None:
        """Start the HTTP server and block until interrupted."""

        handler_class = self._build_handler_class()
        server = ThreadingHTTPServer((self._config.http_host, self._config.http_port), handler_class)
        self._logger.info(
            "http backend server started host=%s port=%s",
            self._config.http_host,
            self._config.http_port,
        )
        try:
            server.serve_forever()
        finally:
            server.server_close()
            self._logger.info("http backend server stopped")

    def _build_handler_class(self) -> type[BaseHTTPRequestHandler]:
        controller = self._controller
        logger = self._logger

        class RequestHandler(BaseHTTPRequestHandler):
            """Handles backend capability routes."""

            def do_POST(self) -> None:  # noqa: N802
                if self.path == "/chat":
                    self._write_json(
                        HTTPStatus.GONE,
                        {
                            "error": "frontend /chat path retired; use Hermes Gateway /v1/chat/completions",
                        },
                    )
                    return

                if self.path == "/internal/durable-jobs":
                    denied = self._private_access_denial()
                    if denied is not None:
                        self._write_json(*denied)
                        return
                    try:
                        payload = self._read_json_body()
                    except ValueError:
                        self._write_json(
                            HTTPStatus.BAD_REQUEST,
                            {"ok": False, "error": "invalid durable job request"},
                        )
                        return
                    status_code, response_payload = controller.handle_durable_job_create(payload)
                    self._write_json(status_code, response_payload)
                    return

                durable_terminal_match = re.fullmatch(
                    r"/internal/durable-jobs/([A-Za-z0-9_.:-]{8,160})/terminal",
                    self.path,
                )
                if durable_terminal_match is not None:
                    denied = self._private_access_denial()
                    if denied is not None:
                        self._write_json(*denied)
                        return
                    try:
                        payload = self._read_json_body()
                    except ValueError:
                        self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid durable job request"})
                        return
                    status_code, response_payload = controller.handle_durable_job_terminal(
                        durable_terminal_match.group(1), payload
                    )
                    self._write_json(status_code, response_payload)
                    return

                if self.path == "/internal/personal-learning/actions":
                    denied = self._private_access_denial()
                    if denied is not None:
                        self._write_json(*denied)
                        return
                    try:
                        payload = self._read_json_body()
                    except ValueError:
                        self._write_json(
                            HTTPStatus.BAD_REQUEST,
                            {"ok": False, "error": "invalid personal learning request"},
                        )
                        return
                    status_code, response_payload = controller.handle_personal_learning_action(payload)
                    self._write_json(status_code, response_payload)
                    return

                if self.path == "/internal/ai-daily-digest":
                    denied = self._private_access_denial()
                    if denied is not None:
                        self._write_json(*denied)
                        return
                    try:
                        payload = self._read_json_body()
                    except ValueError:
                        self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid daily digest request"})
                        return
                    status_code, response_payload = controller.handle_ai_daily_digest_action(payload)
                    self._write_json(status_code, response_payload)
                    return

                try:
                    payload = self._read_json_body()
                except ValueError as exc:
                    logger.warning("invalid http request body error=%s", exc)
                    self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                    return

                try:
                    if self.path == "/ingest":
                        status_code, response_payload = controller.handle_ingest(
                            payload,
                            event_id_header=self.headers.get("X-Ran-Agent-Event-Id", ""),
                        )
                    else:
                        status_code, response_payload = controller.handle_tools(self.path, payload)
                except Exception:
                    logger.exception("http backend request handling failed path=%s", self.path)
                    self._write_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        {"error": "internal server error"},
                    )
                    return

                self._write_json(status_code, response_payload)

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/health":
                    self._write_json(HTTPStatus.OK, {"status": "ok"})
                    return

                durable_job_match = re.fullmatch(
                    r"/internal/durable-jobs/([A-Za-z0-9_.:-]{8,160})",
                    self.path,
                )
                if durable_job_match is not None:
                    denied = self._private_access_denial()
                    if denied is not None:
                        self._write_json(*denied)
                        return
                    status_code, response_payload = controller.handle_durable_job_get(
                        durable_job_match.group(1)
                    )
                    self._write_json(status_code, response_payload)
                    return

                if self.path == "/tools/knowledge/state":
                    try:
                        status_code, response_payload = controller.handle_tools(self.path, None)
                    except Exception:
                        logger.exception("http backend get handling failed path=%s", self.path)
                        self._write_json(
                            HTTPStatus.INTERNAL_SERVER_ERROR,
                            {"error": "internal server error"},
                        )
                        return
                    self._write_json(status_code, response_payload)
                    return

                self._write_json(HTTPStatus.NOT_FOUND, {"error": "route not found"})

            def log_message(self, format: str, *args: Any) -> None:
                logger.info("http access " + format, *args)

            def _read_json_body(self) -> dict[str, Any]:
                content_length = self.headers.get("Content-Length", "").strip()
                if not content_length:
                    raise ValueError("missing Content-Length header")

                try:
                    body_length = int(content_length)
                except ValueError as exc:
                    raise ValueError("invalid Content-Length header") from exc

                raw_body = self.rfile.read(body_length)
                try:
                    parsed_body = json.loads(raw_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError("request body must be valid JSON") from exc

                if not isinstance(parsed_body, dict):
                    raise ValueError("request body must be a JSON object")

                return parsed_body

            def _private_access_denial(self) -> tuple[int, dict[str, Any]] | None:
                secret = os.getenv("RAN_AGENT_INTERNAL_CONTROL_SECRET", "")
                if not secret:
                    return HTTPStatus.SERVICE_UNAVAILABLE, {
                        "ok": False,
                        "error": "private control unavailable",
                    }
                if not _is_loopback_client(self.client_address[0]):
                    return HTTPStatus.FORBIDDEN, {"ok": False, "error": "loopback required"}
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {secret}"
                if not secrets.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
                    return HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"}
                return None

            def _write_json(self, status_code: int, payload: dict[str, Any]) -> None:
                encoded_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(encoded_body)))
                self.end_headers()
                self.wfile.write(encoded_body)

        RequestHandler.protocol_version = "HTTP/1.1"
        return RequestHandler


def run_http_server(
    config: AppConfig,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> int:
    """Start the backend HTTP server and map failures to exit codes."""

    server = PersonalAgentHttpServer(
        config=config,
        message_service=message_service,
        logger=logger,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("http backend server interrupted by user")
        return 0
    except OSError:
        logger.exception("http backend server failed to bind or run")
        return 2
    except Exception:
        logger.exception("http backend server crashed unexpectedly")
        return 3
    return 0


def _normalize_media_refs(raw_value: Any) -> tuple[str, ...]:
    if not isinstance(raw_value, list):
        return ()
    refs: list[str] = []
    for item in raw_value:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()
        if cleaned:
            refs.append(cleaned)
    return tuple(refs)


def _normalize_media_items(raw_value: Any) -> tuple[str, ...]:
    if not isinstance(raw_value, list):
        return ()
    refs: list[str] = []
    for item in raw_value:
        if not isinstance(item, dict):
            continue
        file_path = str(item.get("filePath", "")).strip()
        mime_type = str(item.get("mimeType", "")).strip().lower()
        media_type = str(item.get("type", "")).strip().lower()
        if not file_path:
            continue
        markers = " ".join(part for part in (mime_type, media_type, file_path) if part)
        cleaned = markers.strip()
        if cleaned:
            refs.append(cleaned)
    return tuple(refs)


def _merge_media_refs(*groups: tuple[str, ...]) -> tuple[str, ...]:
    merged: list[str] = []
    for group in groups:
        for ref in group:
            cleaned = ref.strip()
            if cleaned and cleaned not in merged:
                merged.append(cleaned)
    return tuple(merged)


def _serialize_durable_job_receipt(receipt: DurableJobReceipt) -> dict[str, Any]:
    return {
        "jobId": receipt.job_id,
        "actorKey": receipt.actor_key,
        "goalDigest": receipt.goal_digest,
        "status": receipt.status,
        "nextRunAt": receipt.next_run_at,
        "terminalStates": list(receipt.terminal_states),
    }


def _is_loopback_client(value: str) -> bool:
    try:
        address = ipaddress.ip_address(str(value).split("%", 1)[0])
    except ValueError:
        return False
    if address.is_loopback:
        return True
    return bool(address.version == 6 and address.ipv4_mapped and address.ipv4_mapped.is_loopback)


def _short_private_digest(value: str) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:24]


def _trusted_ingest_event_id(body_value: Any, header_value: Any) -> str:
    """Return an idempotency key only when the supplied durable identifier is trusted.

    Missing and malformed values deliberately remain on the legacy path.  When
    both the Node body and header are present, they must agree exactly before
    this endpoint makes an idempotency claim.
    """

    body = str(body_value).strip() if isinstance(body_value, str) else ""
    header = str(header_value).strip() if isinstance(header_value, str) else ""
    supplied = tuple(value for value in (body, header) if value)
    if len(set(supplied)) > 1:
        return ""
    candidate = body or header
    if re.fullmatch(r"outbox_[a-f0-9]{32}", candidate):
        return candidate
    return ""
