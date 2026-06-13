"""Unit tests for runtime configuration loading behavior."""

from __future__ import annotations

import json
import os
import re
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

from personal_agent.config import (
    AppConfig,
    DEFAULT_MEMORY_POLICY_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_TOOL_USE_PROMPT,
    load_config,
)
from personal_agent.scheduler import create_scheduler


class ConfigLoadingTest(unittest.TestCase):
    """Covers prompt loading from file and environment override precedence."""

    def test_default_system_prompt_is_loaded_from_json_file(self) -> None:
        prompt_path = Path(__file__).resolve().parents[1] / "src" / "personal_agent" / "prompts" / "system_prompt.json"
        prompt_data = json.loads(prompt_path.read_text(encoding="utf-8"))

        self.assertEqual(DEFAULT_SYSTEM_PROMPT, prompt_data["agent_system_prompt"])

    def test_environment_variable_overrides_prompt_file(self) -> None:
        with patch.dict(os.environ, {"PERSONAL_AGENT_SYSTEM_PROMPT": "env prompt"}, clear=False):
            config = load_config()

        self.assertEqual(config.agent_system_prompt, "env prompt")

    def test_default_memory_policy_prompt_is_loaded_from_json_file(self) -> None:
        prompt_path = Path(__file__).resolve().parents[1] / "src" / "personal_agent" / "prompts" / "memory_policy.json"
        prompt_data = json.loads(prompt_path.read_text(encoding="utf-8"))

        self.assertIn(str(prompt_data["policy_name"]), DEFAULT_MEMORY_POLICY_PROMPT)
        self.assertIn(str(prompt_data["goal"]), DEFAULT_MEMORY_POLICY_PROMPT)

    def test_default_tool_use_prompt_is_loaded_from_json_file(self) -> None:
        prompt_path = Path(__file__).resolve().parents[1] / "src" / "personal_agent" / "prompts" / "tool_use_system_prompt.json"
        prompt_data = json.loads(prompt_path.read_text(encoding="utf-8"))

        self.assertEqual(DEFAULT_TOOL_USE_PROMPT, prompt_data["tool_use_system_prompt"])

    def test_reviewer_flags_default_to_safe_enabled_values(self) -> None:
        config = load_config()

        self.assertTrue(config.reviewer_enabled)
        self.assertFalse(config.reviewer_debug_log_enabled)
        self.assertTrue(config.reviewer_blacklist_enabled)
        self.assertTrue(config.off_topic_check_enabled)
        self.assertTrue(config.self_reflection_enabled)
        self.assertEqual(config.self_reflection_interval_minutes, 720)
        self.assertEqual(config.self_reflection_sample_limit, 200)
        self.assertTrue(config.knowledge_agent_enabled)
        self.assertEqual(config.knowledge_check_interval_minutes, 360)
        self.assertEqual(config.knowledge_cron_hours, "6,12,18,23")
        self.assertEqual(config.knowledge_cron_minute, 0)
        self.assertTrue(config.daily_carryover_enabled)
        self.assertEqual(config.daily_carryover_hour, 4)
        self.assertEqual(config.daily_carryover_minute, 0)
        self.assertTrue(config.night_cycle_enabled)
        self.assertEqual(config.night_cycle_hour, 0)
        self.assertEqual(config.night_cycle_minute, 0)
        self.assertFalse(config.proactive_enabled)
        self.assertFalse(config.reminder_delivery_enabled)
        self.assertFalse(config.ai_daily_digest_enabled)
        self.assertEqual(config.ai_daily_digest_hour, 10)
        self.assertEqual(config.ai_daily_digest_minute, 0)
        self.assertEqual(config.brain_loop_interval_minutes, 120)
        self.assertEqual(config.proactive_check_interval_minutes, 90)
        self.assertEqual(config.reminder_check_interval_minutes, 5)
        self.assertTrue(config.vector_memory_enabled)
        self.assertEqual(config.vector_memory_embedding_provider, "dashscope")
        self.assertEqual(config.vector_memory_embedding_model, "text-embedding-v4")
        self.assertEqual(config.vector_memory_embedding_dimension, 256)
        self.assertEqual(config.vector_memory_index_path, config.data_dir / "memory_vector_index.bin")
        self.assertEqual(config.vector_memory_metadata_path, config.data_dir / "memory_vector_index.json")
        self.assertEqual(config.profile_memory_limit, 3)
        self.assertEqual(config.working_memory_limit, 2)
        self.assertEqual(config.session_recent_user_messages_limit, 3)
        self.assertEqual(config.memory_context_max_chars, 600)
        self.assertEqual(config.daily_context_max_chars, 600)
        self.assertEqual(config.reflection_context_max_chars, 600)
        self.assertEqual(config.continuity_context_max_chars, 1200)
        self.assertEqual(config.knowledge_recall_limit, 1)
        self.assertEqual(config.knowledge_snippet_max_chars, 240)
        self.assertEqual(config.proactive_memory_context_max_chars, 300)
        self.assertTrue(config.hermes_bounded_context_enabled)
        self.assertEqual(config.hermes_bounded_context_interval_minutes, 720)

    def test_reviewer_flags_can_be_overridden_from_environment(self) -> None:
        with patch.dict(
            os.environ,
            {
                "PERSONAL_AGENT_REVIEWER_ENABLED": "false",
                "PERSONAL_AGENT_REVIEWER_DEBUG_LOG_ENABLED": "true",
                "PERSONAL_AGENT_REVIEWER_BLACKLIST_ENABLED": "false",
                "PERSONAL_AGENT_OFF_TOPIC_CHECK_ENABLED": "false",
                "PERSONAL_AGENT_SELF_REFLECTION_ENABLED": "false",
                "PERSONAL_AGENT_SELF_REFLECTION_INTERVAL_MINUTES": "90",
                "PERSONAL_AGENT_SELF_REFLECTION_SAMPLE_LIMIT": "80",
                "PERSONAL_AGENT_KNOWLEDGE_AGENT_ENABLED": "false",
                "PERSONAL_AGENT_KNOWLEDGE_CHECK_INTERVAL_MINUTES": "60",
                "PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS": "7,13",
                "PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE": "30",
                "PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED": "false",
                "PERSONAL_AGENT_DAILY_CARRYOVER_HOUR": "3",
                "PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE": "45",
                "PERSONAL_AGENT_BRAIN_LOOP_INTERVAL_MINUTES": "240",
                "PERSONAL_AGENT_REMINDER_CHECK_INTERVAL_MINUTES": "12",
                "PERSONAL_AGENT_NIGHT_CYCLE_ENABLED": "false",
                "PERSONAL_AGENT_NIGHT_CYCLE_HOUR": "1",
                "PERSONAL_AGENT_NIGHT_CYCLE_MINUTE": "15",
                "PERSONAL_AGENT_PROACTIVE_ENABLED": "true",
                "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED": "false",
                "PERSONAL_AGENT_VECTOR_MEMORY_ENABLED": "false",
                "PERSONAL_AGENT_VECTOR_MEMORY_EMBEDDING_PROVIDER": "openai_compatible",
                "PERSONAL_AGENT_VECTOR_MEMORY_EMBEDDING_MODEL": "text-embedding-3-small",
                "PERSONAL_AGENT_VECTOR_MEMORY_EMBEDDING_DIMENSION": "128",
                "PERSONAL_AGENT_MEMORY_CONTEXT_MAX_CHARS": "420",
                "PERSONAL_AGENT_DAILY_CONTEXT_MAX_CHARS": "300",
                "PERSONAL_AGENT_REFLECTION_CONTEXT_MAX_CHARS": "280",
                "PERSONAL_AGENT_CONTINUITY_CONTEXT_MAX_CHARS": "700",
                "PERSONAL_AGENT_KNOWLEDGE_RECALL_LIMIT": "2",
                "PERSONAL_AGENT_KNOWLEDGE_SNIPPET_MAX_CHARS": "180",
                "PERSONAL_AGENT_SESSION_RECENT_USER_MESSAGES_LIMIT": "2",
                "PERSONAL_AGENT_PROACTIVE_MEMORY_CONTEXT_MAX_CHARS": "160",
                "PERSONAL_AGENT_HERMES_BOUNDED_CONTEXT_ENABLED": "false",
                "PERSONAL_AGENT_HERMES_BOUNDED_CONTEXT_INTERVAL_MINUTES": "1440",
            },
            clear=False,
        ):
            config = load_config()

        self.assertFalse(config.reviewer_enabled)
        self.assertTrue(config.reviewer_debug_log_enabled)
        self.assertFalse(config.reviewer_blacklist_enabled)
        self.assertFalse(config.off_topic_check_enabled)
        self.assertFalse(config.self_reflection_enabled)
        self.assertEqual(config.self_reflection_interval_minutes, 90)
        self.assertEqual(config.self_reflection_sample_limit, 80)
        self.assertFalse(config.knowledge_agent_enabled)
        self.assertEqual(config.knowledge_check_interval_minutes, 60)
        self.assertEqual(config.knowledge_cron_hours, "7,13")
        self.assertEqual(config.knowledge_cron_minute, 30)
        self.assertFalse(config.daily_carryover_enabled)
        self.assertEqual(config.daily_carryover_hour, 3)
        self.assertEqual(config.daily_carryover_minute, 45)
        self.assertEqual(config.brain_loop_interval_minutes, 240)
        self.assertEqual(config.reminder_check_interval_minutes, 12)
        self.assertFalse(config.night_cycle_enabled)
        self.assertEqual(config.night_cycle_hour, 1)
        self.assertEqual(config.night_cycle_minute, 15)
        self.assertTrue(config.proactive_enabled)
        self.assertFalse(config.reminder_delivery_enabled)
        self.assertFalse(config.vector_memory_enabled)
        self.assertEqual(config.vector_memory_embedding_provider, "openai_compatible")
        self.assertEqual(config.vector_memory_embedding_model, "text-embedding-3-small")
        self.assertEqual(config.vector_memory_embedding_dimension, 128)
        self.assertEqual(config.memory_context_max_chars, 420)
        self.assertEqual(config.daily_context_max_chars, 300)
        self.assertEqual(config.reflection_context_max_chars, 280)
        self.assertEqual(config.continuity_context_max_chars, 700)
        self.assertEqual(config.knowledge_recall_limit, 2)
        self.assertEqual(config.knowledge_snippet_max_chars, 180)
        self.assertEqual(config.session_recent_user_messages_limit, 2)
        self.assertEqual(config.proactive_memory_context_max_chars, 160)
        self.assertFalse(config.hermes_bounded_context_enabled)
        self.assertEqual(config.hermes_bounded_context_interval_minutes, 1440)

    def test_backend_model_contract_defaults_are_empty_after_openclaw_removal(self) -> None:
        config = load_config()

        self.assertEqual(config.backend_model_ref, "")
        self.assertEqual(config.backend_model_provider, "")
        self.assertEqual(config.backend_model_name, "")
        self.assertEqual(config.backend_model_api, "")
        self.assertEqual(config.backend_model_base_url, "")
        self.assertEqual(config.backend_model_api_key_env_var, "")
        self.assertEqual(config.backend_model_max_tokens, 0)

    def test_frontline_bootstrap_contains_wechat_companion_quality_constraints(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        soul = (repo_root / "SOUL.md").read_text(encoding="utf-8")
        identity = (repo_root / "IDENTITY.md").read_text(encoding="utf-8")
        tools = (repo_root / "TOOLS.md").read_text(encoding="utf-8")

        self.assertIn("不要把用户当成任务对象", soul)
        self.assertIn("不要主动长篇报告", soul)
        self.assertIn("不要用分析外泄", identity)
        self.assertIn("不主动把普通陪伴聊天升级成任务", identity)
        self.assertIn("工具只是后台动作", tools)

    def test_repo_mcp_config_registers_playwright_wrapper_without_home_shortcuts(self) -> None:
        mcp_path = Path(__file__).resolve().parents[1] / ".mcp.json"
        mcp_data = json.loads(mcp_path.read_text(encoding="utf-8"))

        playwright = mcp_data["mcpServers"]["playwright"]

        self.assertEqual(playwright["command"], "bash")
        self.assertEqual(playwright["args"], ["scripts/start_playwright_mcp.sh"])
        self.assertNotIn("~", json.dumps(playwright, ensure_ascii=False))

    def test_repo_mcp_config_registers_social_reader_wrapper_without_home_shortcuts(self) -> None:
        mcp_path = Path(__file__).resolve().parents[1] / ".mcp.json"
        mcp_data = json.loads(mcp_path.read_text(encoding="utf-8"))

        social_reader = mcp_data["mcpServers"]["social_reader"]

        self.assertEqual(social_reader["command"], "bash")
        self.assertEqual(social_reader["args"], ["scripts/start_social_reader_mcp.sh"])
        self.assertNotIn("~", json.dumps(social_reader, ensure_ascii=False))

    def test_repo_mcp_config_registers_mimo_power_wrapper_without_home_shortcuts(self) -> None:
        mcp_path = Path(__file__).resolve().parents[1] / ".mcp.json"
        mcp_data = json.loads(mcp_path.read_text(encoding="utf-8"))

        mimo_power = mcp_data["mcpServers"]["mimo_power"]

        self.assertEqual(mimo_power["command"], "bash")
        self.assertEqual(mimo_power["args"], ["scripts/start_mimo_power_mcp.sh"])
        self.assertNotIn("~", json.dumps(mimo_power, ensure_ascii=False))

    def test_scheduler_uses_configured_job_intervals(self) -> None:
        class FakeScheduler:
            def __init__(self, timezone: str) -> None:
                self.timezone = timezone
                self.jobs: list[dict[str, object]] = []

            def add_job(self, func, trigger, id, name, replace_existing, kwargs):
                self.jobs.append(
                    {
                        "func": func.__name__,
                        "trigger": trigger,
                        "id": id,
                        "name": name,
                        "replace_existing": replace_existing,
                        "kwargs": kwargs,
                    }
                )

        fake_scheduler = FakeScheduler(timezone="Asia/Shanghai")
        with patch.dict(os.environ, {"PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED": "true"}, clear=False):
            config = load_config()
        database = MagicMock()
        message_service = MagicMock()
        logger = MagicMock()

        with patch("personal_agent.scheduler.BackgroundScheduler", return_value=fake_scheduler):
            scheduler = create_scheduler(
                config=config,
                database=database,
                message_service=message_service,
                logger=logger,
            )

        self.assertIs(scheduler, fake_scheduler)
        job_map = {job["id"]: job for job in fake_scheduler.jobs}
        self.assertEqual(job_map["brain_loop"]["trigger"].interval, timedelta(minutes=120))
        self.assertEqual(job_map["life_loop"]["trigger"].interval, timedelta(minutes=90))
        self.assertEqual(job_map["knowledge_agent"]["trigger"].fields[5].expressions[0].first, 6)
        self.assertEqual(job_map["knowledge_agent"]["trigger"].fields[5].expressions[1].first, 12)
        self.assertEqual(job_map["knowledge_agent"]["trigger"].fields[5].expressions[2].first, 18)
        self.assertEqual(job_map["knowledge_agent"]["trigger"].fields[5].expressions[3].first, 23)
        self.assertEqual(job_map["knowledge_agent"]["trigger"].fields[6].expressions[0].first, 0)
        self.assertEqual(job_map["daily_carryover"]["func"], "daily_carryover_job")
        self.assertEqual(job_map["daily_carryover"]["trigger"].fields[5].expressions[0].first, 4)
        self.assertEqual(job_map["daily_carryover"]["trigger"].fields[6].expressions[0].first, 0)
        self.assertEqual(job_map["self_reflection"]["trigger"].interval, timedelta(minutes=720))
        self.assertEqual(job_map["hermes_bounded_context"]["trigger"].interval, timedelta(minutes=720))
        self.assertEqual(job_map["reminder_check"]["trigger"].interval, timedelta(minutes=5))

    def test_scheduler_registers_ai_daily_digest_independently_of_proactive(self) -> None:
        class FakeScheduler:
            def __init__(self, timezone: str) -> None:
                self.timezone = timezone
                self.jobs: list[dict[str, object]] = []

            def add_job(self, func, trigger, id, name, replace_existing, kwargs):
                self.jobs.append(
                    {
                        "func": func.__name__,
                        "trigger": trigger,
                        "id": id,
                        "name": name,
                        "replace_existing": replace_existing,
                        "kwargs": kwargs,
                    }
                )

        fake_scheduler = FakeScheduler(timezone="Asia/Shanghai")
        with patch.dict(
            os.environ,
            {
                "AI_DAILY_DIGEST_ENABLED": "true",
                "AI_DAILY_DIGEST_HOUR": "10",
                "AI_DAILY_DIGEST_MINUTE": "0",
                "PERSONAL_AGENT_PROACTIVE_ENABLED": "false",
            },
            clear=False,
        ):
            config = load_config()
        database = MagicMock()
        message_service = MagicMock()
        logger = MagicMock()

        with patch("personal_agent.scheduler.BackgroundScheduler", return_value=fake_scheduler):
            scheduler = create_scheduler(
                config=config,
                database=database,
                message_service=message_service,
                logger=logger,
            )

        self.assertIs(scheduler, fake_scheduler)
        job_map = {job["id"]: job for job in fake_scheduler.jobs}
        self.assertIn("ai_daily_digest", job_map)
        self.assertEqual(job_map["ai_daily_digest"]["func"], "ai_daily_digest_job")
        self.assertEqual(job_map["ai_daily_digest"]["trigger"].fields[5].expressions[0].first, 10)
        self.assertEqual(job_map["ai_daily_digest"]["trigger"].fields[6].expressions[0].first, 0)

    def test_scheduler_skips_reminder_check_when_reminder_delivery_disabled(self) -> None:
        class FakeScheduler:
            def __init__(self, timezone: str) -> None:
                self.timezone = timezone
                self.jobs: list[dict[str, object]] = []

            def add_job(self, func, trigger, id, name, replace_existing, kwargs):
                self.jobs.append(
                    {
                        "func": func.__name__,
                        "trigger": trigger,
                        "id": id,
                        "name": name,
                        "replace_existing": replace_existing,
                        "kwargs": kwargs,
                    }
                )

        fake_scheduler = FakeScheduler(timezone="Asia/Shanghai")
        config = AppConfig(
            base_dir=Path("/tmp/ran-agent-test"),
            data_dir=Path("/tmp/ran-agent-test/data"),
            logs_dir=Path("/tmp/ran-agent-test/logs"),
            vault_dir=Path("/tmp/ran-agent-test/vault"),
            database_path=Path("/tmp/ran-agent-test/data/personal_agent.db"),
            log_file_path=Path("/tmp/ran-agent-test/logs/personal_agent.log"),
            proactive_enabled=True,
            reminder_delivery_enabled=False,
        )
        database = MagicMock()
        message_service = MagicMock()
        logger = MagicMock()

        with patch("personal_agent.scheduler.BackgroundScheduler", return_value=fake_scheduler):
            scheduler = create_scheduler(
                config=config,
                database=database,
                message_service=message_service,
                logger=logger,
            )

        self.assertIs(scheduler, fake_scheduler)
        job_ids = {job["id"] for job in fake_scheduler.jobs}
        self.assertNotIn("reminder_check", job_ids)


if __name__ == "__main__":
    unittest.main()
