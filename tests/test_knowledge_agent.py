"""Tests for the background knowledge-agent wrapper."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from personal_agent.config import AppConfig
from personal_agent.knowledge_agent import KnowledgeAgent, KnowledgeState, load_knowledge_state, save_knowledge_state


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated knowledge-agent tests."""

    logger = logging.getLogger("personal_agent.tests.knowledge_agent")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class KnowledgeAgentTest(unittest.TestCase):
    """Covers structured background knowledge-agent runs and state persistence."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.base_dir = base_dir
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
            knowledge_agent_timeout_seconds=1,
        )
        (self.config.vault_dir / "inbox").mkdir(parents=True, exist_ok=True)
        (self.config.vault_dir / "wiki" / "sources").mkdir(parents=True, exist_ok=True)
        self.logger = build_test_logger()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_auto_run_executes_plan_apply_cleanup_chain(self) -> None:
        """Test that auto_run executes the full plan→apply→cleanup chain."""
        inbox_dir = self.config.vault_dir / "inbox"
        item_1 = inbox_dir / "item-1.md"
        item_2 = inbox_dir / "item-2.md"
        item_1.write_text("hello\n", encoding="utf-8")
        item_2.write_text("hello again\n", encoding="utf-8")

        call_order = []

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            call_order.append(action)
            if action == "apply" and item_1.exists():
                item_1.unlink()
            if action == "cleanup" and item_2.exists():
                item_2.unlink()
            return subprocess.CompletedProcess(args=[action], returncode=0, stdout=f"{action} done", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.auto_run(trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        self.assertEqual(call_order, ["plan", "apply", "cleanup"])
        self.assertEqual(result.action, "cleanup")
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(result.timed_out)

    def test_auto_run_stops_when_apply_returns_ok_without_inbox_progress(self) -> None:
        inbox_dir = self.config.vault_dir / "inbox"
        (inbox_dir / "item-1.md").write_text("hello\n", encoding="utf-8")

        call_order = []

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            call_order.append(action)
            return subprocess.CompletedProcess(args=[action], returncode=0, stdout=f"{action} done", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.auto_run(trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        self.assertEqual(call_order, ["plan", "apply"])
        self.assertEqual(result.action, "apply")
        self.assertEqual(result.status, "no_progress")
        self.assertIn("did not reduce inbox", result.error)

    def test_daily_carryover_requires_target_note_progress(self) -> None:
        inbox_dir = self.config.vault_dir / "inbox"
        note_path = inbox_dir / "night_cycle_2026-04-11.md"
        note_path.write_text("carry-over\n", encoding="utf-8")

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(args=[action], returncode=0, stdout="daily done", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.run(action="daily_carryover", trigger="test", now_local=datetime(2026, 4, 12, 4, 0, 0))

        self.assertEqual(result.status, "no_progress")
        self.assertEqual(result.inbox_count_before, 1)
        self.assertEqual(result.inbox_count_after, 1)
        self.assertIn("night_cycle_2026-04-11.md", result.error)

    def test_auto_run_stops_chain_on_failure(self) -> None:
        """Test that chain stops when a step fails."""
        inbox_dir = self.config.vault_dir / "inbox"
        (inbox_dir / "item-1.md").write_text("hello\n", encoding="utf-8")

        call_order = []

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            call_order.append(action)
            if action == "apply":
                return subprocess.CompletedProcess(args=[action], returncode=1, stdout="", stderr="error")
            return subprocess.CompletedProcess(args=[action], returncode=0, stdout=f"{action} done", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.auto_run(trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        # Should stop after apply fails
        self.assertEqual(call_order, ["plan", "apply"])
        # Failure should be surfaced from the step that stopped the chain.
        self.assertEqual(result.action, "apply")
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.returncode, 1)

    def test_should_not_surface_maintenance_when_backlog_count_equals_threshold(self) -> None:
        now_local = datetime(2026, 4, 11, 12, 0, 0)
        save_knowledge_state(
            self.config,
            KnowledgeState(last_checked_at="2026-04-11 11:59:00", inbox_count=0),
        )
        inbox_dir = self.config.vault_dir / "inbox"
        for index in range(self.config.knowledge_backlog_trigger_count):
            (inbox_dir / f"item-{index}.md").write_text("hello\n", encoding="utf-8")

        agent = KnowledgeAgent(config=self.config, logger=self.logger)

        self.assertFalse(agent.should_surface_maintenance(now_local=now_local))

    def test_should_surface_maintenance_when_backlog_count_exceeds_threshold(self) -> None:
        now_local = datetime(2026, 4, 11, 12, 0, 0)
        save_knowledge_state(
            self.config,
            KnowledgeState(last_checked_at="2026-04-11 11:59:00", inbox_count=0),
        )
        inbox_dir = self.config.vault_dir / "inbox"
        for index in range(self.config.knowledge_backlog_trigger_count + 1):
            (inbox_dir / f"item-{index}.md").write_text("hello\n", encoding="utf-8")

        agent = KnowledgeAgent(config=self.config, logger=self.logger)

        self.assertTrue(agent.should_surface_maintenance(now_local=now_local))

    def test_should_surface_maintenance_when_oldest_inbox_item_is_stale(self) -> None:
        now_local = datetime(2026, 4, 11, 12, 0, 0)
        config = AppConfig(
            base_dir=self.base_dir,
            data_dir=self.base_dir / "data",
            logs_dir=self.base_dir / "logs",
            vault_dir=self.base_dir / "vault",
            database_path=self.base_dir / "data" / "personal_agent.db",
            log_file_path=self.base_dir / "logs" / "personal_agent.log",
            knowledge_check_interval_minutes=360,
            knowledge_backlog_trigger_count=99,
            knowledge_backlog_trigger_age_minutes=120,
        )
        save_knowledge_state(
            config,
            KnowledgeState(last_checked_at="2026-04-11 11:59:00", inbox_count=0),
        )
        item_path = config.vault_dir / "inbox" / "item-1.md"
        item_path.write_text("hello\n", encoding="utf-8")
        stale_timestamp = datetime(2026, 4, 11, 9, 30, 0).timestamp()
        os.utime(item_path, (stale_timestamp, stale_timestamp))

        agent = KnowledgeAgent(config=config, logger=self.logger)

        self.assertTrue(agent.should_surface_maintenance(now_local=now_local))

    def test_default_runner_times_out_and_persists_clear_result(self) -> None:
        script_path = self.config.base_dir / "vault_runner.sh"
        script_path.write_text(
            "#!/bin/bash\nsleep 5\n",
            encoding="utf-8",
        )

        inbox_dir = self.config.vault_dir / "inbox"
        (inbox_dir / "item-1.md").write_text("hello\n", encoding="utf-8")

        agent = KnowledgeAgent(config=self.config, logger=self.logger)
        result = agent.run(action="plan", trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        self.assertEqual(result.status, "timeout")
        self.assertTrue(result.timed_out)
        self.assertEqual(result.returncode, -9)
        self.assertIn("timed out after 1s", result.error)
        self.assertGreaterEqual(result.duration_seconds, 1.0)

        state_payload = json.loads((self.config.data_dir / "knowledge_state.json").read_text(encoding="utf-8"))
        self.assertEqual(state_payload["last_status"], "timeout")
        self.assertTrue(state_payload["last_timed_out"])

    def test_default_runner_uses_configurable_command_and_api_key_env(self) -> None:
        script_path = self.config.base_dir / "reasonix_runner.sh"
        script_path.write_text(
            "#!/bin/bash\nprintf 'runner_api=%s action=%s\\n' \"$REASONIX_API_KEY\" \"$1\"\n",
            encoding="utf-8",
        )
        script_path.chmod(0o755)
        inbox_dir = self.config.vault_dir / "inbox"
        item_path = inbox_dir / "item-1.md"
        item_path.write_text("hello\n", encoding="utf-8")

        config = AppConfig(
            base_dir=self.base_dir,
            data_dir=self.base_dir / "data",
            logs_dir=self.base_dir / "logs",
            vault_dir=self.base_dir / "vault",
            database_path=self.base_dir / "data" / "personal_agent.db",
            log_file_path=self.base_dir / "logs" / "personal_agent.log",
            knowledge_agent_runner_name="reasonix",
            knowledge_agent_command=f"/bin/bash {script_path}",
            knowledge_agent_api_key_env_var="REASONIX_API_KEY",
            knowledge_agent_timeout_seconds=1,
        )

        with patch.dict(os.environ, {"REASONIX_API_KEY": "secret-test-key"}):
            agent = KnowledgeAgent(config=config, logger=self.logger)
            result = agent.run(action="plan", trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        self.assertEqual(result.status, "ok")
        self.assertIn("runner_api=secret-test-key action=plan", result.output_excerpt)

    def test_timeout_result_reflects_partial_inbox_progress(self) -> None:
        inbox_dir = self.config.vault_dir / "inbox"
        item_path = inbox_dir / "item-1.md"
        item_path.write_text("hello\n", encoding="utf-8")

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            item_path.unlink()
            raise subprocess.TimeoutExpired(cmd=[action], timeout=1, output="partial", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.run(action="apply", trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        self.assertEqual(result.status, "timeout")
        self.assertEqual(result.inbox_count_before, 1)
        self.assertEqual(result.inbox_count_after, 0)
        self.assertEqual(result.processed_inbox_count, 1)
        self.assertFalse(result.pending_knowledge_maintenance)


if __name__ == "__main__":
    unittest.main()
