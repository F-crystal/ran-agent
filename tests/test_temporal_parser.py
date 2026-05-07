from __future__ import annotations

import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.temporal_parser import TemporalParser


def build_test_logger() -> logging.Logger:
    logger = logging.getLogger("personal_agent.tests.temporal_parser")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class TemporalParserTest(unittest.TestCase):
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
        self.parser = TemporalParser(
            logger=build_test_logger(),
            config=self.config,
        )
        self.reference_time = datetime(2026, 4, 15, 11, 0, 0)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_parse_returns_range_for_weekday_afternoon_without_specific_clock_time(self) -> None:
        result = self.parser.parse(
            "提醒我周四下午去找老师",
            reference_time=self.reference_time,
            use_llm_fallback=False,
        )

        self.assertTrue(result.success)
        self.assertEqual(result.iso_timestamp, None)
        self.assertEqual(result.resolution_kind, "datetimerange")
        self.assertEqual(result.range_start, "2026-04-16 12:00:00")
        self.assertEqual(result.range_end, "2026-04-16 16:00:00")

    def test_parse_returns_point_for_weekday_afternoon_with_specific_clock_time(self) -> None:
        result = self.parser.parse(
            "提醒我周四下午一点半去找老师",
            reference_time=self.reference_time,
            use_llm_fallback=False,
        )

        self.assertTrue(result.success)
        self.assertEqual(result.resolution_kind, "datetime")
        self.assertEqual(result.iso_timestamp, "2026-04-16 13:30:00")
        self.assertEqual(result.range_start, None)
        self.assertEqual(result.range_end, None)


if __name__ == "__main__":
    unittest.main()
