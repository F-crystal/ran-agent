"""Runtime assembly for shared local agent components."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from personal_agent.config import AppConfig, load_config
from personal_agent.db import Database
from personal_agent.interfaces.model import HermesChatCompletionsModelClient, QwenResponsesModelClient
from personal_agent.logging_setup import configure_logging
from personal_agent.service import PersonalAgentService


@dataclass
class AgentRuntime:
    """Groups shared runtime components used across app entrypoints."""

    config: AppConfig
    logger: logging.Logger
    database: Database
    message_service: PersonalAgentService

    def initialize(self) -> None:
        """Prepare directories and database before handling work."""

        self.config.vault_dir.mkdir(parents=True, exist_ok=True)
        self.config.reflections_dir.mkdir(parents=True, exist_ok=True)
        self.config.night_cycles_dir.mkdir(parents=True, exist_ok=True)
        self.database.initialize()
        self.database.record_timeline_event(
            source="system",
            event_type="startup",
            content="Application initialized.",
            tags="system,startup",
            importance=1,
        )


def build_runtime() -> AgentRuntime:
    """Create the shared runtime used by the local app and test entrypoints."""

    config = load_config()
    logger = configure_logging(config)
    database = Database(config, logger)
    message_service = PersonalAgentService(
        database=database,
        tool_model_client=build_tool_model_client(config, logger) if config.memory_llm_enabled else None,
        logger=logger,
        config=config,
        system_prompt=config.agent_system_prompt,
    )
    return AgentRuntime(
        config=config,
        logger=logger,
        database=database,
        message_service=message_service,
    )


def build_tool_model_client(config: AppConfig, logger: logging.Logger):
    """Build the backend tool client for optional multimodal/tool requests."""

    if not config.backend_qwen_enabled:
        logger.info(
            "using hermes gateway tool model client model=%s timeout_seconds=%s",
            config.hermes_model,
            config.hermes_timeout_seconds,
        )
        return HermesChatCompletionsModelClient(
            base_url=config.hermes_base_url,
            api_key_env_var=config.hermes_api_key_env_var,
            model=config.hermes_model,
            timeout_seconds=config.hermes_timeout_seconds,
            logger=logger,
        )

    logger.info(
        "using qwen tool model client model=%s base_url=%s timeout_seconds=%s",
        config.qwen_tools_model,
        config.qwen_base_url,
        config.qwen_timeout_seconds,
    )
    return QwenResponsesModelClient(
        api_key_env_var=config.qwen_api_key_env_var,
        model=config.qwen_tools_model,
        base_url=config.qwen_base_url,
        timeout_seconds=config.qwen_timeout_seconds,
        logger=logger,
    )
