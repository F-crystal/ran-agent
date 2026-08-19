#!/usr/bin/env python3
"""Record metadata-only evidence for empty Hermes provider responses."""

from __future__ import annotations

import hashlib
import json
import sys
import syslog
from typing import Any


MAX_STDIN_CHARS = 2_000_000
MAX_TEXT_CHARS = 160


def _bounded_text(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value[:MAX_TEXT_CHARS]


def _opaque_ref(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _nonnegative_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return value


def _usage_count(usage: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = _nonnegative_int(usage.get(key))
        if value is not None:
            return value
    return None


def build_observation(payload: Any) -> dict[str, Any] | None:
    """Return an allowlisted anomaly record, or None for non-empty/invalid input."""
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "post_api_request":
        return None
    extra = payload.get("extra")
    if not isinstance(extra, dict):
        return None

    content_chars = _nonnegative_int(extra.get("assistant_content_chars"))
    if content_chars is None or content_chars > 0:
        return None

    tool_calls = _nonnegative_int(extra.get("assistant_tool_call_count"))
    usage = extra.get("usage") if isinstance(extra.get("usage"), dict) else {}
    duration = _nonnegative_number(extra.get("api_duration"))

    return {
        "schema": "ran-agent.provider-response.v1",
        "boundary": "hermes_normalized_post_api_request",
        "classification": (
            "empty_content_with_tool_calls"
            if tool_calls is not None and tool_calls > 0
            else "empty_completion"
            if tool_calls == 0
            else "empty_content_unknown_tool_state"
        ),
        "api_request_ref": _opaque_ref(extra.get("api_request_id")),
        "turn_ref": _opaque_ref(extra.get("turn_id")),
        "api_call_count": _nonnegative_int(extra.get("api_call_count")),
        "provider": _bounded_text(extra.get("provider")),
        "model": _bounded_text(extra.get("model")),
        "response_model": _bounded_text(extra.get("response_model")),
        "finish_reason": _bounded_text(extra.get("finish_reason")),
        "content_chars": content_chars,
        "tool_call_count": tool_calls,
        "input_tokens": _usage_count(usage, "input_tokens"),
        "prompt_tokens": _usage_count(usage, "prompt_tokens"),
        "output_tokens": _usage_count(usage, "completion_tokens", "output_tokens"),
        "total_tokens": _usage_count(usage, "total_tokens"),
        "reasoning_tokens": _usage_count(usage, "reasoning_tokens"),
        "cache_read_tokens": _usage_count(usage, "cache_read_tokens"),
        "cache_write_tokens": _usage_count(usage, "cache_write_tokens"),
        "api_duration_ms": round(duration * 1000) if duration is not None else None,
    }


def _emit(record: dict[str, Any]) -> None:
    syslog.openlog("ran-agent-provider-response-observer", syslog.LOG_PID, syslog.LOG_USER)
    syslog.syslog(
        syslog.LOG_WARNING,
        json.dumps(record, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
    )


def main() -> int:
    """Fail open: observation must never affect the Hermes agent loop."""
    try:
        raw = sys.stdin.read(MAX_STDIN_CHARS + 1)
        if len(raw) > MAX_STDIN_CHARS:
            return 0
        record = build_observation(json.loads(raw))
        if record is not None:
            _emit(record)
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
