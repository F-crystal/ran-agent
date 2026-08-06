"""Shared pytest helpers that keep test state outside the checkout."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from personal_agent.config import AppConfig


_PATH_DEFAULTS = {
    "base_dir": Path("."),
    "data_dir": Path("data"),
    "logs_dir": Path("logs"),
    "vault_dir": Path("vault"),
    "database_path": Path("data/personal_agent.db"),
    "log_file_path": Path("logs/personal_agent.log"),
    "debug_dir": Path("debug"),
    "reflections_dir": Path("debug/reflections"),
    "night_cycles_dir": Path("debug/night_cycles"),
    "vector_memory_index_path": Path("data/memory_vector_index.bin"),
    "vector_memory_metadata_path": Path("data/memory_vector_index.json"),
    "persona_proposals_dir": Path("debug/persona_proposals"),
    "identity_path": Path("IDENTITY.md"),
    "soul_path": Path("SOUL.md"),
}


def make_test_config(tmp_path: Path, **overrides: object) -> AppConfig:
    """Return an AppConfig whose every filesystem path is contained by ``tmp_path``."""

    root = Path(tmp_path).resolve()
    path_values = {name: root / relative for name, relative in _PATH_DEFAULTS.items()}
    config = replace(
        AppConfig(**path_values, ombre_mcp_url="", vector_memory_enabled=False),
        **overrides,
    )

    for field_name in _PATH_DEFAULTS:
        candidate = getattr(config, field_name)
        if not isinstance(candidate, Path) or not candidate.resolve().is_relative_to(root):
            raise ValueError(f"{field_name} is outside pytest tmp_path")
    return config
