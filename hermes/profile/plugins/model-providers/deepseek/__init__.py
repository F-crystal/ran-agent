"""DeepSeek provider policy for ran-agent daily conversation."""

from __future__ import annotations

import os
from typing import Any, Literal

from providers import ProviderProfile, register_provider


def _thinking_mode() -> Literal["disabled"]:
    mode = os.getenv("HERMES_DEEPSEEK_THINKING_MODE", "disabled").strip().lower()
    if mode != "disabled":
        raise ValueError("HERMES_DEEPSEEK_THINKING_MODE must be disabled")
    return "disabled"


class RanAgentDeepSeekProfile(ProviderProfile):
    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict[str, Any] | None = None,
        **_context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        del reasoning_config
        _thinking_mode()
        return {
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
        }, {}


register_provider(RanAgentDeepSeekProfile(
    name="deepseek",
    aliases=("deepseek-chat",),
    env_vars=("DEEPSEEK_API_KEY",),
    display_name="DeepSeek",
    description="DeepSeek — native API with ran-agent non-thinking policy",
    signup_url="https://platform.deepseek.com/",
    fallback_models=("deepseek-v4-pro",),
    base_url="https://api.deepseek.com/v1",
))
