"""Tests for the repository-wide isolated AppConfig factory."""

from __future__ import annotations

from pathlib import Path
from typing import get_type_hints

import pytest

from conftest import make_test_config
from personal_agent.config import AppConfig


def test_make_test_config_keeps_every_path_field_under_tmp_path(tmp_path: Path) -> None:
    config = make_test_config(tmp_path)

    path_fields = {
        name for name, annotation in get_type_hints(AppConfig).items() if annotation is Path
    }

    assert path_fields == {
        "base_dir",
        "data_dir",
        "logs_dir",
        "vault_dir",
        "database_path",
        "log_file_path",
        "debug_dir",
        "reflections_dir",
        "night_cycles_dir",
        "vector_memory_index_path",
        "vector_memory_metadata_path",
        "persona_proposals_dir",
        "identity_path",
        "soul_path",
    }
    for field_name in path_fields:
        assert getattr(config, field_name).resolve().is_relative_to(tmp_path.resolve())


def test_make_test_config_rejects_path_override_outside_tmp_path(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="outside pytest tmp_path"):
        make_test_config(tmp_path, vault_dir=tmp_path.parent / "escaped-vault")
