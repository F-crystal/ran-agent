"""Minimal Ombre Brain MCP adapter for long, core, and emotional memory access."""

from __future__ import annotations

import json
import logging
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass

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


class OmbreMCPMemoryBackend(OmbreMemoryBackend):
    """Memory-specialist backend that talks to Ombre Brain over MCP."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._client = OmbreMCPClient(config, logger)
        self._logger = logger

    def recall(self, *, user_text: str, response_mode: str) -> tuple[str, ...]:
        snippets: list[str] = []
        for action in ("breath", "trace", "pulse"):
            started_monotonic = time.monotonic()
            result = self._client.call(
                action,
                {
                    "user_text": user_text,
                    "response_mode": response_mode,
                },
            )
            duration_seconds = time.monotonic() - started_monotonic
            if not result.ok:
                self._logger.info(
                    "ombre recall action=%s ok=%s items=%d duration_seconds=%.3f error=%s",
                    action,
                    result.ok,
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
                    text = self._client._render_item(item)
                    if text:
                        snippets.append(text)
            self._logger.info(
                "ombre recall action=%s ok=%s items=%d duration_seconds=%.3f error=%s",
                action,
                result.ok,
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
        result = self._client.call("hold", {"candidate": candidate, "layer": "long"})
        if result.ok and result.payload.get("stored") is True:
            return MemoryStoreDecision(
                action="stored_ombre_long",
                candidate=candidate,
                source="ombre_mcp",
            )
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")

    def store_core(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        result = self._client.call("grow", {"candidate": candidate, "layer": "core"})
        if result.ok and result.payload.get("stored") is True:
            return MemoryStoreDecision(
                action="stored_ombre_core",
                candidate=candidate,
                source="ombre_mcp",
            )
        return MemoryStoreDecision(action="skip", candidate=candidate, source="ombre_mcp")
