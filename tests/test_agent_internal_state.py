"""Tests for the agent's own short-window internal lifecycle state."""

from __future__ import annotations

import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.agent_internal_state import (
    AgentActionTrace,
    AgentInternalState,
    OpportunityTrace,
    PendingItem,
    append_opportunities,
    apply_decisions,
    has_recent_action,
    has_recent_proactive_seed,
    load_agent_internal_state,
    record_proactive_send,
    save_agent_internal_state,
)
from personal_agent.config import AppConfig
from personal_agent.db import Database


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated internal-state tests."""

    logger = logging.getLogger("personal_agent.tests.agent_internal_state")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class AgentInternalStateTest(unittest.TestCase):
    """Covers short-window internal traces for opportunities and actions."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_internal_state_round_trips_through_handoff_memory(self) -> None:
        state = AgentInternalState(
            recent_opportunities=(
                OpportunityTrace(
                    opportunity_id="opp-1",
                    kind="companion",
                    attention_hint="worth_a_look",
                    status="open",
                    reason="idle",
                    created_at="2026-04-11 21:00:00",
                ),
            ),
            recent_actions=(
                AgentActionTrace(
                    opportunity_id="opp-1",
                    kind="companion",
                    action="message",
                    reason="natural_opening",
                    created_at="2026-04-11 21:01:00",
                ),
            ),
            updated_at="2026-04-11 21:01:00",
        )
        save_agent_internal_state(self.database, state)

        loaded = load_agent_internal_state(self.database)

        self.assertEqual(loaded.recent_opportunities[0].kind, "companion")
        self.assertEqual(loaded.recent_actions[0].action, "message")

    def test_apply_decisions_prunes_expired_pending_items(self) -> None:
        state = AgentInternalState(
            pending_items=(
                PendingItem(
                    opportunity_id="expired",
                    kind="companion",
                    action="defer",
                    reason="timing_bad",
                    expires_at="2026-04-11 20:00:00",
                    created_at="2026-04-11 19:00:00",
                ),
            ),
        )
        updated = apply_decisions(
            state,
            actions=[],
            suppressed=[],
            pending_items=[
                PendingItem(
                    opportunity_id="fresh",
                    kind="companion",
                    action="inspect_more",
                    reason="needs_context",
                    expires_at="2026-04-11 23:30:00",
                    created_at="2026-04-11 21:30:00",
                )
            ],
            now_local=datetime(2026, 4, 11, 21, 45, 0),
        )

        self.assertEqual(len(updated.pending_items), 1)
        self.assertEqual(updated.pending_items[0].opportunity_id, "fresh")

    def test_record_proactive_send_updates_recent_trace_and_last_sent_time(self) -> None:
        state = AgentInternalState()

        updated = record_proactive_send(
            state,
            opportunity_id="opp-9",
            seed="论文",
            text="刚想到你最近一直在忙论文，今天还顺吗。",
            now_local=datetime(2026, 4, 11, 21, 45, 0),
        )

        self.assertEqual(updated.last_proactive_at, "2026-04-11 21:45:00")
        self.assertEqual(len(updated.recent_proactive_trace), 1)
        self.assertEqual(updated.recent_proactive_trace[0].seed, "论文")
        self.assertTrue(
            has_recent_proactive_seed(
                updated,
                seed="论文",
                now_local=datetime(2026, 4, 11, 22, 0, 0),
                within_minutes=60,
            )
        )

    def test_has_recent_action_detects_short_window_repeat(self) -> None:
        state = AgentInternalState(
            recent_actions=(
                AgentActionTrace(
                    opportunity_id="opp-1",
                    kind="companion",
                    action="message",
                    reason="natural_opening",
                    created_at="2026-04-11 21:05:00",
                ),
            )
        )

        self.assertTrue(
            has_recent_action(
                state,
                kind="companion",
                action="message",
                now_local=datetime(2026, 4, 11, 21, 30, 0),
                within_minutes=60,
            )
        )
        self.assertFalse(
            has_recent_action(
                state,
                kind="companion",
                action="message",
                now_local=datetime(2026, 4, 11, 23, 30, 0),
                within_minutes=60,
            )
        )


if __name__ == "__main__":
    unittest.main()
