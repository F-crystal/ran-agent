"""Lightweight post-generation review for catching tone drift and broken continuity."""

from __future__ import annotations

from dataclasses import dataclass

from personal_agent.conversation_state import ConversationSessionState
from personal_agent.temporal_context import TemporalContextSnapshot


BLACKLISTED_OPENINGS = (
    "哈哈",
    "哎呀",
    "我好像",
    "被你发现了",
    "你刚才想聊什么来着",
)


@dataclass(frozen=True)
class ReplyReviewResult:
    """Represents whether a generated reply should be retried once."""

    triggered: bool
    reasons: tuple[str, ...]
    false_positive_candidate: bool = False


def review_reply(
    reply_text: str,
    user_text: str,
    response_mode: str,
    session_state: ConversationSessionState,
    temporal_snapshot: TemporalContextSnapshot,
    blacklist_enabled: bool = True,
    off_topic_check_enabled: bool = True,
) -> ReplyReviewResult:
    """Return lightweight review findings for one generated reply."""

    normalized_reply = " ".join(reply_text.split()).strip()
    if not normalized_reply:
        return ReplyReviewResult(triggered=False, reasons=())

    reasons: list[str] = []
    if blacklist_enabled and _starts_with_blacklisted_opening(normalized_reply):
        reasons.append("blacklisted_opening")
    if off_topic_check_enabled and _looks_off_topic(normalized_reply, user_text, session_state.current_topic):
        reasons.append("off_topic")
    if response_mode == "casual_chat" and _looks_like_advice_or_explanation(normalized_reply):
        reasons.append("casual_became_advisory")
    if response_mode in {"playful_flirty", "emotional_support"} and _looks_meta_or_explanatory(normalized_reply):
        reasons.append("intimate_or_emotional_became_meta")
    if _looks_like_recent_state_over_inference(normalized_reply, user_text, temporal_snapshot):
        reasons.append("recent_state_over_inference")

    return ReplyReviewResult(triggered=bool(reasons), reasons=tuple(reasons))


def build_retry_instruction(
    reasons: tuple[str, ...],
    response_mode: str,
    session_state: ConversationSessionState,
    temporal_snapshot: TemporalContextSnapshot,
) -> str:
    """Build one compact retry instruction based on review failures."""

    lines = [
        "上一版回复不合适，请重写一次。",
        f"- 当前 response mode: {response_mode}",
        f"- 触发原因: {', '.join(reasons)}",
    ]
    if session_state.current_topic:
        lines.append(f"- 当前主题不要丢: {session_state.current_topic}")
    if session_state.pending_thread:
        lines.append(f"- 还挂着的话头: {session_state.pending_thread}")
    if temporal_snapshot.recent_mood_hint:
        lines.append(f"- 当前情绪线索: {temporal_snapshot.recent_mood_hint}")
    if temporal_snapshot.current_time_period_text:
        lines.append(f"- 当前时间段: {temporal_snapshot.current_time_period_text}")
    lines.extend(
        [
            "- 不要用模板化开场。",
            "- 不要突然掉回解释型、建议型或自我 meta 口吻。",
            "- 如果用户刚表达即时状态，先回应该状态，不要立刻推测长期原因。",
            "- 保持自然、短、贴着这一轮语境。",
        ]
    )
    return "\n".join(lines)


def _starts_with_blacklisted_opening(reply_text: str) -> bool:
    return any(reply_text.startswith(prefix) for prefix in BLACKLISTED_OPENINGS)


def _looks_off_topic(reply_text: str, user_text: str, current_topic: str) -> bool:
    normalized_topic = current_topic.strip()
    if not normalized_topic:
        return False
    if normalized_topic in reply_text:
        return False
    if _has_explicit_topic_shift(user_text, normalized_topic):
        return False
    generic_redirect_markers = (
        "你可以",
        "建议",
        "首先",
        "其次",
        "总结一下",
        "换个角度",
        "从这个角度",
    )
    return any(marker in reply_text for marker in generic_redirect_markers)


def _has_explicit_topic_shift(user_text: str, current_topic: str) -> bool:
    topic_markers = ("论文", "项目", "工作", "考试", "答辩", "关系", "睡觉", "聊天", "图片", "照片", "天气")
    current_markers = {marker for marker in topic_markers if marker in current_topic}
    user_markers = {marker for marker in topic_markers if marker in user_text}
    if not user_markers:
        return False
    return not bool(current_markers & user_markers)


def _looks_like_advice_or_explanation(reply_text: str) -> bool:
    markers = (
        "你可以",
        "建议",
        "不妨",
        "试着",
        "首先",
        "其次",
        "总结一下",
        "从这个角度",
        "这里可以",
    )
    return any(marker in reply_text for marker in markers)


def _looks_meta_or_explanatory(reply_text: str) -> bool:
    markers = (
        "作为",
        "根据你的描述",
        "从这个角度",
        "总结一下",
        "我来分析",
        "让我解释",
        "我的理解是",
    )
    return any(marker in reply_text for marker in markers)


def _looks_like_recent_state_over_inference(
    reply_text: str,
    user_text: str,
    temporal_snapshot: TemporalContextSnapshot,
) -> bool:
    if not temporal_snapshot.current_state_is_recent:
        return False
    immediate_markers = ("困", "累", "烦", "烦躁", "头疼", "饿", "想睡", "没劲")
    if not any(marker in user_text for marker in immediate_markers):
        return False
    cause_markers = ("熬夜", "作息", "压力", "长期", "一直都", "最近都", "这阵子", "习惯")
    if not any(marker in reply_text for marker in cause_markers):
        return False
    explicit_support = ("因为", "这几天", "最近一直", "连续", "总是")
    return not any(marker in user_text for marker in explicit_support)
