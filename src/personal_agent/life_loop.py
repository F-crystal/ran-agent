"""Lightweight periodic layer that emits life opportunities without taking action."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.memory_specialist import MemorySpecialist


@dataclass(frozen=True)
class LifeOpportunity:
    """One lightweight life opportunity surfaced by the life loop."""

    id: str
    kind: str
    source: str
    consumer: str
    attention_hint: str
    reason: str
    context: dict[str, object]
    signals: dict[str, object]
    payload: dict[str, object]
    created_at: str
    expires_at: str
    status: str = "open"

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable dictionary representation."""

        return asdict(self)


@dataclass(frozen=True)
class LifeLoopRunResult:
    """Container for the opportunities emitted in one life-loop pass."""

    opportunities: tuple[LifeOpportunity, ...]
    generated_at: str


class LifeLoop:
    """Generates periodic background opportunities without visible proactive sends."""

    def __init__(
        self,
        *,
        config: AppConfig,
        database: Database,
        logger: logging.Logger,
        memory_specialist: MemorySpecialist | None = None,
        knowledge_agent: KnowledgeAgent | None = None,
    ) -> None:
        self._config = config
        self._database = database
        self._logger = logger
        self._memory_specialist = memory_specialist or MemorySpecialist(
            database=database,
            logger=logger,
            config=config,
        )
        self._knowledge_agent = knowledge_agent or KnowledgeAgent(config=config, logger=logger)

    def run(
        self,
        *,
        now_local: datetime | None = None,
        now_utc: datetime | None = None,
    ) -> LifeLoopRunResult:
        """Generate current lifecycle opportunities without executing downstream action."""

        local_now = now_local or datetime.now()
        del now_utc
        opportunities: list[LifeOpportunity] = []

        reflection_opportunity = self._build_reflection_opportunity(local_now=local_now)
        if reflection_opportunity is not None:
            opportunities.append(reflection_opportunity)

        maintenance_opportunity = self._build_memory_maintenance_opportunity(local_now=local_now)
        if maintenance_opportunity is not None:
            opportunities.append(maintenance_opportunity)

        knowledge_opportunity = self._build_knowledge_maintenance_opportunity(local_now=local_now)
        if knowledge_opportunity is not None:
            opportunities.append(knowledge_opportunity)

        exploration_opportunity = self._build_exploration_opportunity(local_now=local_now)
        if exploration_opportunity is not None:
            opportunities.append(exploration_opportunity)

        self._logger.info(
            "life loop generated opportunities count=%s kinds=%s",
            len(opportunities),
            ",".join(opportunity.kind for opportunity in opportunities) or "none",
        )
        return LifeLoopRunResult(
            opportunities=tuple(opportunities),
            generated_at=local_now.strftime("%Y-%m-%d %H:%M:%S"),
        )

    def _build_reflection_opportunity(self, *, local_now: datetime) -> LifeOpportunity | None:
        """Return one reflection opportunity when the reflection loop is due."""

        if not self._config.self_reflection_enabled:
            return None

        recent_observations = self._database.get_recent_reply_review_observations(limit=1)
        if not recent_observations:
            return None

        last_generated_at = self._get_loop_timestamp("life_loop:last_reflection_opportunity_at")
        if last_generated_at is not None and (
            local_now - last_generated_at
        ) < timedelta(minutes=self._config.self_reflection_interval_minutes):
            return None

        opportunity = self._new_opportunity(
            kind="reflection",
            consumer="reflection_specialist",
            attention_hint="background",
            reason="reflection interval reached and recent review observations are available",
            context={
                "sample_limit": self._config.self_reflection_sample_limit,
                "time_of_day": _time_of_day(local_now),
            },
            signals={
                "maintenance_value": "medium",
                "user_interrupt_risk": "none",
            },
            payload={
                "sample_limit": self._config.self_reflection_sample_limit,
            },
            created_at=local_now,
            ttl_minutes=self._config.self_reflection_interval_minutes,
        )
        self._set_loop_timestamp("life_loop:last_reflection_opportunity_at", local_now)
        return opportunity

    def _build_memory_maintenance_opportunity(self, *, local_now: datetime) -> LifeOpportunity | None:
        """Return one lightweight maintenance opportunity when local memory is active."""

        working_memories = self._database.get_working_memories(
            limit=self._config.working_memory_retention_limit + 1
        )
        if not working_memories:
            return None

        last_generated_at = self._get_loop_timestamp("life_loop:last_maintenance_opportunity_at")
        if last_generated_at is not None and (
            local_now - last_generated_at
        ) < timedelta(minutes=self._config.brain_loop_interval_minutes):
            return None

        opportunity = self._new_opportunity(
            kind="maintenance",
            consumer="memory_specialist",
            attention_hint="background",
            reason="local short-term memory is active and worth a maintenance pass",
            context={
                "working_memory_count": len(working_memories),
                "retention_limit": self._config.working_memory_retention_limit,
            },
            signals={
                "maintenance_value": "medium",
                "user_interrupt_risk": "none",
            },
            payload={
                "maintenance_scope": "local_short_memory",
                "suggested_actions": [
                    "review_working_memory_retention",
                    "check_resurfacing_candidates",
                ],
            },
            created_at=local_now,
            ttl_minutes=self._config.brain_loop_interval_minutes,
        )
        self._set_loop_timestamp("life_loop:last_maintenance_opportunity_at", local_now)
        return opportunity

    def _build_knowledge_maintenance_opportunity(self, *, local_now: datetime) -> LifeOpportunity | None:
        """Return one background knowledge-maintenance opportunity when inbox work is pending."""

        if not self._config.knowledge_agent_enabled:
            return None
        if not self._knowledge_agent.should_surface_maintenance(now_local=local_now):
            return None

        inbox_count = self._knowledge_agent.count_inbox_items()
        return self._new_opportunity(
            kind="knowledge_maintenance",
            consumer="knowledge_agent",
            attention_hint="background",
            reason="vault inbox has pending material worth a background knowledge pass",
            context={
                "inbox_count": inbox_count,
                "time_of_day": _time_of_day(local_now),
            },
            signals={
                "maintenance_value": "medium",
                "user_interrupt_risk": "none",
            },
            payload={
                "preferred_action": "plan" if inbox_count < 2 else "apply",
            },
            created_at=local_now,
            ttl_minutes=self._config.knowledge_check_interval_minutes,
        )

    def _build_exploration_opportunity(self, *, local_now: datetime) -> LifeOpportunity | None:
        """Return one exploration opportunity for the agent to learn something new."""

        # Check if exploration is enabled (at least once per 2 hours)
        last_exploration_at = self._get_loop_timestamp("life_loop:last_exploration_at")
        if last_exploration_at is not None:
            time_since_last = local_now - last_exploration_at
            if time_since_last < timedelta(minutes=120):  # 2 hours minimum interval
                return None

        # Only explore during certain hours (9 AM to 9 PM)
        if local_now.hour < 9 or local_now.hour >= 21:
            return None

        opportunity = self._new_opportunity(
            kind="exploration",
            consumer="exploration_specialist",
            attention_hint="background",
            reason="agent should explore and learn something new to share with user",
            context={
                "time_of_day": _time_of_day(local_now),
                "exploration_interval_hours": 2,
            },
            signals={
                "learning_value": "medium",
                "user_interrupt_risk": "none",
            },
            payload={
                "suggested_sources": ["tech_news", "wikipedia", "github_trending"],
            },
            created_at=local_now,
            ttl_minutes=60,
        )
        self._set_loop_timestamp("life_loop:last_exploration_at", local_now)
        return opportunity

    def _new_opportunity(
        self,
        *,
        kind: str,
        consumer: str,
        attention_hint: str,
        reason: str,
        context: dict[str, object],
        signals: dict[str, object],
        payload: dict[str, object],
        created_at: datetime,
        ttl_minutes: int,
    ) -> LifeOpportunity:
        """Build one opportunity with the shared minimal structure."""

        return LifeOpportunity(
            id=f"{kind}:{uuid.uuid4().hex[:12]}",
            kind=kind,
            source="life_loop",
            consumer=consumer,
            attention_hint=attention_hint,
            reason=reason,
            context=context,
            signals=signals,
            payload=payload,
            created_at=created_at.strftime("%Y-%m-%d %H:%M:%S"),
            expires_at=(created_at + timedelta(minutes=ttl_minutes)).strftime("%Y-%m-%d %H:%M:%S"),
        )

    def _get_loop_timestamp(self, key: str) -> datetime | None:
        """Return one internal life-loop timestamp stored in handoff memory."""

        raw = self._database.get_handoff_value(key)
        if not raw:
            return None
        try:
            return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            self._logger.warning("life loop handoff timestamp invalid key=%s value=%s", key, raw)
            return None

    def _set_loop_timestamp(self, key: str, value: datetime) -> None:
        """Persist one internal life-loop timestamp in handoff memory."""

        self._database.set_handoff_value(key, value.strftime("%Y-%m-%d %H:%M:%S"))


def serialize_opportunities(opportunities: tuple[LifeOpportunity, ...]) -> str:
    """Render opportunities into a stable JSON string for logs and timeline recording."""

    return json.dumps([opportunity.to_dict() for opportunity in opportunities], ensure_ascii=False)


def _time_of_day(local_now: datetime) -> str:
    """Return a lightweight time-of-day label for candidate context."""

    hour = local_now.hour
    if 0 <= hour <= 5:
        return "late_night"
    if 6 <= hour <= 11:
        return "morning"
    if 12 <= hour <= 17:
        return "afternoon"
    return "evening"
