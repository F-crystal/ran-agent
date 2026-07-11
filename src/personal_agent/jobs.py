"""Safe scheduled jobs used by the local scheduler bootstrap."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from collections.abc import Callable

from personal_agent.ai_daily_digest import run_ai_daily_digest
from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.durable_jobs import DurableJobDispatcher, DurableJobOutcome, DurableJobRecord
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.life_loop import LifeLoop, serialize_opportunities
from personal_agent.night_cycle import NightCycle
from personal_agent.reflection_specialist import ReflectionSpecialist
from personal_agent.service import PersonalAgentService
from personal_agent.todo_manager import TodoManager


def durable_job_dispatch_job(dispatcher: DurableJobDispatcher) -> list[DurableJobRecord]:
    """Wake the SQLite-backed durable dispatcher without owning job truth."""

    return dispatcher.dispatch_due()


def core_durable_job_kind_handlers(
    *,
    message_service: PersonalAgentService,
) -> dict[str, Callable[[DurableJobRecord], DurableJobOutcome]]:
    """Return the small, restart-safe set of Core jobs that can be accepted.

    Every handler owns a real local effect.  Unsupported future work is not
    represented by a job, so the reply gate has no receipt to turn into a
    promise.
    """

    def memory_maintenance(_record: DurableJobRecord) -> DurableJobOutcome:
        message_service.get_memory_specialist().execute_background_maintenance()
        return DurableJobOutcome.terminal("completed", "job:memory-maintenance")

    def reflection(_record: DurableJobRecord) -> DurableJobOutcome:
        message_service.run_reflection()
        return DurableJobOutcome.terminal("completed", "job:reflection")

    def night_cycle(_record: DurableJobRecord) -> DurableJobOutcome:
        result = message_service.run_night_cycle_state()
        summary_date = str(result.get("summary_date") or "").strip()
        if not summary_date:
            return DurableJobOutcome.terminal("blocked", "job:night-cycle-unconfirmed")
        return DurableJobOutcome.terminal("completed", f"job:night-cycle:{summary_date}")

    return {
        "core.memory-maintenance": memory_maintenance,
        "core.reflection": reflection,
        "core.night-cycle": night_cycle,
    }


def brain_loop_job(database: Database, logger: logging.Logger) -> None:
    """Run a lightweight maintenance pass placeholder."""

    logger.info("brain loop started")
    database.record_timeline_event(
        source="scheduler",
        event_type="brain_loop",
        content="Phase 1 brain loop heartbeat executed.",
        tags="system,brain-loop",
    )
    logger.info("brain loop finished")


def life_loop_job(
    config: AppConfig,
    database: Database,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> None:
    """Run one lightweight life-loop pass and record surfaced opportunities and judgments."""

    logger.info("life loop job started")
    result = LifeLoop(config=config, database=database, logger=logger).run()
    if not result.opportunities:
        logger.info("life loop job finished with no opportunities")
        return

    timeline_event_id = database.record_timeline_event(
        source="scheduler",
        event_type="life_loop_opportunities",
        content=serialize_opportunities(result.opportunities),
        tags="system,life-loop,opportunities",
        importance=1,
    )
    judgment_batch = message_service.evaluate_life_opportunities(result.opportunities)
    decision_summary = [
        {
            "opportunity_id": judgment.opportunity_id,
            "kind": judgment.kind,
            "action": judgment.action,
            "reason": judgment.reason,
            "uses_local_context": judgment.uses_local_context,
            "suggested_text": judgment.suggested_text,
        }
        for judgment in judgment_batch.judgments
    ]
    decision_event_id = database.record_timeline_event(
        source="scheduler",
        event_type="life_loop_judgments",
        content=json.dumps(decision_summary, ensure_ascii=False),
        tags="system,life-loop,judgments",
        importance=1,
    )
    logger.info(
        "life loop opportunities recorded timeline_event_id=%s decision_event_id=%s count=%s proactive_sent=%s",
        timeline_event_id,
        decision_event_id,
        len(result.opportunities),
        len(judgment_batch.outbound_messages),
    )


def self_reflection_job(
    config: AppConfig,
    database: Database,
    logger: logging.Logger,
) -> None:
    """Generate one offline reflection report from recent reply-review observations."""

    logger.info("self reflection job started")
    report = ReflectionSpecialist(database=database, config=config, logger=logger).generate_report(
        limit=config.self_reflection_sample_limit
    )
    logger.info(
        "self reflection report written path=%s samples=%s trigger_rate=%.2f",
        report.output_path,
        report.metrics.total_samples,
        report.metrics.reviewer_trigger_rate,
    )


def hermes_bounded_context_job(
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> None:
    """Run low-frequency bounded-memory hygiene without adding per-turn model calls."""

    logger.info("hermes bounded context job started")
    result = message_service.get_memory_specialist().execute_background_maintenance()
    logger.info(
        "hermes bounded context job finished reviewed=%s cleaned=%s promoted=%s",
        result.get("working_memories_reviewed", 0),
        result.get("old_memories_cleaned", 0),
        result.get("promoted_to_long_term", 0),
    )


def knowledge_agent_job(
    config: AppConfig,
    logger: logging.Logger,
) -> None:
    """Run one low-interference background knowledge-agent pass."""

    logger.info("knowledge agent job started")
    result = KnowledgeAgent(config=config, logger=logger).auto_run(trigger="scheduler")
    logger.info(
        "knowledge agent job finished action=%s status=%s inbox_before=%s inbox_after=%s pending=%s",
        result.action,
        result.status,
        result.inbox_count_before,
        result.inbox_count_after,
        result.pending_knowledge_maintenance,
    )


def daily_carryover_job(
    config: AppConfig,
    logger: logging.Logger,
) -> None:
    """Ensure the previous day's night-cycle carry-over is archived before soft reset."""

    logger.info("daily carryover job started")
    result = KnowledgeAgent(config=config, logger=logger).run(action="daily_carryover", trigger="daily_carryover")
    logger.info(
        "daily carryover job finished status=%s inbox_before=%s inbox_after=%s error=%s",
        result.status,
        result.inbox_count_before,
        result.inbox_count_after,
        result.error,
    )


def night_cycle_job(
    config: AppConfig,
    database: Database,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> None:
    """Run one nightly rollover and write carry-over artifacts for the next day."""

    logger.info("night cycle job started")
    result = NightCycle(
        config=config,
        database=database,
        memory_specialist=message_service.get_memory_specialist(),
        logger=logger,
    ).run()
    database.record_timeline_event(
        source="scheduler",
        event_type="night_cycle",
        content=result.daily_summary,
        tags="system,night-cycle,summary",
        importance=1,
    )
    logger.info(
        "night cycle finished summary_date=%s cleared_sessions=%s promoted=%s inbox=%s knowledge_action=%s knowledge_status=%s",
        result.summary_date,
        result.cleared_session_count,
        result.promoted_count,
        result.knowledge_inbox_path,
        result.knowledge_action,
        result.knowledge_status,
    )


def ai_daily_digest_job(
    config: AppConfig,
    database: Database,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> None:
    """Send the scheduled AI daily digest through the Feishu/Hermes path."""

    logger.info("AI daily digest job started")
    result = run_ai_daily_digest(
        config=config,
        database=database,
        outbound_client=message_service,
        logger=logger,
    )
    logger.info("AI daily digest job finished sent=%s reason=%s", result.get("sent"), result.get("reason", ""))


def reminder_check_job(
    config: AppConfig,
    database: Database,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> None:
    """Check for due reminders and submit structured proactive reminder events."""

    if not config.reminder_delivery_enabled:
        logger.info("reminder check job skipped because reminder delivery is disabled")
        return

    logger.info("reminder check job started")
    todo_manager = TodoManager(
        database=database,
        logger=logger,
        config=config,
    )

    # Check for due reminders
    check_result = todo_manager.check_reminders()

    if not check_result.due_reminders:
        logger.info("reminder check job finished no_due_reminders")
        return

    # Send reminder for each due todo
    sent_count = 0
    for todo in check_result.due_reminders:
        reminder_message = todo_manager.format_reminder_message(todo)
        reminder_seed = _reminder_event_key(todo.id, todo.reminder_at)

        if database.has_recent_proactive_seed(channel="feishu", seed=reminder_seed, window_minutes=30):
            logger.info("reminder skipped by recent dedupe todo_id=%s seed=%s", todo.id, reminder_seed)
            continue

        try:
            bridge_result = message_service.send_proactive_event(
                _build_reminder_proactive_event(
                    todo_id=todo.id,
                    content=todo.content,
                    reminder_at=todo.reminder_at or "",
                    formatted_message=reminder_message,
                )
            )
            if bridge_result.get("success") is True:
                database.mark_todo_reminded(todo.id)
                sent_count += 1
                logger.info(
                    "reminder event sent todo_id=%s content=%s",
                    todo.id,
                    todo.content[:50],
                )
            else:
                logger.warning(
                    "reminder event not sent todo_id=%s result=%s",
                    todo.id,
                    bridge_result,
                )
        except Exception as e:
            logger.exception("failed to send reminder todo_id=%s error=%s", todo.id, str(e))
            continue

    # Record to timeline
    database.record_timeline_event(
        source="scheduler",
        event_type="reminder_batch_sent",
        content=json.dumps(
            {
                "due_count": len(check_result.due_reminders),
                "sent_count": sent_count,
                "next_check": check_result.next_check_time,
            },
            ensure_ascii=False,
        ),
        tags="system,reminder,batch",
        importance=1,
    )

    logger.info(
        "reminder check job finished due=%s sent=%s next_check=%s",
        len(check_result.due_reminders),
        sent_count,
        check_result.next_check_time,
    )


def _build_reminder_proactive_event(
    *,
    todo_id: int,
    content: str,
    reminder_at: str,
    formatted_message: str,
) -> dict[str, object]:
    now = datetime.now()
    key = _reminder_event_key(todo_id, reminder_at)
    return {
        "event_id": key,
        "kind": "reminder",
        "global_user_id": "owner",
        "channel": "feishu",
        "watch_scope": f"todo:{todo_id}",
        "reason": f"Explicit reminder is due: {formatted_message or content}",
        "evidence_refs": [f"todo:{todo_id}"],
        "dedupe_key": key,
        "created_at": now.astimezone().isoformat(),
        "expires_at": (now + timedelta(hours=1)).astimezone().isoformat(),
        "deliverability": "notify_allowed",
        "allowed_capability_tiers": ["T0"],
        "quiet_policy": "ignore_for_explicit_reminder",
        "budget_class": "reminder",
    }


def _reminder_event_key(todo_id: int, reminder_at: str | None) -> str:
    compact_time = str(reminder_at or "due").replace(" ", "T").replace(":", "").replace("-", "")
    return f"reminder:{todo_id}:{compact_time}"
