"""Tests for the scheduled AI daily digest job."""

from __future__ import annotations

import json
import logging
import socket
import tempfile
import urllib.error
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.ai_daily_digest import (
    AI_DAILY_DIGEST_SENT_PREFIX,
    build_digest_prompt,
    load_aihot_facts,
    prepare_ai_daily_digest,
    run_ai_daily_digest,
)
from personal_agent.config import AppConfig
from personal_agent.db import Database


class StubDigestOutboundClient:
    def __init__(self) -> None:
        self.sent_facts: list[str] = []

    def send_ai_daily_digest(self, facts: str, *, date: str = "") -> dict[str, object]:
        self.sent_facts.append(facts)
        return {"ok": True, "delivery_status": "sent", "outbox_id": "outbox:test-digest", "digest_date": date}


class StubHttpResponse:
    def __init__(self, payload: str) -> None:
        self.payload = payload.encode("utf-8")

    def __enter__(self) -> "StubHttpResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


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

        prompt = build_digest_prompt("FACTS", "2026-08-15")

        self.assertIn("给陛下呈上今日 AI 日报", prompt)
        self.assertIn("2026-08-15", prompt)
        self.assertIn("标题、来源、正文", prompt)
        self.assertIn("50-200", prompt)
        self.assertIn("报道式自然段", prompt)
        self.assertIn("不要使用“看点/意义/适合/今日信号”", prompt)
        self.assertIn("FACTS", prompt)
        self.assertNotIn("{facts}", prompt)
        self.assertNotIn("{YYYY-MM-DD}", prompt)
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

    def test_run_ai_daily_digest_sends_an_honest_partial_when_facts_unavailable(self) -> None:
        outbound = StubDigestOutboundClient()

        def failing_loader() -> str:
            raise urllib.error.URLError("temporary DNS failure")

        result = run_ai_daily_digest(
            config=self.config,
            database=self.database,
            outbound_client=outbound,
            logger=self.logger,
            now_local=datetime(2026, 7, 9, 8, 0, 0),
            facts_loader=failing_loader,
        )

        self.assertTrue(result["sent"])
        self.assertTrue(result["partial"])
        self.assertIn("事实材料暂时不可用", outbound.sent_facts[0])
        sent_key = f"{AI_DAILY_DIGEST_SENT_PREFIX}2026-07-09"
        self.assertEqual(
            json.loads(self.database.get_handoff_value(sent_key) or "{}")["status"],
            "sent",
        )

    def test_run_ai_daily_digest_does_not_mark_sent_without_delivery_commit(self) -> None:
        class UnconfirmedOutbound:
            def send_ai_daily_digest(self, facts: str, *, date: str = "") -> dict[str, object]:
                del facts, date
                return {"ok": True}

        result = run_ai_daily_digest(
            config=self.config,
            database=self.database,
            outbound_client=UnconfirmedOutbound(),
            logger=self.logger,
            now_local=datetime(2026, 7, 10, 8, 0, 0),
            facts_loader=lambda: "facts",
        )

        self.assertFalse(result["sent"])
        self.assertEqual(result["reason"], "delivery_unconfirmed")
        self.assertIsNone(
            self.database.get_handoff_value(f"{AI_DAILY_DIGEST_SENT_PREFIX}2026-07-10")
        )

    def test_load_aihot_facts_falls_back_after_daily_dns_failure(self) -> None:
        calls: list[str] = []

        def urlopen(request, timeout=20):
            calls.append(request.full_url)
            if request.full_url.endswith("/daily"):
                raise urllib.error.URLError(socket.gaierror(-2, "Name or service not known"))
            return StubHttpResponse(
                '{"items":[{"title":"Model news","summary":"Short summary",'
                '"source":"Lab","url":"https://example.test"}]}'
            )

        facts = load_aihot_facts(urlopen=urlopen)

        self.assertEqual(len(calls), 3)
        self.assertIn("Model news", facts)
        self.assertIn("Short summary", facts)

    def test_historical_digest_preparation_uses_exact_daily_endpoint_without_delivery(self) -> None:
        calls: list[str] = []

        def urlopen(request, timeout=20):
            calls.append(request.full_url)
            return StubHttpResponse(
                '{"date":"2026-08-14","sections":[{"label":"模型",'
                '"items":[{"title":"Historical fact","source":"AIHOT"}]}]}'
            )

        prepared = prepare_ai_daily_digest(
            "2026-08-14",
            facts_loader=lambda: load_aihot_facts("2026-08-14", urlopen=urlopen),
        )

        self.assertEqual(calls, ["https://aihot.virxact.com/api/public/daily/2026-08-14"])
        self.assertEqual(prepared["date"], "2026-08-14")
        self.assertIn("Historical fact", str(prepared["prompt"]))
        self.assertIn("2026-08-14", str(prepared["prompt"]))
        self.assertFalse(prepared["partial"])

    def test_run_ai_daily_digest_does_not_mark_sent_without_date_confirmation(self) -> None:
        class DatelessOutbound:
            def send_ai_daily_digest(self, facts: str, *, date: str = "") -> dict[str, object]:
                del facts, date
                return {"ok": True, "delivery_status": "sent", "outbox_id": "outbox:dateless"}

        result = run_ai_daily_digest(
            config=self.config,
            database=self.database,
            outbound_client=DatelessOutbound(),
            logger=self.logger,
            now_local=datetime(2026, 7, 11, 8, 0, 0),
            facts_loader=lambda: "facts",
        )

        self.assertFalse(result["sent"])
        self.assertEqual(result["reason"], "delivery_unconfirmed")
        self.assertIsNone(
            self.database.get_handoff_value(f"{AI_DAILY_DIGEST_SENT_PREFIX}2026-07-11")
        )


if __name__ == "__main__":
    unittest.main()
