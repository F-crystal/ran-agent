"""Lightweight post-generation review for catching tone drift and broken continuity."""

from __future__ import annotations

import os
import re
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

COURTLY_MARKERS = ("陛下", "臣", "微臣")
COURTLY_DISABLE_PATTERN = re.compile(r"正常说话|别叫陛下|别演|不要角色扮演|先别演")
AI_PERSONA_LEAK_PATTERN = re.compile(r"作为一个AI语言模型|作为AI助手|作为一个人工智能|我是AI|作为语言模型")
MECHANISM_LEAK_PATTERN = re.compile(
    r"Hermes|API Server|session header|recent history|global timeline|lark-cli|stateless|memory scope|提示词|system prompt|技能扫描|工具列表|工具链|工具调用机制|模型限制|上下文窗口|token|压缩机制|内部约束|前置扫描|fallback 链路|internal fallback|vision_analyze|browser_vision|DeepSeek\s*(?:V4)?[^。！？\n]{0,20}(?:没(?:有)?视觉|不能看|无法看)|不能看像素",
    re.IGNORECASE,
)
MECHANISM_QUESTION_PATTERN = re.compile(
    r"为什么|原因|怎么会|机制|提示词|system prompt|上下文|token|工具|压缩",
    re.IGNORECASE,
)
WRONG_VISION_TOOL_EXPLANATION_PATTERN = re.compile(
    r"vision_analyze|browser_vision|DeepSeek\s*(?:V4)?[^。！？\n]{0,20}(?:没(?:有)?视觉|不能看|无法看|text-only)|不能看像素|原生视觉能力",
    re.IGNORECASE,
)
SOCIAL_MEDIA_RETRY_REQUEST_PATTERN = re.compile(
    r"fallback|图片.*(?:读|看|内容)|读取图片|图里|没看到图|图片呢|那张图|媒体资源"
)
MECHANISM_EXPLANATION_PATTERN = re.compile(
    r"工具调用机制|fallback 链路|internal fallback|模型.*(?:视觉|能力|限制)|DeepSeek|Hermes|API Server|上下文窗口|token|session|recent history|global timeline|stateless|memory scope|lark-cli",
    re.IGNORECASE,
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
    if response_mode == "casual_chat" and _has_mechanism_leak(normalized_reply, user_text):
        reasons.append("mechanism_leak")
    if response_mode == "casual_chat" and _has_wrong_vision_tool_explanation(normalized_reply, user_text):
        reasons.append("wrong_vision_tool_explanation")
    if response_mode == "casual_chat" and _social_media_retry_needed(normalized_reply, user_text):
        reasons.append("social_media_retry_needed")
    if response_mode == "casual_chat" and _has_over_courtly_template(normalized_reply):
        reasons.append("over_courtly_template")
    if response_mode == "casual_chat" and _looks_like_unnatural_flow(normalized_reply, user_text):
        reasons.append("unnatural_conversation_flow")
    if response_mode == "casual_chat" and _has_overlong_systemic_explanation(normalized_reply, user_text):
        reasons.append("overlong_systemic_explanation")

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


def _has_mechanism_leak(reply_text: str, user_text: str) -> bool:
    if not MECHANISM_LEAK_PATTERN.search(reply_text):
        return False
    return not _user_asked_about_mechanism(user_text)


def _user_asked_about_mechanism(user_text: str) -> bool:
    return bool(MECHANISM_QUESTION_PATTERN.search(user_text))


def _has_wrong_vision_tool_explanation(reply_text: str, user_text: str) -> bool:
    if not _is_social_media_retry_request(user_text):
        return False
    return bool(WRONG_VISION_TOOL_EXPLANATION_PATTERN.search(reply_text))


def _social_media_retry_needed(reply_text: str, user_text: str) -> bool:
    if not _is_social_media_retry_request(user_text):
        return False
    return bool(MECHANISM_EXPLANATION_PATTERN.search(reply_text))


def _is_social_media_retry_request(user_text: str) -> bool:
    return bool(SOCIAL_MEDIA_RETRY_REQUEST_PATTERN.search(user_text))


def _has_over_courtly_template(reply_text: str) -> bool:
    dense_phrases = ("臣以为", "臣觉得", "臣知道", "臣惭愧")
    dense_count = sum(reply_text.count(phrase) for phrase in dense_phrases)
    marker_count = reply_text.count("陛下") + reply_text.count("微臣") + reply_text.count("臣")
    sentence_count = max(1, len([part for part in re.split(r"[。！？!?；;]", reply_text) if part.strip()]))
    return dense_count >= 3 or (marker_count >= 5 and sentence_count <= 6)


def _looks_like_unnatural_flow(reply_text: str, user_text: str) -> bool:
    if not _is_naturalness_feedback(user_text):
        return False
    report_markers = ("自检报告", "流程汇报", "已完成以下", "问题分析", "原因定位", "下一步建议")
    numbered_items = len(re.findall(r"(?:^|\n)\s*\d+[.、]", reply_text))
    return any(marker in reply_text for marker in report_markers) or numbered_items >= 3


def _has_overlong_systemic_explanation(reply_text: str, user_text: str) -> bool:
    if not _is_naturalness_feedback(user_text):
        return False
    if len(reply_text) < 90:
        return False
    systemic_markers = ("第一", "第二", "第三", "从架构上", "系统解释", "提示词", "上下文窗口", "内部约束")
    return sum(1 for marker in systemic_markers if marker in reply_text) >= 2


def _is_naturalness_feedback(user_text: str) -> bool:
    return any(marker in user_text for marker in ("不连贯", "不自然", "模板", "套话", "机制外显", "太机械"))


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


def detect_courtly_persona_drift(
    reply_text: str,
    user_text: str | None = None,
) -> dict[str, object]:
    """Check if a reply maintains the courtly attendant persona.

    Returns a dict with:
        ok: bool — True if reply passes the check
        reason: str — explanation if not ok, empty otherwise
        should_rewrite: bool — True if a rewrite is recommended
        mode: str — always "courtly_attendant"
    """
    mode = os.getenv("RAN_AGENT_COURTLY_MODE", "on").strip().lower()
    if mode == "off":
        return {"ok": True, "reason": "", "should_rewrite": False, "mode": "courtly_attendant"}

    # If user disabled courtly style this turn, skip check
    if user_text and COURTLY_DISABLE_PATTERN.search(user_text):
        return {"ok": True, "reason": "", "should_rewrite": False, "mode": "courtly_attendant"}

    normalized = " ".join(reply_text.split()).strip()
    if not normalized:
        return {"ok": True, "reason": "empty_reply", "should_rewrite": False, "mode": "courtly_attendant"}

    # Strip code blocks for analysis
    text_without_code = re.sub(r"```[\s\S]*?```", "", normalized)
    text_without_code = re.sub(r"`[^`]+`", "", text_without_code)
    # Strip command-like lines
    lines = text_without_code.split("\n")
    conversational_lines = [
        ln.strip() for ln in lines
        if ln.strip() and not ln.strip().startswith(("$", "#", ">", "bash", "sh", "python", "node"))
    ]
    conversational_text = " ".join(conversational_lines)

    # Check for AI persona leak (always bad)
    if AI_PERSONA_LEAK_PATTERN.search(conversational_text):
        return {
            "ok": False,
            "reason": "ai_persona_leak",
            "should_rewrite": True,
            "mode": "courtly_attendant",
        }

    # If reply is purely code/commands, no courtly check needed
    if not conversational_text:
        return {"ok": True, "reason": "", "should_rewrite": False, "mode": "courtly_attendant"}

    # Check if courtly markers appear in first 2 conversational sentences
    first_part = conversational_text[:200]
    has_courtly_marker = any(marker in first_part for marker in COURTLY_MARKERS)

    if not has_courtly_marker:
        return {
            "ok": False,
            "reason": "courtly_marker_missing",
            "should_rewrite": True,
            "mode": "courtly_attendant",
        }

    return {"ok": True, "reason": "", "should_rewrite": False, "mode": "courtly_attendant"}
