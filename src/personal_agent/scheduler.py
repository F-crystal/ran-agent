"""APScheduler bootstrap and low-risk job registration for the local agent."""

from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.jobs import (
    ai_daily_digest_job,
    brain_loop_job,
    daily_carryover_job,
    hermes_bounded_context_job,
    knowledge_agent_job,
    life_loop_job,
    night_cycle_job,
    reminder_check_job,
    self_reflection_job,
)
from personal_agent.service import PersonalAgentService


def create_scheduler(
    config: AppConfig,
    database: Database,
    message_service: PersonalAgentService,
    logger: logging.Logger,
) -> BackgroundScheduler:
    """Create a scheduler with lightweight recurring maintenance and candidate jobs."""

    scheduler = BackgroundScheduler(timezone=config.scheduler_timezone)
    scheduler.add_job(
        brain_loop_job,
        trigger=IntervalTrigger(minutes=config.brain_loop_interval_minutes),
        id="brain_loop",
        name="brain_loop",
        replace_existing=True,
        kwargs={"database": database, "logger": logger},
    )
    scheduler.add_job(
        life_loop_job,
        trigger=IntervalTrigger(minutes=config.proactive_check_interval_minutes),
        id="life_loop",
        name="life_loop",
        replace_existing=True,
        kwargs={
            "config": config,
            "database": database,
            "message_service": message_service,
            "logger": logger,
        },
    )
    if config.knowledge_agent_enabled:
        scheduler.add_job(
            knowledge_agent_job,
            trigger=CronTrigger(
                hour=config.knowledge_cron_hours,
                minute=config.knowledge_cron_minute,
                timezone=config.scheduler_timezone,
            ),
            id="knowledge_agent",
            name="knowledge_agent",
            replace_existing=True,
            kwargs={
                "config": config,
                "logger": logger,
            },
        )
    if config.daily_carryover_enabled:
        scheduler.add_job(
            daily_carryover_job,
            trigger=CronTrigger(
                hour=config.daily_carryover_hour,
                minute=config.daily_carryover_minute,
                timezone=config.scheduler_timezone,
            ),
            id="daily_carryover",
            name="daily_carryover",
            replace_existing=True,
            kwargs={
                "config": config,
                "logger": logger,
            },
        )
    if config.self_reflection_enabled:
        scheduler.add_job(
            self_reflection_job,
            trigger=IntervalTrigger(minutes=config.self_reflection_interval_minutes),
            id="self_reflection",
            name="self_reflection",
            replace_existing=True,
            kwargs={
                "config": config,
                "database": database,
                "logger": logger,
            },
        )
    if config.hermes_bounded_context_enabled:
        scheduler.add_job(
            hermes_bounded_context_job,
            trigger=IntervalTrigger(minutes=config.hermes_bounded_context_interval_minutes),
            id="hermes_bounded_context",
            name="hermes_bounded_context",
            replace_existing=True,
            kwargs={
                "message_service": message_service,
                "logger": logger,
            },
        )
    if config.night_cycle_enabled:
        scheduler.add_job(
            night_cycle_job,
            trigger=CronTrigger(
                hour=config.night_cycle_hour,
                minute=config.night_cycle_minute,
                timezone=config.scheduler_timezone,
            ),
            id="night_cycle",
            name="night_cycle",
            replace_existing=True,
            kwargs={
                "config": config,
                "database": database,
                "message_service": message_service,
                "logger": logger,
            },
        )
    if config.ai_daily_digest_enabled:
        scheduler.add_job(
            ai_daily_digest_job,
            trigger=CronTrigger(
                hour=config.ai_daily_digest_hour,
                minute=config.ai_daily_digest_minute,
                timezone=config.scheduler_timezone,
            ),
            id="ai_daily_digest",
            name="ai_daily_digest",
            replace_existing=True,
            kwargs={
                "config": config,
                "database": database,
                "message_service": message_service,
                "logger": logger,
            },
        )
    if config.reminder_delivery_enabled:
        scheduler.add_job(
            reminder_check_job,
            trigger=IntervalTrigger(minutes=config.reminder_check_interval_minutes),
            id="reminder_check",
            name="reminder_check",
            replace_existing=True,
            kwargs={
                "config": config,
                "database": database,
                "message_service": message_service,
                "logger": logger,
            },
        )
    logger.info(
        "scheduler configured with brain_loop interval=%s minutes life_loop interval=%s minutes knowledge cron=%s:%02d enabled=%s daily_carryover=%s %02d:%02d enabled=%s self_reflection interval=%s minutes enabled=%s hermes_bounded_context interval=%s minutes enabled=%s night_cycle=%s %02d:%02d enabled=%s ai_daily_digest=%02d:%02d enabled=%s reminder_check interval=%s minutes enabled=%s",
        config.brain_loop_interval_minutes,
        config.proactive_check_interval_minutes,
        config.knowledge_cron_hours,
        config.knowledge_cron_minute,
        config.knowledge_agent_enabled,
        config.scheduler_timezone,
        config.daily_carryover_hour,
        config.daily_carryover_minute,
        config.daily_carryover_enabled,
        config.self_reflection_interval_minutes,
        config.self_reflection_enabled,
        config.hermes_bounded_context_interval_minutes,
        config.hermes_bounded_context_enabled,
        config.scheduler_timezone,
        config.night_cycle_hour,
        config.night_cycle_minute,
        config.night_cycle_enabled,
        config.ai_daily_digest_hour,
        config.ai_daily_digest_minute,
        config.ai_daily_digest_enabled,
        config.reminder_check_interval_minutes,
        config.reminder_delivery_enabled,
    )
    return scheduler
