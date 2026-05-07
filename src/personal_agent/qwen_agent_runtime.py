"""Qwen-driven chat runtime that centralizes front-end tool and multimodal execution."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from personal_agent.interfaces.model import ModelClient, ModelRequest, ModelResponse
from personal_agent.tool_registry import ToolRegistry


@dataclass(frozen=True)
class LocalInspectionResult:
    """Structured local inspection output for inspect-more decisions."""

    tool_name: str
    payload: dict[str, object]


class QwenAgentRuntime:
    """Repository-local Qwen runtime used as the chat-side ReAct execution layer."""

    def __init__(
        self,
        *,
        chat_model_client: ModelClient,
        tool_model_client: ModelClient | None,
        tool_registry: ToolRegistry,
        logger: logging.Logger,
    ) -> None:
        self._chat_model_client = chat_model_client
        self._tool_model_client = tool_model_client or chat_model_client
        self._tool_registry = tool_registry
        self._logger = logger

    def run_turn(
        self,
        *,
        request: ModelRequest,
        route: str,
        response_mode: str,
    ) -> ModelResponse:
        """Run one front-end turn through the fixed Qwen chat runtime."""

        if route in {"web_search", "vision_understand"}:
            self._logger.info(
                "qwen agent runtime turn route=%s mode=%s continue=%s",
                route,
                response_mode,
                False,
            )
            return self._tool_model_client.generate_reply(request)

        self._logger.info(
            "qwen agent runtime turn route=%s mode=%s continue=%s",
            route,
            response_mode,
            False,
        )
        return self._chat_model_client.generate_reply(request)

    def inspect_local_context(
        self,
        *,
        channel: str,
        user_text: str,
    ) -> tuple[LocalInspectionResult, ...]:
        """Inspect only local continuity, memory, preference, and lifecycle state."""

        inspections = (
            LocalInspectionResult(
                tool_name="get_recent_session_support",
                payload=self._tool_registry.call("get_recent_session_support", channel=channel),
            ),
            LocalInspectionResult(
                tool_name="inspect_local_memory",
                payload=self._tool_registry.call("inspect_local_memory", user_text=user_text),
            ),
            LocalInspectionResult(
                tool_name="get_preference_profile",
                payload=self._tool_registry.call("get_preference_profile"),
            ),
            LocalInspectionResult(
                tool_name="get_agent_internal_state",
                payload=self._tool_registry.call("get_agent_internal_state"),
            ),
            LocalInspectionResult(
                tool_name="get_knowledge_state",
                payload=self._tool_registry.call("get_knowledge_state"),
            ),
        )
        self._logger.info(
            "qwen agent runtime local inspection tools=%s",
            ",".join(item.tool_name for item in inspections),
        )
        return inspections
