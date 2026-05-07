"""Temporal context snapshots for recent continuity without full transcript replay."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

from personal_agent.memory import parse_memory_content, render_memory_for_prompt

if TYPE_CHECKING:
    from personal_agent.conversation_state import ConversationSessionState


@dataclass(frozen=True)
class TemporalContextSnapshot:
    """Represents a compressed near-term context state."""

    active_project: str = ""
    current_life_context: str = ""
    unresolved_items: tuple[str, ...] = field(default_factory=tuple)
    recent_mood_hint: str = ""
    today_context_summary: str = ""
    current_clock_text: str = ""
    current_time_of_day: str = ""
    current_time_period_text: str = ""
    current_state_is_recent: bool = False


def build_temporal_context_snapshot(
    recent_user_messages: list[str],
    session_state: ConversationSessionState | None,
    working_memories: list[str],
    profile_memories: list[str],
    now_local: datetime,
) -> TemporalContextSnapshot:
    """Build one lightweight near-term state summary from recent inputs."""

    active_project = _infer_active_project(recent_user_messages, session_state, working_memories)
    current_life_context = _infer_life_context(
        recent_user_messages,
        session_state,
        working_memories,
        profile_memories,
    )
    unresolved_items = _infer_unresolved_items(recent_user_messages, session_state, working_memories)
    recent_mood_hint = _infer_recent_mood(recent_user_messages, working_memories)
    today_context_summary = _build_today_summary(active_project, current_life_context, recent_mood_hint)
    current_time_of_day = _infer_snapshot_time_of_day(session_state, now_local)
    return TemporalContextSnapshot(
        active_project=active_project,
        current_life_context=current_life_context,
        unresolved_items=unresolved_items,
        recent_mood_hint=recent_mood_hint,
        today_context_summary=today_context_summary,
        current_clock_text=now_local.strftime("%H:%M"),
        current_time_of_day=current_time_of_day,
        current_time_period_text=_render_time_period_text(current_time_of_day),
        current_state_is_recent=_looks_like_immediate_state(recent_user_messages),
    )


def render_temporal_context(snapshot: TemporalContextSnapshot) -> str:
    """Render one compact temporal context block for prompt injection."""

    lines: list[str] = []
    if snapshot.active_project:
        lines.append(f"- 当前较明确的进行中主题：{snapshot.active_project}")
    if snapshot.current_life_context:
        lines.append(f"- 最近生活/状态背景：{snapshot.current_life_context}")
    if snapshot.unresolved_items:
        lines.append(f"- 还没收束的话头：{'；'.join(snapshot.unresolved_items)}")
    if snapshot.recent_mood_hint:
        lines.append(f"- 最近情绪线索：{snapshot.recent_mood_hint}")
    if snapshot.today_context_summary:
        lines.append(f"- 这会儿的近时上下文：{snapshot.today_context_summary}")
    if snapshot.current_clock_text:
        lines.append(f"- 当前本地时间：{snapshot.current_clock_text}")
    if snapshot.current_time_period_text:
        lines.append(f"- 当前时间段：{snapshot.current_time_period_text}")
    if snapshot.current_state_is_recent:
        lines.append("- 用户这一轮表达的状态更像是刚刚发生，先贴着当下回应。")
    return "\n".join(lines)


def _infer_active_project(
    recent_user_messages: list[str],
    session_state: ConversationSessionState | None,
    working_memories: list[str],
) -> str:
    project_markers = ("论文", "项目", "答辩", "考试", "工作", "汇报", "代码")
    for text in reversed(recent_user_messages):
        for marker in project_markers:
            if marker in text:
                return marker
    if session_state and session_state.current_topic:
        return session_state.current_topic
    for item in working_memories[:1]:
        parsed = parse_memory_content(item)
        if parsed and parsed.get("topic"):
            return str(parsed["topic"]).strip()
    return ""


def _infer_life_context(
    recent_user_messages: list[str],
    session_state: ConversationSessionState | None,
    working_memories: list[str],
    profile_memories: list[str],
) -> str:
    for text in reversed(recent_user_messages[-2:]):
        cleaned = " ".join(text.split()).strip()
        if cleaned:
            return cleaned[:30]
    if session_state and session_state.current_topic:
        return session_state.current_topic[:30]
    for item in working_memories[:2]:
        rendered = render_memory_for_prompt(item).strip()
        if rendered:
            return rendered
    for item in profile_memories[:1]:
        rendered = render_memory_for_prompt(item).strip()
        if rendered:
            return rendered
    return ""


def _infer_unresolved_items(
    recent_user_messages: list[str],
    session_state: ConversationSessionState | None,
    working_memories: list[str],
) -> tuple[str, ...]:
    items: list[str] = []
    for text in reversed(recent_user_messages[-3:]):
        if any(marker in text for marker in ("怎么办", "怎么弄", "还没", "不知道", "卡住", "纠结")):
            cleaned = " ".join(text.split()).strip()[:28]
            if cleaned and cleaned not in items:
                items.append(cleaned)
    if session_state and session_state.pending_thread and session_state.pending_thread not in items:
        items.append(session_state.pending_thread[:28])
    for item in working_memories[:1]:
        rendered = render_memory_for_prompt(item).strip()
        if any(marker in rendered for marker in ("还", "最近", "卡")) and rendered not in items:
            items.append(rendered[:28])
    return tuple(items[:3])


def _infer_recent_mood(recent_user_messages: list[str], working_memories: list[str]) -> str:
    mood_markers = ("烦躁", "低落", "疲惫", "焦虑", "轻松", "开心", "紧张", "乱")
    for text in reversed(recent_user_messages[-3:]):
        for marker in mood_markers:
            if marker in text:
                return marker
    for item in working_memories[:1]:
        rendered = render_memory_for_prompt(item)
        for marker in mood_markers:
            if marker in rendered:
                return marker
    return ""


def _build_today_summary(active_project: str, current_life_context: str, recent_mood_hint: str) -> str:
    parts = []
    if active_project:
        parts.append(f"主要围绕{active_project}")
    if current_life_context:
        parts.append(current_life_context[:24])
    if recent_mood_hint:
        parts.append(f"情绪上偏{recent_mood_hint}")
    return "，".join(part for part in parts if part)[:80]


def _infer_snapshot_time_of_day(session_state: ConversationSessionState | None, now_local: datetime) -> str:
    hour = now_local.hour
    if 0 <= hour <= 5:
        return "late_night"
    if 6 <= hour <= 11:
        return "morning"
    if 12 <= hour <= 17:
        return "afternoon"
    return "evening"


def _render_time_period_text(time_of_day: str) -> str:
    mapping = {
        "morning": "早上",
        "afternoon": "白天",
        "evening": "晚上",
        "late_night": "深夜",
    }
    return mapping.get(time_of_day, "")


def _looks_like_immediate_state(recent_user_messages: list[str]) -> bool:
    if not recent_user_messages:
        return False
    latest_text = recent_user_messages[-1]
    immediate_markers = ("困", "累", "烦", "烦躁", "困死", "困了", "头疼", "饿", "想睡", "没劲")
    return any(marker in latest_text for marker in immediate_markers)
