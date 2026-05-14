"""Model client interface reserved for future Codex/API integration."""

from __future__ import annotations

import json
import logging
import os
import socket
import urllib.error
import urllib.request
import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ModelResponse:
    """Minimal response shape for future model calls."""

    text: str
    provider: str = "unknown"
    is_error: bool = False


@dataclass(frozen=True)
class ModelRequest:
    """Structured model input with room for future memory-related context."""

    system_prompt: str
    user_message: str
    memory_context: str = ""
    daily_context: str = ""
    reflection_context: str = ""
    image_urls: tuple[str, ...] = ()
    tool_name: str = ""

    def build_user_prompt(self) -> str:
        """Build the user-visible prompt with minimal future context sections."""

        sections: list[str] = []
        if self.daily_context.strip():
            sections.append(f"[当日状态]\n{self.daily_context.strip()}")
        if self.reflection_context.strip():
            sections.append(f"[夜间总结]\n{self.reflection_context.strip()}")

        sections.append(f"[用户消息]\n{self.user_message.strip()}")
        return "\n\n".join(sections)


class ModelClient(Protocol):
    """Defines the contract for sending prompts to a model backend."""

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        """Return a model reply for the given prompt."""


class PlaceholderModelClient:
    """Minimal local placeholder client for message-loop validation."""

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        cleaned_prompt = " ".join(request.user_message.strip().split())
        if not cleaned_prompt:
            reply_text = "我在这里。你可以再多说一点。"
        else:
            preview = cleaned_prompt[:60]
            reply_text = f"收到。这是本地占位回复：{preview}"

        return ModelResponse(text=reply_text, provider="placeholder")


class QwenResponsesModelClient:
    """Minimal Qwen Responses client for web search and multimodal understanding."""

    def __init__(
        self,
        api_key_env_var: str,
        model: str,
        base_url: str,
        timeout_seconds: int,
        logger: logging.Logger,
    ) -> None:
        self._api_key_env_var = api_key_env_var
        self._model = model
        self._base_url = base_url
        self._timeout_seconds = timeout_seconds
        self._logger = logger

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        """Call the Qwen Responses API for tool use or multimodal requests."""

        api_key = os.getenv(self._api_key_env_var, "").strip()
        if not api_key:
            self._logger.error("qwen api key is missing env_var=%s", self._api_key_env_var)
            return ModelResponse(
                text=(
                    "模型服务暂时不可用：未设置 Qwen API key。"
                    f"请检查环境变量 {self._api_key_env_var}。"
                ),
                provider="qwen",
                is_error=True,
            )

        payload = {
            "model": self._model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": request.system_prompt,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": self._build_user_content(request),
                },
            ],
        }
        tools = self._build_tools(request)
        if tools:
            payload["tools"] = tools

        request_url = self._build_request_url()
        self._logger.info("qwen request url=%s tool=%s", request_url, request.tool_name or "none")
        request_obj = urllib.request.Request(
            url=request_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request_obj, timeout=self._timeout_seconds) as response:
                response_data = json.loads(response.read().decode("utf-8"))
        except TimeoutError:
            self._logger.warning(
                "qwen request timed out (expected behavior) timeout_seconds=%s url=%s",
                self._timeout_seconds,
                request_url,
            )
            return ModelResponse(
                text=f"模型服务暂时不可用：Qwen 请求超时（{self._timeout_seconds}s），请稍后再试。",
                provider="qwen",
                is_error=True,
            )
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            self._logger.exception(
                "qwen request failed http_status=%s body=%s",
                exc.code,
                error_body,
            )
            return ModelResponse(
                text="模型服务暂时不可用：Qwen 接口返回错误，请稍后再试。",
                provider="qwen",
                is_error=True,
            )
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, (TimeoutError, socket.timeout)):
                self._logger.warning(
                    "qwen request timed out via urlerror (expected behavior) timeout_seconds=%s url=%s",
                    self._timeout_seconds,
                    request_url,
                )
                return ModelResponse(
                    text=f"模型服务暂时不可用：Qwen 请求超时（{self._timeout_seconds}s），请稍后再试。",
                    provider="qwen",
                    is_error=True,
                )
            self._logger.exception("qwen request failed due to network error")
            return ModelResponse(
                text="模型服务暂时不可用：连接 Qwen 失败，请稍后再试。",
                provider="qwen",
                is_error=True,
            )
        except Exception:
            self._logger.exception("qwen request failed unexpectedly")
            return ModelResponse(
                text="模型服务暂时不可用：Qwen 请求过程中出现异常，请稍后再试。",
                provider="qwen",
                is_error=True,
            )

        output_text = self._extract_output_text(response_data)
        if not output_text:
            self._logger.error("qwen response did not contain text output")
            return ModelResponse(
                text="模型服务暂时不可用：Qwen 未返回可读文本。",
                provider="qwen",
                is_error=True,
            )

        return ModelResponse(text=output_text, provider="qwen", is_error=False)

    def _build_user_content(self, request: ModelRequest) -> list[dict[str, str]]:
        content: list[dict[str, str]] = []
        user_prompt = request.build_user_prompt().strip()
        if user_prompt:
            content.append({"type": "input_text", "text": user_prompt})
        for image_url in request.image_urls:
            image_input = self._build_image_input(image_url)
            if image_input:
                content.append(image_input)
        return content

    def _build_tools(self, request: ModelRequest) -> list[dict[str, str]]:
        if request.tool_name == "web_search":
            return [{"type": "web_search"}]
        return []

    def _build_image_input(self, image_ref: str) -> dict[str, str] | None:
        cleaned_ref = image_ref.strip()
        if not cleaned_ref:
            return None
        if cleaned_ref.startswith(("http://", "https://", "data:")):
            return {"type": "input_image", "image_url": cleaned_ref}
        if cleaned_ref.startswith("file://"):
            cleaned_ref = cleaned_ref[7:]

        local_path = Path(cleaned_ref).expanduser()
        if local_path.exists() and local_path.is_file():
            data_url = self._encode_local_image_as_data_url(local_path)
            if data_url:
                return {"type": "input_image", "image_url": data_url}
            self._logger.warning("qwen image input ignored path=%s reason=encode_failed", local_path)
            return None

        return {"type": "input_image", "image_url": cleaned_ref}

    def _encode_local_image_as_data_url(self, local_path: Path) -> str | None:
        try:
            file_bytes = local_path.read_bytes()
        except OSError:
            self._logger.exception("failed to read local image path=%s", local_path)
            return None
        file_size = len(file_bytes)
        mime_type = _detect_image_mime_type(local_path, file_bytes)
        self._logger.info(
            "qwen image file inspected path=%s exists=%s size=%s detected_type=%s",
            local_path,
            local_path.exists(),
            file_size,
            mime_type or "unknown",
        )
        if not mime_type:
            self._logger.warning(
                "qwen image file rejected path=%s exists=%s size=%s reason=unsupported_image_type",
                local_path,
                local_path.exists(),
                file_size,
            )
            return None

        encoded = base64.b64encode(file_bytes).decode("ascii")
        self._logger.info(
            "qwen image file encoded path=%s size=%s detected_type=%s success=%s",
            local_path,
            file_size,
            mime_type,
            True,
        )
        return f"data:{mime_type};base64,{encoded}"

    def _extract_output_text(self, response_data: dict) -> str:
        output_text = response_data.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()

        output = response_data.get("output", [])
        for item in output:
            if item.get("type") != "message":
                continue
            for content in item.get("content", []):
                text = content.get("text")
                if isinstance(text, str) and text.strip():
                    return text.strip()
        return ""

    def _build_request_url(self) -> str:
        normalized = self._base_url.strip()
        if not normalized:
            return "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
        normalized = normalized.rstrip("/")
        if normalized.endswith("/responses"):
            return normalized
        return f"{normalized}/responses"


class HermesChatCompletionsModelClient:
    """Hermes Gateway chat-completions client for backend model calls."""

    def __init__(
        self,
        base_url: str,
        api_key_env_var: str,
        model: str,
        timeout_seconds: int,
        logger: logging.Logger,
    ) -> None:
        self._base_url = base_url
        self._api_key_env_var = api_key_env_var
        self._model = model
        self._timeout_seconds = timeout_seconds
        self._logger = logger

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        api_key = os.getenv(self._api_key_env_var, "").strip()
        if not api_key:
            # Fallback to API_SERVER_KEY
            api_key = os.getenv("API_SERVER_KEY", "").strip()
        if not api_key:
            self._logger.error("hermes api key missing env_var=%s", self._api_key_env_var)
            return ModelResponse(
                text=f"模型服务暂时不可用：未设置 Hermes API key（{self._api_key_env_var}）。",
                provider="hermes",
                is_error=True,
            )

        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.build_user_prompt()},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        request_url = self._build_request_url()
        self._logger.info(
            "hermes gateway request url=%s model=%s",
            request_url,
            self._model,
        )
        request_obj = urllib.request.Request(
            url=request_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request_obj, timeout=self._timeout_seconds) as response:
                response_data = json.loads(response.read().decode("utf-8"))
        except TimeoutError:
            self._logger.warning(
                "hermes gateway request timed out timeout_seconds=%s url=%s",
                self._timeout_seconds,
                request_url,
            )
            return ModelResponse(
                text=f"模型服务暂时不可用：Hermes Gateway 请求超时（{self._timeout_seconds}s），请稍后再试。",
                provider="hermes",
                is_error=True,
            )
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            self._logger.exception(
                "hermes gateway request failed http_status=%s body=%s",
                exc.code,
                error_body,
            )
            return ModelResponse(
                text="模型服务暂时不可用：Hermes Gateway 返回错误，请稍后再试。",
                provider="hermes",
                is_error=True,
            )
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, (TimeoutError, socket.timeout)):
                self._logger.warning(
                    "hermes gateway request timed out via urlerror timeout_seconds=%s url=%s",
                    self._timeout_seconds,
                    request_url,
                )
                return ModelResponse(
                    text=f"模型服务暂时不可用：Hermes Gateway 请求超时（{self._timeout_seconds}s），请稍后再试。",
                    provider="hermes",
                    is_error=True,
                )
            self._logger.exception("hermes gateway request failed due to network error")
            return ModelResponse(
                text="模型服务暂时不可用：连接 Hermes Gateway 失败，请稍后再试。",
                provider="hermes",
                is_error=True,
            )
        except Exception:
            self._logger.exception("hermes gateway request failed unexpectedly")
            return ModelResponse(
                text="模型服务暂时不可用：Hermes Gateway 请求过程中出现异常，请稍后再试。",
                provider="hermes",
                is_error=True,
            )

        output_text = self._extract_output_text(response_data)
        if not output_text:
            self._logger.error("hermes gateway response did not contain text output")
            return ModelResponse(
                text="模型服务暂时不可用：Hermes Gateway 未返回可读文本。",
                provider="hermes",
                is_error=True,
            )

        return ModelResponse(text=output_text, provider="hermes", is_error=False)

    def _build_request_url(self) -> str:
        normalized = self._base_url.strip()
        if not normalized:
            return "http://127.0.0.1:8642/v1/chat/completions"
        normalized = normalized.rstrip("/")
        if normalized.endswith("/v1/chat/completions"):
            return normalized
        return f"{normalized}/v1/chat/completions"

    def _extract_output_text(self, response_data: dict) -> str:
        choices = response_data.get("choices", [])
        if not isinstance(choices, list) or not choices:
            return ""
        first = choices[0]
        if not isinstance(first, dict):
            return ""
        message = first.get("message", {})
        if not isinstance(message, dict):
            return ""
        content = message.get("content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            texts = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    texts.append(text.strip())
            return "\n".join(texts).strip()
        return ""


def _detect_image_mime_type(local_path: Path, file_bytes: bytes) -> str:
    guessed_mime_type, _ = mimetypes.guess_type(str(local_path))
    if guessed_mime_type and guessed_mime_type.startswith("image/"):
        return guessed_mime_type

    header = file_bytes[:16]
    if header.startswith(b"\xFF\xD8\xFF"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return ""
