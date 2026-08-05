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
from personal_agent.memory_types import MemoryStoreDecision, OmbreMemoryBackend


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


def _recall_excerpts(items: object, *, limit: int) -> list[str] | None:
    """Validate the local Node adapter's canonical recall item schema."""

    if not isinstance(items, list):
        return None
    if len(items) > limit:
        return None
    excerpts: list[str] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"path", "excerpt"}:
            return None
        path = item.get("path")
        excerpt = item.get("excerpt")
        if (
            not isinstance(path, str)
            or not path.strip()
            or not isinstance(excerpt, str)
            or not excerpt.strip()
        ):
            return None
        excerpts.append(excerpt.strip())
    return excerpts


class OfficialOmbreHTTPClient:
    """Small JSON-RPC client for the local recall-only Ombre adapter."""

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
        if not isinstance(structured, dict) or not isinstance(structured.get("items"), list):
            return OmbreCallResult(ok=False, payload={}, error="payload_items_invalid")
        return OmbreCallResult(ok=True, payload={"items": structured["items"]})


class OmbreMCPMemoryBackend(OmbreMemoryBackend):
    """Recall-only backend that talks to the local filtered Ombre adapter."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        backend_mode = config.ombre_backend.strip().lower()
        if backend_mode == "official_with_legacy_fallback":
            logger.warning("legacy Ombre backend value is mapped to recall_only; no legacy fallback is active")
        elif backend_mode != "recall_only":
            raise ValueError("unsupported Ombre backend; only recall_only is authorized")
        self._official_client = OfficialOmbreHTTPClient(config, logger)
        self._logger = logger

    def recall(self, *, user_text: str, response_mode: str) -> tuple[str, ...]:
        del response_mode
        return self._recall_with_client(
            self._official_client,
            query=user_text,
            limit=5,
            actions=("ombre_recall_search",),
            source="local_recall_projection",
        )

    def _recall_with_client(
        self,
        client,
        *,
        query: str,
        limit: int,
        actions: tuple[str, ...],
        source: str,
    ) -> tuple[str, ...]:
        snippets: list[str] = []
        for action in actions:
            started_monotonic = time.monotonic()
            result = client.call(
                action,
                {
                    "query": query,
                    "limit": limit,
                },
            )
            duration_seconds = time.monotonic() - started_monotonic
            if not result.ok:
                self._logger.info(
                    "ombre recall action=%s ok=%s outcome=%s source=%s items=%d duration_seconds=%.3f error=%s",
                    action,
                    result.ok,
                    "failed",
                    source,
                    0,
                    duration_seconds,
                    result.error or "call_not_ok",
                )
                continue
            excerpts = _recall_excerpts(result.payload.get("items"), limit=limit)
            if excerpts is None:
                self._logger.info(
                    "ombre recall action=%s ok=%s outcome=%s source=%s items=%d duration_seconds=%.3f error=%s",
                    action,
                    False,
                    "failed",
                    source,
                    0,
                    duration_seconds,
                    "payload_items_invalid",
                )
                continue
            snippets.extend(excerpts)
            self._logger.info(
                "ombre recall action=%s ok=%s outcome=%s source=%s items=%d duration_seconds=%.3f error=%s",
                action,
                result.ok,
                "hit" if excerpts else "empty",
                source,
                len(excerpts),
                duration_seconds,
                "",
            )
        deduped: list[str] = []
        seen: set[str] = set()
        for item in snippets:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)
        return tuple(deduped[:5])

    def store_long_term(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """O1 has no Ombre mutation authority."""
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")

    def store_core(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """O1 has no Ombre mutation authority."""
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")
