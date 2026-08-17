"""Unit tests for backend runtime model-client selection."""

from __future__ import annotations

import logging
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from personal_agent.config import AppConfig
from personal_agent.interfaces.model import HermesChatCompletionsModelClient, QwenResponsesModelClient
from personal_agent.runtime import build_runtime, build_tool_model_client


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

    def test_build_tool_model_client_uses_hermes_by_default(self) -> None:
        client = build_tool_model_client(self.base_config, self.logger)

        self.assertIsInstance(client, HermesChatCompletionsModelClient)

    def test_build_tool_model_client_uses_qwen_when_explicitly_enabled(self) -> None:
        config = AppConfig(**{**self.base_config.__dict__, "backend_qwen_enabled": True})

        client = build_tool_model_client(config, self.logger)

        self.assertIsInstance(client, QwenResponsesModelClient)

    def test_runtime_does_not_construct_the_retired_frontend_model_graph(self) -> None:
        service = Mock()
        with (
            patch("personal_agent.runtime.load_config", return_value=self.base_config),
            patch("personal_agent.runtime.configure_logging", return_value=self.logger),
            patch("personal_agent.runtime.Database", return_value=Mock()),
            patch("personal_agent.runtime.build_tool_model_client") as tool_builder,
            patch("personal_agent.runtime.PersonalAgentService", return_value=service) as service_builder,
        ):
            runtime = build_runtime()

        tool_builder.assert_not_called()
        self.assertNotIn("model_client", service_builder.call_args.kwargs)
        self.assertIs(runtime.message_service, service)


if __name__ == "__main__":
    unittest.main()
