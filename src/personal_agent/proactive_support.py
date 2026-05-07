"""Helpers for surfacing lightweight companion seeds and context clues from recent context."""

from __future__ import annotations

from datetime import datetime

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.memory import parse_memory_content, render_memory_for_prompt
from personal_agent.memory_specialist import MemorySpecialist


def is_in_silent_window(config: AppConfig, local_now: datetime) -> bool:
    """Return whether the current local time is inside the proactive quiet hours."""

    start_hour = config.proactive_silent_start_hour
    end_hour = config.proactive_silent_end_hour
    current_hour = local_now.hour

    if start_hour == end_hour:
        return False
    if start_hour < end_hour:
        return start_hour <= current_hour < end_hour
    return current_hour >= start_hour or current_hour < end_hour


def build_proactive_hint(
    *,
    database: Database,
    config: AppConfig,
    memory_specialist: MemorySpecialist,
) -> tuple[str | None, dict[str, object]]:
    """Build one lightweight proactive clue and expose its origin context."""

    working_memories = database.get_working_memories(limit=config.working_memory_limit)
    for row in working_memories:
        content = str(row["content"])
        clue = _build_from_working_memory(content)
        if clue:
            seed = _extract_seed_from_memory(content)
            return clue, {"source_type": "working_memory", "memory": content, "seed": seed}

    profile_memories = database.get_profile_memories(limit=config.profile_memory_limit)
    for row in profile_memories:
        content = str(row["content"])
        clue = _build_from_profile_memory(content)
        if clue:
            seed = _extract_seed_from_memory(content)
            return clue, {"source_type": "profile_memory", "memory": content, "seed": seed}

    recent_messages = database.get_recent_wechat_user_messages(limit=3)
    for message_text in recent_messages:
        clue = _build_from_recent_text(message_text, memory_specialist)
        if clue:
            return clue, {"source_type": "recent_text", "text": message_text, "seed": message_text[:24].strip()}

    return None, {}


def _build_from_working_memory(content: str) -> str | None:
    """Generate one lightweight context clue from recent working memory."""

    memory_payload = parse_memory_content(content)
    if not memory_payload or memory_payload.get("type") != "working":
        return render_memory_for_prompt(content) or None

    topic = str(memory_payload.get("topic", "")).strip()
    state = str(memory_payload.get("state", "")).strip()

    if topic and state:
        return f"最近在忙{topic}，状态偏{_state_tail(state)}"
    if topic:
        return f"最近一直在忙{topic}"
    if state:
        return f"最近状态偏{_state_tail(state)}"

    return render_memory_for_prompt(content) or None


def _build_from_profile_memory(content: str) -> str | None:
    """Generate one lightweight context clue from profile memory."""

    memory_payload = parse_memory_content(content)
    if not memory_payload or memory_payload.get("type") != "profile":
        return render_memory_for_prompt(content) or None

    category = str(memory_payload.get("category", "")).strip()
    trait = str(memory_payload.get("trait", "")).strip()
    if not trait:
        return render_memory_for_prompt(content) or None

    if category == "preference":
        return f"偏好{trait}"
    if category == "dislike":
        return f"不太喜欢{trait}"
    if category in {"work", "study"}:
        return f"长期在线索{trait}上投入较多"
    if category == "habit":
        return f"平时会{trait}"
    if category == "value":
        return f"比较在意{trait}"
    return trait


def _build_from_recent_text(user_text: str, memory_specialist: MemorySpecialist) -> str | None:
    """Fallback context clue based on recent wechat text."""

    cleaned = user_text.strip()
    if not cleaned or not memory_specialist.should_inject_memory(cleaned):
        return None
    if len(cleaned) > 24:
        cleaned = cleaned[:24].rstrip() + "…"
    return cleaned


def _state_tail(state: str) -> str:
    """Shorten one state phrase for lighter proactive wording."""

    trimmed = state.strip()
    for prefix in ("情绪有些", "有些", "脑子有些", "压力有些", "心情还"):
        if trimmed.startswith(prefix):
            remainder = trimmed[len(prefix) :].strip()
            if remainder:
                return remainder
    return trimmed


def _extract_seed_from_memory(content: str) -> str:
    """Extract one lightweight repeat-check seed from serialized memory content."""

    payload = parse_memory_content(content)
    if not payload:
        rendered = render_memory_for_prompt(content)
        return rendered[:24].strip() if rendered else ""
    for key in ("topic", "trait", "summary", "state"):
        value = str(payload.get(key, "")).strip()
        if value:
            return value[:24]
    return ""
