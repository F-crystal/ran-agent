"""Local read-only tools that expose continuity and context to the chat runtime."""

from __future__ import annotations

import json

from personal_agent.agent_internal_state import load_agent_internal_state
from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.knowledge_agent import load_knowledge_state
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.preference_profile import load_preference_weak_reference


def get_recent_timeline(database: Database, *, limit: int = 10) -> dict[str, object]:
    """Return recent timeline events for local inspection."""

    events = database.fetch_timeline_events()[-limit:]
    return {
        "events": [
            {
                "id": int(row["id"]),
                "source": str(row["source"]),
                "event_type": str(row["event_type"]),
                "content": str(row["content"]),
                "created_at": str(row["created_at"]),
            }
            for row in events
        ]
    }


def get_recent_session_support(
    memory_specialist: MemorySpecialist,
    *,
    channel: str,
) -> dict[str, object]:
    """Return local short-term continuity support for one channel."""

    support = memory_specialist.get_session_support(channel=channel)
    return {
        "recent_user_messages": list(support.recent_user_messages),
        "working_memories": list(support.working_memories),
        "profile_memories": list(support.profile_memories),
    }


def get_preference_profile(config: AppConfig) -> dict[str, object]:
    """Return the weak preference reference currently available to the runtime."""

    reference = load_preference_weak_reference(config)
    return {
        "stable_dislikes": list(reference.stable_dislikes),
        "contextual_risks": list(reference.contextual_risks),
        "updated_at": reference.updated_at,
    }


def get_active_opportunities(database: Database) -> dict[str, object]:
    """Return the most recent surfaced opportunities recorded by the life loop."""

    for row in reversed(database.fetch_timeline_events()):
        if str(row["event_type"]) != "life_loop_opportunities":
            continue
        try:
            opportunities = json.loads(str(row["content"]))
        except json.JSONDecodeError:
            opportunities = []
        return {"opportunities": opportunities, "created_at": str(row["created_at"])}
    return {"opportunities": [], "created_at": ""}


def get_agent_internal_state(database: Database) -> dict[str, object]:
    """Return the current agent-side lifecycle trace state."""

    state = load_agent_internal_state(database)
    return {
        "recent_opportunities": [item.__dict__ for item in state.recent_opportunities],
        "recent_actions": [item.__dict__ for item in state.recent_actions],
        "recent_suppressed": [item.__dict__ for item in state.recent_suppressed],
        "pending_items": [item.__dict__ for item in state.pending_items],
        "last_proactive_at": state.last_proactive_at,
        "recent_proactive_trace": [item.__dict__ for item in state.recent_proactive_trace],
        "daily_traces": [item.__dict__ for item in state.daily_traces],
        "last_night_cycle_at": state.last_night_cycle_at,
        "updated_at": state.updated_at,
    }


def inspect_local_memory(memory_specialist: MemorySpecialist, *, user_text: str) -> dict[str, object]:
    """Return a local-memory recall snapshot without external long-memory calls."""

    recall = memory_specialist.recall_for_turn(
        user_text=user_text,
        route="text_chat",
        response_mode="casual_chat",
    )
    return {
        "should_inject": recall.should_inject,
        "short_term_memories": list(recall.short_term_memories),
        "long_term_memories": list(recall.long_term_memories),
        "core_memories": list(recall.core_memories),
        "rendered_context": recall.rendered_context,
        "used_sources": list(recall.used_sources),
        "source_status": dict(recall.source_statuses),
    }


def get_knowledge_state(config: AppConfig) -> dict[str, object]:
    """Return the latest lightweight background knowledge-maintenance state."""

    state = load_knowledge_state(config)
    return {
        "last_checked_at": state.last_checked_at,
        "last_run_at": state.last_run_at,
        "last_action": state.last_action,
        "last_trigger": state.last_trigger,
        "last_status": state.last_status,
        "inbox_count": state.inbox_count,
        "processed_inbox_count": state.processed_inbox_count,
        "pending_knowledge_maintenance": state.pending_knowledge_maintenance,
        "recent_curated_topics": list(state.recent_curated_topics),
        "recent_source_additions": list(state.recent_source_additions),
    }
