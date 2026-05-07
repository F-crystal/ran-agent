"""Small helpers for enforcing prompt-context character budgets."""

from __future__ import annotations


def trim_context(text: str, max_chars: int) -> str:
    """Return text bounded to max_chars while preserving readable edges."""

    cleaned = str(text or "").strip()
    if max_chars <= 0:
        return ""
    if len(cleaned) <= max_chars:
        return cleaned
    if max_chars <= 12:
        return cleaned[:max_chars]

    marker = "\n...[trimmed]...\n"
    marker_len = len(marker)
    if max_chars <= marker_len + 8:
        return cleaned[:max_chars]
    edge_budget = max_chars - marker_len
    head_chars = max(edge_budget // 2, 1)
    tail_chars = max(edge_budget - head_chars, 1)
    return f"{cleaned[:head_chars].rstrip()}{marker}{cleaned[-tail_chars:].lstrip()}"
