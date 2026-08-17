"""Backend capabilities facade (no frontend chat orchestration)."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from time import perf_counter

from personal_agent.config import AppConfig
from personal_agent.context_budget import trim_context
from personal_agent.context_compact import ContextCompactor
from personal_agent.db import Database
from personal_agent.inbox_sync import write_external_exchange_to_inbox
from personal_agent.media_dedup import MediaDedupService
from personal_agent.interfaces.chat import IncomingMessage, OutgoingMessage
from personal_agent.interfaces.model import ModelClient, ModelRequest, PlaceholderModelClient
from personal_agent.exploration_specialist import ExplorationSpecialist
from personal_agent.conversation_state import (
    ConversationSessionState,
    build_session_id,
    parse_session_state,
    serialize_session_state,
    update_session_state,
)
from personal_agent.temporal_context import build_temporal_context_snapshot, render_temporal_context
from personal_agent.reply_reviewer import ReplyReviewResult, build_retry_instruction, review_reply
from personal_agent.knowledge_agent import KnowledgeAgent, load_knowledge_state
from personal_agent.knowledge_retriever import KnowledgeRetriever
from personal_agent.life_loop import LifeLoop, LifeOpportunity
from personal_agent.memory_llm import LLMMemoryExtractor
from personal_agent.memory_specialist import DisabledMemoryExtractor, MemorySpecialist
from personal_agent.memory import extract_repeated_learning_candidates
from personal_agent.night_cycle import NightCycle
from personal_agent.orchestrator_agent import OrchestratorAgent
from personal_agent.outbound_channel import NodeBridgeOutboundClient
from personal_agent.personal_learning import PersonalLearningRecord, PersonalLearningStore
from personal_agent.reflection_specialist import ReflectionSpecialist


@dataclass(frozen=True)
class LifeOpportunityJudgment:
    """Backend-only placeholder judgment for surfaced opportunities."""

    opportunity_id: str
    kind: str
    action: str
    reason: str
    uses_local_context: bool
    suggested_text: str | None = None


@dataclass(frozen=True)
class LifeOpportunityExecutionBatch:
    """Compatibility container for scheduler life-loop logging."""

    judgments: tuple[LifeOpportunityJudgment, ...]
    outbound_messages: tuple[dict[str, object], ...] = ()


class _ConversationAgentFacade:
    """Small prompt builder used by the backend turn handler."""

    def __init__(self, *, service: "PersonalAgentService") -> None:
        self._service = service

    def _build_system_prompt(
        self,
        memory_context: str,
        continuity_context: str,
        *,
        route: str = "text_chat",
        response_mode: str = "casual_chat",
        tool_use: bool = False,
    ) -> str:
        config = self._service._config
        base_prompt = config.tool_use_system_prompt if tool_use else config.agent_system_prompt
        extra_prompt = self._service._system_prompt_override.strip()

        identity_lines = [base_prompt.strip()]
        if extra_prompt and extra_prompt not in identity_lines:
            identity_lines.append(extra_prompt)

        behavior_lines = [f"- 当前 response mode：{response_mode}"]
        if route != "text_chat":
            behavior_lines.append("- 这是工具或多模态请求，直接完成任务，不要暴露内部路由。")
        if response_mode == "emotional_support":
            behavior_lines.append("- 先直接回应当下感受，不要立刻推测长期原因。")
        elif response_mode == "playful_flirty":
            behavior_lines.append("- 亲昵称呼只是弱控制信号，不要过度升级亲密度。")
        elif response_mode == "task_help":
            behavior_lines.append("- 优先给出可执行、清楚的帮助。")
        elif response_mode == "info_request":
            behavior_lines.append("- 直接回答用户关心的信息点。")
        else:
            behavior_lines.append("- 保持自然、简短、贴着当下语境。")
        behavior_lines.extend(
            [
                "- 不要写括号里的动作、停顿、表情说明或舞台说明。",
                "- 不要暴露 memory 的来源。",
                "- 不要把回复写成小说台词或角色扮演。",
            ]
        )

        prompt_lines = [
            "## 1. 身份与语气（Identity & Tone）",
            *identity_lines,
            "",
            "## 2. 行为规则（Behavior Rules）",
            *behavior_lines,
            "",
            "## Session Continuity Context",
            "## 3. Session Continuity Context",
            continuity_context.strip() or "- 当前没有明显的连续性补充。",
            "",
            "## 4. Memory Context（动态注入）",
            memory_context.strip() or "当前没有可用的 memory context。",
            "",
            "## 5. Memory 使用规则",
            "- memory 只用于辅助理解用户。",
            "- 不暴露来源，不提“我翻过记录”这类说法。",
            "- 自然记得，不要强调记忆机制本身。",
        ]
        return "\n".join(prompt_lines).strip()


class PersonalAgentService:
    """Provides project-local backend capabilities for tool calls."""

    _knowledge_actions = {"auto", "plan", "apply", "cleanup", "daily_carryover"}

    def __init__(
        self,
        database: Database,
        model_client: ModelClient,
        logger: logging.Logger,
        config: AppConfig | None = None,
        system_prompt: str = "",
        tool_model_client: ModelClient | None = None,
        memory_extractor: object | None = None,
        knowledge_agent: KnowledgeAgent | None = None,
    ) -> None:
        self._config = config or database.config
        self._database = database
        self._model_client = model_client
        self._tool_model_client = tool_model_client or model_client
        self._logger = logger
        self._system_prompt_override = system_prompt
        self._memory_extractor = memory_extractor or (
            LLMMemoryExtractor(
                model_client=self._tool_model_client,
                logger=logger,
                config=self._config,
            )
            if self._config.memory_llm_enabled
            else DisabledMemoryExtractor()
        )
        self._memory_specialist = MemorySpecialist(
            database=database,
            logger=logger,
            config=self._config,
            memory_extractor=self._memory_extractor,
        )
        self._personal_learning = PersonalLearningStore(database=database, config=self._config)
        self._reflection_specialist = ReflectionSpecialist(
            database=database,
            config=self._config,
            logger=logger,
        )
        self._knowledge_agent = knowledge_agent or KnowledgeAgent(config=self._config, logger=logger)
        self._dedup_service = MediaDedupService(database=database, vault_root=self._config.vault_dir)
        self._knowledge_retriever = KnowledgeRetriever(self._config)
        self._exploration_specialist = ExplorationSpecialist(
            database=database,
            config=self._config,
            logger=logger,
        )
        self._context_compactor = ContextCompactor(
            database=database,
            context_window=getattr(self._config, "context_window", 120000),
        )
        self._conversation_agent = _ConversationAgentFacade(service=self)
        self._orchestrator_agent = OrchestratorAgent(
            database=database,
            model_client=model_client,
            logger=logger,
            config=self._config,
            system_prompt=system_prompt,
            memory_specialist=self._memory_specialist,
            tool_model_client=tool_model_client,
            reflection_specialist=self._reflection_specialist,
            knowledge_agent=self._knowledge_agent,
            exploration_specialist=self._exploration_specialist,
        )
        self._outbound_client = NodeBridgeOutboundClient(self._config)
        self._post_reply_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="pa_post_reply",
        )
        self._reviewer_stats = {
            "reviewer_trigger_count": 0,
            "reviewer_retry_count": 0,
            "reviewer_first_pass_success_count": 0,
            "reviewer_retry_success_count": 0,
            "retry_success_count": 0,
            "off_topic_count": 0,
            "recent_state_over_inference_count": 0,
            "blacklisted_opening_count": 0,
            "casual_became_advisory_count": 0,
            "intimate_or_emotional_became_meta_count": 0,
            "mechanism_leak_count": 0,
            "wrong_vision_tool_explanation_count": 0,
            "social_media_retry_needed_count": 0,
            "over_courtly_template_count": 0,
            "unnatural_conversation_flow_count": 0,
            "overlong_systemic_explanation_count": 0,
        }
        self._executor_closed = False

    def shutdown(self) -> None:
        """Release local background resources used by deferred pipelines."""

        if self._executor_closed:
            return
        self._post_reply_executor.shutdown(wait=True, cancel_futures=False)
        self._executor_closed = True

    def __del__(self) -> None:
        try:
            self.shutdown()
        except Exception:
            pass

    def handle_incoming_message(self, message: IncomingMessage) -> OutgoingMessage:
        """Handle one backend turn locally without the retired frontend path."""

        local_now = self._get_local_now()
        route_decision = self._orchestrator_agent._decide_request_route(
            text=message.text,
            image_urls=message.image_urls,
            route_hint=message.route_hint,
        )
        response_mode = self._orchestrator_agent._decide_response_mode(
            user_text=message.text,
            route=route_decision.route,
        )
        session_state = self._load_session_state(message)
        session_support = self._memory_specialist.get_session_support(message.channel)
        temporal_snapshot = self._build_temporal_snapshot_from_support(
            session_support=session_support,
            session_state=session_state,
            now_local=local_now,
            current_user_text=message.text,
        )
        recall_result = self._memory_specialist.recall_local_for_turn(
            user_text=message.text,
            route=route_decision.route,
            response_mode=response_mode,
            session_support=session_support,
        )
        legacy_memory_context = self._memory_specialist.build_memory_context(recall_result)
        personal_learning_context = self._recall_personal_learning_context(message.text)
        memory_context = trim_context(
            "\n".join(
                part
                for part in (personal_learning_context, legacy_memory_context)
                if part.strip()
            ),
            self._config.memory_context_max_chars,
        )
        daily_context = self._load_daily_context()
        reflection_context = self._load_reflection_context()
        continuity_context = self._build_continuity_context(
            session_state=session_state,
            temporal_snapshot=temporal_snapshot,
            route=route_decision.route,
            response_mode=response_mode,
            user_text=message.text,
        )
        tool_use = route_decision.route in {"web_search", "vision_understand"}
        system_prompt = self._conversation_agent._build_system_prompt(
            memory_context,
            continuity_context,
            route=route_decision.route,
            response_mode=response_mode,
            tool_use=tool_use,
        )
        request = self._build_model_request(
            message=message,
            route=route_decision.route,
            response_mode=response_mode,
            system_prompt=system_prompt,
            memory_context=memory_context,
            daily_context=daily_context,
            reflection_context=reflection_context,
        )
        client = self._tool_model_client if tool_use else self._model_client
        first_response = client.generate_reply(request)
        reply_text = first_response.text
        review_result = ReplyReviewResult(triggered=False, reasons=())
        retry_performed = False
        retry_success = False

        if route_decision.route == "text_chat" and self._config.reviewer_enabled:
            review_result = review_reply(
                reply_text=reply_text,
                user_text=message.text,
                response_mode=response_mode,
                session_state=session_state,
                temporal_snapshot=temporal_snapshot,
                blacklist_enabled=self._config.reviewer_blacklist_enabled,
                off_topic_check_enabled=self._config.off_topic_check_enabled,
            )
            if review_result.triggered:
                self._reviewer_stats["reviewer_trigger_count"] += 1
                self._increment_reviewer_reason_counters(review_result.reasons)
                retry_performed = True
                retry_request = ModelRequest(
                    system_prompt=(
                        f"{system_prompt}\n\n[Reviewer Retry]\n"
                        + build_retry_instruction(
                            review_result.reasons,
                            response_mode,
                            session_state,
                            temporal_snapshot,
                        )
                    ),
                    user_message=message.text,
                    memory_context=memory_context,
                    daily_context=daily_context,
                    reflection_context=reflection_context,
                    image_urls=message.image_urls,
                    tool_name=request.tool_name,
                )
                retry_response = client.generate_reply(retry_request)
                reply_text = retry_response.text
                self._reviewer_stats["reviewer_retry_count"] += 1
                retry_review = review_reply(
                    reply_text=reply_text,
                    user_text=message.text,
                    response_mode=response_mode,
                    session_state=session_state,
                    temporal_snapshot=temporal_snapshot,
                    blacklist_enabled=self._config.reviewer_blacklist_enabled,
                    off_topic_check_enabled=self._config.off_topic_check_enabled,
                )
                if not retry_review.triggered:
                    self._reviewer_stats["reviewer_retry_success_count"] += 1
                    self._reviewer_stats["retry_success_count"] += 1
                    retry_success = True
            else:
                self._reviewer_stats["reviewer_first_pass_success_count"] += 1
        else:
            self._reviewer_stats["reviewer_first_pass_success_count"] += 1

        user_content = message.text if message.text != "" else ("[image]" if message.image_urls else "")
        self._database.record_timeline_event(
            source=message.channel,
            event_type="user_message",
            content=user_content,
            tags="message,user",
            importance=1,
        )
        self._database.record_timeline_event(
            source="agent",
            event_type="agent_reply",
            content=reply_text,
            tags=f"message,reply,{message.channel}",
            importance=1,
        )
        next_state = self._save_session_state(
            message=message,
            previous_state=session_state,
            response_mode=response_mode,
            reply_text=reply_text,
            temporal_snapshot=temporal_snapshot,
            now_local=local_now,
        )
        if route_decision.route == "text_chat":
            self._database.record_reply_review_observation(
                channel=message.channel,
                sender_id=message.sender_id,
                route=route_decision.route,
                response_mode=response_mode,
                current_topic=session_state.current_topic or getattr(temporal_snapshot, "active_project", ""),
                intimacy_level=session_state.intimacy_level,
                recent_turn_summary=next_state.recent_turn_summary[-1] if next_state.recent_turn_summary else "",
                time_of_day=getattr(temporal_snapshot, "current_time_of_day", ""),
                user_message=message.text,
                first_draft=first_response.text,
                final_reply=reply_text,
                review_triggered=review_result.triggered,
                review_reasons=json.dumps(list(review_result.reasons), ensure_ascii=False),
                retry_performed=retry_performed,
                retry_success=retry_success,
                false_positive_candidate=review_result.false_positive_candidate,
                user_dissatisfaction_signal=False,
            )
        self._schedule_post_reply_memory_update(
            channel=message.channel,
            sender_id=message.sender_id,
            user_text=message.text,
        )
        return OutgoingMessage(
            channel=message.channel,
            recipient_id=message.sender_id,
            text=reply_text,
        )

    def get_reviewer_stats(self) -> dict[str, int]:
        """Reviewer stats are retired with Python frontend runtime."""

        return dict(self._reviewer_stats)

    def get_memory_specialist(self) -> MemorySpecialist:
        """Expose shared memory backend facade."""

        return self._memory_specialist

    def evaluate_life_opportunities(
        self,
        opportunities: tuple[LifeOpportunity, ...],
        *,
        now_local: datetime | None = None,
    ) -> LifeOpportunityExecutionBatch:
        """Evaluate background life-loop opportunities without legacy proactive sends."""

        local_now = now_local or datetime.now()
        retired_judgments = tuple(
            LifeOpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="drop",
                reason="legacy_companion_proactive_retired",
                uses_local_context=False,
            )
            for opportunity in opportunities
            if opportunity.kind == "companion"
        )
        background_opportunities = tuple(
            opportunity for opportunity in opportunities if opportunity.kind != "companion"
        )
        execution_batch = (
            self._orchestrator_agent.evaluate_opportunities(
                background_opportunities,
                now_local=local_now,
            )
            if background_opportunities
            else None
        )
        judgments = tuple(
            LifeOpportunityJudgment(
                opportunity_id=item.opportunity_id,
                kind=item.kind,
                action=item.action,
                reason=item.reason,
                uses_local_context=item.uses_local_context,
                suggested_text=item.suggested_text or None,
            )
            for item in (execution_batch.judgments if execution_batch else ())
        )
        return LifeOpportunityExecutionBatch(
            judgments=(*retired_judgments, *judgments),
            outbound_messages=(),
        )

    def run_life_loop_state(self, *, now_local: datetime | None = None) -> dict[str, object]:
        """Run one life-loop pass and return state payload."""

        result = LifeLoop(
            config=self._config,
            database=self._database,
            logger=self._logger,
            memory_specialist=self._memory_specialist,
        ).run(now_local=now_local)
        return {
            "generated_at": result.generated_at,
            "opportunities": [item.to_dict() for item in result.opportunities],
        }

    def run_night_cycle_state(self) -> dict[str, object]:
        """Run one night-cycle pass and return structured state payload."""

        result = NightCycle(
            config=self._config,
            database=self._database,
            memory_specialist=self._memory_specialist,
            logger=self._logger,
        ).run()
        return {
            "summary_date": result.summary_date,
            "daily_summary": result.daily_summary,
            "cleared_session_count": result.cleared_session_count,
            "promoted_count": result.promoted_count,
            "knowledge_action": result.knowledge_action,
            "knowledge_status": result.knowledge_status,
            "knowledge_inbox_path": str(result.knowledge_inbox_path),
            "persona_proposal_path": result.persona_proposal_path,
            "daily_context_key": "daily_context:latest",
            "reflection_digest_key": "night_cycle:latest_reflection_digest",
        }

    def compact_conversation_context(
        self,
        *,
        channel: str,
        sender_id: str,
        focus: str = "",
        strategy: str = "handoff",
        preserve_recent_turns: int = 2,
    ) -> dict[str, object]:
        """Compact one channel-scoped conversation history and persist the summary."""

        normalized_channel = str(channel).strip() or "wechat"
        normalized_sender_id = str(sender_id).strip()
        session_id = build_session_id(normalized_channel, normalized_sender_id)
        history = self._build_compaction_history(normalized_channel)
        normalized_strategy = str(strategy).strip() or "handoff"
        result = self._context_compactor.compact(
            conversation_history=history,
            strategy=normalized_strategy,  # type: ignore[arg-type]
            custom_focus=str(focus).strip(),
            preserve_recent_turns=max(1, int(preserve_recent_turns) if str(preserve_recent_turns).strip() else 2),
            preserve_tool_outputs=True,
        )

        if result.status == "compacted":
            current_state = self._load_session_state_by_id(session_id)
            refreshed_summaries = tuple(
                item
                for item in (
                    result.summary.strip(),
                    *current_state.recent_turn_summary,
                )
                if item
            )[:2]
            refreshed_state = ConversationSessionState(
                session_id=session_id,
                current_topic=current_state.current_topic,
                current_mode=current_state.current_mode,
                pending_thread=current_state.pending_thread,
                last_user_intent=current_state.last_user_intent,
                intimacy_level=current_state.intimacy_level,
                last_user_ts=current_state.last_user_ts,
                last_agent_ts=current_state.last_agent_ts,
                current_time_of_day=current_state.current_time_of_day,
                recent_turn_summary=refreshed_summaries,
            )
            self._database.set_handoff_value(
                f"conversation_session_state:{session_id}",
                serialize_session_state(refreshed_state),
            )

        reply_text = self._render_compaction_reply(result, focus=focus)
        return {
            "session_id": session_id,
            "reply_text": reply_text,
            "status": result.status,
            "strategy": result.strategy,
            "original_tokens": result.original_tokens,
            "compacted_tokens": result.compacted_tokens,
            "summary": result.summary,
            "reason": result.reason,
            "error": result.error,
            "preserved_items": list(result.preserved_items),
            "archived_turns": result.archived_turns,
            "archive_path": result.archive_path,
            "compression_ratio": result.compression_ratio,
        }

    def run_knowledge_maintenance(self, *, action: str = "auto", trigger: str = "manual") -> dict[str, object]:
        """Run knowledge maintenance and return structured tool-call output."""

        normalized_action = str(action).strip() or "auto"
        normalized_trigger = str(trigger).strip() or "manual"
        if normalized_action not in self._knowledge_actions:
            raise ValueError("action must be one of: auto, plan, apply, cleanup, daily_carryover")
        if normalized_action == "auto":
            result = self._knowledge_agent.auto_run(trigger=normalized_trigger)
        else:
            result = self._knowledge_agent.run(action=normalized_action, trigger=normalized_trigger)
        return {
            "action": result.action,
            "trigger": result.trigger,
            "status": result.status,
            "started_at": result.started_at,
            "finished_at": result.finished_at,
            "inbox_count_before": result.inbox_count_before,
            "inbox_count_after": result.inbox_count_after,
            "processed_inbox_count": result.processed_inbox_count,
            "pending_knowledge_maintenance": result.pending_knowledge_maintenance,
            "recent_curated_topics": list(result.recent_curated_topics),
            "recent_source_additions": list(result.recent_source_additions),
            "output_excerpt": result.output_excerpt,
            "error": result.error,
        }

    def run_reflection(self) -> dict[str, object]:
        """Run one reflection pass and return summary payload."""

        report = self._reflection_specialist.generate_report(limit=self._config.self_reflection_sample_limit)
        return {
            "output_path": str(report.output_path),
            "total_samples": report.metrics.total_samples,
            "trigger_rate": report.metrics.reviewer_trigger_rate,
            "top_rules": [
                {
                    "rule": rule,
                    "count": count,
                }
                for rule, count in report.top_rules
            ],
            "advisory_only": True,
        }

    def run_memory_maintenance(self) -> dict[str, object]:
        """Run the existing bounded background memory maintenance pass."""

        return dict(self._memory_specialist.execute_background_maintenance())

    def get_knowledge_state(self) -> dict[str, object]:
        """Return latest lightweight knowledge-maintenance state."""

        state = load_knowledge_state(self._config)
        return {
            "updated_at": state.updated_at,
            "last_checked_at": state.last_checked_at,
            "last_run_at": state.last_run_at,
            "last_action": state.last_action,
            "last_trigger": state.last_trigger,
            "last_status": state.last_status,
            "inbox_count": state.inbox_count,
            "processed_inbox_count": state.processed_inbox_count,
            "pending_knowledge_maintenance": state.pending_knowledge_maintenance,
            "last_error": state.last_error,
            "last_output_excerpt": state.last_output_excerpt,
            "recent_curated_topics": list(state.recent_curated_topics),
            "recent_source_additions": list(state.recent_source_additions),
        }

    def recall_memory(self, user_text: str, *, route: str = "text_chat", response_mode: str = "chat") -> dict[str, object]:
        """Return structured memory recall payload for tool callers."""

        recall = self._memory_specialist.recall_for_turn(
            user_text=user_text,
            route=route,
            response_mode=response_mode,
            explicit=True,
        )
        knowledge_hits = self._knowledge_retriever.retrieve(user_text)
        personal_learning_context = self._recall_personal_learning_context(user_text)
        rendered_context = "\n\n".join(
            part for part in (personal_learning_context, recall.rendered_context) if part.strip()
        )
        if knowledge_hits:
            knowledge_context = "【知识库线索】\n" + "\n".join(
                f"- {hit.title}（{hit.path}）：{hit.snippet}" for hit in knowledge_hits
            )
            rendered_context = f"{rendered_context}\n\n{knowledge_context}" if rendered_context else knowledge_context
        used_sources = list(recall.used_sources)
        if personal_learning_context:
            used_sources.append("personal_learning")
        if knowledge_hits:
            used_sources.append("vault_knowledge")
        source_status = dict(recall.source_statuses)
        source_status["personal_learning"] = "hit" if personal_learning_context else "empty"
        source_status["vault_knowledge"] = "hit" if knowledge_hits else "empty"
        injection_level = recall.injection_level if recall.should_inject else (
            "light" if personal_learning_context or knowledge_hits else "none"
        )
        return {
            "should_inject": bool(rendered_context.strip()),
            "short_term_memories": list(recall.short_term_memories),
            "long_term_memories": list(recall.long_term_memories),
            "core_memories": list(recall.core_memories),
            "rendered_context": trim_context(
                rendered_context,
                self._config.memory_context_max_chars,
            ),
            "used_sources": used_sources,
            "source_status": source_status,
            "knowledge_hits": [hit.__dict__ for hit in knowledge_hits],
            "injection_level": injection_level,
        }

    def update_memory(self, user_text: str) -> dict[str, object]:
        """Run one memory extraction/update pass for a user turn."""

        result = self._memory_specialist.update_from_user_turn(user_text)
        return {
            "working_written": result.working_written,
            "profile_written": result.profile_written,
            "long_term_candidate": result.long_term_candidate,
            "core_candidate": result.core_candidate,
            "fallback_used": result.fallback_used,
        }

    def observe_personal_learning(
        self,
        *,
        kind: str,
        subject_key: str,
        statement: str,
        source: str,
        evidence_digests: list[str] | tuple[str, ...],
        confidence: float,
    ) -> dict[str, object]:
        """Record one sanitized learning observation through the sole lifecycle."""

        record = self._personal_learning.observe(
            kind=kind,
            subject_key=subject_key,
            statement=statement,
            source=source,
            evidence_digests=evidence_digests,
            confidence=confidence,
        )
        if record.status == "active":
            self._project_personal_learning_best_effort()
        return _personal_learning_payload(record)

    def query_personal_learning(
        self,
        *,
        subject_prefix: str = "",
        limit: int = 50,
    ) -> list[dict[str, object]]:
        """Return only active learning records, bounded for private callers."""

        return [
            _personal_learning_payload(record)
            for record in self._personal_learning.list_active(
                subject_prefix=subject_prefix,
                limit=limit,
            )
        ]

    def _recall_personal_learning_context(self, user_text: str) -> str:
        records = self._personal_learning.recall_relevant(user_text, limit=5)
        if not records:
            return ""
        return "\n".join(
            ["[已确认的个人偏好]", *(f"- {record.statement}" for record in records)]
        )

    def forget_personal_learning(self, subject_key: str) -> dict[str, int]:
        """Forget active/candidate learning without mutating legacy memory."""

        forgotten_count = self._personal_learning.forget(subject_key)
        if forgotten_count:
            self._project_personal_learning_best_effort()
        return {"forgotten_count": forgotten_count}

    def _project_personal_learning_best_effort(self) -> None:
        try:
            self._personal_learning.project_compatibility_views()
        except (OSError, ValueError, TypeError):
            self._logger.exception("personal learning compatibility projection failed")

    def store_exploration_memory(
        self,
        *,
        topic: str,
        source: str,
        summary: str,
        key_insights: tuple[str, ...] = (),
        relevance_to_user: str = "",
    ) -> dict[str, object]:
        """Store exploration result as a working memory."""
        from personal_agent.memory import serialize_memory_content

        memory_payload = {
            "type": "working",
            "category": "exploration",
            "topic": topic,
            "source": source,
            "summary": summary,
            "key_insights": list(key_insights),
            "relevance_to_user": relevance_to_user,
            "time_scope": "recent",
            "state": "已探索",
        }

        try:
            memory_id = self._database.store_memory(
                content=serialize_memory_content(memory_payload),
                memory_type="working",
                importance=1,
            )

            self._database.record_timeline_event(
                source="exploration_specialist",
                event_type="exploration",
                importance=1,
                content=json.dumps(
                    {
                        "topic": topic,
                        "source": source,
                        "summary": summary,
                        "key_insights": list(key_insights),
                        "explored_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    ensure_ascii=False,
                ),
            )

            self._logger.info(
                "exploration memory stored topic=%s source=%s memory_id=%d",
                topic,
                source,
                memory_id,
            )

            return {
                "success": True,
                "memory_id": memory_id,
                "topic": topic,
            }
        except Exception as e:
            self._logger.exception("failed to store exploration memory")
            return {
                "success": False,
                "error": str(e),
            }

    def get_session_support(self, channel: str) -> dict[str, object]:
        """Return lightweight session support payload."""

        support = self._memory_specialist.get_session_support(channel)
        return {
            "recent_user_messages": list(support.recent_user_messages),
            "working_memories": list(support.working_memories),
            "profile_memories": list(support.profile_memories),
        }

    def record_external_exchange(
        self,
        channel: str,
        sender_id: str,
        user_text: str,
        reply_text: str,
        source: str,
        media_refs: tuple[str, ...] = (),
        event_id: str = "",
    ) -> str:
        """Store a user/agent exchange generated outside Python frontend path."""

        self._logger.info(
            "recording external exchange source_hash=%s channel_hash=%s sender_hash=%s",
            _private_log_digest(source),
            _private_log_digest(channel),
            _private_log_digest(sender_id),
        )
        if event_id:
            outcome = self._database.record_external_exchange_once(
                event_id=event_id,
                channel=channel,
                sender_id=sender_id,
                user_text=user_text,
                reply_text=reply_text,
                source=source,
                media_refs=media_refs,
            )
            if outcome != "stored":
                self._logger.info("external exchange durable projection outcome=%s", outcome)
                return outcome
        else:
            self._database.record_timeline_event(
                source=channel,
                event_type="user_message",
                content=user_text,
                tags=f"message,user,{source}",
                importance=1,
            )
            self._database.record_timeline_event(
                source="agent",
                event_type="agent_reply",
                content=reply_text,
                tags=f"message,reply,{channel},{source}",
                importance=1,
            )
            outcome = "stored"
        try:
            write_external_exchange_to_inbox(
                config=self._config,
                channel=channel,
                sender_id=sender_id,
                source=source,
                user_text=user_text,
                reply_text=reply_text,
                media_refs=media_refs,
                dedup_service=self._dedup_service,
            )
            self._logger.info("external exchange synced to vault inbox")
        except Exception:
            self._logger.warning(
                "external exchange inbox sync failed channel_hash=%s sender_hash=%s source_hash=%s",
                _private_log_digest(channel),
                _private_log_digest(sender_id),
                _private_log_digest(source),
            )
        self._schedule_post_reply_memory_update(
            channel=channel,
            sender_id=sender_id,
            user_text=user_text,
            evidence_seed=event_id,
        )
        return outcome

    def _schedule_post_reply_memory_update(
        self,
        *,
        channel: str,
        sender_id: str,
        user_text: str,
        evidence_seed: str = "",
    ) -> None:
        if not user_text.strip():
            return
        if isinstance(self._model_client, PlaceholderModelClient):
            self._run_deferred_memory_pipeline(channel, sender_id, user_text, evidence_seed)
            return
        self._post_reply_executor.submit(
            self._run_deferred_memory_pipeline,
            channel,
            sender_id,
            user_text,
            evidence_seed,
        )

    def _run_deferred_memory_pipeline(
        self,
        channel: str,
        sender_id: str,
        user_text: str,
        evidence_seed: str = "",
    ) -> None:
        started = perf_counter()
        self._logger.info(
            "memory async extraction started channel=%s sender_hash=%s",
            channel,
            _private_log_digest(sender_id),
        )
        try:
            self._observe_repeated_personal_learning(user_text, evidence_seed=evidence_seed)
            update_result = self._memory_specialist.update_from_user_turn(user_text)
            promotion_action = "skip"
            if update_result.long_term_candidate is not None:
                core_decision = self._memory_specialist.maybe_store_core(update_result.long_term_candidate)
                promotion_action = core_decision.action
            self._logger.info(
                "memory async extraction finished channel=%s sender_hash=%s elapsed_seconds=%.3f working_written=%s profile_written=%s fallback_used=%s deferred_promotion=%s",
                channel,
                _private_log_digest(sender_id),
                perf_counter() - started,
                update_result.working_written,
                update_result.profile_written,
                update_result.fallback_used,
                promotion_action,
            )
        except Exception:
            self._logger.exception(
                "memory async extraction failed channel=%s sender_hash=%s",
                channel,
                _private_log_digest(sender_id),
            )

    def _observe_repeated_personal_learning(self, user_text: str, *, evidence_seed: str = "") -> None:
        """Feed deterministic user-authored candidates without touching legacy memory."""

        for candidate in extract_repeated_learning_candidates(user_text, evidence_seed=evidence_seed):
            try:
                record = self._personal_learning.observe(
                    kind=candidate["kind"],
                    subject_key=candidate["subject_key"],
                    statement=candidate["statement"],
                    source="repeated_observation",
                    evidence_digests=[candidate["evidence_digest"]],
                    confidence=0.8,
                )
                if record.status == "active":
                    self._project_personal_learning_best_effort()
            except (TypeError, ValueError):
                self._logger.info("personal learning candidate rejected by safety validation")

    def record_verified_delivery_outcome(self, *, outcome: str, event_id: str) -> dict[str, object]:
        """Persist a fixed, non-executable lesson for a verified ambiguous delivery."""

        if str(outcome).strip().lower() != "ambiguous":
            raise ValueError("unsupported verified delivery outcome")
        normalized_event_id = str(event_id).strip()
        if not re.fullmatch(r"outbox_[a-f0-9]{32}", normalized_event_id):
            raise ValueError("invalid verified delivery outcome")
        record = self._personal_learning.observe(
            kind="operating_lesson",
            subject_key="operating:ambiguous-delivery",
            statement="不确定的外发结果不得盲目重发",
            source="verified_outcome",
            evidence_digests=[hashlib.sha256(normalized_event_id.encode("utf-8")).hexdigest()],
            confidence=1.0,
        )
        self._project_personal_learning_best_effort()
        return _personal_learning_payload(record)

    def send_proactive_message(
        self,
        text: str,
        channel: str = "wechat",
        seed: str = "",
        reason: str = "",
    ) -> dict[str, object]:
        """Reject the retired direct proactive text route.

        Visible proactive delivery must now go through structured ProactiveEvent
        synthetic turns so Hermes writes the message and Node applies egress.
        """
        self._logger.warning(
            "legacy proactive text route rejected channel=%s seed=%s reason=%s text_chars=%s",
            channel,
            seed,
            reason,
            len(text),
        )
        return {
            "success": False,
            "channel": channel,
            "text": text,
            "seed": seed,
            "reason": reason,
            "error": "legacy proactive text route retired; use send_proactive_event",
        }

    def register_core_reminder(self, *, todo_id: int, scheduled_for: str) -> dict[str, object]:
        """Best-effort immediate registration; the managed reminder scan is the recovery path."""

        return self._outbound_client.register_core_reminder(
            todo_id=todo_id,
            scheduled_for=scheduled_for,
        )

    def send_proactive_event(self, event: dict[str, object]) -> dict[str, object]:
        """Submit one structured proactive event through the Node bridge."""

        event_id = str(event.get("event_id") or event.get("eventId") or "").strip()
        kind = str(event.get("kind") or "").strip()
        self._logger.info("submitting proactive event kind=%s event_id=%s", kind, event_id)
        try:
            bridge_result = self._outbound_client.send_proactive_event(event)
        except Exception as e:
            self._logger.exception(
                "proactive event submit failed kind=%s event_id=%s error=%s",
                kind,
                event_id,
                str(e),
            )
            return {
                "success": False,
                "event_id": event_id,
                "kind": kind,
                "error": str(e),
            }
        success = bridge_result.get("notified") is True or bridge_result.get("status") == "sent"
        delivery_state = str(
            bridge_result.get("delivery_status") or bridge_result.get("outbox_status") or ""
        ).strip().lower()
        if delivery_state == "ambiguous" and re.fullmatch(r"outbox_[a-f0-9]{32}", event_id):
            try:
                self.record_verified_delivery_outcome(outcome="ambiguous", event_id=event_id)
            except (TypeError, ValueError, OSError):
                self._logger.warning("verified delivery lesson was not persisted")
        if success:
            self._database.record_timeline_event(
                source="agent",
                event_type="agent_proactive",
                content=json.dumps(
                    {
                        "event_id": event_id,
                        "kind": kind,
                        "watch_scope": event.get("watch_scope", ""),
                        "reason": event.get("reason", ""),
                    },
                    ensure_ascii=False,
                ),
                tags=_build_proactive_tags(str(event.get("channel") or "feishu"), str(event.get("dedupe_key") or event_id)),
                importance=1,
            )
        return {
            "success": success,
            "event_id": event_id,
            "kind": kind,
            "bridge_result": bridge_result,
        }

    def send_ai_daily_digest(self, prompt: str, *, mode: str = "scheduled", operation_id: str = "", date: str = "") -> dict[str, object]:
        """Send one prepared AI daily digest prompt through Node bridge."""

        self._logger.info("sending prepared AI daily digest prompt_chars=%s", len(prompt))
        return self._outbound_client.send_ai_daily_digest(prompt, mode=mode, operation_id=operation_id, date=date)

    def _get_local_now(self) -> datetime:
        """Return the local clock for prompt and session-state building."""

        return datetime.now()

    def _load_session_state(self, message: IncomingMessage) -> ConversationSessionState:
        """Load one compact session state from handoff storage."""

        session_id = build_session_id(message.channel, message.sender_id)
        return self._load_session_state_by_id(session_id)

    def _load_session_state_by_id(self, session_id: str) -> ConversationSessionState:
        """Load one compact session state by id."""

        raw_value = self._database.get_handoff_value(f"conversation_session_state:{session_id}")
        if not raw_value:
            return ConversationSessionState(session_id=session_id)
        return parse_session_state(raw_value, session_id=session_id)

    def _build_compaction_history(self, channel: str, limit: int = 80) -> list[dict[str, object]]:
        """Build a compactable conversation history from timeline events."""

        events = self._database.fetch_timeline_events()
        recent_events = [
            event
            for event in events
            if str(event["source"]) in {channel, "agent"}
            and str(event["event_type"]) in {"user_message", "agent_reply", "agent_proactive"}
        ]
        recent_events = recent_events[-max(1, limit):]

        history: list[dict[str, object]] = []
        for event in recent_events:
            source = str(event["source"])
            event_type = str(event["event_type"])
            role = "user" if source == channel and event_type == "user_message" else "assistant"
            history.append(
                {
                    "role": role,
                    "content": str(event["content"]),
                    "source": source,
                    "event_type": event_type,
                }
            )
        return history

    def _render_compaction_reply(self, result, *, focus: str = "") -> str:
        """Render a short user-facing confirmation for manual compaction."""

        if result.status == "compacted":
            summary = str(result.summary).strip()
            if summary:
                if focus.strip():
                    return f"好，已经帮你压缩了当前上下文，重点是：{focus.strip()}。摘要：{summary}"
                return f"好，已经帮你压缩了当前上下文。摘要：{summary}"
            return "好，已经帮你压缩了当前上下文。"
        if result.status == "skipped":
            reason = str(result.reason).strip() or "当前内容还不够多，不需要压缩"
            return f"暂时不需要压缩：{reason}。"
        error = str(result.error).strip() or "压缩失败"
        return f"压缩失败：{error}。"
    def _load_daily_context(self) -> str:
        """Load the compact day-summary used for next-turn continuity."""

        return str(self._database.get_handoff_value("daily_context:latest") or "").strip()

    def _load_reflection_context(self) -> str:
        """Load the latest reflection digest used for continuity prompts."""

        return str(self._database.get_handoff_value("night_cycle:latest_reflection_digest") or "").strip()

    def _build_temporal_snapshot_from_support(
        self,
        *,
        session_support,
        session_state: ConversationSessionState,
        now_local: datetime,
        current_user_text: str = "",
    ):
        """Build temporal context from pre-gathered local support."""

        recent_user_messages = list(session_support.recent_user_messages)
        if current_user_text.strip():
            recent_user_messages.append(current_user_text)
        return build_temporal_context_snapshot(
            recent_user_messages=recent_user_messages,
            session_state=session_state,
            working_memories=list(session_support.working_memories),
            profile_memories=list(session_support.profile_memories),
            now_local=now_local,
        )

    def _save_session_state(
        self,
        *,
        message: IncomingMessage,
        previous_state: ConversationSessionState,
        response_mode: str,
        reply_text: str,
        temporal_snapshot,
        now_local: datetime,
    ) -> ConversationSessionState:
        """Persist one updated session state after generating a reply."""

        next_state = update_session_state(
            previous_state=previous_state,
            user_text=message.text,
            reply_text=reply_text,
            response_mode=response_mode,
            temporal_snapshot=temporal_snapshot,
            now_local=now_local,
        )
        self._database.set_handoff_value(
            f"conversation_session_state:{next_state.session_id}",
            serialize_session_state(next_state),
        )
        return next_state

    def _build_continuity_context(
        self,
        *,
        session_state: ConversationSessionState,
        temporal_snapshot,
        route: str,
        response_mode: str,
        user_text: str = "",
    ) -> str:
        """Render a compact continuity block for the current turn."""

        lines: list[str] = [
            f"- 当前 response mode：{response_mode}",
            f"- 当前 route：{route or 'text_chat'}",
        ]
        if session_state.current_topic:
            lines.append(f"- 当前话题：{session_state.current_topic}")
        if session_state.last_user_intent:
            lines.append(f"- 上一轮较明确的用户意图：{session_state.last_user_intent}")
        if session_state.recent_turn_summary:
            lines.append(f"- 最近几轮压缩摘要：{'；'.join(session_state.recent_turn_summary)}")
        rendered_temporal = render_temporal_context(temporal_snapshot).strip()
        if rendered_temporal:
            lines.append(rendered_temporal)
        if getattr(temporal_snapshot, "current_state_is_recent", False):
            lines.append("- 先直接回应当下感受，不要立刻推测长期原因。")

        knowledge_state = load_knowledge_state(self._config)
        if knowledge_state.pending_knowledge_maintenance:
            lines.append("- 知识侧有待整理项")
        if knowledge_state.recent_curated_topics:
            lines.append(f"- 最近整理过的主题：{'、'.join(knowledge_state.recent_curated_topics)}")
        if knowledge_state.recent_source_additions:
            lines.append(f"- 最近新增来源：{'、'.join(knowledge_state.recent_source_additions)}")
        knowledge_hits = self._knowledge_retriever.retrieve(user_text)
        if knowledge_hits:
            lines.append("- 本轮可参考的知识片段：")
            for hit in knowledge_hits:
                lines.append(f"  • {hit.title}（{hit.path}）：{hit.snippet}")
        return trim_context(
            "\n".join(line for line in lines if line.strip()),
            self._config.continuity_context_max_chars,
        )

    def _build_model_request(
        self,
        *,
        message: IncomingMessage,
        route: str,
        response_mode: str,
        system_prompt: str,
        memory_context: str,
        daily_context: str,
        reflection_context: str,
    ) -> ModelRequest:
        """Build one structured model request for the current turn."""

        return ModelRequest(
            system_prompt=system_prompt,
            user_message=message.text,
            memory_context=trim_context(memory_context, self._config.memory_context_max_chars),
            daily_context=trim_context(daily_context, self._config.daily_context_max_chars),
            reflection_context=trim_context(
                reflection_context,
                self._config.reflection_context_max_chars,
            ),
            image_urls=message.image_urls,
            tool_name="web_search" if route == "web_search" else "",
        )

    def _increment_reviewer_reason_counters(self, reasons: tuple[str, ...]) -> None:
        reason_to_stat = {
            "blacklisted_opening": "blacklisted_opening_count",
            "off_topic": "off_topic_count",
            "recent_state_over_inference": "recent_state_over_inference_count",
            "casual_became_advisory": "casual_became_advisory_count",
            "intimate_or_emotional_became_meta": "intimate_or_emotional_became_meta_count",
            "mechanism_leak": "mechanism_leak_count",
            "wrong_vision_tool_explanation": "wrong_vision_tool_explanation_count",
            "social_media_retry_needed": "social_media_retry_needed_count",
            "over_courtly_template": "over_courtly_template_count",
            "unnatural_conversation_flow": "unnatural_conversation_flow_count",
            "overlong_systemic_explanation": "overlong_systemic_explanation_count",
        }
        for reason in reasons:
            stat_key = reason_to_stat.get(reason)
            if stat_key is not None:
                self._reviewer_stats[stat_key] += 1


def _personal_learning_payload(record: PersonalLearningRecord) -> dict[str, object]:
    return {
        "learning_id": record.learning_id,
        "kind": record.kind,
        "subject_key": record.subject_key,
        "statement": record.statement,
        "source": record.source,
        "evidence_digests": list(record.evidence_digests),
        "confidence": record.confidence,
        "status": record.status,
        "observation_count": record.observation_count,
        "created_at": record.created_at,
        "last_observed_at": record.last_observed_at,
        "last_confirmed_at": record.last_confirmed_at,
        "superseded_by": record.superseded_by,
    }


def _build_proactive_tags(channel: str, seed: str) -> str:
    tags = ["message", "proactive", channel]
    if seed:
        tags.append(f"seed:{seed}")
    return ",".join(tags)


def _private_log_digest(value: str) -> str:
    """Stable correlation token for logs that must not expose an identity."""

    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:24]
