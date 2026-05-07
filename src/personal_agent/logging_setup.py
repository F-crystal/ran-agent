"""Logging setup for console and file output."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from personal_agent.config import AppConfig


def configure_logging(config: AppConfig) -> logging.Logger:
    """Configure the application logger once and return it."""

    config.logs_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("personal_agent")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    file_handler = RotatingFileHandler(
        config.log_file_path,
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    logger.addHandler(stream_handler)
    logger.addHandler(file_handler)
    logger.propagate = False
    logger.info("logging initialized")
    return logger
