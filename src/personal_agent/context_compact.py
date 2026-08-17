"""Context compression for long conversations.

Inspired by Codex /compact and Claude Code's compaction system.
Provides automatic and manual context compression to manage token limits.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from personal_agent.db import Database


CompactionStrategy = Literal["auto", "handoff", "micro", "aggressive"]


@dataclass(frozen=True)
class CompactionResult:
    """Result of a context compaction operation."""

    status: Literal["compacted", "skipped", "failed"]
    strategy: CompactionStrategy
    original_tokens: int
    compacted_tokens: int
    summary: str
    reason: str = ""
    error: str = ""
    preserved_items: list[dict] = field(default_factory=list)
    preserved_turn_count: int = 0
    archived_turns: int = 0
    archive_path: str = ""
    compression_ratio: float = 0.0


class ContextCompactor:
    """Manages context compression for conversation history."""

    # Token thresholds
    DEFAULT_CONTEXT_WINDOW = 120000  # Default context window size
    AUTO_COMPACT_THRESHOLD = 0.8  # 80% of context window
    MICRO_COMPACT_THRESHOLD = 0.6  # 60% for single large tool outputs

    def __init__(
        self,
        database: Database | None = None,
        context_window: int = DEFAULT_CONTEXT_WINDOW,
    ):
        self._database = database
        self._context_window = context_window
        self._auto_threshold = int(context_window * self.AUTO_COMPACT_THRESHOLD)

    def estimate_tokens(self, text: str) -> int:
        """Fast token estimation without external tokenizer.

        Chinese: ~1.5 tokens per char
        English: ~0.25 tokens per char
        """
        chinese_chars = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
        other_chars = len(text) - chinese_chars
        return int(chinese_chars * 1.5 + other_chars * 0.25)

    def should_compact(
        self,
        conversation_history: list[dict],
        current_tokens: int | None = None,
    ) -> tuple[bool, str]:
        """Check if compaction is needed.

        Returns:
            (should_compact, reason)
        """
        if current_tokens is None:
            current_tokens = self._estimate_history_tokens(conversation_history)

        if current_tokens > self._auto_threshold:
            return True, f"tokens {current_tokens} > threshold {self._auto_threshold}"

        # Check for oversized single messages (tool outputs)
        for msg in conversation_history:
            content = msg.get("content", "")
            if isinstance(content, str):
                msg_tokens = self.estimate_tokens(content)
                if msg_tokens > self._context_window * 0.3:  # Single msg > 30%
                    return True, f"oversized message {msg_tokens} tokens"

        return False, ""

    def compact(
        self,
        conversation_history: list[dict],
        strategy: CompactionStrategy = "auto",
        custom_focus: str = "",
        preserve_recent_turns: int = 2,
        preserve_tool_outputs: bool = True,
    ) -> CompactionResult:
        """Compress conversation history.

        Args:
            conversation_history: Full conversation history
            strategy: Compression strategy
            custom_focus: User-specified focus for handoff summary
            preserve_recent_turns: Number of recent turns to keep verbatim
            preserve_tool_outputs: Whether to preserve key tool outputs

        Returns:
            CompactionResult with summary and metadata
        """
        original_tokens = self._estimate_history_tokens(conversation_history)

        if len(conversation_history) <= preserve_recent_turns + 1:
            return CompactionResult(
                status="skipped",
                strategy=strategy,
                original_tokens=original_tokens,
                compacted_tokens=original_tokens,
                summary="",
                reason="history too short",
                preserved_turn_count=0,
            )

        try:
            # Split history
            recent_history = conversation_history[-preserve_recent_turns:]
            old_history = conversation_history[:-preserve_recent_turns]

            # Generate summary based on strategy
            if strategy == "micro":
                summary = self._generate_micro_summary(old_history)
            elif strategy == "handoff":
                summary = self._generate_handoff_summary(old_history, custom_focus)
            elif strategy == "aggressive":
                summary = self._generate_aggressive_summary(old_history)
            else:  # auto
                summary = self._generate_auto_summary(old_history)

            # Build preserved items list
            preserved_items = []
            for i, msg in enumerate(recent_history):
                preserved_items.append({
                    "type": msg.get("role", "unknown"),
                    "turn": i - len(recent_history),
                    "preview": str(msg.get("content", ""))[:50],
                })

            # Optionally preserve key tool outputs from old history
            if preserve_tool_outputs:
                tool_outputs = self._extract_key_tool_outputs(old_history)
                preserved_items.extend(tool_outputs)

            # Build compacted history
            compacted_history = [
                {
                    "role": "system",
                    "content": f"[上下文已压缩] 历史摘要：\n{summary}",
                },
                *recent_history,
            ]

            compacted_tokens = self._estimate_history_tokens(compacted_history)
            compression_ratio = (
                (original_tokens - compacted_tokens) / original_tokens
                if original_tokens > 0 else 0
            )

            # Archive if database available
            archive_path = ""
            if self._database:
                archive_path = self._archive_history(
                    old_history, summary, compression_ratio
                )

            return CompactionResult(
                status="compacted",
                strategy=strategy,
                original_tokens=original_tokens,
                compacted_tokens=compacted_tokens,
                summary=summary,
                reason="",
                error="",
                preserved_items=preserved_items,
                preserved_turn_count=len(recent_history),
                archived_turns=len(old_history),
                archive_path=archive_path,
                compression_ratio=compression_ratio,
            )

        except Exception as e:
            return CompactionResult(
                status="failed",
                strategy=strategy,
                original_tokens=original_tokens,
                compacted_tokens=original_tokens,
                summary="",
                preserved_turn_count=0,
                error=str(e),
            )

    def _estimate_history_tokens(self, history: list[dict]) -> int:
        """Estimate total tokens in conversation history."""
        total = 0
        for msg in history:
            content = msg.get("content", "")
            if isinstance(content, str):
                total += self.estimate_tokens(content)
            elif isinstance(content, list):
                # Handle multi-modal content
                for item in content:
                    if isinstance(item, dict) and "text" in item:
                        total += self.estimate_tokens(item["text"])
        return total

    def _generate_auto_summary(self, history: list[dict]) -> str:
        """Generate automatic summary for regular compaction."""
        # Extract key information
        topics = set()
        decisions = []
        pending = []

        for msg in history:
            content = str(msg.get("content", ""))
            role = msg.get("role", "")

            # Extract topics
            if role == "user":
                topics.update(self._extract_topics(content))
                # Check for questions or pending items
                if any(m in content for m in ["?", "？", "怎么", "如何", "为什么"]):
                    pending.append(content[:50])

            # Extract decisions
            if role == "assistant" and any(m in content for m in ["决定", "选择", "使用", "采用"]):
                decisions.append(content[:100])

        summary_parts = []
        if topics:
            summary_parts.append(f"讨论主题：{', '.join(list(topics)[:5])}")
        if decisions:
            summary_parts.append(f"关键决策：{decisions[-1][:80]}")
        if pending:
            summary_parts.append(f"待解决问题：{pending[-1][:50]}...")

        return "；".join(summary_parts) if summary_parts else "历史对话已压缩"

    def _generate_handoff_summary(self, history: list[dict], focus: str = "") -> str:
        """Generate handoff-style summary for task boundaries."""
        # Build structured handoff document
        handoff = []

        # Current task
        user_msgs = [m for m in history if m.get("role") == "user"]
        if user_msgs:
            last_user = str(user_msgs[-1].get("content", ""))[:100]
            handoff.append(f"当前任务：{last_user}")

        # Key decisions
        assistant_msgs = [m for m in history if m.get("role") == "assistant"]
        key_points = []
        for msg in assistant_msgs[-3:]:  # Last 3 assistant messages
            content = str(msg.get("content", ""))
            # Extract code blocks, file paths, key statements
            if "```" in content or "." in content[:20]:
                key_points.append(content[:80])

        if key_points:
            handoff.append(f"关键进展：{'；'.join(key_points[:2])}")

        # User focus if specified
        if focus:
            handoff.append(f"用户关注：{focus}")

        # Next steps hint
        if user_msgs:
            last_intent = self._extract_intent(str(user_msgs[-1].get("content", "")))
            if last_intent:
                handoff.append(f"用户意图：{last_intent}")

        return "\n".join(handoff) if handoff else "任务交接摘要"

    def _generate_micro_summary(self, history: list[dict]) -> str:
        """Generate micro-summary for oversized single messages."""
        # Focus on tool outputs and results
        summaries = []
        for msg in history:
            if msg.get("role") == "tool" or msg.get("tool_calls"):
                content = str(msg.get("content", ""))
                # Truncate large content
                if len(content) > 500:
                    summaries.append(f"[工具输出已摘要] {content[:200]}...")
                else:
                    summaries.append(content[:200])

        return "\n".join(summaries) if summaries else "工具输出已压缩"

    def _generate_aggressive_summary(self, history: list[dict]) -> str:
        """Generate minimal summary for emergency compaction."""
        # Keep only essential information
        essentials = []

        # Last user request
        user_msgs = [m for m in history if m.get("role") == "user"]
        if user_msgs:
            essentials.append(f"用户最后请求：{str(user_msgs[-1].get('content', ''))[:80]}")

        # Any todos or action items
        for msg in history:
            content = str(msg.get("content", ""))
            if any(m in content for m in ["TODO", "待办", "需要", "必须"]):
                essentials.append(f"待办：{content[:60]}")

        return " | ".join(essentials) if essentials else "紧急压缩模式"

    def _extract_topics(self, text: str) -> set[str]:
        """Extract topic keywords from text."""
        # Simple keyword extraction
        keywords = []
        markers = [
            "论文", "项目", "代码", "API", "数据库", "前端", "后端",
            "设计", "问题", "错误", "功能", "模块", "系统",
            "学习", "工作", "计划", "任务", "会议",
        ]
        for marker in markers:
            if marker in text:
                keywords.append(marker)
        return set(keywords)

    def _extract_intent(self, text: str) -> str:
        """Extract user intent hint."""
        # Intent patterns
        if any(m in text for m in ["怎么", "如何", "怎样"]):
            return "寻求方法"
        if any(m in text for m in ["为什么", "原因"]):
            return "寻求解释"
        if any(m in text for m in ["错误", "失败", "不行"]):
            return "问题解决"
        if any(m in text for m in ["实现", "完成", "做"]):
            return "任务执行"
        return ""

    def _extract_key_tool_outputs(self, history: list[dict]) -> list[dict]:
        """Extract important tool outputs to preserve."""
        preserved = []
        for msg in history:
            if msg.get("role") == "tool":
                content = str(msg.get("content", ""))
                # Check for important patterns
                is_important = any(
                    pattern in content
                    for pattern in ["error", "成功", "失败", "schema", "config"]
                )
                if is_important:
                    preserved.append({
                        "type": "tool_output",
                        "preview": content[:80],
                        "reason": "关键结果",
                    })
        return preserved

    def _archive_history(
        self,
        history: list[dict],
        summary: str,
        compression_ratio: float,
    ) -> str:
        """Archive compressed history to database."""
        if not self._database:
            return ""

        archive_id = str(uuid.uuid4())
        try:
            # Store in database
            self._database.record_timeline_event(
                source="context_compact",
                event_type="conversation_archive",
                importance=0,  # Low importance, just for record
                content=json.dumps({
                    "archive_id": archive_id,
                    "turns": len(history),
                    "summary": summary,
                    "compression_ratio": compression_ratio,
                    "full_history": history,  # Optional: can be large
                }, ensure_ascii=False),
            )
            return f"memory://conversation_archives/{archive_id}"
        except Exception:
            return ""


def build_compact_prompt_for_model(
    summary: str,
    preserved_context: str = "",
) -> str:
    """Build system prompt for compacted context.

    This is injected at the beginning of the conversation after compaction.
    """
    parts = [
        "[上下文已压缩 - 以下是对话历史摘要]",
        "",
        summary,
    ]
    if preserved_context:
        parts.extend([
            "",
            "[保留的关键信息]",
            preserved_context,
        ])
    parts.extend([
        "",
        "[压缩说明] 历史对话已摘要处理，如需查看完整历史请使用 /history 命令。",
    ])
    return "\n".join(parts)
