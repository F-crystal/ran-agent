"""Minimal Ombre Brain MCP adapter for long, core, and emotional memory access."""

from __future__ import annotations

import json
import logging
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from urllib.error import URLError
from urllib.request import Request, urlopen

from personal_agent.config import AppConfig
from personal_agent.memory_types import MemoryStoreDecision, OmbreMemoryBackend


@dataclass(frozen=True)
class OmbreCallResult:
    """Structured Ombre MCP call result."""

    ok: bool
    payload: dict[str, object]


class OmbreMCPClient:
    """Small subprocess-based Ombre MCP transport."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._command = config.ombre_mcp_command.strip()
        self._timeout_seconds = config.ombre_mcp_timeout_seconds
        self._logger = logger

    @property
    def available(self) -> bool:
        """Return whether Ombre MCP is configured."""

        return bool(self._command)

    def _build_argv(self, action: str) -> list[str]:
        """Build a stable subprocess argv for the configured MCP command."""

        command = self._command
        if not command:
            return []
        parts = shlex.split(command)
        if parts and parts[0].endswith(".py"):
            return [sys.executable, *parts, action]
        return [*parts, action]

    @staticmethod
    def _render_item(item: object) -> str:
        """Render one recall item into plain text for the chat memory pipeline."""

        if isinstance(item, str):
            return item.strip()
        if isinstance(item, dict):
            for key in ("content", "summary", "text", "message", "memory"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            try:
                return json.dumps(item, ensure_ascii=False, sort_keys=True)
            except TypeError:
                return str(item).strip()
        return str(item).strip()

    def call(self, action: str, payload: dict[str, object]) -> OmbreCallResult:
        """Call the configured Ombre MCP transport and parse one JSON response."""

        if not self.available:
            return OmbreCallResult(ok=False, payload={})
        argv = self._build_argv(action)
        if not argv:
            return OmbreCallResult(ok=False, payload={})
        try:
            completed = subprocess.run(
                argv,
                input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self._timeout_seconds,
                check=False,
            )
        except Exception:
            self._logger.exception("ombre mcp call failed action=%s", action)
            return OmbreCallResult(ok=False, payload={})

        if completed.returncode != 0:
            self._logger.error(
                "ombre mcp call returned non-zero action=%s returncode=%s stderr=%s",
                action,
                completed.returncode,
                completed.stderr.decode("utf-8", errors="replace"),
            )
            return OmbreCallResult(ok=False, payload={})

        try:
            response_payload = json.loads(completed.stdout.decode("utf-8"))
        except json.JSONDecodeError:
            self._logger.error("ombre mcp returned invalid json action=%s", action)
            return OmbreCallResult(ok=False, payload={})
        return OmbreCallResult(ok=True, payload=response_payload)


class OfficialOmbreHTTPClient:
    """Small JSON-RPC over streamable-HTTP client for upstream Ombre Brain."""

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
            return OmbreCallResult(ok=False, payload={})
        request_payload = {
            "jsonrpc": "2.0",
            "id": f"ran-agent-{action}",
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
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except (OSError, URLError):
            self._logger.info("official ombre http call failed action=%s endpoint=%s", action, endpoint)
            return OmbreCallResult(ok=False, payload={})

        payloads = self._parse_response_payloads(raw)
        if not payloads:
            self._logger.info("official ombre http returned empty response action=%s", action)
            return OmbreCallResult(ok=False, payload={})
        return OmbreCallResult(ok=True, payload=self._merge_payloads(payloads))

    @staticmethod
    def _parse_response_payloads(raw: str) -> list[dict[str, object]]:
        raw = raw.strip()
        if not raw:
            return []
        chunks: list[str] = []
        if raw.startswith("data:") or "\ndata:" in raw:
            for line in raw.splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data and data != "[DONE]":
                        chunks.append(data)
        else:
            chunks.append(raw)

        parsed: list[dict[str, object]] = []
        for chunk in chunks:
            try:
                value = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                parsed.append(value)
        return parsed

    @classmethod
    def _merge_payloads(cls, payloads: list[dict[str, object]]) -> dict[str, object]:
        merged_items: list[object] = []
        last_payload: dict[str, object] = payloads[-1]
        for payload in payloads:
            extracted = cls._extract_items_from_json_rpc(payload)
            merged_items.extend(extracted)
        if merged_items:
            return {"items": merged_items}
        return last_payload

    @staticmethod
    def _extract_items_from_json_rpc(payload: dict[str, object]) -> list[object]:
        result = payload.get("result", payload)
        if not isinstance(result, dict):
            return []
        for key in ("items", "memories", "results"):
            value = result.get(key)
            if isinstance(value, list):
                return value
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            for key in ("items", "memories", "results"):
                value = structured.get(key)
                if isinstance(value, list):
                    return value
        content = result.get("content")
        if not isinstance(content, list):
            return []
        items: list[object] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            try:
                inner = json.loads(text)
            except json.JSONDecodeError:
                items.append(text.strip())
                continue
            if isinstance(inner, dict):
                for key in ("items", "memories", "results"):
                    value = inner.get(key)
                    if isinstance(value, list):
                        items.extend(value)
                        break
                else:
                    items.append(inner)
            elif isinstance(inner, list):
                items.extend(inner)
            else:
                items.append(str(inner).strip())
        return items


class OmbreMCPMemoryBackend(OmbreMemoryBackend):
    """Recall-only backend that talks to the local filtered Ombre adapter."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._backend_mode = config.ombre_backend.strip().lower()
        self._client = OmbreMCPClient(config, logger)
        self._official_client = OfficialOmbreHTTPClient(config, logger)
        self._logger = logger

    def recall(self, *, user_text: str, response_mode: str) -> tuple[str, ...]:
        return self._recall_with_client(
            self._official_client,
            user_text=user_text,
            response_mode=response_mode,
            actions=("ombre_recall_search",),
            source="local_recall_projection",
        )

    def _recall_with_client(
        self,
        client,
        *,
        user_text: str,
        response_mode: str,
        actions: tuple[str, ...],
        source: str,
    ) -> tuple[str, ...]:
        snippets: list[str] = []
        for action in actions:
            started_monotonic = time.monotonic()
            result = client.call(
                action,
                {
                    "user_text": user_text,
                    "response_mode": response_mode,
                },
            )
            duration_seconds = time.monotonic() - started_monotonic
            if not result.ok:
                self._logger.info(
                    "ombre recall action=%s ok=%s source=%s items=%d duration_seconds=%.3f error=%s",
                    action,
                    result.ok,
                    source,
                    0,
                    duration_seconds,
                    "call_not_ok",
                )
                continue
            raw_items = result.payload.get("items")
            if raw_items is None:
                raw_items = result.payload.get("memories")
            if raw_items is None:
                raw_items = result.payload.get("results")
            if raw_items is None:
                raw_items = []
            if isinstance(raw_items, list):
                for item in raw_items:
                    text = OmbreMCPClient._render_item(item)
                    if text:
                        snippets.append(text)
            self._logger.info(
                "ombre recall action=%s ok=%s source=%s items=%d duration_seconds=%.3f error=%s",
                action,
                result.ok,
                source,
                len(raw_items) if isinstance(raw_items, list) else 0,
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
