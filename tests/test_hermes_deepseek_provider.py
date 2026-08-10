from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "hermes/profile/plugins/model-providers/deepseek"


def _runtime() -> tuple[Path, Path]:
    hermes_bin = os.environ.get("RAN_AGENT_HERMES_TEST_BIN")
    assert hermes_bin, "RAN_AGENT_HERMES_TEST_BIN is required"
    hermes_path = Path(hermes_bin)
    assert hermes_path.is_absolute() and hermes_path.is_file()
    assert os.access(hermes_path, os.X_OK)
    runtime_python = os.environ.get("RAN_AGENT_HERMES_TEST_PYTHON_BIN")
    assert runtime_python, "RAN_AGENT_HERMES_TEST_PYTHON_BIN is required"
    python_path = Path(runtime_python)
    assert python_path.is_absolute() and python_path.is_file()
    assert os.access(python_path, os.X_OK)
    artifact = json.loads((ROOT / "docs/governance/hermes_runtime_artifact.v1.json").read_text())
    expected_version = artifact["source"]["version"]
    assert expected_version == "0.20.0"
    assert artifact["dependencies"]["installed"]["hermes-agent"] == expected_version
    install_root = hermes_path.resolve().parents[1]
    probe = subprocess.run(
        [
            str(python_path), "-B", "-I", str(ROOT / "scripts/hermes-sealed-runtime-probe.py"),
            "--install-root", str(install_root),
            "--hermes", str(hermes_path),
            "--python", str(python_path),
            "--expected-version", expected_version,
        ],
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": "/nonexistent",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        text=True,
        capture_output=True,
    )
    assert probe.returncode == 0, f"sealed runtime contract failed: {probe.stderr.strip()}"
    result = json.loads(probe.stdout)
    assert result["cliVersion"] == expected_version
    assert result["metadataVersion"] == expected_version
    return python_path, Path(result["appRoot"])


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
    runtime_python, runtime_app = _runtime()
    home = _installed_home(tmp_path, mode)
    runtime_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "HERMES_HOME": str(home),
        "HERMES_PROVIDER": "deepseek",
        "HERMES_INFERENCE_PROVIDER": "deepseek",
        "HERMES_DEEPSEEK_THINKING_MODE": "disabled",
        "PYTHONSAFEPATH": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(runtime_app),
        "API_SERVER_KEY": "",
    }
    result = subprocess.run(
        [
            str(runtime_python),
            "-B",
            "-P",
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
    runtime_python, runtime_app = _runtime()
    home = _installed_home(tmp_path, "full")
    runtime_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "HERMES_HOME": str(home),
        "HERMES_PROVIDER": "deepseek",
        "HERMES_INFERENCE_PROVIDER": "deepseek",
        "HERMES_DEEPSEEK_THINKING_MODE": "enabled",
        "PYTHONSAFEPATH": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(runtime_app),
    }
    result = subprocess.run(
        [
            str(runtime_python),
            "-B",
            "-P",
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


def _write_runtime_fixture(
    tmp_path: Path,
    *,
    cli_version: str = "0.20.0",
    metadata_version: str = "0.20.0",
    imports: bool = True,
) -> tuple[Path, Path]:
    runtime = tmp_path / "runtime"
    subprocess.run([
        sys.executable, "-m", "venv", "--without-pip", "--copies", str(runtime / "python"),
    ], check=True)
    runtime_python = runtime / "python/bin" / f"python{sys.version_info.major}.{sys.version_info.minor}"
    site = Path(subprocess.check_output([
        str(runtime_python), "-B", "-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))",
    ], text=True).strip())
    metadata = site / f"hermes_agent-{metadata_version}.dist-info"
    metadata.mkdir()
    (metadata / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: hermes-agent\nVersion: {metadata_version}\n",
        encoding="utf-8",
    )
    app = runtime / "app"
    if imports:
        for name in ("gateway", "hermes_cli"):
            package = app / name
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("", encoding="utf-8")
        for name in ("httpx", "openai"):
            package = site / name
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
    else:
        app.mkdir()
    (app / "hermes_cli").mkdir(exist_ok=True)
    (app / "hermes_cli/main.py").write_text(
        "import sys\n"
        f"print('Hermes Agent v{cli_version} (fixture build 2026.8.3)')\n"
        "print('Install directory: fixture')\n"
        "print('Install method: sealed')\n"
        "print('Python: fixture')\n"
        "print('OpenAI SDK: fixture')\n",
        encoding="utf-8",
    )
    hermes = runtime / "bin/hermes"
    hermes.parent.mkdir()
    hermes.write_text(
        "#!/bin/sh\nset -eu\n"
        "ROOT=$(CDPATH= cd \"$(dirname \"$0\")/..\" && pwd -P)\n"
        "unset PYTHONHOME\n"
        "export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONSAFEPATH=1\n"
        "export PYTHONPATH=\"$ROOT/app\"\n"
        "exec \"$ROOT/python/bin/python3\" -m hermes_cli.main \"$@\"\n",
        encoding="utf-8",
    )
    hermes.chmod(0o755)
    return hermes, runtime_python


def _runtime_tree_snapshot(runtime: Path) -> tuple[tuple[str, str, int, str], ...]:
    records = []
    for path in sorted(runtime.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(runtime).as_posix()
        mode = path.lstat().st_mode & 0o7777
        if path.is_symlink():
            records.append((relative, "symlink", mode, os.readlink(path)))
        elif path.is_dir():
            records.append((relative, "directory", mode, ""))
        else:
            records.append((relative, "file", mode, hashlib.sha256(path.read_bytes()).hexdigest()))
    return tuple(records)


def test_shared_probe_requires_bytecode_guard_and_preserves_runtime_tree(tmp_path: Path) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path)
    runtime = hermes.parents[1]
    probe = ROOT / "scripts/hermes-sealed-runtime-probe.py"
    arguments = [
        str(probe),
        "--install-root", str(runtime),
        "--hermes", str(hermes),
        "--python", str(runtime_python),
        "--expected-version", "0.20.0",
    ]
    before = _runtime_tree_snapshot(runtime)
    unguarded = subprocess.run(
        [str(runtime_python), "-I", *arguments],
        text=True,
        capture_output=True,
        env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"},
    )
    assert unguarded.returncode != 0
    assert "bytecode_write_guard_required" in unguarded.stderr
    assert _runtime_tree_snapshot(runtime) == before

    guarded = subprocess.run(
        [str(runtime_python), "-B", "-I", *arguments],
        text=True,
        capture_output=True,
        env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"},
    )
    assert guarded.returncode == 0, guarded.stderr
    after = _runtime_tree_snapshot(runtime)
    assert after == before
    assert not any(path.name == "__pycache__" or path.suffix == ".pyc" for path in runtime.rglob("*"))


def test_runtime_v020_without_project_line_uses_explicit_python(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path)
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    assert _runtime()[0] == runtime_python


def test_runtime_rejects_v013(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path, cli_version="0.13.0")
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
    with pytest.raises(AssertionError, match="sealed runtime contract failed"):
        _runtime()


def test_runtime_rejects_wrong_app_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path)
    app = hermes.parent.parent / "app"
    app.rename(hermes.parent.parent / "unrelated-app")
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    with pytest.raises(AssertionError, match="sealed runtime contract failed"):
        _runtime()


def test_runtime_rejects_wrong_package_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path, metadata_version="0.19.0")
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    with pytest.raises(AssertionError, match="sealed runtime contract failed"):
        _runtime()


def test_runtime_ignores_ambient_pythonpath(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, runtime_python = _write_runtime_fixture(tmp_path)
    attacker = tmp_path / "attacker"
    (attacker / "gateway").mkdir(parents=True)
    (attacker / "gateway/__init__.py").write_text("raise RuntimeError('ambient path used')\n")
    monkeypatch.setenv("PYTHONPATH", str(attacker))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(runtime_python))
    assert _runtime()[0] == runtime_python


def test_runtime_rejects_python_from_another_installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes, _runtime_python = _write_runtime_fixture(tmp_path / "one")
    _other_hermes, other_python = _write_runtime_fixture(tmp_path / "two")
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_BIN", str(hermes))
    monkeypatch.setenv("RAN_AGENT_HERMES_TEST_PYTHON_BIN", str(other_python))
    with pytest.raises(AssertionError, match="sealed runtime contract failed"):
        _runtime()
