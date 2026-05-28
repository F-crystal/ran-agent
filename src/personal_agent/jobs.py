"""Safe scheduled jobs used by the local scheduler bootstrap."""

from __future__ import annotations

import json
import logging

from personal_agent.ai_daily_digest import run_ai_daily_digest
from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.life_loop import LifeLoop, serialize_opportunities
from personal_agent.night_cycle import NightCycle
from personal_agent.reflection_specialist import ReflectionSpecialist
from personal_agent.service import PersonalAgentService
from personal_agent.todo_manager import TodoManager


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

    if not config.proactive_enabled:
        logger.info("life loop job skipped because proactive messaging is frozen")
        return

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
    """Check for due reminders and send proactive reminder messages."""

    if not config.proactive_enabled:
        logger.info("reminder check job skipped because proactive messaging is frozen")
        return
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
        reminder_seed = f"reminder:{todo.id}"

        if database.has_recent_proactive_seed(channel="wechat", seed=reminder_seed, window_minutes=30):
            logger.info("reminder skipped by recent dedupe todo_id=%s seed=%s", todo.id, reminder_seed)
            continue

        # Send via message service
        try:
            message_service.send_proactive_message(
                text=reminder_message,
                channel="wechat",
                seed=reminder_seed,
                reason=f"Reminder for todo: {todo.content[:50]}",
            )
            database.mark_todo_reminded(todo.id)
            sent_count += 1
            logger.info(
                "reminder sent todo_id=%s content=%s",
                todo.id,
                todo.content[:50],
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
