from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.persona_evolution import evolve_persona_bootstrap
from personal_agent.reflection_specialist import generate_reflection_report


def build_test_logger() -> logging.Logger:
    logger = logging.getLogger("personal_agent.tests.persona_evolution")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class PersonaEvolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            debug_dir=base_dir / "debug",
            reflections_dir=base_dir / "debug" / "reflections",
            night_cycles_dir=base_dir / "debug" / "night_cycles",
            persona_proposals_dir=base_dir / "debug" / "persona_proposals",
            identity_path=base_dir / "IDENTITY.md",
            soul_path=base_dir / "SOUL.md",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()
        self.config.identity_path.write_text("# IDENTITY.md\n\n手写身份段落。\n", encoding="utf-8")
        self.config.soul_path.write_text("# SOUL.md\n\n手写灵魂段落。\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_persona_evolution_writes_proposal_and_updates_managed_sections(self) -> None:
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u1",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="聊天",
            intimacy_level=0,
            recent_turn_summary="话题:聊天；意图:有点乱",
            time_of_day="evening",
            user_message="我有点乱",
            first_draft="哈哈，那你可以先把事情拆成三部分。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["blacklisted_opening","casual_became_advisory"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )
        report = generate_reflection_report(self.database, self.config, self.logger, limit=20)

        result = evolve_persona_bootstrap(
            config=self.config,
            reflection_report=report,
            summary_date="2026-04-16",
            logger=self.logger,
        )

        assert result is not None
        self.assertTrue(result.proposal_json_path.exists())
        self.assertTrue(result.proposal_markdown_path.exists())
        identity_text = self.config.identity_path.read_text(encoding="utf-8")
        soul_text = self.config.soul_path.read_text(encoding="utf-8")
        self.assertIn("手写身份段落。", identity_text)
        self.assertIn("手写灵魂段落。", soul_text)
        self.assertIn("BEGIN AUTO-IDENTITY", identity_text)
        self.assertIn("BEGIN AUTO-SOUL", soul_text)

    def test_persona_evolution_does_not_duplicate_existing_auto_evolution_heading(self) -> None:
        self.config.identity_path.write_text(
            "# IDENTITY.md\n\n手写身份段落。\n\n## Auto Evolution\n<!-- BEGIN AUTO-IDENTITY -->\n- old identity\n<!-- END AUTO-IDENTITY -->\n",
            encoding="utf-8",
        )
        self.config.soul_path.write_text(
            "# SOUL.md\n\n手写灵魂段落。\n\n## Auto Evolution\n<!-- BEGIN AUTO-SOUL -->\n- old soul\n<!-- END AUTO-SOUL -->\n",
            encoding="utf-8",
        )
        self.database.record_reply_review_observation(
            channel="wechat",
            sender_id="u1",
            route="text_chat",
            response_mode="casual_chat",
            current_topic="聊天",
            intimacy_level=0,
            recent_turn_summary="话题:聊天；意图:有点乱",
            time_of_day="evening",
            user_message="我有点乱",
            first_draft="哈哈，那你可以先把事情拆成三部分。",
            final_reply="先不急，慢慢说也可以。",
            review_triggered=True,
            review_reasons='["blacklisted_opening"]',
            retry_performed=True,
            retry_success=True,
            false_positive_candidate=False,
            user_dissatisfaction_signal=True,
        )
        report = generate_reflection_report(self.database, self.config, self.logger, limit=20)

        evolve_persona_bootstrap(
            config=self.config,
            reflection_report=report,
            summary_date="2026-04-16",
            logger=self.logger,
        )

        identity_text = self.config.identity_path.read_text(encoding="utf-8")
        soul_text = self.config.soul_path.read_text(encoding="utf-8")
        self.assertEqual(identity_text.count("## Auto Evolution"), 1)
        self.assertEqual(soul_text.count("## Auto Evolution"), 1)


if __name__ == "__main__":
    unittest.main()
