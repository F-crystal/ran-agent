"""Tests for the scheduled AI daily digest job."""

from __future__ import annotations

import json
import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.ai_daily_digest import (
    AI_DAILY_DIGEST_SENT_PREFIX,
    build_digest_prompt,
    run_ai_daily_digest,
)
from personal_agent.config import AppConfig
from personal_agent.db import Database


class StubDigestOutboundClient:
    def __init__(self) -> None:
        self.sent_facts: list[str] = []

    def send_ai_daily_digest(self, facts: str) -> dict[str, object]:
        self.sent_facts.append(facts)
        return {"ok": True}


class AiDailyDigestTest(unittest.TestCase):
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
            ai_daily_digest_enabled=True,
        )
        self.logger = logging.getLogger("personal_agent.tests.ai_daily_digest")
        self.logger.handlers.clear()
        self.logger.addHandler(logging.NullHandler())
        self.database = Database(self.config, self.logger)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_build_digest_prompt_uses_editable_report_template(self) -> None:
        template_path = Path("src/personal_agent/prompts/ai_daily_digest_report.md")
        self.assertTrue(template_path.exists())

        prompt = build_digest_prompt("FACTS")

        self.assertIn("给陛下呈上今日 AI 日报", prompt)
        self.assertIn("标题、来源、正文", prompt)
        self.assertIn("50-200", prompt)
        self.assertIn("报道式自然段", prompt)
        self.assertIn("不要使用“看点/意义/适合/今日信号”", prompt)
        self.assertIn("FACTS", prompt)
        self.assertNotIn("{facts}", prompt)
        self.assertNotIn("必须逐字使用", prompt)

    def test_run_ai_daily_digest_sends_once_per_local_date(self) -> None:
        outbound = StubDigestOutboundClient()

        result = run_ai_daily_digest(
            config=self.config,
            database=self.database,
            outbound_client=outbound,
            logger=self.logger,
            now_local=datetime(2026, 5, 28, 10, 0, 0),
            facts_loader=lambda: "AIHOT facts",
        )
        second_result = run_ai_daily_digest(
            config=self.config,
            database=self.database,
            outbound_client=outbound,
            logger=self.logger,
            now_local=datetime(2026, 5, 28, 10, 5, 0),
            facts_loader=lambda: "new facts",
        )

        self.assertTrue(result["sent"])
        self.assertEqual(second_result["reason"], "already_sent")
        self.assertEqual(len(outbound.sent_facts), 1)
        self.assertIn("AIHOT facts", outbound.sent_facts[0])
        sent_key = f"{AI_DAILY_DIGEST_SENT_PREFIX}2026-05-28"
        self.assertEqual(
            json.loads(self.database.get_handoff_value(sent_key) or "{}")["status"],
            "sent",
        )


if __name__ == "__main__":
    unittest.main()
