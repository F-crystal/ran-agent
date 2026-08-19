import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts/hermes-provider-response-observer.py"
SPEC = importlib.util.spec_from_file_location("hermes_provider_response_observer", SCRIPT)
assert SPEC and SPEC.loader
OBSERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBSERVER)


def payload(**extra):
    return {
        "hook_event_name": "post_api_request",
        "session_id": "must-not-be-recorded",
        "extra": extra,
    }


def test_nonempty_provider_response_is_not_recorded() -> None:
    assert OBSERVER.build_observation(payload(assistant_content_chars=1)) is None


def test_empty_completion_keeps_only_diagnostic_metadata() -> None:
    source = payload(
        assistant_content_chars=0,
        assistant_tool_call_count=0,
        api_request_id="req-1",
        turn_id="turn-1",
        api_call_count=2,
        provider="deepseek",
        model="deepseek-v4-flash",
        response_model="deepseek-v4-flash",
        finish_reason="stop",
        api_duration=1.234,
        usage={
            "prompt_tokens": 11065,
            "input_tokens": 2065,
            "completion_tokens": 1050,
            "output_tokens": 1050,
            "total_tokens": 12115,
            "reasoning_tokens": 1049,
            "cache_read_tokens": 9000,
            "cache_write_tokens": 0,
            "provider_payload": "must-not-be-recorded",
        },
        response={"content": "must-not-be-recorded"},
        assistant_message="must-not-be-recorded",
        user_message="must-not-be-recorded",
    )

    record = OBSERVER.build_observation(source)

    assert record == {
        "schema": "ran-agent.provider-response.v1",
        "boundary": "hermes_normalized_post_api_request",
        "classification": "empty_completion",
        "api_request_ref": hashlib.sha256(b"req-1").hexdigest()[:16],
        "turn_ref": hashlib.sha256(b"turn-1").hexdigest()[:16],
        "api_call_count": 2,
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "response_model": "deepseek-v4-flash",
        "finish_reason": "stop",
        "content_chars": 0,
        "tool_call_count": 0,
        "input_tokens": 2065,
        "prompt_tokens": 11065,
        "output_tokens": 1050,
        "total_tokens": 12115,
        "reasoning_tokens": 1049,
        "cache_read_tokens": 9000,
        "cache_write_tokens": 0,
        "api_duration_ms": 1234,
    }
    serialized = json.dumps(record)
    assert "must-not-be-recorded" not in serialized
    assert "session_id" not in serialized
    assert "req-1" not in serialized
    assert "turn-1" not in serialized


def test_empty_tool_call_is_classified_as_legitimate_intermediate_state() -> None:
    record = OBSERVER.build_observation(
        payload(assistant_content_chars=0, assistant_tool_call_count=1)
    )
    assert record["classification"] == "empty_content_with_tool_calls"


def test_malformed_or_oversized_input_fails_open_without_output() -> None:
    malformed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input="not-json",
        text=True,
        capture_output=True,
        check=False,
    )
    oversized = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input="x" * (OBSERVER.MAX_STDIN_CHARS + 1),
        text=True,
        capture_output=True,
        check=False,
    )
    assert (malformed.returncode, malformed.stdout, malformed.stderr) == (0, "", "")
    assert (oversized.returncode, oversized.stdout, oversized.stderr) == (0, "", "")
