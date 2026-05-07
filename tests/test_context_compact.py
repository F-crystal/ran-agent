from __future__ import annotations

from personal_agent.context_compact import ContextCompactor


def test_compact_short_history_returns_skipped_reason() -> None:
    compactor = ContextCompactor(context_window=100)

    result = compactor.compact(
        conversation_history=[
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "收到"},
        ],
        preserve_recent_turns=2,
    )

    assert result.status == "skipped"
    assert result.reason == "history too short"
    assert result.error == ""
