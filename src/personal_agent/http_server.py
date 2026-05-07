"""HTTP adapter exposing backend capabilities for OpenClaw tool calls."""

from __future__ import annotations

import json
import logging
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from personal_agent.config import AppConfig
from personal_agent.service import PersonalAgentService
from personal_agent.todo_manager import TodoManager


class BackendHttpController:
    """Validates and dispatches backend capability requests."""

    _knowledge_actions = {"auto", "plan", "apply"}

    def __init__(self, message_service: PersonalAgentService, logger: logging.Logger, config: AppConfig) -> None:
        self._message_service = message_service
        self._logger = logger
        self._config = config

    def handle_ingest(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        # Validate required string fields (channel, sender_id, source must be non-empty)
        for field_name in ("channel", "sender_id", "source"):
            value = payload.get(field_name)
            if not isinstance(value, str) or not value.strip():
                self._logger.warning("[ingest] validation failed: field '%s' is missing or empty, value=%r", field_name, value)
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
        # Debug log for multimedia sync
        self._logger.info(
            "[ingest] sender_id=%s text_length=%s image_urls_count=%s media_count=%s media_refs_count=%s",
            payload.get("sender_id"),
            len(user_text),
            len(image_urls_raw) if isinstance(image_urls_raw, list) else 0,
            len(media_raw) if isinstance(media_raw, list) else 0,
            len(media_refs),
        )
        if media_refs:
            self._logger.info("[ingest] media_refs: %s", media_refs)

        self._message_service.record_external_exchange(
            channel=str(payload["channel"]),
            sender_id=str(payload["sender_id"]),
            user_text=user_text,
            reply_text=reply_text,
            source=str(payload["source"]),
            media_refs=media_refs,
        )
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
                return HTTPStatus.BAD_REQUEST, {"error": "field 'action' must be one of: auto, plan, apply"}

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

        if path == "/tools/todo/complete":
            return self._handle_todo_complete(body)

        if path == "/tools/todo/cancel":
            return self._handle_todo_cancel(body)

        if path == "/tools/exploration/store":
            return self._handle_exploration_store(body)

        return HTTPStatus.NOT_FOUND, {"error": "tool route not found"}

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
                if result.todo_id is not None:
                    stored_todo = self._message_service._database.get_todo_by_id(result.todo_id)
                    if stored_todo and stored_todo["content"]:
                        todo_content = str(stored_todo["content"])
                return HTTPStatus.OK, {
                    "success": True,
                    "todo_id": result.todo_id,
                    "content": todo_content,
                    "parsed_time": result.parsed_time,
                    "explanation": result.explanation,
                    "needs_confirmation": result.needs_confirmation,
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
                        "status": t.status,
                    }
                    for t in todos
                ],
            }
        except Exception as exc:
            self._logger.exception("todo list failed")
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

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
                            "error": "frontend /chat path retired; use OpenClaw Gateway /v1/chat/completions",
                        },
                    )
                    return

                try:
                    payload = self._read_json_body()
                except ValueError as exc:
                    logger.warning("invalid http request body error=%s", exc)
                    self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                    return

                try:
                    if self.path == "/ingest":
                        status_code, response_payload = controller.handle_ingest(payload)
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
