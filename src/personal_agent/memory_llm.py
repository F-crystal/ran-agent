"""LLM-backed memory extraction with strict JSON validation and safe fallback."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from personal_agent.config import AppConfig
from personal_agent.interfaces.model import ModelClient, ModelRequest


ALLOWED_MEMORY_DECISIONS = {"working", "profile", "skip"}
ALLOWED_MEMORY_LAYERS = {"working", "profile"}


@dataclass(frozen=True)
class MemoryExtractionResult:
    """Represents one LLM extraction outcome and whether fallback is needed."""

    decision: str
    memory: dict[str, Any] | None
    source: str
    should_fallback: bool = False


class LLMMemoryExtractor:
    """Runs a constrained model call that decides whether and how to store memory."""

    def __init__(
        self,
        model_client: ModelClient,
        logger: logging.Logger,
        config: AppConfig,
    ) -> None:
        self._model_client = model_client
        self._logger = logger
        self._config = config

    def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
        """Return a validated memory decision or request rule-based fallback."""

        if not self._config.memory_llm_enabled:
            return MemoryExtractionResult(
                decision="skip",
                memory=None,
                source="disabled",
                should_fallback=True,
            )

        payload_request = ModelRequest(
            system_prompt=self._build_system_prompt(),
            user_message=self._build_user_prompt(
                user_text=user_text,
                recent_history=recent_history[-self._config.memory_llm_history_limit :],
            ),
        )

        response = self._model_client.generate_reply(payload_request)
        if response.is_error:
            self._logger.warning(
                "llm memory extraction failed provider=%s reason=model_error",
                response.provider,
            )
            return MemoryExtractionResult(
                decision="skip",
                memory=None,
                source=response.provider,
                should_fallback=True,
            )

        parsed = self._parse_response_text(response.text)
        if parsed is None:
            self._logger.warning(
                "llm memory extraction returned invalid json provider=%s",
                response.provider,
            )
            return MemoryExtractionResult(
                decision="skip",
                memory=None,
                source=response.provider,
                should_fallback=True,
            )

        validated = self._validate_result(parsed)
        if validated is None:
            self._logger.warning(
                "llm memory extraction returned invalid schema provider=%s",
                response.provider,
            )
            return MemoryExtractionResult(
                decision="skip",
                memory=None,
                source=response.provider,
                should_fallback=True,
            )

        self._logger.info(
            "llm memory extraction finished provider=%s decision=%s",
            response.provider,
            validated.decision,
        )
        return validated

    def _build_system_prompt(self) -> str:
        return (
            f"{self._config.memory_policy_prompt.strip()}\n\n"
            "你必须只输出一个 JSON 对象，不要输出 Markdown，不要解释。"
        )

    def _build_user_prompt(self, user_text: str, recent_history: list[str]) -> str:
        history_lines = "\n".join(
            f"- {line.strip()}" for line in recent_history if line.strip()
        ) or "- 无"
        return (
            "[当前用户消息]\n"
            f"{user_text.strip()}\n\n"
            "[近期用户消息]\n"
            f"{history_lines}\n\n"
            "[输出要求]\n"
            '返回 {"decision":"working|profile|skip","memory":{...}}。\n'
            "如果 decision 为 skip，memory 可以为 null。\n"
            "memory 必须包含 layer、type、category、topic、summary、evidence、confidence、ttl_days。"
        )

    def _parse_response_text(self, response_text: str) -> dict[str, Any] | None:
        normalized = response_text.strip()
        if not normalized:
            return None

        if normalized.startswith("```"):
            normalized = normalized.strip("`").strip()
            if normalized.lower().startswith("json"):
                normalized = normalized[4:].strip()

        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed, dict):
            return None
        return parsed

    def _validate_result(self, payload: dict[str, Any]) -> MemoryExtractionResult | None:
        decision = str(payload.get("decision", "")).strip().lower()
        if decision not in ALLOWED_MEMORY_DECISIONS:
            return None
        if decision == "skip":
            return MemoryExtractionResult(
                decision="skip",
                memory=None,
                source="llm",
                should_fallback=False,
            )

        raw_memory = payload.get("memory")
        if not isinstance(raw_memory, dict):
            return None

        layer = str(raw_memory.get("layer", raw_memory.get("type", ""))).strip().lower()
        memory_type = str(raw_memory.get("type", layer)).strip().lower()
        if layer not in ALLOWED_MEMORY_LAYERS or memory_type not in ALLOWED_MEMORY_LAYERS:
            return None
        if layer != decision or memory_type != decision:
            return None

        summary = _normalize_text_field(raw_memory.get("summary"), max_length=80)
        evidence = _normalize_text_field(raw_memory.get("evidence"), max_length=120)
        category = _normalize_text_field(raw_memory.get("category"), max_length=24)
        topic = _normalize_text_field(raw_memory.get("topic"), max_length=24)
        if not summary or not evidence or not category:
            return None

        normalized_memory: dict[str, Any] = {
            "type": memory_type,
            "layer": layer,
            "category": category,
            "topic": topic,
            "summary": summary,
            "evidence": evidence,
            "confidence": _normalize_confidence(raw_memory.get("confidence")),
            "ttl_days": _normalize_ttl_days(raw_memory.get("ttl_days"), layer),
        }

        for optional_key in ("trait", "state", "time_scope"):
            optional_value = _normalize_text_field(raw_memory.get(optional_key), max_length=32)
            if optional_value:
                normalized_memory[optional_key] = optional_value

        return MemoryExtractionResult(
            decision=decision,
            memory=normalized_memory,
            source="llm",
            should_fallback=False,
        )


def _normalize_text_field(value: Any, max_length: int) -> str:
    normalized = " ".join(str(value or "").split()).strip()
    if not normalized:
        return ""
    return normalized[:max_length]


def _normalize_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, round(confidence, 2)))


def _normalize_ttl_days(value: Any, layer: str) -> int:
    default_days = 7 if layer == "working" else 90
    try:
        ttl_days = int(value)
    except (TypeError, ValueError):
        return default_days
    return max(1, min(365, ttl_days))
