"""Short-lived conversation session state for continuity across nearby turns."""

from __future__ import annotations

import json
from datetime import datetime
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from personal_agent.temporal_context import TemporalContextSnapshot


@dataclass(frozen=True)
class ConversationSessionState:
    """Represents lightweight session continuity outside long-term memory."""

    session_id: str
    current_topic: str = ""
    current_mode: str = "casual_chat"
    pending_thread: str = ""
    last_user_intent: str = ""
    intimacy_level: int = 0
    last_user_ts: str = ""
    last_agent_ts: str = ""
    current_time_of_day: str = "afternoon"
    recent_turn_summary: tuple[str, ...] = field(default_factory=tuple)


def build_session_id(channel: str, sender_id: str) -> str:
    """Return a stable session id for one chat participant on one channel."""

    return f"{channel}:{sender_id}".strip(":")


def serialize_session_state(state: ConversationSessionState) -> str:
    """Serialize session state into JSON for handoff storage."""

    payload = asdict(state)
    payload["recent_turn_summary"] = list(state.recent_turn_summary)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def parse_session_state(raw_value: str, session_id: str) -> ConversationSessionState:
    """Parse session state JSON and return a safe default on failure."""

    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError:
        return ConversationSessionState(session_id=session_id)
    if not isinstance(parsed, dict):
        return ConversationSessionState(session_id=session_id)

    summaries = parsed.get("recent_turn_summary", [])
    normalized_summaries = tuple(
        str(item).strip()
        for item in summaries
        if str(item).strip()
    )[:2]
    intimacy_level = _clamp_intimacy_level(parsed.get("intimacy_level"))
    return ConversationSessionState(
        session_id=str(parsed.get("session_id") or session_id),
        current_topic=str(parsed.get("current_topic", "")).strip(),
        current_mode=str(parsed.get("current_mode", "casual_chat")).strip() or "casual_chat",
        pending_thread=str(parsed.get("pending_thread", "")).strip(),
        last_user_intent=str(parsed.get("last_user_intent", "")).strip(),
        intimacy_level=intimacy_level,
        last_user_ts=str(parsed.get("last_user_ts", "")).strip(),
        last_agent_ts=str(parsed.get("last_agent_ts", "")).strip(),
        current_time_of_day=_normalize_time_of_day(parsed.get("current_time_of_day")),
        recent_turn_summary=normalized_summaries,
    )


def update_session_state(
    previous_state: ConversationSessionState,
    user_text: str,
    reply_text: str,
    response_mode: str,
    temporal_snapshot: TemporalContextSnapshot,
    now_local: datetime,
) -> ConversationSessionState:
    """Return the next lightweight session state after one handled turn."""

    topic_hint = _extract_topic_hint(user_text)
    topic = topic_hint or previous_state.current_topic or temporal_snapshot.active_project
    pending_thread = temporal_snapshot.unresolved_items[0] if temporal_snapshot.unresolved_items else ""
    recent_turn_summary = (
        previous_state.recent_turn_summary
        + (_build_turn_summary(user_text=user_text, temporal_snapshot=temporal_snapshot),)
    )[-2:]
    return ConversationSessionState(
        session_id=previous_state.session_id,
        current_topic=topic,
        current_mode=response_mode,
        pending_thread=pending_thread,
        last_user_intent=_extract_intent_hint(user_text),
        intimacy_level=_next_intimacy_level(previous_state.intimacy_level, user_text, response_mode),
        last_user_ts=now_local.strftime("%Y-%m-%d %H:%M:%S"),
        last_agent_ts=now_local.strftime("%Y-%m-%d %H:%M:%S"),
        current_time_of_day=infer_time_of_day(now_local),
        recent_turn_summary=recent_turn_summary,
    )


def _extract_topic_hint(user_text: str) -> str:
    markers = ("论文", "项目", "工作", "考试", "答辩", "关系", "睡觉", "聊天")
    for marker in markers:
        if marker in user_text:
            return marker
    return user_text.strip()[:16]


def _extract_intent_hint(user_text: str) -> str:
    normalized = " ".join(user_text.split()).strip()
    if len(normalized) <= 24:
        return normalized
    return normalized[:24]


def _build_turn_summary(user_text: str, temporal_snapshot: TemporalContextSnapshot) -> str:
    topic = temporal_snapshot.active_project or _extract_topic_hint(user_text)
    intent = _extract_intent_hint(user_text)
    topic_short = topic[:10]
    if temporal_snapshot.unresolved_items:
        return f"话题:{topic_short}；挂起:{temporal_snapshot.unresolved_items[0][:12]}"
    return f"话题:{topic_short}；意图:{intent[:12]}"


def _clamp_intimacy_level(value: object) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(2, numeric))


def _next_intimacy_level(previous_level: int, user_text: str, response_mode: str) -> int:
    if response_mode == "playful_flirty":
        return min(2, previous_level + 1)
    if any(marker in user_text for marker in ("晚安", "想你", "宝贝", "宝宝")):
        return min(2, previous_level + 1)
    if response_mode == "emotional_support":
        return min(1, max(previous_level, 1))
    if response_mode == "task_help":
        return max(0, previous_level - 1)
    return previous_level


def infer_time_of_day(now_local: datetime) -> str:
    """Return one coarse-grained time-of-day bucket for the local clock."""

    hour = now_local.hour
    if 0 <= hour <= 5:
        return "late_night"
    if 6 <= hour <= 11:
        return "morning"
    if 12 <= hour <= 17:
        return "afternoon"
    return "evening"


def _normalize_time_of_day(value: object) -> str:
    normalized = str(value or "").strip()
    if normalized in {"morning", "afternoon", "evening", "late_night"}:
        return normalized
    return "afternoon"
