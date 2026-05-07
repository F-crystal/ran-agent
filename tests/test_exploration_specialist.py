from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.exploration_specialist import ExplorationSpecialist


def build_test_logger() -> logging.Logger:
    logger = logging.getLogger("personal_agent.tests.exploration_specialist")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class ExplorationSpecialistTest(unittest.TestCase):
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

    def test_extract_user_interests_handles_sqlite_rows(self) -> None:
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"论文","state":"进行中","summary":"用户最近在写论文"}',
            "working",
            importance=1,
        )
        specialist = ExplorationSpecialist(
            database=self.database,
            config=self.config,
            logger=self.logger,
        )

        interests = specialist._extract_user_interests_from_memories()

        self.assertIn("学术", interests)


if __name__ == "__main__":
    unittest.main()
