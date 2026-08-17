"""Outbound transport for proactive messages sent through the local Node bridge."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from personal_agent.config import AppConfig


# The caller must outlive Node's Hermes and Feishu deadlines so their committed
# delivery result can return before Python records its local completion truth.
OUTBOUND_TIMEOUT_MARGIN_SECONDS = 30


def _outbound_request_timeout_seconds() -> int:
    def positive_env_seconds(name: str, default: int) -> int:
        try:
            return max(1, int(os.environ.get(name, default)))
        except (TypeError, ValueError):
            return default

    return (
        positive_env_seconds("HERMES_REPLY_TIMEOUT_SECONDS", 180)
        + positive_env_seconds("FEISHU_SEND_TIMEOUT_SECONDS", 30)
        + OUTBOUND_TIMEOUT_MARGIN_SECONDS
    )


class NodeBridgeOutboundClient:
    """Tiny HTTP client for sending one proactive text through the local outbound bridge."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config

    def send_text(self, text: str, *, kind: str = "checkin", force: bool = False) -> dict[str, object]:
        """Send one proactive text and return the parsed bridge response."""

        request = urllib.request.Request(
            url=f"{self._config.node_bridge_outbound_base_url}/outbound/send",
            data=json.dumps({"text": text, "kind": kind, "force": force}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok") is not True:
            raise RuntimeError("node bridge outbound response missing ok=true")
        return payload

    def send_proactive_event(self, event: dict[str, object]) -> dict[str, object]:
        """Submit one structured proactive event to the local Node bridge."""

        secret = os.getenv("RAN_AGENT_INTERNAL_CONTROL_SECRET", "").strip()
        if not secret:
            raise RuntimeError("node bridge internal control secret is unavailable")
        request = urllib.request.Request(
            url=f"{self._config.node_bridge_outbound_base_url}/proactive/event",
            data=json.dumps(event, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=_outbound_request_timeout_seconds()) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok") is not True:
            raise RuntimeError("node bridge proactive event response missing ok=true")
        return payload

    def send_ai_daily_digest(self, prompt: str, *, mode: str = "scheduled", operation_id: str = "", date: str = "") -> dict[str, object]:
        """Send one prepared AI digest prompt through the local Node bridge."""

        secret = os.getenv("RAN_AGENT_INTERNAL_CONTROL_SECRET", "").strip()
        if not secret:
            raise RuntimeError("node bridge internal control secret is unavailable")
        request = urllib.request.Request(
            url=f"{self._config.node_bridge_outbound_base_url}/scheduled/ai-daily-digest",
            data=json.dumps({"prompt": prompt, "mode": mode, "operation_id": operation_id, "date": date}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
            method="POST",
        )
        with urllib.request.urlopen(
            request,
            timeout=_outbound_request_timeout_seconds(),
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok") is not True:
            raise RuntimeError("node bridge scheduled digest response missing ok=true")
        return payload

    def register_core_reminder(self, *, todo_id: int, scheduled_for: str) -> dict[str, object]:
        """Register one explicit todo reminder with the local Core authority."""

        secret = os.getenv("RAN_AGENT_INTERNAL_CONTROL_SECRET", "").strip()
        if not secret:
            raise RuntimeError("node bridge internal control secret is unavailable")
        request = urllib.request.Request(
            url=f"{self._config.node_bridge_outbound_base_url}/internal/core/reminders/register",
            data=json.dumps({"todoId": todo_id, "scheduledFor": scheduled_for}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok") is not True:
            raise RuntimeError("node bridge Core reminder response missing ok=true")
        return payload
