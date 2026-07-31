from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "hermes/profile/plugins/model-providers/deepseek"


def _runtime_project() -> Path:
    result = subprocess.run(
        [os.environ.get("RAN_AGENT_HERMES_TEST_BIN")
         or os.environ.get("HERMES_TEST_BIN", "hermes"), "version"],
        check=True,
        text=True,
        capture_output=True,
    )
    assert "Hermes Agent v0.13." in result.stdout
    project = next(
        line.split(":", 1)[1].strip()
        for line in result.stdout.splitlines()
        if line.startswith("Project:")
    )
    return Path(project)


def _installed_home(tmp_path: Path, mode: str) -> Path:
    home = tmp_path / f"hermes-{mode}"
    destination = home / "plugins/model-providers/deepseek"
    destination.mkdir(parents=True)
    shutil.copy2(PLUGIN / "__init__.py", destination / "__init__.py")
    shutil.copy2(PLUGIN / "plugin.yaml", destination / "plugin.yaml")
    return home


@pytest.mark.parametrize("mode", ("lite", "full"))
def test_real_hermes_v013_final_http_body_is_non_thinking(
    tmp_path: Path, mode: str
) -> None:
    project = _runtime_project()
    home = _installed_home(tmp_path, mode)
    result = subprocess.run(
        [
            str(project / "venv/bin/python"),
            str(ROOT / "scripts/hermes-provider-boundary-self-check.py"),
            "--hermes-home",
            str(home),
            "--mode",
            mode,
            "--model",
            "deepseek-v4-pro",
        ],
        check=True,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "HERMES_HOME": str(home),
            "HERMES_PROVIDER": "deepseek",
            "HERMES_INFERENCE_PROVIDER": "deepseek",
            "HERMES_DEEPSEEK_THINKING_MODE": "disabled",
            "PYTHONPATH": str(project),
            "API_SERVER_KEY": "",
        },
    )
    assert f"mode={mode} provider=deepseek model=deepseek-v4-pro thinking=disabled" in result.stdout
    assert "tools=present response_format=json_object transport=mock" in result.stdout
    assert "adapter_normalized=yes" in result.stdout


def test_real_provider_policy_fails_closed_if_env_requests_enabled(
    tmp_path: Path,
) -> None:
    project = _runtime_project()
    home = _installed_home(tmp_path, "full")
    result = subprocess.run(
        [
            str(project / "venv/bin/python"),
            str(ROOT / "scripts/hermes-provider-boundary-self-check.py"),
            "--hermes-home",
            str(home),
            "--mode",
            "full",
        ],
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "HERMES_HOME": str(home),
            "HERMES_PROVIDER": "deepseek",
            "HERMES_INFERENCE_PROVIDER": "deepseek",
            "HERMES_DEEPSEEK_THINKING_MODE": "enabled",
            "PYTHONPATH": str(project),
        },
    )
    assert result.returncode != 0
    assert "thinking_policy_not_disabled" in result.stderr
