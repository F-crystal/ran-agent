#!/usr/bin/env python3
"""No-network proof of the installed Hermes DeepSeek provider boundary."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from openai import OpenAI


def _fail(message: str) -> None:
    raise SystemExit(f"hermes-provider-boundary-self-check: failed:{message}")


def _normalized_gateway_input() -> dict[str, Any]:
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter

    hostile = {
        "model": "deepseek-v4-pro",
        "messages": [
            {"role": "user", "content": "prior normalized turn"},
            {"role": "assistant", "content": "prior normalized reply"},
            {"role": "user", "content": "use the registered tool"},
        ],
        "stream": False,
        "thinking": {"type": "enabled"},
        "reasoning": {"enabled": True},
        "reasoning_config": {"enabled": True, "effort": "max"},
    }

    class Request:
        headers: dict[str, str] = {}

        async def json(self) -> dict[str, Any]:
            return hostile

    adapter = APIServerAdapter(PlatformConfig(enabled=True))
    captured: dict[str, Any] = {}

    async def capture_agent(**kwargs: Any) -> tuple[dict[str, Any], dict[str, int]]:
        captured.update(kwargs)
        return {"final_response": "{}", "completed": True}, {}

    adapter._run_agent = capture_agent  # type: ignore[method-assign]
    asyncio.run(adapter._handle_chat_completions(Request()))
    if {"thinking", "reasoning", "reasoning_config"}.intersection(captured):
        _fail("gateway_forwarded_user_reasoning_policy")
    if captured.get("user_message") != "use the registered tool":
        _fail("gateway_handler_not_exercised")
    if captured.get("conversation_history") != hostile["messages"][:-1]:
        _fail("gateway_history_not_normalized")
    return captured


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-home", required=True)
    parser.add_argument("--mode", required=True, choices=("lite", "full"))
    parser.add_argument("--model", default="deepseek-v4-pro")
    args = parser.parse_args()

    home = Path(args.hermes_home).resolve()
    expected_plugin = home / "plugins/model-providers/deepseek/__init__.py"
    if not expected_plugin.is_file():
        _fail("installed_plugin_missing")
    if os.environ.get("HERMES_HOME") != str(home):
        _fail("HERMES_HOME_mismatch")
    if os.environ.get("HERMES_DEEPSEEK_THINKING_MODE", "disabled") != "disabled":
        _fail("thinking_policy_not_disabled")

    from agent.transports.chat_completions import ChatCompletionsTransport
    from hermes_cli.runtime_provider import resolve_requested_provider
    from providers import get_provider_profile

    if resolve_requested_provider(
        requested=os.environ.get("HERMES_INFERENCE_PROVIDER")
    ) != "deepseek":
        _fail("runtime_provider_not_deepseek")
    profile = get_provider_profile("deepseek")
    if profile is None:
        _fail("deepseek_profile_not_registered")
    module = sys.modules.get(profile.__class__.__module__)
    if Path(getattr(module, "__file__", "")).resolve() != expected_plugin:
        _fail("user_plugin_not_selected")

    normalized = _normalized_gateway_input()
    messages = list(normalized.get("conversation_history") or [])
    messages.append({"role": "user", "content": normalized["user_message"]})
    tools = [{
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "local provider-boundary diagnostic",
            "parameters": {"type": "object", "properties": {}},
        },
    }]
    kwargs = ChatCompletionsTransport().build_kwargs(
        model=args.model,
        messages=messages,
        tools=tools,
        provider_profile=profile,
        reasoning_config={"enabled": True, "effort": "max"},
        session_id=f"provider-boundary-self-check-{args.mode}",
    )

    captured: dict[str, Any] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={
            "id": f"local-provider-boundary-self-check-{args.mode}",
            "object": "chat.completion",
            "created": 0,
            "model": args.model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "{}"},
                "finish_reason": "stop",
            }],
        })

    with httpx.Client(transport=httpx.MockTransport(capture)) as http_client:
        OpenAI(
            api_key="local-redacted-stub",
            base_url="http://provider-boundary.invalid/v1",
            http_client=http_client,
        ).chat.completions.create(**kwargs)

    expected = {
        "model": args.model,
        "messages": messages,
        "tools": tools,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
    }
    for key, value in expected.items():
        if captured.get(key) != value:
            _fail(f"{key}_missing")
    for forbidden_key in ("reasoning", "reasoning_config"):
        if forbidden_key in captured:
            _fail(f"hostile_{forbidden_key}_present")
    if "reasoning_content" in json.dumps(captured):
        _fail("reasoning_content_present")

    print(
        "hermes-provider-boundary-self-check: ok "
        f"mode={args.mode} provider=deepseek model={args.model} thinking=disabled "
        "tools=present response_format=json_object transport=mock adapter_normalized=yes"
    )


if __name__ == "__main__":
    main()
