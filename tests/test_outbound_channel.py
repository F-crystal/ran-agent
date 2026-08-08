"""Trust-boundary tests for Python -> Node daily-digest transport."""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from personal_agent.outbound_channel import NodeBridgeOutboundClient


class _Response:
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return b'{"ok": true, "delivery_status": "sent", "outbox_id": "outbox_test"}'


class NodeBridgeOutboundClientTest(TestCase):
    def setUp(self) -> None:
        self.client = NodeBridgeOutboundClient(SimpleNamespace(node_bridge_outbound_base_url="http://127.0.0.1:8791"))

    def test_daily_digest_sends_the_private_control_secret(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    "RAN_AGENT_INTERNAL_CONTROL_SECRET": "private-control-secret",
                    "HERMES_REPLY_TIMEOUT_SECONDS": "1200",
                    "FEISHU_SEND_TIMEOUT_SECONDS": "30",
                },
                clear=True,
            ),
            patch("personal_agent.outbound_channel.urllib.request.urlopen", return_value=_Response()) as urlopen,
        ):
            result = self.client.send_ai_daily_digest("verified facts", mode="manual", operation_id="op_" + "a" * 32)

        self.assertEqual(result["delivery_status"], "sent")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer private-control-secret")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 1260)

    def test_proactive_event_waits_for_hermes_and_feishu_completion(self) -> None:
        with (
            patch.dict(
                os.environ,
                {"HERMES_REPLY_TIMEOUT_SECONDS": "180", "FEISHU_SEND_TIMEOUT_SECONDS": "30"},
                clear=True,
            ),
            patch("personal_agent.outbound_channel.urllib.request.urlopen", return_value=_Response()) as urlopen,
        ):
            self.client.send_proactive_event({"event_id": "reminder-timeout-contract"})

        self.assertEqual(urlopen.call_args.kwargs["timeout"], 240)

    def test_daily_digest_fails_closed_without_the_private_control_secret(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("personal_agent.outbound_channel.urllib.request.urlopen") as urlopen:
            with self.assertRaisesRegex(RuntimeError, "internal control secret"):
                self.client.send_ai_daily_digest("verified facts")

        urlopen.assert_not_called()
