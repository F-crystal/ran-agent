"""Memory extraction and prompt-context helpers for the local personal agent."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable


WORKING_TIME_MARKERS = (
    "今天",
    "最近",
    "这两天",
    "这周",
    "这段时间",
    "刚刚",
    "刚",
    "现在",
    "一直",
)

EMOTION_PATTERNS = (
    (re.compile(r"(累|疲惫|没劲|困|撑不住)"), "有些疲惫"),
    (re.compile(r"(烦|烦躁|崩溃|焦虑|慌|心烦)"), "情绪有些烦躁"),
    (re.compile(r"(难过|低落|委屈|想哭)"), "情绪有些低落"),
    (re.compile(r"(开心|高兴|轻松|踏实|安心)"), "心情还不错"),
    (re.compile(r"(紧张|压力大|压得喘不过气|绷着)"), "压力有些大"),
    (re.compile(r"(乱|混乱|烦乱)"), "脑子有些乱"),
)

PROFILE_PATTERNS = (
    re.compile(r"我(?:平时|一般|通常|经常|总是)(?P<trait>[^，。！？]{2,24})"),
    re.compile(r"我(?:很|还)?喜欢(?P<trait>[^，。！？]{1,20})"),
    re.compile(r"我(?:不太|不怎么|不)喜欢(?P<trait>[^，。！？]{1,20})"),
    re.compile(r"我是(?P<trait>[^，。！？]{1,18})"),
    re.compile(r"我在(?P<trait>[^，。！？]{1,20}工作)"),
    re.compile(r"我在读(?P<trait>[^，。！？]{1,20})"),
    re.compile(r"我住在(?P<trait>[^，。！？]{1,20})"),
)

MemoryPayload = Dict[str, Any]


def build_memory_context(
    profile_memories: Iterable[str],
    working_memories: Iterable[str],
) -> str:
    """Build the memory prompt block shown to the model."""

    sections: list[str] = []
    profile_items = [
        render_memory_for_prompt(item).strip()
        for item in profile_memories
        if render_memory_for_prompt(item).strip()
    ]
    working_items = [
        render_memory_for_prompt(item).strip()
        for item in working_memories
        if render_memory_for_prompt(item).strip()
    ]

    if profile_items:
        profile_lines = "\n".join(f"- {item}" for item in profile_items)
        sections.append(f"【你对用户的了解】\n{profile_lines}")

    if working_items:
        working_lines = "\n".join(f"- {item}" for item in working_items)
        sections.append(f"【用户当前状态（近期）】\n{working_lines}")

    return "\n\n".join(sections)


def extract_working_memory(user_text: str) -> MemoryPayload | None:
    """Summarize a current user state into one short working-memory item."""

    cleaned = _normalize_text(user_text)
    if not cleaned:
        return None

    has_current_marker = any(marker in cleaned for marker in WORKING_TIME_MARKERS)
    activity = _extract_activity_fragment(cleaned)
    emotion = _extract_emotion_fragment(cleaned)

    if not has_current_marker and not emotion:
        return None
    if not activity and not emotion:
        return None

    time_scope = ""
    parts = ["用户"]
    if "今天" in cleaned:
        parts.append("今天")
        time_scope = "today"
    elif any(marker in cleaned for marker in ("最近", "这段时间", "这两天", "这周")):
        parts.append("最近")
        time_scope = "recent"
    elif any(marker in cleaned for marker in ("刚刚", "刚", "现在", "一直")):
        parts.append("这会儿")
        time_scope = "current"

    summary = "".join(parts)
    if activity:
        summary = f"{summary}在{activity}"

    if emotion:
        connector = "，" if activity else ""
        summary = f"{summary}{connector}{emotion}"

    summary = summary.strip("，")
    if not summary or summary == "用户":
        return None

    topic = _extract_topic(activity)
    return {
        "type": "working",
        "time_scope": time_scope or "recent",
        "topic": _truncate_text(topic, max_length=20) if topic else "",
        "state": emotion,
        "summary": _truncate_text(summary, max_length=50),
    }


def extract_profile_memory(
    user_text: str,
    history: list[str],
    repeat_threshold: int = 2,
) -> MemoryPayload | None:
    """Extract a stable profile memory only when it appears repeatedly."""

    candidates = _extract_profile_candidates(user_text)
    if not candidates:
        return None

    historical_candidates = [
        candidate
        for text in history
        for candidate in _extract_profile_candidates(text)
    ]

    for candidate in candidates:
        count = sum(
            1
            for previous in historical_candidates
            if _memory_similarity_key(previous["summary"]) == _memory_similarity_key(candidate["summary"])
        )
        if count + 1 >= repeat_threshold:
            return {
                **candidate,
                "summary": _truncate_text(candidate["summary"], max_length=50),
            }

    return None


def serialize_memory_content(memory_payload: MemoryPayload) -> str:
    """Serialize a memory payload into JSON stored in the TEXT column."""

    return json.dumps(memory_payload, ensure_ascii=False, separators=(",", ":"))


def parse_memory_content(content: str) -> MemoryPayload | None:
    """Parse a stored memory payload when it is valid JSON; otherwise return None."""

    normalized = content.strip()
    if not normalized:
        return None

    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return None

    if not isinstance(parsed, dict):
        return None
    if not isinstance(parsed.get("type"), str):
        return None
    return {key: value for key, value in parsed.items() if value is not None}


def render_memory_for_prompt(content: str) -> str:
    """Render stored memory content into natural language for the prompt."""

    parsed = parse_memory_content(content)
    if not parsed:
        return content.strip()

    if parsed.get("type") == "working":
        return _render_working_memory(parsed)
    if parsed.get("type") == "profile":
        return _render_profile_memory(parsed)
    summary = parsed.get("summary", "").strip()
    if summary:
        return summary
    return content.strip()


def memory_similarity(a: str | MemoryPayload, b: str | MemoryPayload) -> bool:
    """Return whether two memory strings are effectively the same."""

    return _memory_similarity_key(_memory_text_for_compare(a)) == _memory_similarity_key(
        _memory_text_for_compare(b)
    )


def _extract_activity_fragment(text: str) -> str:
    patterns = (
        re.compile(r"(?:今天|最近|这两天|这周|这段时间|刚刚|刚|现在|一直)?(?:我)?(?:一直)?(?:在|正|正在|忙着)(?P<activity>[^，。！？]{2,20})"),
        re.compile(r"(?:今天|最近|这两天|这周|这段时间)?(?:我)?(?P<activity>(?:改|写|做|赶|准备|处理|开|上|忙)[^，。！？]{1,18})"),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        activity = match.group("activity").strip("，。！？ ")
        activity = re.sub(r"^(一下|一整天|整天|一直|总在)", "", activity)
        if len(activity) < 2:
            continue
        return _normalize_activity(activity)
    return ""


def _normalize_activity(activity: str) -> str:
    replacements = (
        (r"^改论文", "处理论文"),
        (r"^写论文", "写论文"),
        (r"^改代码", "处理代码"),
        (r"^写代码", "写代码"),
        (r"^开会", "开会"),
        (r"^上班", "上班"),
        (r"^加班", "加班"),
        (r"^做汇报", "做汇报"),
        (r"^准备考试", "准备考试"),
        (r"^赶项目", "赶项目"),
        (r"^处理工作", "处理工作"),
    )
    normalized = activity
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized)
    normalized = re.sub(r"^(开会).*", r"\1", normalized)
    normalized = re.sub(r"^(上班).*", r"\1", normalized)
    normalized = re.sub(r"^(加班).*", r"\1", normalized)
    return normalized.strip()


def _extract_emotion_fragment(text: str) -> str:
    for pattern, summary in EMOTION_PATTERNS:
        if pattern.search(text):
            return summary
    return ""


def _extract_profile_candidates(text: str) -> list[MemoryPayload]:
    cleaned = _normalize_text(text)
    if not cleaned:
        return []

    candidates: list[MemoryPayload] = []
    for pattern in PROFILE_PATTERNS:
        match = pattern.search(cleaned)
        if not match:
            continue
        trait = match.group("trait").strip("，。！？ ")
        candidate = _render_profile_candidate(pattern, trait)
        if candidate:
            candidates.append(candidate)
    return candidates


def _render_profile_candidate(pattern: re.Pattern[str], trait: str) -> MemoryPayload | None:
    pattern_text = pattern.pattern
    if not trait or len(trait) < 2:
        return None
    if "喜欢" in pattern_text and "不" not in pattern_text:
        return {
            "type": "profile",
            "category": "preference",
            "trait": trait,
            "summary": f"用户喜欢{trait}",
        }
    if "不太" in pattern_text or "不怎么" in pattern_text or "不)喜欢" in pattern_text:
        return {
            "type": "profile",
            "category": "dislike",
            "trait": trait,
            "summary": f"用户不太喜欢{trait}",
        }
    if "我是" in pattern_text:
        return {
            "type": "profile",
            "category": "identity",
            "trait": trait,
            "summary": f"用户是{trait}",
        }
    if "工作" in pattern_text:
        return {
            "type": "profile",
            "category": "work",
            "trait": trait,
            "summary": f"用户在{trait}",
        }
    if "我在读" in pattern_text:
        return {
            "type": "profile",
            "category": "study",
            "trait": trait,
            "summary": f"用户在读{trait}",
        }
    if "住在" in pattern_text:
        return {
            "type": "profile",
            "category": "location",
            "trait": trait,
            "summary": f"用户住在{trait}",
        }
    return {
        "type": "profile",
        "category": "habit",
        "trait": trait,
        "summary": f"用户平时{trait}",
    }


def _render_working_memory(memory_payload: MemoryPayload) -> str:
    time_scope = str(memory_payload.get("time_scope", "")).strip()
    topic = str(memory_payload.get("topic", "")).strip()
    state = str(memory_payload.get("state", "")).strip()
    summary = str(memory_payload.get("summary", "")).strip()

    variant_index = _stable_variant_index(memory_payload, variant_count=3)
    if topic and state:
        variants = (
            {
                "today": f"今天主要还在{topic}，{state}",
                "recent": f"最近似乎一直在{topic}，{state}",
                "current": f"这会儿还卡在{topic}里，{state}",
            },
            {
                "today": f"今天的状态像是一直在{topic}，也有点{_state_tail(state)}",
                "recent": f"这段时间多半都在{topic}，整个人也有点{_state_tail(state)}",
                "current": f"眼下还在忙{topic}，状态上有点{_state_tail(state)}",
            },
            {
                "today": f"今天重心基本都在{topic}上，{state}",
                "recent": f"最近不少精力都放在{topic}上，{state}",
                "current": f"这会儿注意力还在{topic}上，{state}",
            },
        )
        return variants[variant_index].get(time_scope, variants[variant_index]["recent"]).strip()

    if topic:
        variants = (
            {
                "today": f"今天主要还在{topic}",
                "recent": f"最近似乎一直在{topic}",
                "current": f"这会儿还在忙{topic}",
            },
            {
                "today": f"今天的重心基本都在{topic}上",
                "recent": f"这段时间不少精力都放在{topic}上",
                "current": f"眼下注意力还在{topic}上",
            },
            {
                "today": f"今天还在{_topic_with_optional_processing(topic)}",
                "recent": f"最近一直在{_topic_with_optional_processing(topic)}",
                "current": f"这会儿还卡在{topic}里",
            },
        )
        return variants[variant_index].get(time_scope, variants[variant_index]["recent"]).strip()

    if state:
        variants = (
            {
                "today": f"今天整体状态是{state}",
                "recent": f"最近整体状态有点{_state_tail(state)}",
                "current": f"这会儿状态上有点{_state_tail(state)}",
            },
            {
                "today": f"今天人有点{_state_tail(state)}",
                "recent": f"这段时间人有点{_state_tail(state)}",
                "current": f"眼下人有点{_state_tail(state)}",
            },
            {
                "today": f"今天看起来有些{_state_tail(state)}",
                "recent": f"最近看起来有些{_state_tail(state)}",
                "current": f"现在看起来有些{_state_tail(state)}",
            },
        )
        return variants[variant_index].get(time_scope, variants[variant_index]["recent"]).strip()

    return summary


def _render_profile_memory(memory_payload: MemoryPayload) -> str:
    summary = str(memory_payload.get("summary", "")).strip()
    category = str(memory_payload.get("category", "")).strip()
    trait = str(memory_payload.get("trait", "")).strip()
    if not trait:
        return summary
    variant_index = _stable_variant_index(memory_payload, variant_count=3)
    if category == "preference":
        variants = (
            f"好像一直挺喜欢{trait}",
            f"对{trait}会更偏爱一些",
            f"看起来对{trait}是有明显偏好的",
        )
        return variants[variant_index]
    if category == "dislike":
        variants = (
            f"似乎不太喜欢{trait}",
            f"对{trait}多少有点排斥",
            f"看起来不会太偏向{trait}",
        )
        return variants[variant_index]
    if category == "identity":
        variants = (
            f"像是{trait}",
            f"给人的感觉更像是{trait}",
            f"大体可以把对方理解成{trait}",
        )
        return variants[variant_index]
    if category == "work":
        variants = (
            f"工作上是在{trait}",
            f"平时主要是在{trait}",
            f"职业状态更接近{trait}",
        )
        return variants[variant_index]
    if category == "study":
        variants = (
            f"现在还在读{trait}",
            f"学习阶段是在读{trait}",
            f"目前像是在读{trait}",
        )
        return variants[variant_index]
    if category == "location":
        variants = (
            f"现在住在{trait}",
            f"常住地应该是在{trait}",
            f"生活地点更像是在{trait}",
        )
        return variants[variant_index]
    if category == "value":
        variants = (
            f"对{trait}似乎比较在意",
            f"看起来会把{trait}看得很重",
            f"心里对{trait}是有明确偏向的",
        )
        return variants[variant_index]
    variants = (
        f"平时会有{trait}这样的倾向",
        f"整个人带着一点{trait}的习惯",
        f"日常里像是会{trait}",
    )
    return variants[variant_index]


def _memory_text_for_compare(memory: str | MemoryPayload) -> str:
    if isinstance(memory, dict):
        return memory.get("summary", "").strip()
    parsed = parse_memory_content(memory)
    if parsed:
        return parsed.get("summary", "").strip()
    rendered = render_memory_for_prompt(memory)
    return rendered.strip()


def _stable_variant_index(memory_payload: MemoryPayload, variant_count: int) -> int:
    seed = "|".join(
        (
            memory_payload.get("type", ""),
            memory_payload.get("category", ""),
            memory_payload.get("time_scope", ""),
            memory_payload.get("topic", ""),
            memory_payload.get("trait", ""),
            memory_payload.get("state", ""),
            memory_payload.get("summary", ""),
        )
    )
    return sum(ord(char) for char in seed) % variant_count


def _state_tail(state: str) -> str:
    trimmed = state.strip()
    for prefix in ("情绪有些", "有些", "脑子有些", "压力有些", "心情"):
        if trimmed.startswith(prefix):
            remainder = trimmed[len(prefix) :].strip()
            if remainder:
                return remainder
    return trimmed


def _extract_topic(activity: str) -> str:
    if not activity:
        return ""
    topic_patterns = (
        (r"论文", "处理论文"),
        (r"代码", "处理代码"),
        (r"工作", "处理工作"),
        (r"答辩", "准备答辩"),
        (r"考试", "准备考试"),
        (r"项目", "赶项目"),
        (r"汇报", "做汇报"),
        (r"开会", "开会"),
        (r"上班", "上班"),
        (r"加班", "加班"),
    )
    for pattern, topic in topic_patterns:
        if re.search(pattern, activity):
            return topic
    return activity


def _topic_with_optional_processing(topic: str) -> str:
    if topic.startswith(("处理", "准备", "赶", "做", "开", "上", "加")):
        return topic
    return f"处理{topic}"


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", text).strip()


def _truncate_text(text: str, max_length: int) -> str:
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def _memory_similarity_key(text: str) -> str:
    normalized = _normalize_text(text)
    normalized = re.sub(r"[，。！？、；：“”‘’（）()]", "", normalized)
    return normalized
