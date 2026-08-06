"""Tests for the direct official Ombre Brain recall boundary."""

from __future__ import annotations

import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from personal_agent.config import AppConfig
from personal_agent.ombre_mcp import OmbreCallResult, OmbreMCPMemoryBackend


class OmbreMCPTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = logging.getLogger("personal_agent.tests.ombre_mcp")
        self.logger.handlers.clear()
        self.logger.addHandler(logging.NullHandler())

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_recall_calls_official_breath_search_and_returns_hit(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        calls = []

        def call(action, payload):
            calls.append((action, payload))
            return OmbreCallResult(
                ok=True,
                payload={"result": "[检索降级：语义检索不可用]\n一段长期关系记忆"},
            )

        backend._official_client.call = call

        recalled = backend.recall(user_text="我们之前聊过什么", response_mode="chat")

        self.assertEqual(recalled.items, ("一段长期关系记忆",))
        self.assertEqual(recalled.outcome, "hit")
        self.assertEqual(calls, [("breath_search", {"query": "我们之前聊过什么", "max_results": 5})])

    def test_recall_distinguishes_empty_transport_and_protocol_results(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        cases = (
            (OmbreCallResult(ok=True, payload={"result": "没有匹配到相关记忆。"}), "empty"),
            (OmbreCallResult(ok=False, payload={}, error="transport_unavailable"), "transport_error"),
            (OmbreCallResult(ok=False, payload={}, error="rpc_error:-32002"), "protocol_error"),
            (OmbreCallResult(ok=True, payload={"result": 3}), "protocol_error"),
        )
        for downstream, expected in cases:
            with self.subTest(expected=expected):
                backend._official_client.call = lambda *_args, value=downstream, **_kwargs: value
                recalled = backend.recall(user_text="测试", response_mode="chat")
                self.assertEqual(recalled.items, ())
                self.assertEqual(recalled.outcome, expected)

    def test_recall_bounds_official_ombre_text(self) -> None:
        config = AppConfig(
            base_dir=self.config.base_dir,
            data_dir=self.config.data_dir,
            logs_dir=self.config.logs_dir,
            vault_dir=self.config.vault_dir,
            database_path=self.config.database_path,
            log_file_path=self.config.log_file_path,
            memory_context_max_chars=40,
        )
        backend = OmbreMCPMemoryBackend(config=config, logger=self.logger)
        backend._official_client.call = lambda *_args, **_kwargs: OmbreCallResult(
            ok=True,
            payload={"result": "长期关系记忆" * 20},
        )

        recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled.outcome, "hit")
        self.assertLessEqual(len(recalled.items[0]), 40)

    def test_recall_does_not_treat_quoted_no_hit_words_as_empty(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        backend._official_client.call = lambda *_args, **_kwargs: OmbreCallResult(
            ok=True,
            payload={"result": "用户曾解释：‘没有匹配到’是旧系统的错误提示。"},
        )

        recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled.outcome, "hit")

    def test_http_client_uses_correlated_json_rpc_and_official_result_shape(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            captured["request"] = json.loads(request.data.decode("utf-8"))
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-breath_search-test",
                    "result": {
                        "isError": False,
                        "structuredContent": {"result": "官方 Ombre 结果"},
                    },
                }
            ).encode("utf-8")
            return response

        with (
            patch("personal_agent.ombre_mcp.uuid.uuid4", return_value=MagicMock(hex="test")),
            patch("personal_agent.ombre_mcp.urlopen", side_effect=fake_urlopen),
        ):
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled.items, ("官方 Ombre 结果",))
        self.assertEqual(recalled.outcome, "hit")
        self.assertEqual(captured["url"], "http://127.0.0.1:18001/mcp")
        self.assertEqual(
            captured["request"]["params"],
            {"name": "breath_search", "arguments": {"query": "测试", "max_results": 5}},
        )

    def test_http_client_rejects_uncorrelated_or_noncanonical_results(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        invalid = (
            {"jsonrpc": "2.0", "id": "wrong", "result": {}},
            {"jsonrpc": "2.0", "id": "ran-agent-breath_search-test", "result": {"isError": True}},
            {
                "jsonrpc": "2.0",
                "id": "ran-agent-breath_search-test",
                "result": {"isError": False, "structuredContent": {"items": []}},
            },
            {"jsonrpc": "2.0", "id": "ran-agent-breath_search-test", "error": "broken"},
        )
        for payload in invalid:
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps(payload).encode("utf-8")
            with self.subTest(payload=payload), patch(
                "personal_agent.ombre_mcp.uuid.uuid4", return_value=MagicMock(hex="test")
            ), patch("personal_agent.ombre_mcp.urlopen", return_value=response):
                recalled = backend.recall(user_text="测试", response_mode="chat")
                self.assertEqual(recalled.items, ())
                self.assertEqual(recalled.outcome, "protocol_error")

    def test_ombre_store_methods_remain_read_only(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        backend._official_client.call = MagicMock(side_effect=AssertionError("must not call"))

        self.assertEqual(backend.store_long_term({"content": "x"}).action, "skip")
        self.assertEqual(backend.store_core({"content": "x"}).action, "skip")
        backend._official_client.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
