"""Memory facade for chat-side recall, updates, and future Ombre integration."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from time import perf_counter

from personal_agent.config import AppConfig
from personal_agent.context_budget import trim_context
from personal_agent.db import Database
from personal_agent.memory import (
    build_memory_context,
    extract_profile_memory,
    extract_working_memory,
    memory_similarity,
    parse_memory_content,
    render_memory_for_prompt,
    serialize_memory_content,
)
from personal_agent.memory_llm import LLMMemoryExtractor, MemoryExtractionResult
from personal_agent.memory_retriever import HybridMemoryRetriever
from personal_agent.memory_types import MemoryStoreDecision, OmbreMemoryBackend
from personal_agent.ombre_mcp import OmbreMCPMemoryBackend
from personal_agent.vector_memory_index import VectorMemoryIndex


@dataclass(frozen=True)
class MemoryRecallResult:
    """Structured recall result returned to the chat agent layer."""

    should_inject: bool
    short_term_memories: tuple[str, ...] = ()
    long_term_memories: tuple[str, ...] = ()
    core_memories: tuple[str, ...] = ()
    rendered_context: str = ""
    used_sources: tuple[str, ...] = ()
    injection_level: str = "none"
    topic_associations: tuple[str, ...] = ()  # 话题关联的记忆


@dataclass(frozen=True)
class MemoryUpdateResult:
    """Summarizes what changed after processing one user turn."""

    working_written: bool = False
    profile_written: bool = False
    long_term_candidate: dict[str, object] | None = None
    core_candidate: dict[str, object] | None = None
    fallback_used: bool = False


@dataclass(frozen=True)
class SessionSupport:
    """Minimal short-term support payload for continuity builders."""

    recent_user_messages: tuple[str, ...] = ()
    working_memories: tuple[str, ...] = ()
    profile_memories: tuple[str, ...] = ()


class DisabledMemoryExtractor:
    """Safe extractor fallback used when the specialist is built without one."""

    def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
        del user_text, recent_history
        return MemoryExtractionResult(
            decision="skip",
            memory=None,
            source="disabled",
            should_fallback=True,
        )


class MemorySpecialist:
    """Chat-side memory facade for local recall, updates, and future Ombre hooks."""

    def __init__(
        self,
        database: Database,
        logger: logging.Logger,
        config: AppConfig,
        memory_extractor: LLMMemoryExtractor | None = None,
        memory_retriever: HybridMemoryRetriever | None = None,
        vector_backend=None,
        ombre_backend: OmbreMemoryBackend | None = None,
    ) -> None:
        self._database = database
        self._logger = logger
        self._config = config
        self._memory_extractor = memory_extractor or DisabledMemoryExtractor()
        resolved_vector_backend = vector_backend
        if resolved_vector_backend is None and getattr(config, "vector_memory_enabled", False):
            resolved_vector_backend = VectorMemoryIndex(database=database, logger=logger, config=config)
        self._memory_retriever = memory_retriever or HybridMemoryRetriever(
            database=database,
            logger=logger,
            config=config,
            vector_backend=resolved_vector_backend,
        )
        self._ombre_backend = ombre_backend or OmbreMCPMemoryBackend(config=config, logger=logger)

    def execute_background_maintenance(self) -> dict[str, object]:
        """Execute background memory maintenance when opportunity is judged as silent.
        
        This method performs memory housekeeping without user interaction:
        - Reviews working memory retention
        - Identifies candidates for resurfacing
        - Promotes valuable memories to long-term
        """
        results = {
            "working_memories_reviewed": 0,
            "old_memories_cleaned": 0,
            "resurfacing_candidates": 0,
            "promoted_to_long_term": 0,
        }
        
        # Review working memories
        working_rows = self._database.get_working_memories(
            limit=self._config.working_memory_retention_limit + 10
        )
        results["working_memories_reviewed"] = len(working_rows)
        
        # Clean old working memories
        if len(working_rows) > self._config.working_memory_retention_limit:
            deleted = self._database.delete_old_working_memories(
                keep_limit=self._config.working_memory_retention_limit
            )
            results["old_memories_cleaned"] = deleted
        
        # Identify resurfacing candidates (memories that might be relevant again)
        resurfacing_candidates = []
        for row in working_rows:
            content = str(row["content"])
            payload = parse_memory_content(content)
            if payload and payload.get("type") == "working":
                state = str(payload.get("state", "")).strip()
                # Check for unresolved states that might need follow-up
                if state in {"进行中", "待处理", "计划", "考虑中"}:
                    resurfacing_candidates.append({
                        "topic": payload.get("topic", ""),
                        "state": state,
                        "summary": payload.get("summary", ""),
                    })
        
        results["resurfacing_candidates"] = len(resurfacing_candidates)
        
        # Promote valuable working memories to long-term
        promotion_decisions = self.run_night_promotion(limit=2)
        results["promoted_to_long_term"] = sum(
            1 for d in promotion_decisions if d.action in {"stored_local_profile", "stored_ombre"}
        )
        
        # Store maintenance summary as timeline event
        self._database.record_timeline_event(
            source="memory_specialist",
            event_type="background_maintenance",
            importance=0,
            content=str(results),
        )
        
        self._logger.info(
            "memory background maintenance completed reviewed=%d cleaned=%d candidates=%d promoted=%d",
            results["working_memories_reviewed"],
            results["old_memories_cleaned"],
            results["resurfacing_candidates"],
            results["promoted_to_long_term"],
        )
        
        return results

    def recall_for_turn(
        self,
        *,
        user_text: str,
        route: str,
        response_mode: str,
    ) -> MemoryRecallResult:
        """Return the structured memory needed for the current turn."""

        if route != "text_chat" or not self.should_inject_memory(user_text):
            return MemoryRecallResult(should_inject=False)

        profile_rows = self._database.get_profile_memories(limit=self._config.profile_memory_limit)
        working_rows = self._database.get_working_memories(limit=self._config.working_memory_limit)
        short_term_memories = tuple(str(row["content"]) for row in working_rows)
        long_term_memories = tuple(str(row["content"]) for row in profile_rows)
        
        # Get ombre brain memories
        ombre_memories = self._ombre_backend.recall(
            user_text=user_text,
            response_mode=response_mode,
        )
        
        # Find topic-associated memories for proactive surfacing
        topic_associations = self.find_associated_memories(
            user_text=user_text,
            recent_memories=short_term_memories,
            long_term_memories=long_term_memories + ombre_memories,
            max_associations=3,
        )
        
        # Build enhanced context with topic associations
        rendered_context = build_memory_context(
            profile_memories=long_term_memories + ombre_memories,
            working_memories=short_term_memories,
        )
        
        # Add topic associations to context if found
        if topic_associations:
            association_text = "【相关记忆】\n" + "\n".join(f"- {mem}" for mem in topic_associations)
            if rendered_context:
                rendered_context = f"{rendered_context}\n\n{association_text}"
            else:
                rendered_context = association_text
        
        used_sources = []
        if short_term_memories:
            used_sources.append("local_short_memory")
        if long_term_memories:
            used_sources.append("local_profile_memory")
        if ombre_memories:
            used_sources.append("ombre_long_memory")
        if topic_associations:
            used_sources.append("topic_association")

        return MemoryRecallResult(
            should_inject=bool(rendered_context.strip()),
            short_term_memories=short_term_memories,
            long_term_memories=long_term_memories,
            core_memories=(),
            rendered_context=rendered_context,
            used_sources=tuple(used_sources),
            injection_level="light" if rendered_context.strip() else "none",
            topic_associations=topic_associations,
        )

    def recall_local_for_turn(
        self,
        *,
        user_text: str,
        route: str,
        response_mode: str,
        session_support: SessionSupport,
    ) -> MemoryRecallResult:
        """Return sync local recall only, without extra remote/LLM memory calls."""

        started = perf_counter()
        if route != "text_chat" or not self.should_inject_memory(user_text):
            result = MemoryRecallResult(should_inject=False)
            self._logger.info(
                "memory sync recall should_inject=%s short=%s profile=%s ombre=%s elapsed_seconds=%.3f route=%s mode=%s",
                result.should_inject,
                0,
                0,
                0,
                perf_counter() - started,
                route,
                response_mode,
            )
            return result

        short_term_memories = tuple(session_support.working_memories[: self._config.working_memory_limit])
        long_term_memories = tuple(session_support.profile_memories[: self._config.profile_memory_limit])
        rendered_context = build_memory_context(
            profile_memories=long_term_memories,
            working_memories=short_term_memories,
        )
        used_sources = []
        if short_term_memories:
            used_sources.append("local_short_memory")
        if long_term_memories:
            used_sources.append("local_profile_memory")

        result = MemoryRecallResult(
            should_inject=bool(rendered_context.strip()),
            short_term_memories=short_term_memories,
            long_term_memories=long_term_memories,
            core_memories=(),
            rendered_context=rendered_context,
            used_sources=tuple(used_sources),
            injection_level="light" if rendered_context.strip() else "none",
        )
        self._logger.info(
            "memory sync recall should_inject=%s short=%s profile=%s ombre=%s elapsed_seconds=%.3f route=%s mode=%s",
            result.should_inject,
            len(short_term_memories),
            len(long_term_memories),
            0,
            perf_counter() - started,
            route,
            response_mode,
        )
        return result

    def build_memory_context(self, recall_result: MemoryRecallResult) -> str:
        """Return the rendered memory block without recomputing recall."""

        return trim_context(recall_result.rendered_context, self._config.memory_context_max_chars)

    def update_from_user_turn(self, user_text: str) -> MemoryUpdateResult:
        """Update local short memory after one user turn."""

        cleaned = user_text.strip()
        if not cleaned:
            return MemoryUpdateResult()
        normalized = re.sub(r"\s+", "", cleaned).strip().lower()
        if not normalized:
            return MemoryUpdateResult()

        # Fast-path skip for low-information and task/technical turns:
        # these turns are unlikely to produce useful durable memory and can
        # otherwise add one extra LLM request latency before main reply.
        if self._is_low_information_message(normalized) or self._is_task_or_technical_message(normalized):
            self._logger.info("memory extraction skipped reason=low_value_turn")
            return MemoryUpdateResult()

        recent_history = self._database.get_recent_user_messages(
            limit=self._config.profile_memory_history_limit
        )
        extraction_result = self._memory_extractor.extract(
            user_text=user_text,
            recent_history=recent_history,
        )
        if not extraction_result.should_fallback:
            return self._store_extraction_result(extraction_result)

        self._logger.info("memory extraction falling back to rules source=%s", extraction_result.source)
        return self._update_with_rules(user_text, recent_history)

    def update_from_agent_turn(
        self,
        *,
        channel: str,
        sender_id: str,
        reply_text: str,
    ) -> MemoryStoreDecision:
        """Keep agent-turn updates minimal in Phase 1."""

        del channel, sender_id, reply_text
        return MemoryStoreDecision(action="skip", source="local_agent_turn")

    def get_session_support(self, channel: str) -> SessionSupport:
        """Return the local short-term support used by continuity builders."""

        recent_messages = self._database.get_recent_channel_messages(
            channel=channel,
            limit=self._config.session_recent_user_messages_limit,
        )
        working_memories = tuple(
            str(row["content"])
            for row in self._database.get_working_memories(limit=self._config.working_memory_limit)
        )
        profile_memories = tuple(
            str(row["content"])
            for row in self._database.get_profile_memories(limit=2)
        )
        return SessionSupport(
            recent_user_messages=tuple(recent_messages),
            working_memories=working_memories,
            profile_memories=profile_memories,
        )

    def get_exploration_memories(self, limit: int = 3) -> tuple[str, ...]:
        """Get recent exploration memories for context injection.

        Returns exploration memories stored via store_exploration_memory tool.
        These are working memories with category='exploration'.
        """
        working_memories = self._database.get_working_memories(limit=limit + 10)
        exploration_memories = []

        for row in working_memories:
            content = str(row["content"])
            payload = parse_memory_content(content)
            if payload and payload.get("category") == "exploration":
                rendered = render_memory_for_prompt(content)
                if rendered:
                    exploration_memories.append(rendered)
                    if len(exploration_memories) >= limit:
                        break

        return tuple(exploration_memories)

    def maybe_store_long_term(self, candidate: dict[str, object] | None) -> MemoryStoreDecision:
        """Return a conservative long-term decision without forcing Ombre writes."""

        if not candidate:
            return MemoryStoreDecision(action="skip", source="local")

        memory_type = str(candidate.get("type", "")).strip().lower()
        if memory_type == "profile":
            decision = self._ombre_backend.store_long_term(candidate)
            if decision.action != "skip":
                return decision
            self._store_memory_payload(candidate)
            return MemoryStoreDecision(action="stored_local_profile", candidate=candidate, source="local")
        return self._ombre_backend.store_long_term(candidate)

    def maybe_store_core(self, candidate: dict[str, object] | None) -> MemoryStoreDecision:
        """Keep core-memory writes disabled in the first migration step."""

        if not candidate:
            return MemoryStoreDecision(action="skip", source="local")
        return self._ombre_backend.store_core(candidate)

    def build_night_long_term_candidates(self, limit: int = 3) -> tuple[dict[str, object], ...]:
        """Build conservative long-term candidates from current short-term memory."""

        candidates: list[dict[str, object]] = []
        for row in self._database.get_working_memories(limit=limit):
            candidate = self._build_long_term_candidate_from_working(str(row["content"]))
            if candidate:
                candidates.append(candidate)
        return tuple(candidates)

    def run_night_promotion(self, limit: int = 3) -> tuple[MemoryStoreDecision, ...]:
        """Promote a small set of high-value nightly candidates into long-term memory."""

        decisions: list[MemoryStoreDecision] = []
        for candidate in self.build_night_long_term_candidates(limit=limit):
            decisions.append(self.maybe_store_long_term(candidate))
            if str(candidate.get("category", "")).strip() in {"relationship", "value"}:
                decisions.append(self.maybe_store_core(candidate))
        return tuple(decisions)

    def should_inject_memory(self, user_text: str) -> bool:
        """Gate memory injection so lightweight turns stay prompt-light."""

        normalized = re.sub(r"\s+", "", user_text).strip().lower()
        if not normalized:
            return False

        if self._is_low_information_message(normalized):
            return False

        if self._is_task_or_technical_message(normalized):
            return False

        return True

    def _store_extraction_result(self, extraction_result: MemoryExtractionResult) -> MemoryUpdateResult:
        if extraction_result.memory is None:
            return MemoryUpdateResult()

        memory_type = str(extraction_result.memory.get("type", "")).strip().lower()
        if memory_type == "working":
            self._store_memory_payload(extraction_result.memory)
            return MemoryUpdateResult(
                working_written=True,
                profile_written=False,
                fallback_used=False,
            )

        store_decision = self.maybe_store_long_term(extraction_result.memory)
        return MemoryUpdateResult(
            working_written=False,
            profile_written=store_decision.action == "stored_local_profile",
            long_term_candidate=extraction_result.memory if memory_type == "profile" else None,
            fallback_used=False,
        )

    def _update_with_rules(self, user_text: str, recent_history: list[str]) -> MemoryUpdateResult:
        working_written = False
        profile_written = False

        working_memory = extract_working_memory(user_text)
        if working_memory and not self._memory_exists("working", working_memory):
            self._store_memory_payload(working_memory)
            working_written = True

        profile_memory = extract_profile_memory(
            user_text=user_text,
            history=recent_history,
            repeat_threshold=self._config.profile_memory_repeat_threshold,
        )
        long_term_candidate = None
        if profile_memory and not self._memory_exists("profile", profile_memory):
            decision = self.maybe_store_long_term(profile_memory)
            profile_written = decision.action == "stored_local_profile"
            if decision.candidate is not None:
                long_term_candidate = decision.candidate

        return MemoryUpdateResult(
            working_written=working_written,
            profile_written=profile_written,
            long_term_candidate=long_term_candidate,
            fallback_used=True,
        )

    def _store_memory_payload(self, memory_payload: dict[str, object]) -> None:
        memory_type = str(memory_payload.get("type", "")).strip().lower()
        if memory_type not in {"working", "profile"}:
            return
        if self._memory_exists(memory_type, memory_payload):
            return

        importance = 2 if memory_type == "profile" else 1
        self._database.store_memory(
            content=serialize_memory_content(memory_payload),
            memory_type=memory_type,
            importance=importance,
        )
        if memory_type == "working":
            self._database.delete_old_working_memories(
                keep_limit=self._config.working_memory_retention_limit
            )

    def _memory_exists(self, memory_type: str, content: str | dict[str, object]) -> bool:
        existing_memories = self._database.get_memories_by_type(memory_type)
        return any(memory_similarity(str(row["content"]), content) for row in existing_memories)

    def _is_low_information_message(self, normalized_text: str) -> bool:
        short_messages = {
            "嗯",
            "嗯嗯",
            "哦",
            "哦哦",
            "好",
            "好的",
            "行",
            "行吧",
            "在吗",
            "收到",
            "哈哈",
            "哈",
            "ha",
            "haha",
            "ok",
            "okk",
            "okok",
        }
        if normalized_text in short_messages:
            return True

        if len(normalized_text) <= 3 and all(char in "嗯哦啊哈呀欸唉好在吗?" for char in normalized_text):
            return True

        if len(normalized_text) <= 4 and re.fullmatch(r"[哈啊嗯哦呀欸]+", normalized_text):
            return True

        return False

    def _is_task_or_technical_message(self, normalized_text: str) -> bool:
        technical_markers = (
            "python",
            "java",
            "javascript",
            "typescript",
            "bug",
            "error",
            "traceback",
            "exception",
            "stack",
            "api",
            "http",
            "json",
            "sql",
            "sqlite",
            "pip",
            "npm",
            "curl",
            "bash",
            "shell",
            "函数",
            "脚本",
            "命令",
            "报错",
            "报错了",
            "安装",
            "运行",
            "修复",
            "改下",
            "帮我写",
            "给我写",
            "实现",
            "代码",
            "接口",
            "路径",
            "文件",
        )

        if any(marker in normalized_text for marker in technical_markers):
            return True

        if any(symbol in normalized_text for symbol in ("def ", "class ", "=>", "{}", "[]", "</", "/Users/", "src/")):
            return True

        if "/" in normalized_text and any(token in normalized_text for token in ("src/", "tests/", ".py", ".js", ".json")):
            return True

        return False

    def _build_long_term_candidate_from_working(self, content: str) -> dict[str, object] | None:
        payload = parse_memory_content(content)
        if not payload or payload.get("type") != "working":
            rendered = render_memory_for_prompt(content)
            if not rendered:
                return None
            return {
                "type": "profile",
                "category": "life",
                "trait": rendered[:32],
                "summary": rendered[:48],
            }

        topic = str(payload.get("topic", "")).strip()
        state = str(payload.get("state", "")).strip()
        summary = str(payload.get("summary", "")).strip()
        if not (topic or summary):
            return None

        category = "life"
        topic_lower = topic.lower()
        if any(marker in topic for marker in ("论文", "答辩", "考试")):
            category = "study"
        elif any(marker in topic for marker in ("项目", "工作")) or "project" in topic_lower:
            category = "work"
        elif any(marker in topic for marker in ("朋友", "家人", "关系")):
            category = "relationship"

        trait = topic or summary[:32]
        normalized_summary = summary or f"用户近阶段主要在{topic}。"
        if state:
            normalized_summary = f"{normalized_summary.rstrip('。')} 当前状态偏{state}。"

        return {
            "type": "profile",
            "category": category,
            "trait": trait[:32],
            "summary": normalized_summary[:72],
        }

    def extract_topics(self, user_text: str) -> tuple[str, ...]:
        """Extract key topics from user text for memory association."""
        # Simple keyword-based topic extraction
        topic_keywords = {
            "论文": ["论文", "答辩", "毕业", "导师", "修改", "提纲"],
            "工作": ["工作", "项目", "代码", "开发", "需求", "会议"],
            "生活": ["休息", "睡觉", "吃饭", "运动", "健康", "身体"],
            "情绪": ["开心", "难过", "焦虑", "压力", "累", "烦"],
            "计划": ["计划", "安排", "明天", "后天", "周末", "假期"],
            "学习": ["学习", "看书", "课程", "考试", "复习", "备考"],
            "娱乐": ["游戏", "电影", "剧", "音乐", "玩", "放松"],
            "社交": ["朋友", "聚会", "聊天", "见面", "约"],
            "家庭": ["家人", "父母", "家里", "回家", "爸妈"],
        }
        
        found_topics: list[str] = []
        text_lower = user_text.lower()
        
        for topic, keywords in topic_keywords.items():
            if any(kw in text_lower for kw in keywords):
                found_topics.append(topic)
        
        return tuple(found_topics)

    def find_associated_memories(
        self,
        user_text: str,
        recent_memories: tuple[str, ...],
        long_term_memories: tuple[str, ...],
        max_associations: int = 3,
    ) -> tuple[str, ...]:
        """Find memories associated with current topics."""
        query_parts = [user_text, *self.extract_topics(user_text)]
        retriever_hits = self._memory_retriever.retrieve(
            user_text=" ".join(part for part in query_parts if part),
            limit=max_associations,
            memory_types=("working", "profile"),
        )
        associations = [hit.rendered_text for hit in retriever_hits if hit.rendered_text.strip()]
        if associations:
            return tuple(associations[:max_associations])

        topics = self.extract_topics(user_text)
        if not topics:
            return ()

        associations = []
        all_memories = list(recent_memories) + list(long_term_memories)

        for memory in all_memories:
            memory_lower = memory.lower()
            for topic in topics:
                topic_keywords = {
                    "论文": ["论文", "答辩", "毕业", "导师"],
                    "工作": ["工作", "项目", "代码", "开发"],
                    "生活": ["休息", "睡觉", "吃饭", "运动"],
                    "情绪": ["开心", "难过", "焦虑", "压力"],
                    "计划": ["计划", "安排", "明天", "周末"],
                    "学习": ["学习", "看书", "课程", "考试"],
                    "娱乐": ["游戏", "电影", "剧", "音乐"],
                    "社交": ["朋友", "聚会", "聊天", "见面"],
                    "家庭": ["家人", "父母", "家里", "爸妈"],
                }.get(topic, [topic])

                if any(kw in memory_lower for kw in topic_keywords):
                    rendered = render_memory_for_prompt(memory)
                    if rendered and rendered not in associations:
                        associations.append(rendered)
                        if len(associations) >= max_associations:
                            return tuple(associations)
                        break

        return tuple(associations)
