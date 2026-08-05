"""Tests for the Ombre MCP client adapter."""

from __future__ import annotations

import logging
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from dataclasses import replace
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
from unittest.mock import MagicMock, patch

from personal_agent.config import AppConfig
from personal_agent.ombre_mcp import OmbreCallResult, OmbreMCPMemoryBackend


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated Ombre adapter tests."""

    logger = logging.getLogger("personal_agent.tests.ombre_mcp")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class OmbreMCPTest(unittest.TestCase):
    """Covers the recall-only HTTP contract and structured response parsing."""

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
        self.logger = build_test_logger()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _node_22(self) -> str:
        node = os.environ.get("RAN_AGENT_NODE_BIN") or shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        result = subprocess.run(
            [node, "-p", "process.versions.node"],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            version = tuple(int(part) for part in result.stdout.strip().split(".")[:2])
        except ValueError:
            self.skipTest("Node version could not be determined")
        if result.returncode != 0 or len(version) < 2 or version < (22, 13):
            self.skipTest("Node >=22.13 is required for cross-process recall evidence")
        return node

    @staticmethod
    def _free_loopback_port() -> int:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return int(listener.getsockname()[1])

    @staticmethod
    def _wait_for_listener(process: subprocess.Popen[str], port: int) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if process.poll() is not None:
                _stdout, stderr = process.communicate()
                raise AssertionError(f"Ombre recall fixture exited early: {stderr}")
            try:
                with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.1) as response:
                    health = json.loads(response.read().decode("utf-8"))
            except (OSError, URLError, json.JSONDecodeError):
                time.sleep(0.05)
                continue
            expected = {
                "ok": True,
                "mode": "recall-only",
                "upstream_commit": "0e83d4671ce1629e03ad36bb9160235bf60dbd34",
                "policy_digest": "sha256:a1d99e98e67359880703e83ca183c13fba0967add315d4f1eb67e79dc49e3595",
            }
            if health != expected:
                raise AssertionError(f"Unexpected service on Ombre fixture port: {health}")
            return
        raise AssertionError("Ombre recall fixture did not listen within 5 seconds")

    def test_recall_accepts_only_canonical_path_excerpt_items(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)

        responses = {
            "ombre_recall_search": OmbreCallResult(
                ok=True,
                payload={
                    "items": [
                        {"path": "one.md", "excerpt": "第一条结构化记忆"},
                        {"path": "two.md", "excerpt": "第二条摘要"},
                        {"path": "three.md", "excerpt": "第三条纯文本"},
                        {"path": "four.md", "excerpt": "第四条文本"},
                        {"path": "five.md", "excerpt": "第五条"},
                    ]
                },
            ),
        }

        backend._official_client.call = lambda action, payload: responses[action]  # type: ignore[method-assign]

        recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(
            recalled,
            (
                "第一条结构化记忆",
                "第二条摘要",
                "第三条纯文本",
                "第四条文本",
                "第五条",
            ),
        )

    def test_recall_logs_duration_and_failed_action(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.observable")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = True
        backend = OmbreMCPMemoryBackend(config=self.config, logger=logger)

        backend._official_client.call = lambda action, payload: OmbreCallResult(  # type: ignore[method-assign]
            ok=False,
            payload={"error": "boom"},
        )

        with self.assertLogs("personal_agent.tests.ombre_mcp.observable", level="INFO") as captured:
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled, ())
        log_text = "\n".join(captured.output)
        self.assertIn("ombre recall action=ombre_recall_search ok=False", log_text)
        self.assertIn("error=call_not_ok", log_text)
        self.assertIn("duration_seconds=", log_text)

    def test_http_backend_calls_only_local_recall_tool(self) -> None:
        calls: list[tuple[str, str, dict[str, object]]] = []

        def fake_urlopen(request, timeout):
            del timeout
            payload = json.loads(request.data.decode("utf-8"))
            name = payload["params"]["name"]
            calls.append((request.full_url, name, payload["params"]["arguments"]))
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {
                        "isError": False,
                        "structuredContent": {"items": [{"path": "memory.md", "excerpt": f"official {name}"}]},
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(
                                    {"items": [{"path": "memory.md", "excerpt": f"official {name}"}]},
                                    ensure_ascii=False,
                                ),
                            }
                        ]
                    },
                }
            ).encode("utf-8")
            return response

        config = AppConfig(
            base_dir=Path(self.temp_dir.name),
            data_dir=Path(self.temp_dir.name) / "data",
            logs_dir=Path(self.temp_dir.name) / "logs",
            vault_dir=Path(self.temp_dir.name) / "vault",
            database_path=Path(self.temp_dir.name) / "data" / "personal_agent.db",
            log_file_path=Path(self.temp_dir.name) / "logs" / "personal_agent.log",
            ombre_backend="recall_only",
            ombre_mcp_url="http://127.0.0.1:18002/mcp",
        )
        backend = OmbreMCPMemoryBackend(config=config, logger=self.logger)

        with patch("personal_agent.ombre_mcp.urlopen", side_effect=fake_urlopen):
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(
            recalled,
            ("official ombre_recall_search",),
        )
        self.assertEqual(
            calls,
            [
                (
                    "http://127.0.0.1:18002/mcp",
                    "ombre_recall_search",
                    {"query": "测试", "limit": 5},
                ),
            ],
        )

    def test_json_rpc_error_is_observed_as_failure_not_empty_recall(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.rpc_error")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = True
        backend = OmbreMCPMemoryBackend(config=self.config, logger=logger)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "ran-agent-ombre_recall_search-test",
                "error": {"code": -32002, "message": "Ombre recall failed closed"},
            }
        ).encode("utf-8")

        with (
            patch("personal_agent.ombre_mcp.uuid.uuid4", return_value=MagicMock(hex="test")),
            patch("personal_agent.ombre_mcp.urlopen", return_value=response),
            self.assertLogs("personal_agent.tests.ombre_mcp.rpc_error", level="INFO") as captured,
        ):
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled, ())
        log_text = "\n".join(captured.output)
        self.assertIn("ok=False", log_text)
        self.assertIn("error=rpc_error:-32002", log_text)

    def test_truncated_http_response_is_observed_as_transport_failure(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.truncated_response")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = True
        backend = OmbreMCPMemoryBackend(config=self.config, logger=logger)
        response = MagicMock()
        response.__enter__.return_value.read.side_effect = IncompleteRead(b"{", 20)

        with (
            patch("personal_agent.ombre_mcp.urlopen", return_value=response),
            self.assertLogs("personal_agent.tests.ombre_mcp.truncated_response", level="INFO") as captured,
        ):
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled, ())
        log_text = "\n".join(captured.output)
        self.assertIn("outcome=failed", log_text)
        self.assertIn("error=transport_unavailable", log_text)

    def test_http_response_fails_closed_on_uncorrelated_or_noncanonical_results(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.invalid_response")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = True
        backend = OmbreMCPMemoryBackend(config=self.config, logger=logger)
        invalid_responses = {
            "wrong id": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "wrong-call",
                    "result": {"isError": False, "structuredContent": {"items": [{"content": "inject"}]}},
                }
            ),
            "bare payload": json.dumps({"items": []}),
            "tool error": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "result": {"isError": True, "structuredContent": {"items": []}},
                }
            ),
            "plain content": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "result": {"isError": False, "content": [{"type": "text", "text": "downstream failed"}]},
                }
            ),
            "event stream": 'data: {"jsonrpc":"2.0"}\n\n',
            "blank item": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "result": {"isError": False, "structuredContent": {"items": [""]}},
                }
            ),
            "foreign item shape": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "result": {"isError": False, "structuredContent": {"items": [{"message": "FOREIGN_INJECTION"}]}},
                }
            ),
            "too many items": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "result": {
                        "isError": False,
                        "structuredContent": {
                            "items": [{"path": f"{index}.md", "excerpt": "x"} for index in range(6)]
                        },
                    },
                }
            ),
            "non-object error": json.dumps(
                {"jsonrpc": "2.0", "id": "ran-agent-ombre_recall_search-test", "error": "broken"}
            ),
            "result and error": json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "ran-agent-ombre_recall_search-test",
                    "error": {"code": -32002},
                    "result": {"isError": False, "structuredContent": {"items": []}},
                }
            ),
            "duplicate result": (
                '{"jsonrpc":"2.0","id":"ran-agent-ombre_recall_search-test",'
                '"result":{"isError":true},'
                '"result":{"isError":false,"structuredContent":{"items":[]}}}'
            ),
            "non-standard number": (
                '{"jsonrpc":"2.0","id":"ran-agent-ombre_recall_search-test",'
                '"result":{"isError":false,"structuredContent":{"items":[]},"value":NaN}}'
            ),
            "excessive nesting": '{"x":' + ("[" * 2000) + "0" + ("]" * 2000) + "}",
        }

        for label, raw in invalid_responses.items():
            response = MagicMock()
            response.__enter__.return_value.read.return_value = raw.encode("utf-8")
            with self.subTest(label=label):
                with (
                    patch("personal_agent.ombre_mcp.uuid.uuid4", return_value=MagicMock(hex="test")),
                    patch("personal_agent.ombre_mcp.urlopen", return_value=response),
                    self.assertLogs("personal_agent.tests.ombre_mcp.invalid_response", level="INFO") as captured,
                ):
                    self.assertEqual(backend.recall(user_text="测试", response_mode="chat"), ())
                self.assertIn("outcome=failed", "\n".join(captured.output))

    def test_malformed_success_payload_is_observed_as_failure_not_empty_recall(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.invalid_payload")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = True
        backend = OmbreMCPMemoryBackend(config=self.config, logger=logger)
        backend._official_client.call = lambda action, payload: OmbreCallResult(  # type: ignore[method-assign]
            ok=True,
            payload={"unexpected": "shape"},
        )

        with self.assertLogs("personal_agent.tests.ombre_mcp.invalid_payload", level="INFO") as captured:
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled, ())
        log_text = "\n".join(captured.output)
        self.assertIn("outcome=failed", log_text)
        self.assertIn("error=payload_items_invalid", log_text)

    def test_real_python_http_node_chain_distinguishes_hit_empty_and_failure(self) -> None:
        node = self._node_22()
        base_dir = Path(self.temp_dir.name)
        bucket = base_dir / "synthetic-bucket"
        bucket.mkdir()
        (bucket / "safe.md").write_text(
            "The Empress remembers synthetic jasmine tea.",
            encoding="utf-8",
        )
        outside = base_dir / "outside-private.md"
        outside.write_text(
            "fake phone 13800138000; fake secret SYNTHETIC_SECRET_DO_NOT_LEAK",
            encoding="utf-8",
        )
        (bucket / "private.md").symlink_to(outside)
        port = self._free_loopback_port()
        root_dir = Path(__file__).resolve().parents[1]
        process = subprocess.Popen(
            [node, str(root_dir / "node_bridge" / "src" / "ombreRecallMcpServer.mjs")],
            cwd=root_dir,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "OMBRE_BUCKETS_DIR": str(bucket),
                "OMBRE_RECALL_BIND_HOST": "127.0.0.1",
                "OMBRE_RECALL_PORT": str(port),
            },
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            self._wait_for_listener(process, port)
            backend = OmbreMCPMemoryBackend(
                config=replace(self.config, ombre_mcp_url=f"http://127.0.0.1:{port}/mcp"),
                logger=self.logger,
            )

            self.assertEqual(
                backend.recall(user_text="synthetic jasmine", response_mode="chat"),
                ("The Empress remembers synthetic jasmine tea.",),
            )
            with self.assertLogs("personal_agent.tests.ombre_mcp", level="INFO") as captured:
                for private_query in ("13800138000", "SYNTHETIC_SECRET_DO_NOT_LEAK"):
                    self.assertEqual(backend.recall(user_text=private_query, response_mode="chat"), ())
            self.assertIn("outcome=empty", "\n".join(captured.output))
        finally:
            process.terminate()
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()

        with self.assertLogs("personal_agent.tests.ombre_mcp", level="INFO") as captured:
            unavailable_recall = backend.recall(user_text="synthetic jasmine", response_mode="chat")
        self.assertEqual(unavailable_recall, ())
        log_text = "\n".join(captured.output)
        self.assertIn("outcome=failed", log_text)
        self.assertIn("error=transport_unavailable", log_text)

    def test_ombre_store_methods_are_fail_closed_in_o1(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)
        backend._official_client.call = MagicMock(side_effect=AssertionError("must not call"))  # type: ignore[method-assign]

        self.assertEqual(backend.store_long_term({"content": "x"}).action, "skip")
        self.assertEqual(backend.store_core({"content": "x"}).action, "skip")
        backend._official_client.call.assert_not_called()

    def test_legacy_backend_value_maps_to_recall_only_and_unknown_mode_fails_closed(self) -> None:
        logger = logging.getLogger("personal_agent.tests.ombre_mcp.legacy_mode")
        logger.handlers.clear()
        logger.setLevel(logging.WARNING)
        logger.propagate = True
        with self.assertLogs("personal_agent.tests.ombre_mcp.legacy_mode", level="WARNING") as captured:
            backend = OmbreMCPMemoryBackend(
                config=replace(self.config, ombre_backend="official_with_legacy_fallback"),
                logger=logger,
            )
        self.assertIsInstance(backend, OmbreMCPMemoryBackend)
        self.assertIn("mapped to recall_only", "\n".join(captured.output))
        with self.assertRaisesRegex(ValueError, "only recall_only is authorized"):
            OmbreMCPMemoryBackend(config=replace(self.config, ombre_backend="legacy"), logger=self.logger)


if __name__ == "__main__":
    unittest.main()
