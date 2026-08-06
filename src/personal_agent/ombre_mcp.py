"""Minimal Ombre Brain MCP adapter for long, core, and emotional memory access."""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from http.client import HTTPException
from urllib.error import URLError
from urllib.request import Request, urlopen

from personal_agent.config import AppConfig
from personal_agent.context_budget import trim_context
from personal_agent.memory_types import (
    MemoryStoreDecision,
    OmbreMemoryBackend,
    OmbreRecallResult,
)


@dataclass(frozen=True)
class OmbreCallResult:
    """Structured Ombre MCP call result."""

    ok: bool
    payload: dict[str, object]
    error: str = ""


def _strict_json_object(raw: str) -> dict[str, object] | None:
    """Parse one JSON object without duplicate keys or non-standard constants."""

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate JSON key")
            value[key] = item
        return value

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON constant: {value}")

    try:
        parsed = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (json.JSONDecodeError, RecursionError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _upstream_recall_items(value: object) -> tuple[str, ...] | None:
    """Normalize official breath_search text without leaking its empty hint."""

    if not isinstance(value, str) or not value.strip():
        return None
    lines = value.strip().splitlines()
    if lines and lines[0].startswith("[检索降级："):
        lines = lines[1:]
    normalized = "\n".join(lines).strip()
    first_line = normalized.splitlines()[0] if normalized else ""
    if not normalized or (
        first_line.startswith("没有匹配到")
        and ("相关记忆" in first_line or "相关的记忆" in first_line)
    ):
        return ()
    return (normalized,)


class OfficialOmbreHTTPClient:
    """Small JSON-RPC client for official Ombre Brain on loopback."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._mcp_url = config.ombre_mcp_url.strip()
        self._timeout_seconds = config.ombre_mcp_timeout_seconds
        self._logger = logger

    @property
    def available(self) -> bool:
        return bool(self._mcp_url)

    def _endpoint_for_action(self, action: str) -> str:
        del action
        return self._mcp_url

    def call(self, action: str, payload: dict[str, object]) -> OmbreCallResult:
        endpoint = self._endpoint_for_action(action)
        if not endpoint:
            return OmbreCallResult(ok=False, payload={}, error="endpoint_unavailable")
        request_id = f"ran-agent-{action}-{uuid.uuid4().hex}"
        request_payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "name": action,
                "arguments": payload,
            },
        }
        request = Request(
            endpoint,
            data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except (HTTPException, OSError, URLError):
            self._logger.info("official ombre http call failed action=%s endpoint=%s", action, endpoint)
            return OmbreCallResult(ok=False, payload={}, error="transport_unavailable")

        response_payload = _strict_json_object(raw)
        if response_payload is None:
            return OmbreCallResult(ok=False, payload={}, error="response_invalid")
        if (
            response_payload.get("jsonrpc") != "2.0"
            or response_payload.get("id") != request_id
        ):
            return OmbreCallResult(ok=False, payload={}, error="response_invalid")
        has_result = "result" in response_payload
        has_error = "error" in response_payload
        if has_result == has_error:
            return OmbreCallResult(ok=False, payload={}, error="response_invalid")
        if has_error:
            rpc_error = response_payload["error"]
            if not isinstance(rpc_error, dict):
                return OmbreCallResult(ok=False, payload={}, error="response_invalid")
            code = rpc_error.get("code", "unknown")
            self._logger.info("official ombre http rpc error action=%s code=%s", action, code)
            return OmbreCallResult(ok=False, payload={}, error=f"rpc_error:{code}")
        result = response_payload.get("result")
        if not isinstance(result, dict) or result.get("isError") is not False:
            return OmbreCallResult(ok=False, payload={}, error="tool_result_invalid")
        structured = result.get("structuredContent")
        if not isinstance(structured, dict) or not isinstance(structured.get("result"), str):
            return OmbreCallResult(ok=False, payload={}, error="payload_result_invalid")
        return OmbreCallResult(ok=True, payload={"result": structured["result"]})


class OmbreMCPMemoryBackend(OmbreMemoryBackend):
    """Recall-only backend that calls official Ombre Brain directly."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._official_client = OfficialOmbreHTTPClient(config, logger)
        self._logger = logger
        self._max_chars = config.memory_context_max_chars

    def recall(self, *, user_text: str, response_mode: str) -> OmbreRecallResult:
        del response_mode
        action = "breath_search"
        started_monotonic = time.monotonic()
        result = self._official_client.call(
            action,
            {"query": user_text, "max_results": 5},
        )
        duration_seconds = time.monotonic() - started_monotonic
        if not result.ok:
            outcome = "transport_error" if result.error == "transport_unavailable" else "protocol_error"
            items: tuple[str, ...] = ()
        else:
            parsed = _upstream_recall_items(result.payload.get("result"))
            if parsed is None:
                result = OmbreCallResult(ok=False, payload={}, error="payload_result_invalid")
                outcome = "protocol_error"
                items = ()
            else:
                items = tuple(trim_context(item, self._max_chars) for item in parsed)
                outcome = "hit" if items else "empty"
        self._logger.info(
            "ombre recall action=%s ok=%s outcome=%s source=%s items=%d duration_seconds=%.3f error=%s",
            action,
            result.ok,
            outcome,
            "official_ombre",
            len(items),
            duration_seconds,
            result.error,
        )
        return OmbreRecallResult(items=items, outcome=outcome)

    def store_long_term(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """The personal-memory facade has no Ombre mutation authority."""
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")

    def store_core(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """The personal-memory facade has no Ombre mutation authority."""
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")
