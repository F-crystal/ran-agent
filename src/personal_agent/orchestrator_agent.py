"""Internal orchestration agent that decides route/context/actions and delegates speaking."""

from __future__ import annotations

import concurrent.futures
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from time import perf_counter

from personal_agent.agent_internal_state import (
    AgentActionTrace,
    AgentInternalState,
    OpportunityTrace,
    PendingItem,
    SuppressedOpportunityTrace,
    apply_decisions,
    append_opportunities,
    load_agent_internal_state,
    save_agent_internal_state,
)
from personal_agent.config import AppConfig
from personal_agent.conversation_state import (
    ConversationSessionState,
    build_session_id,
    parse_session_state,
    serialize_session_state,
    update_session_state,
)
from personal_agent.db import Database
from personal_agent.interfaces.chat import IncomingMessage
from personal_agent.interfaces.model import ModelClient, ModelRequest
from personal_agent.context_compact import ContextCompactor, CompactionResult
from personal_agent.exploration_specialist import ExplorationSpecialist
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.life_loop import LifeOpportunity
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.preference_profile import load_preference_weak_reference
from personal_agent.reflection_specialist import ReflectionSpecialist
from personal_agent.qwen_agent_runtime import QwenAgentRuntime
from personal_agent.reply_reviewer import ReplyReviewResult
from personal_agent.temporal_context import TemporalContextSnapshot, build_temporal_context_snapshot
from personal_agent.tool_registry import build_local_tool_registry


@dataclass(frozen=True)
class OrchestratorTurnResult:
    """Structured result for one handled turn returned to the service layer."""

    reply_text: str
    provider: str
    is_error: bool
    route: str
    response_mode: str
    memory_context: str
    retry_performed: bool
    review_result: ReplyReviewResult
    first_draft_text: str
    session_state: ConversationSessionState
    temporal_snapshot: TemporalContextSnapshot


@dataclass(frozen=True)
class OpportunityJudgment:
    """Structured decision made by the orchestrator for one life opportunity."""

    opportunity_id: str
    kind: str
    action: str
    reason: str
    uses_local_context: bool = False
    notes: str = ""
    suggested_text: str = ""


@dataclass(frozen=True)
class OpportunityExecutionBatch:
    """Structured opportunity evaluation with real actions ready for execution."""

    judgments: tuple[OpportunityJudgment, ...]
    surfaced_count: int
    outbound_messages: tuple[object, ...] = ()


@dataclass(frozen=True)
class _RouteDecision:
    route: str
    reason: str


SEARCH_INTENT_PATTERNS = (
    re.compile(r"(上网查查|上网搜搜|上网查一下|上网搜一下)"),
    re.compile(r"(帮我搜一下|帮我查一下|帮我搜搜|帮我查查)"),
    re.compile(r"(搜一下|查一下|搜搜|查查).*(最新|新闻|消息|情况|信息)?"),
    re.compile(r"(看看最新的|看下最新的|看一下最新的)"),
    re.compile(r"(最新(情况|消息|新闻|价格|汇率|天气|动态))"),
)

VISION_INTENT_PATTERNS = (
    re.compile(r"(看图理解|看图|帮我看看这张图|帮我看下这张图|看看这张图|图里是什么)"),
    re.compile(r"(识图|图片里|照片里|截图里)"),
)


class OrchestratorAgent:
    """Turn-level orchestrator that coordinates context and delegates final speaking."""

    def __init__(
        self,
        *,
        database: Database,
        model_client: ModelClient,
        logger: logging.Logger,
        config: AppConfig,
        system_prompt: str,
        memory_specialist: MemorySpecialist,
        tool_model_client: ModelClient | None = None,
        reflection_specialist: ReflectionSpecialist | None = None,
        knowledge_agent: KnowledgeAgent | None = None,
        exploration_specialist: ExplorationSpecialist | None = None,
    ) -> None:
        del system_prompt
        self._database = database
        self._model_client = model_client
        self._tool_model_client = tool_model_client
        self._logger = logger
        self._config = config
        self._memory_specialist = memory_specialist
        self._reflection_specialist = reflection_specialist
        self._knowledge_agent = knowledge_agent
        self._exploration_specialist = exploration_specialist
        self._tool_registry = build_local_tool_registry(
            database=database,
            memory_specialist=memory_specialist,
            config=config,
        )
        self._qwen_agent_runtime = QwenAgentRuntime(
            chat_model_client=model_client,
            tool_model_client=tool_model_client,
            tool_registry=self._tool_registry,
            logger=logger,
        )
        self._local_gather_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="pa_local_gather",
        )
        # Context compression for long conversations
        self._context_compactor = ContextCompactor(
            database=database,
            context_window=getattr(config, 'context_window', 120000),
        )

    def get_reviewer_stats(self) -> dict[str, int]:
        """Return placeholder reviewer counters after frontend retirement."""

        return {
            "reviewer_trigger_count": 0,
            "reviewer_retry_count": 0,
            "reviewer_first_pass_success_count": 0,
            "reviewer_retry_success_count": 0,
            "off_topic_count": 0,
            "recent_state_over_inference_count": 0,
        }

    def handle_turn(
        self,
        message: IncomingMessage,
        *,
        now_local: datetime,
    ) -> OrchestratorTurnResult:
        """Frontend turn handling is retired; Hermes gateway owns chat mainline."""

        del message, now_local
        raise RuntimeError("/chat frontend path is retired; use Hermes Gateway")

    def evaluate_opportunities(
        self,
        opportunities: tuple[LifeOpportunity, ...],
        *,
        now_local: datetime,
    ) -> OpportunityExecutionBatch:
        """Apply lightweight judgment and produce executable actions for opportunities."""

        started = perf_counter()
        state = load_agent_internal_state(self._database)
        opportunity_traces = [
            OpportunityTrace(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                attention_hint=opportunity.attention_hint,
                status=opportunity.status,
                reason=opportunity.reason,
                created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
            )
            for opportunity in opportunities
        ]
        state = append_opportunities(state, traces=opportunity_traces, now_local=now_local)

        judgment_started = perf_counter()
        judgments: list[OpportunityJudgment] = []
        action_traces: list[AgentActionTrace] = []
        suppressed_traces: list[SuppressedOpportunityTrace] = []
        pending_items: list[PendingItem] = []
        for opportunity in opportunities:
            judgment = self._judge_opportunity(
                opportunity,
                state=state,
                now_local=now_local,
            )
            judgments.append(judgment)
            action_traces.append(
                AgentActionTrace(
                    opportunity_id=judgment.opportunity_id,
                    kind=judgment.kind,
                    action=judgment.action,
                    reason=judgment.reason,
                    created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
                )
            )
            if judgment.action in {"defer", "drop"}:
                suppressed_traces.append(
                    SuppressedOpportunityTrace(
                        opportunity_id=judgment.opportunity_id,
                        kind=judgment.kind,
                        action=judgment.action,
                        reason=judgment.reason,
                        created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
                    )
                )
            if judgment.action in {"defer", "inspect_more"}:
                pending_items.append(
                    PendingItem(
                        opportunity_id=judgment.opportunity_id,
                        kind=judgment.kind,
                        action=judgment.action,
                        reason=judgment.reason,
                        expires_at=opportunity.expires_at,
                        created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
                    )
                )
            # Execute background work for silent actions
            if judgment.action == "silent":
                self._execute_silent_work(opportunity, judgment)

        state = apply_decisions(
            state,
            actions=action_traces,
            suppressed=suppressed_traces,
            pending_items=pending_items,
            now_local=now_local,
        )
        save_agent_internal_state(self._database, state)

        judgment_elapsed = perf_counter() - judgment_started
        total_elapsed = perf_counter() - started
        self._logger.info(
            "orchestrator opportunity timing total_seconds=%.3f judgment_seconds=%.3f surfaced=%s actions=%s",
            total_elapsed,
            judgment_elapsed,
            len(judgments),
            ",".join(judgment.action for judgment in judgments) or "none",
        )
        return OpportunityExecutionBatch(
            judgments=tuple(judgments),
            surfaced_count=len(opportunities),
            outbound_messages=(),
        )

    def _execute_silent_work(
        self,
        opportunity: LifeOpportunity,
        judgment: OpportunityJudgment,
    ) -> None:
        """Execute background work for silent opportunities.
        
        This method routes silent opportunities to the appropriate specialist
        for background processing without user interaction.
        """
        kind = opportunity.kind
        consumer = opportunity.consumer
        
        self._logger.info(
            "executing silent work kind=%s consumer=%s opportunity_id=%s",
            kind,
            consumer,
            opportunity.id,
        )
        
        try:
            if kind == "reflection" and self._reflection_specialist:
                result = self._reflection_specialist.execute_background_work()
                self._logger.info(
                    "reflection background work completed status=%s samples=%d",
                    result.get("status"),
                    result.get("samples_analyzed", 0),
                )
            
            elif kind == "maintenance" and self._memory_specialist:
                result = self._memory_specialist.execute_background_maintenance()
                self._logger.info(
                    "memory background maintenance completed reviewed=%d cleaned=%d promoted=%d",
                    result.get("working_memories_reviewed", 0),
                    result.get("old_memories_cleaned", 0),
                    result.get("promoted_to_long_term", 0),
                )
            
            elif kind == "knowledge_maintenance" and self._knowledge_agent:
                from datetime import datetime
                result = self._knowledge_agent.execute_background_maintenance(
                    now_local=datetime.now()
                )
                self._logger.info(
                    "knowledge background maintenance completed action=%s status=%s processed=%d",
                    result.action,
                    result.status,
                    result.processed_inbox_count,
                )
            
            elif kind == "exploration" and self._exploration_specialist:
                result = self._exploration_specialist.execute_exploration()
                self._logger.info(
                    "exploration completed source=%s topic=%s items=%d",
                    result.source,
                    result.topic,
                    len(result.learned_items),
                )

            elif kind == "reminder":
                # Reminders are handled by the dedicated reminder_check_job
                # This is just a signal that reminders are available
                self._logger.info(
                    "reminder opportunity acknowledged - handled by reminder_check_job"
                )

            else:
                self._logger.warning(
                    "no handler for silent work kind=%s consumer=%s",
                    kind,
                    consumer,
                )
        
        except Exception as e:
            self._logger.exception(
                "silent work execution failed kind=%s error=%s",
                kind,
                str(e),
            )

    def _judge_opportunity(
        self,
        opportunity: LifeOpportunity,
        *,
        state: AgentInternalState,
        now_local: datetime,
    ) -> OpportunityJudgment:
        """Apply lightweight judgment without turning into a rigid rules engine."""

        del state, now_local

        if opportunity.kind == "exploration":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="silent",
                reason="exploration_fits_background_work",
            )

        if opportunity.kind == "reflection":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="silent",
                reason="offline_reflection_fits_background_work",
            )

        if opportunity.kind == "maintenance":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="silent",
                reason="maintenance_fits_background_work",
            )

        if opportunity.kind == "knowledge_maintenance":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="silent",
                reason="knowledge_maintenance_fits_background_work",
            )

        if opportunity.kind == "companion":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="drop",
                reason="legacy_companion_proactive_retired",
            )

        if opportunity.kind != "companion":
            return OpportunityJudgment(
                opportunity_id=opportunity.id,
                kind=opportunity.kind,
                action="drop",
                reason="unsupported_opportunity_kind",
            )

    def _load_session_state(self, message: IncomingMessage) -> ConversationSessionState:
        """Load one short-lived session state from handoff storage."""

        session_id = build_session_id(message.channel, message.sender_id)
        raw_value = self._database.get_handoff_value(f"conversation_session_state:{session_id}")
        if not raw_value:
            return ConversationSessionState(session_id=session_id)
        return parse_session_state(raw_value, session_id=session_id)

    def _save_session_state(
        self,
        *,
        message: IncomingMessage,
        previous_state: ConversationSessionState,
        response_mode: str,
        reply_text: str,
        temporal_snapshot: TemporalContextSnapshot,
        now_local: datetime,
    ) -> ConversationSessionState:
        """Persist the next short-lived session state after generating one reply."""

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

    def _build_temporal_snapshot(
        self,
        channel: str,
        session_state: ConversationSessionState,
        now_local: datetime,
    ) -> TemporalContextSnapshot:
        """Build one near-term context snapshot from recent chat activity and memories."""

        session_support = self._memory_specialist.get_session_support(channel=channel)
        return build_temporal_context_snapshot(
            recent_user_messages=list(session_support.recent_user_messages),
            session_state=session_state,
            working_memories=list(session_support.working_memories),
            profile_memories=list(session_support.profile_memories),
            now_local=now_local,
        )

    def _build_temporal_snapshot_from_support(
        self,
        *,
        session_support,
        session_state: ConversationSessionState,
        now_local: datetime,
    ) -> TemporalContextSnapshot:
        """Build temporal snapshot from pre-gathered session support."""

        return build_temporal_context_snapshot(
            recent_user_messages=list(session_support.recent_user_messages),
            session_state=session_state,
            working_memories=list(session_support.working_memories),
            profile_memories=list(session_support.profile_memories),
            now_local=now_local,
        )

    def _gather_local_context_parallel(
        self,
        *,
        channel: str,
        route: str,
        response_mode: str,
        user_text: str,
    ):
        """Parallelize local specialist reads needed before one reply."""

        @dataclass(frozen=True)
        class _GatheredContext:
            session_support: object
            knowledge_state: KnowledgeState
            preference_hint: str
            agent_internal_state: AgentInternalState
            knowledge_elapsed_seconds: float

        def _timed_call(fn, *args):
            started = perf_counter()
            result = fn(*args)
            return result, perf_counter() - started

        futures = {
            "session_support": self._local_gather_executor.submit(
                _timed_call,
                self._memory_specialist.get_session_support,
                channel,
            ),
            "knowledge_state": self._local_gather_executor.submit(
                _timed_call,
                load_knowledge_state,
                self._config,
            ),
            "preference": self._local_gather_executor.submit(
                _timed_call,
                lambda: load_preference_weak_reference(self._config).render_for_prompt().strip(),
            ),
            "agent_internal_state": self._local_gather_executor.submit(
                _timed_call,
                load_agent_internal_state,
                self._database,
            ),
        }
        results = {name: future.result() for name, future in futures.items()}
        self._logger.info(
            "orchestrator local gather session_support=%.3f knowledge_state=%.3f preference=%.3f agent_state=%.3f route=%s mode=%s",
            results["session_support"][1],
            results["knowledge_state"][1],
            results["preference"][1],
            results["agent_internal_state"][1],
            route,
            response_mode,
        )
        return _GatheredContext(
            session_support=results["session_support"][0],
            knowledge_state=results["knowledge_state"][0],
            preference_hint=str(results["preference"][0] or "").strip(),
            agent_internal_state=results["agent_internal_state"][0],
            knowledge_elapsed_seconds=results["knowledge_state"][1],
        )

    def _render_agent_state_hint(self, state: AgentInternalState) -> str:
        """Return one compact internal-state hint line for continuity context."""

        parts: list[str] = []
        if state.pending_items:
            parts.append(f"pending={len(state.pending_items)}")
        if state.last_proactive_at:
            parts.append(f"last_proactive_at={state.last_proactive_at}")
        return "; ".join(parts)

    def _decide_request_route(
        self,
        *,
        text: str,
        image_urls: tuple[str, ...] = (),
        route_hint: str = "",
    ) -> _RouteDecision:
        """Keep route selection in one orchestrator instead of scattering across modules."""

        normalized_hint = route_hint.strip().lower()
        if normalized_hint in {"web_search", "vision_understand", "text_chat"}:
            return _RouteDecision(route=normalized_hint, reason="route_hint")

        if image_urls:
            return _RouteDecision(route="vision_understand", reason="image_input")

        normalized_text = " ".join(text.split()).strip()
        if not normalized_text:
            return _RouteDecision(route="text_chat", reason="empty_text")

        if any(pattern.search(normalized_text) for pattern in VISION_INTENT_PATTERNS):
            return _RouteDecision(route="vision_understand", reason="vision_intent")
        if any(pattern.search(normalized_text) for pattern in SEARCH_INTENT_PATTERNS):
            return _RouteDecision(route="web_search", reason="search_intent")
        return _RouteDecision(route="text_chat", reason="default")

    def _decide_response_mode(self, *, user_text: str, route: str = "text_chat") -> str:
        """Keep response-mode choice inside orchestrator while separate from route."""

        normalized = " ".join(user_text.split()).strip().lower()
        if not normalized:
            return "casual_chat"
        if self._looks_playful_or_flirty(normalized):
            return "playful_flirty"
        if self._looks_emotional(normalized):
            return "emotional_support"
        if route == "web_search" or self._looks_info_request(normalized):
            return "info_request"
        if self._looks_task_help(normalized):
            return "task_help"
        return "casual_chat"

    def _looks_emotional(self, text: str) -> bool:
        return any(
            marker in text
            for marker in (
                "难受",
                "低落",
                "烦",
                "烦躁",
                "焦虑",
                "委屈",
                "难过",
                "困",
                "想哭",
                "崩溃",
                "撑不住",
                "好累",
                "很累",
                "心里堵",
            )
        )

    def _looks_task_help(self, text: str) -> bool:
        return any(
            marker in text
            for marker in (
                "帮我",
                "怎么做",
                "怎么办",
                "怎么弄",
                "修一下",
                "改一下",
                "看看这个",
                "处理一下",
                "写一下",
            )
        )

    def _looks_info_request(self, text: str) -> bool:
        return any(
            marker in text
            for marker in (
                "是什么",
                "什么意思",
                "为什么",
                "怎么回事",
                "最新",
                "搜一下",
                "查一下",
                "看一下",
            )
        )

    def _looks_playful_or_flirty(self, text: str) -> bool:
        patterns = (
            r"(想你|想我没|撒娇|亲亲|抱抱|哄我|夸我)",
            r"(晚安宝|宝贝|宝宝|乖不乖)",
            r"(调戏|撩|暧昧)",
        )
        return any(re.search(pattern, text) for pattern in patterns)

    def check_and_compact_context(
        self,
        conversation_history: list[dict],
        *,
        force: bool = False,
        strategy: str = "auto",
        custom_focus: str = "",
    ) -> CompactionResult:
        """Check context length and compact if needed.

        This method should be called before sending conversation to LLM.
        It automatically compresses history when token count exceeds threshold.

        Args:
            conversation_history: Full conversation history
            force: Force compaction even if under threshold
            strategy: Compaction strategy (auto, handoff, micro, aggressive)
            custom_focus: User-specified focus for handoff summary

        Returns:
            CompactionResult with status and compressed history info
        """
        if not force:
            should_compact, reason = self._context_compactor.should_compact(
                conversation_history
            )
            if not should_compact:
                return CompactionResult(
                    status="skipped",
                    strategy=strategy,
                    original_tokens=self._context_compactor.estimate_tokens(
                        json.dumps(conversation_history, ensure_ascii=False)
                    ),
                    compacted_tokens=0,
                    summary="",
                    reason=reason,
                    preserved_turn_count=0,
                )

        self._logger.info(
            "context compaction triggered strategy=%s history_len=%d",
            strategy,
            len(conversation_history),
        )

        result = self._context_compactor.compact(
            conversation_history=conversation_history,
            strategy=strategy,
            custom_focus=custom_focus,
            preserve_recent_turns=2,
            preserve_tool_outputs=True,
        )

        if result.status == "compacted":
            self._logger.info(
                "context compaction completed ratio=%.2f original=%d compacted=%d archived=%d",
                result.compression_ratio,
                result.original_tokens,
                result.compacted_tokens,
                result.archived_turns,
            )
        elif result.status == "failed":
            self._logger.warning(
                "context compaction failed error=%s",
                getattr(result, 'error', 'unknown'),
            )

        return result

    def apply_compaction_to_messages(
        self,
        messages: list[dict],
        compaction_result: CompactionResult,
    ) -> list[dict]:
        """Apply compaction result to message list.

        Replaces old history with compacted summary while preserving recent turns.
        """
        if compaction_result.status != "compacted":
            return messages

        # Build compacted message list
        compacted_messages = [
            {
                "role": "system",
                "content": f"[上下文已压缩] 历史摘要：\n{compaction_result.summary}",
            }
        ]

        # Add preserved recent turns (last N turns from original)
        preserved_count = compaction_result.preserved_turn_count
        if preserved_count > 0:
            compacted_messages.extend(messages[-preserved_count:])
        else:
            # Fallback: keep last 2 messages
            compacted_messages.extend(messages[-2:])

        return compacted_messages
