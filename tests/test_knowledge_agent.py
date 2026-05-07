"""Tests for the background Qwen Code knowledge-agent wrapper."""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.knowledge_agent import KnowledgeAgent, load_knowledge_state


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
            qwen_timeout_seconds=1,
        )
        (self.config.vault_dir / "inbox").mkdir(parents=True, exist_ok=True)
        (self.config.vault_dir / "wiki" / "sources").mkdir(parents=True, exist_ok=True)
        self.logger = build_test_logger()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_auto_run_executes_plan_apply_cleanup_chain(self) -> None:
        """Test that auto_run executes the full plan→apply→cleanup chain."""
        inbox_dir = self.config.vault_dir / "inbox"
        (inbox_dir / "item-1.md").write_text("hello\n", encoding="utf-8")

        call_order = []

        def runner(action: str) -> subprocess.CompletedProcess[str]:
            call_order.append(action)
            return subprocess.CompletedProcess(args=[action], returncode=0, stdout=f"{action} done", stderr="")

        agent = KnowledgeAgent(config=self.config, logger=self.logger, command_runner=runner)
        result = agent.auto_run(trigger="scheduler", now_local=datetime(2026, 4, 11, 12, 0, 0))

        # Should execute plan, then apply, then cleanup
        self.assertEqual(call_order, ["plan", "apply", "cleanup"])
        # Result should be from the first action (plan)
        self.assertEqual(result.action, "plan")
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(result.timed_out)

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
