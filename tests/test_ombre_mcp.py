"""Tests for the Ombre MCP client adapter."""

from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.ombre_mcp import OmbreCallResult, OmbreMCPClient, OmbreMCPMemoryBackend


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated Ombre adapter tests."""

    logger = logging.getLogger("personal_agent.tests.ombre_mcp")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class OmbreMCPTest(unittest.TestCase):
    """Covers subprocess command resolution and structured recall parsing."""

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
            ombre_mcp_command=str(base_dir / "src" / "personal_agent" / "ombre_brain_mcp.py"),
        )
        self.logger = build_test_logger()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_client_uses_python_interpreter_for_script_commands(self) -> None:
        client = OmbreMCPClient(self.config, self.logger)

        argv = client._build_argv("breath")

        self.assertEqual(argv, [sys.executable, self.config.ombre_mcp_command, "breath"])

    def test_recall_accepts_structured_items_and_legacy_payload_keys(self) -> None:
        backend = OmbreMCPMemoryBackend(config=self.config, logger=self.logger)

        responses = {
            "breath": OmbreCallResult(
                ok=True,
                payload={
                    "items": [
                        {"content": "第一条结构化记忆", "tags": ["a"]},
                        {"summary": "第二条摘要"},
                        "第三条纯文本",
                    ]
                },
            ),
            "trace": OmbreCallResult(
                ok=True,
                payload={
                    "memories": [
                        {"memory": "第二条摘要"},
                        {"text": "第四条文本"},
                    ]
                },
            ),
            "pulse": OmbreCallResult(ok=True, payload={"results": [{"content": "第五条"}]}),
        }

        backend._client.call = lambda action, payload: responses[action]  # type: ignore[method-assign]

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

        responses = {
            "breath": OmbreCallResult(ok=False, payload={"error": "boom"}),
            "trace": OmbreCallResult(ok=True, payload={"items": ["trace memory"]}),
            "pulse": OmbreCallResult(ok=True, payload={"items": []}),
        }
        backend._client.call = lambda action, payload: responses[action]  # type: ignore[method-assign]

        with self.assertLogs("personal_agent.tests.ombre_mcp.observable", level="INFO") as captured:
            recalled = backend.recall(user_text="测试", response_mode="chat")

        self.assertEqual(recalled, ("trace memory",))
        log_text = "\n".join(captured.output)
        self.assertIn("ombre recall action=breath ok=False", log_text)
        self.assertIn("error=call_not_ok", log_text)
        self.assertIn("duration_seconds=", log_text)


if __name__ == "__main__":
    unittest.main()
