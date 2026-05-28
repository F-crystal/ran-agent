"""Outbound transport for proactive messages sent through the local Node bridge."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from personal_agent.config import AppConfig


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

    def send_ai_daily_digest(self, facts: str) -> dict[str, object]:
        """Send one scheduled AI digest trigger through the local Node bridge."""

        request = urllib.request.Request(
            url=f"{self._config.node_bridge_outbound_base_url}/scheduled/ai-daily-digest",
            data=json.dumps({"facts": facts}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok") is not True:
            raise RuntimeError("node bridge scheduled digest response missing ok=true")
        return payload
