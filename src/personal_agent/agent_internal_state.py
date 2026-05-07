"""Lightweight internal trace state for the agent's own ongoing lifecycle."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime

from personal_agent.db import Database


STATE_KEY = "agent_internal_state"
RECENT_OPPORTUNITY_LIMIT = 20
RECENT_ACTION_LIMIT = 20
PENDING_ITEM_LIMIT = 8
RECENT_SUPPRESSED_LIMIT = 20
RECENT_PROACTIVE_TRACE_LIMIT = 10
DAILY_TRACE_LIMIT = 7


@dataclass(frozen=True)
class OpportunityTrace:
    """Compact trace of one surfaced opportunity."""

    opportunity_id: str
    kind: str
    attention_hint: str
    status: str
    reason: str
    created_at: str


@dataclass(frozen=True)
class AgentActionTrace:
    """Compact trace of one agent-side decision or action."""

    opportunity_id: str
    kind: str
    action: str
    reason: str
    created_at: str


@dataclass(frozen=True)
class PendingItem:
    """One deferred or inspect-more item retained for a short window."""

    opportunity_id: str
    kind: str
    action: str
    reason: str
    expires_at: str
    created_at: str


@dataclass(frozen=True)
class SuppressedOpportunityTrace:
    """Compact trace of one deferred or dropped opportunity."""

    opportunity_id: str
    kind: str
    action: str
    reason: str
    created_at: str


@dataclass(frozen=True)
class ProactiveTrace:
    """Compact trace of one proactive outbound message actually sent."""

    opportunity_id: str
    seed: str
    text: str
    created_at: str


@dataclass(frozen=True)
class DailyTrace:
    """Compact nightly trace so the agent can carry yesterday forward without full context."""

    summary_date: str
    summary: str
    reflection_digest: str
    knowledge_note_path: str
    created_at: str


@dataclass(frozen=True)
class AgentInternalState:
    """Short-window internal continuity state for the agent's own lifecycle."""

    recent_opportunities: tuple[OpportunityTrace, ...] = ()
    recent_actions: tuple[AgentActionTrace, ...] = ()
    recent_suppressed: tuple[SuppressedOpportunityTrace, ...] = ()
    pending_items: tuple[PendingItem, ...] = ()
    last_proactive_at: str = ""
    recent_proactive_trace: tuple[ProactiveTrace, ...] = ()
    daily_traces: tuple[DailyTrace, ...] = ()
    last_night_cycle_at: str = ""
    updated_at: str = ""


def load_agent_internal_state(database: Database) -> AgentInternalState:
    """Load the current agent-internal state from handoff memory."""

    raw = database.get_handoff_value(STATE_KEY)
    if not raw:
        return AgentInternalState()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return AgentInternalState()

    return AgentInternalState(
        recent_opportunities=tuple(
            OpportunityTrace(**item) for item in payload.get("recent_opportunities", [])
        ),
        recent_actions=tuple(AgentActionTrace(**item) for item in payload.get("recent_actions", [])),
        recent_suppressed=tuple(
            SuppressedOpportunityTrace(**item) for item in payload.get("recent_suppressed", [])
        ),
        pending_items=tuple(PendingItem(**item) for item in payload.get("pending_items", [])),
        last_proactive_at=str(payload.get("last_proactive_at", "")).strip(),
        recent_proactive_trace=tuple(
            ProactiveTrace(**item) for item in payload.get("recent_proactive_trace", [])
        ),
        daily_traces=tuple(DailyTrace(**item) for item in payload.get("daily_traces", [])),
        last_night_cycle_at=str(payload.get("last_night_cycle_at", "")).strip(),
        updated_at=str(payload.get("updated_at", "")).strip(),
    )


def save_agent_internal_state(database: Database, state: AgentInternalState) -> None:
    """Persist the current agent-internal state into handoff memory."""

    payload = {
        "recent_opportunities": [asdict(item) for item in state.recent_opportunities],
        "recent_actions": [asdict(item) for item in state.recent_actions],
        "recent_suppressed": [asdict(item) for item in state.recent_suppressed],
        "pending_items": [asdict(item) for item in state.pending_items],
        "last_proactive_at": state.last_proactive_at,
        "recent_proactive_trace": [asdict(item) for item in state.recent_proactive_trace],
        "daily_traces": [asdict(item) for item in state.daily_traces],
        "last_night_cycle_at": state.last_night_cycle_at,
        "updated_at": state.updated_at,
    }
    database.set_handoff_value(STATE_KEY, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def append_opportunities(
    state: AgentInternalState,
    *,
    traces: list[OpportunityTrace],
    now_local: datetime,
) -> AgentInternalState:
    """Append surfaced opportunities while keeping a short recent window."""

    recent_opportunities = [*state.recent_opportunities, *traces][-RECENT_OPPORTUNITY_LIMIT:]
    pending_items = _prune_pending_items(state.pending_items, now_local)
    return AgentInternalState(
        recent_opportunities=tuple(recent_opportunities),
        recent_actions=state.recent_actions,
        recent_suppressed=state.recent_suppressed,
        pending_items=pending_items,
        last_proactive_at=state.last_proactive_at,
        recent_proactive_trace=state.recent_proactive_trace,
        daily_traces=state.daily_traces,
        last_night_cycle_at=state.last_night_cycle_at,
        updated_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )


def apply_decisions(
    state: AgentInternalState,
    *,
    actions: list[AgentActionTrace],
    suppressed: list[SuppressedOpportunityTrace],
    pending_items: list[PendingItem],
    now_local: datetime,
) -> AgentInternalState:
    """Append action traces and refresh pending items within a short window."""

    merged_pending = [*_prune_pending_items(state.pending_items, now_local), *pending_items]
    deduped_pending: list[PendingItem] = []
    seen_ids: set[str] = set()
    for item in reversed(merged_pending):
        if item.opportunity_id in seen_ids:
            continue
        seen_ids.add(item.opportunity_id)
        deduped_pending.append(item)
    deduped_pending.reverse()

    recent_actions = [*state.recent_actions, *actions][-RECENT_ACTION_LIMIT:]
    recent_suppressed = [*state.recent_suppressed, *suppressed][-RECENT_SUPPRESSED_LIMIT:]
    return AgentInternalState(
        recent_opportunities=state.recent_opportunities,
        recent_actions=tuple(recent_actions),
        recent_suppressed=tuple(recent_suppressed),
        pending_items=tuple(deduped_pending[-PENDING_ITEM_LIMIT:]),
        last_proactive_at=state.last_proactive_at,
        recent_proactive_trace=state.recent_proactive_trace,
        daily_traces=state.daily_traces,
        last_night_cycle_at=state.last_night_cycle_at,
        updated_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )


def has_recent_action(
    state: AgentInternalState,
    *,
    kind: str,
    action: str,
    now_local: datetime,
    within_minutes: int,
) -> bool:
    """Return whether the agent recently took the same kind of action."""

    for trace in reversed(state.recent_actions):
        if trace.kind != kind or trace.action != action:
            continue
        try:
            trace_time = datetime.strptime(trace.created_at, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if (now_local - trace_time).total_seconds() <= within_minutes * 60:
            return True
    return False


def has_recent_proactive_seed(
    state: AgentInternalState,
    *,
    seed: str,
    now_local: datetime,
    within_minutes: int,
) -> bool:
    """Return whether the same proactive seed was used recently."""

    normalized = seed.strip()
    if not normalized:
        return False
    for trace in reversed(state.recent_proactive_trace):
        if trace.seed.strip() != normalized:
            continue
        try:
            trace_time = datetime.strptime(trace.created_at, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if (now_local - trace_time).total_seconds() <= within_minutes * 60:
            return True
    return False


def record_proactive_send(
    state: AgentInternalState,
    *,
    opportunity_id: str,
    seed: str,
    text: str,
    now_local: datetime,
) -> AgentInternalState:
    """Record one successful proactive outbound send."""

    trace = ProactiveTrace(
        opportunity_id=opportunity_id,
        seed=seed.strip(),
        text=text.strip(),
        created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )
    return AgentInternalState(
        recent_opportunities=state.recent_opportunities,
        recent_actions=state.recent_actions,
        recent_suppressed=state.recent_suppressed,
        pending_items=_prune_pending_items(state.pending_items, now_local),
        last_proactive_at=trace.created_at,
        recent_proactive_trace=tuple([*state.recent_proactive_trace, trace][-RECENT_PROACTIVE_TRACE_LIMIT:]),
        daily_traces=state.daily_traces,
        last_night_cycle_at=state.last_night_cycle_at,
        updated_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )


def record_night_cycle(
    state: AgentInternalState,
    *,
    summary_date: str,
    summary: str,
    reflection_digest: str,
    knowledge_note_path: str,
    now_local: datetime,
) -> AgentInternalState:
    """Record one nightly rollover trace for next-day continuity."""

    trace = DailyTrace(
        summary_date=summary_date,
        summary=summary.strip(),
        reflection_digest=reflection_digest.strip(),
        knowledge_note_path=knowledge_note_path.strip(),
        created_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )
    return AgentInternalState(
        recent_opportunities=state.recent_opportunities,
        recent_actions=state.recent_actions,
        recent_suppressed=state.recent_suppressed,
        pending_items=(),
        last_proactive_at=state.last_proactive_at,
        recent_proactive_trace=state.recent_proactive_trace,
        daily_traces=tuple([*state.daily_traces, trace][-DAILY_TRACE_LIMIT:]),
        last_night_cycle_at=trace.created_at,
        updated_at=now_local.strftime("%Y-%m-%d %H:%M:%S"),
    )


def _prune_pending_items(
    pending_items: tuple[PendingItem, ...],
    now_local: datetime,
) -> tuple[PendingItem, ...]:
    """Drop expired pending items and keep the short pending window clean."""

    retained: list[PendingItem] = []
    for item in pending_items:
        try:
            expires_at = datetime.strptime(item.expires_at, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if expires_at >= now_local:
            retained.append(item)
    return tuple(retained[-PENDING_ITEM_LIMIT:])
