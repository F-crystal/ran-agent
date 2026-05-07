"""Unit tests for backend runtime model-client selection."""

from __future__ import annotations

import logging
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.interfaces.model import OpenClawChatCompletionsModelClient, QwenResponsesModelClient
from personal_agent.runtime import build_chat_model_client, build_tool_model_client


def build_test_logger() -> logging.Logger:
    logger = logging.getLogger("personal_agent.tests.runtime")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class RuntimeModelClientSelectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.logger = build_test_logger()
        self.base_config = AppConfig(
            base_dir=Path("."),
            data_dir=Path("./data"),
            logs_dir=Path("./logs"),
            vault_dir=Path("./vault"),
            database_path=Path("./data/personal_agent.db"),
            log_file_path=Path("./logs/personal_agent.log"),
        )

    def test_build_chat_model_client_uses_openclaw_gateway_by_default(self) -> None:
        client = build_chat_model_client(self.base_config, self.logger)

        self.assertIsInstance(client, OpenClawChatCompletionsModelClient)

    def test_build_tool_model_client_uses_openclaw_gateway_by_default(self) -> None:
        client = build_tool_model_client(self.base_config, self.logger)

        self.assertIsInstance(client, OpenClawChatCompletionsModelClient)

    def test_build_chat_model_client_uses_qwen_when_explicitly_enabled(self) -> None:
        config = AppConfig(**{**self.base_config.__dict__, "backend_qwen_enabled": True})

        client = build_chat_model_client(config, self.logger)

        self.assertIsInstance(client, QwenResponsesModelClient)

    def test_build_tool_model_client_uses_qwen_when_explicitly_enabled(self) -> None:
        config = AppConfig(**{**self.base_config.__dict__, "backend_qwen_enabled": True})

        client = build_tool_model_client(config, self.logger)

        self.assertIsInstance(client, QwenResponsesModelClient)


if __name__ == "__main__":
    unittest.main()
