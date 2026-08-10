from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "hermes/profile/plugins/model-providers/deepseek"


def _runtime() -> Path:
    hermes_bin = os.environ.get("RAN_AGENT_HERMES_TEST_BIN")
    assert hermes_bin, "RAN_AGENT_HERMES_TEST_BIN is required"
    hermes_path = Path(hermes_bin)
    assert hermes_path.is_absolute() and hermes_path.is_file()
    assert os.access(hermes_path, os.X_OK)
    result = subprocess.run(
        [str(hermes_path), "version"],
        check=True,
        text=True,
        capture_output=True,
    )
    assert result.stdout.strip() == "Hermes Agent v0.20.0"
    runtime_python = os.environ.get("RAN_AGENT_HERMES_TEST_PYTHON_BIN")
    assert runtime_python, "RAN_AGENT_HERMES_TEST_PYTHON_BIN is required"
    python_path = Path(runtime_python)
    assert python_path.is_absolute() and python_path.is_file()
    assert os.access(python_path, os.X_OK)
    imports = subprocess.run(
        [str(python_path), "-I", "-c", "import gateway, hermes_cli, httpx, openai"],
        text=True,
        capture_output=True,
    )
    assert imports.returncode == 0, "runtime Python cannot import required Hermes modules"
    return python_path


def _installed_home(tmp_path: Path, mode: str) -> Path:
    home = tmp_path / f"hermes-{mode}"
    destination = home / "plugins/model-providers/deepseek"
    destination.mkdir(parents=True)
    shutil.copy2(PLUGIN / "__init__.py", destination / "__init__.py")
    shutil.copy2(PLUGIN / "plugin.yaml", destination / "plugin.yaml")
    return home


@pytest.mark.parametrize("mode", ("lite", "full"))
def test_real_hermes_v020_final_http_body_is_non_thinking(
    tmp_path: Path, mode: str
) -> None:
    runtime_python = _runtime()
    home = _installed_home(tmp_path, mode)
    runtime_env = {
        **os.environ,
        "HERMES_HOME": str(home),
        "HERMES_PROVIDER": "deepseek",
        "HERMES_INFERENCE_PROVIDER": "deepseek",
        "HERMES_DEEPSEEK_THINKING_MODE": "disabled",
        "PYTHONSAFEPATH": "1",
        "PYTHONNOUSERSITE": "1",
        "API_SERVER_KEY": "",
    }
    runtime_env.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            str(runtime_python),
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
        env=runtime_env,
    )
    assert f"mode={mode} provider=deepseek model=deepseek-v4-pro thinking=disabled" in result.stdout
    assert "tools=present response_format=json_object transport=mock" in result.stdout
    assert "adapter_normalized=yes" in result.stdout


def test_real_provider_policy_fails_closed_if_env_requests_enabled(
    tmp_path: Path,
) -> None:
    runtime_python = _runtime()
    home = _installed_home(tmp_path, "full")
    runtime_env = {
        **os.environ,
        "HERMES_HOME": str(home),
        "HERMES_PROVIDER": "deepseek",
        "HERMES_INFERENCE_PROVIDER": "deepseek",
        "HERMES_DEEPSEEK_THINKING_MODE": "enabled",
        "PYTHONSAFEPATH": "1",
        "PYTHONNOUSERSITE": "1",
    }
    runtime_env.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            str(runtime_python),
            str(ROOT / "scripts/hermes-provider-boundary-self-check.py"),
            "--hermes-home",
            str(home),
            "--mode",
            "full",
        ],
        text=True,
        capture_output=True,
        env=runtime_env,
    )
    assert result.returncode != 0
    assert "thinking_policy_not_disabled" in result.stderr


def _write_runtime_fixture(tmp_path: Path, version: str = "v0.20.0", imports: bool = True) -> tuple[Path, Path]:
    hermes = tmp_path / "hermes"
    hermes.write_text(f"#!/bin/sh\nprintf 'Hermes Agent {version}\\n'\n", encoding="utf-8")
    hermes.chmod(0o755)
    runtime_python = tmp_path / "runtime/bin/python"
    runtime_python.parent.mkdir(parents=True)
    runtime_python.write_text(f"#!/bin/sh\nexit {0 if imports else 1}\n", encoding="utf-8")
    runtime_python.chmod(0o755)
    return hermes, runtime_python


def test_runtime_v020_without_project_line_uses_explicit_python(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path)
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    assert _runtime() == runtime_python


def test_runtime_rejects_v013(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path, version="v0.13.0")
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    with pytest.raises(AssertionError):
        _runtime()


def test_runtime_python_is_required(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hermes, _runtime_python = _write_runtime_fixture(tmp_path)
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.delenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", raising=False)
    with pytest.raises(AssertionError, match="RAN_AGENT_HERMES_TEST_PYTHON_BIN is required"):
        _runtime()


def test_runtime_python_must_import_required_modules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path, imports=False)
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    with pytest.raises(AssertionError, match="cannot import required Hermes modules"):
        _runtime()
