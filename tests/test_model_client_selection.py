"""Unit tests for the Qwen chat/tool runtime clients and request behavior."""

from __future__ import annotations

import logging
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from personal_agent.config import AppConfig
from personal_agent.interfaces.model import (
    ModelRequest,
    HermesChatCompletionsModelClient,
    QwenResponsesModelClient,
)
from personal_agent.runtime import build_chat_model_client, build_tool_model_client


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated model-client tests."""

    logger = logging.getLogger("personal_agent.tests.model_client")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class ModelClientSelectionTest(unittest.TestCase):
    """Covers the fixed Qwen chat/tool runtime and Qwen request helpers."""

    def setUp(self) -> None:
        self.logger = build_test_logger()

    def test_build_chat_model_client_returns_hermes_client_by_default(self) -> None:
        config = AppConfig(
            base_dir=Path("."),
            data_dir=Path("./data"),
            logs_dir=Path("./logs"),
            vault_dir=Path("./vault"),
            database_path=Path("./data/personal_agent.db"),
            log_file_path=Path("./logs/personal_agent.log"),
        )

        client = build_chat_model_client(config, self.logger)

        self.assertIsInstance(client, HermesChatCompletionsModelClient)

    def test_build_tool_model_client_returns_hermes_client_by_default(self) -> None:
        config = AppConfig(
            base_dir=Path("."),
            data_dir=Path("./data"),
            logs_dir=Path("./logs"),
            vault_dir=Path("./vault"),
            database_path=Path("./data/personal_agent.db"),
            log_file_path=Path("./logs/personal_agent.log"),
        )

        client = build_tool_model_client(config, self.logger)

        self.assertIsInstance(client, HermesChatCompletionsModelClient)

    def test_hermes_client_returns_fallback_message_when_token_is_missing(self) -> None:
        client = HermesChatCompletionsModelClient(
            base_url="http://127.0.0.1:8642",
            api_key_env_var="HERMES_API_KEY",
            model="deepseek-v4-flash",
            timeout_seconds=5,
            logger=self.logger,
        )

        with patch.dict(os.environ, {}, clear=True):
            response = client.generate_reply(
                ModelRequest(system_prompt="system", user_message="帮我总结一下今天")
            )

        self.assertTrue(response.is_error)
        self.assertEqual(response.provider, "hermes")
        self.assertIn("未设置 Hermes API key", response.text)

    def test_build_chat_model_client_returns_qwen_client_when_enabled(self) -> None:
        config = AppConfig(
            base_dir=Path("."),
            data_dir=Path("./data"),
            logs_dir=Path("./logs"),
            vault_dir=Path("./vault"),
            database_path=Path("./data/personal_agent.db"),
            log_file_path=Path("./logs/personal_agent.log"),
            backend_qwen_enabled=True,
        )

        client = build_chat_model_client(config, self.logger)

        self.assertIsInstance(client, QwenResponsesModelClient)

    def test_build_tool_model_client_returns_qwen_client_when_enabled(self) -> None:
        config = AppConfig(
            base_dir=Path("."),
            data_dir=Path("./data"),
            logs_dir=Path("./logs"),
            vault_dir=Path("./vault"),
            database_path=Path("./data/personal_agent.db"),
            log_file_path=Path("./logs/personal_agent.log"),
            backend_qwen_enabled=True,
        )

        client = build_tool_model_client(config, self.logger)

        self.assertIsInstance(client, QwenResponsesModelClient)

    def test_qwen_client_returns_fallback_message_when_api_key_is_missing(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )

        with patch.dict(os.environ, {}, clear=True):
            response = client.generate_reply(
                ModelRequest(system_prompt="system", user_message="帮我搜一下今天上海天气", tool_name="web_search")
            )

        self.assertTrue(response.is_error)
        self.assertEqual(response.provider, "qwen")
        self.assertIn("未设置 Qwen API key", response.text)

    def test_qwen_client_converts_local_image_path_to_data_url(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "test.png"
            image_path.write_bytes(
                bytes.fromhex(
                    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
                    "0000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082"
                )
            )

            content = client._build_user_content(
                ModelRequest(
                    system_prompt="system",
                    user_message="帮我看看这张图",
                    image_urls=(str(image_path),),
                )
            )

        image_item = content[1]
        self.assertEqual(image_item["type"], "input_image")
        self.assertTrue(image_item["image_url"].startswith("data:image/png;base64,"))

    def test_qwen_client_detects_png_from_bin_header(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "wechat-image.bin"
            image_path.write_bytes(
                bytes.fromhex(
                    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
                    "0000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082"
                )
            )

            image_input = client._build_image_input(str(image_path))

        assert image_input is not None
        self.assertTrue(image_input["image_url"].startswith("data:image/png;base64,"))

    def test_qwen_client_detects_jpeg_from_bin_header(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "wechat-image.bin"
            image_path.write_bytes(b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00")

            image_input = client._build_image_input(str(image_path))

        assert image_input is not None
        self.assertTrue(image_input["image_url"].startswith("data:image/jpeg;base64,"))

    def test_qwen_client_rejects_non_image_bin_file(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / "not-image.bin"
            file_path.write_bytes(b"not an image file")

            image_input = client._build_image_input(str(file_path))

        self.assertIsNone(image_input)

    def test_qwen_client_returns_timeout_message_when_request_times_out(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )

        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "test-key"}, clear=True):
            with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
                response = client.generate_reply(
                    ModelRequest(system_prompt="system", user_message="hello")
                )

        self.assertTrue(response.is_error)
        self.assertEqual(response.provider, "qwen")
        self.assertIn("请求超时", response.text)

    def test_qwen_client_returns_timeout_message_when_urlerror_wraps_timeout(self) -> None:
        client = QwenResponsesModelClient(
            api_key_env_var="DASHSCOPE_API_KEY",
            model="qwen3.5-plus",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
            timeout_seconds=5,
            logger=self.logger,
        )

        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "test-key"}, clear=True):
            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError(TimeoutError("timed out")),
            ):
                response = client.generate_reply(
                    ModelRequest(system_prompt="system", user_message="hello")
                )

        self.assertTrue(response.is_error)
        self.assertEqual(response.provider, "qwen")
        self.assertIn("请求超时", response.text)

if __name__ == "__main__":
    unittest.main()
