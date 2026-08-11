#!/usr/bin/env python3
"""Fail-closed structural probe for the sealed Hermes runtime."""

from __future__ import annotations

import sys

if not sys.dont_write_bytecode or "-B" not in getattr(sys, "orig_argv", ()):
    raise SystemExit("hermes-sealed-runtime-probe: failed:bytecode_write_guard_required")

import argparse
import importlib
import importlib.metadata
import json
import os
import re
import shutil
import stat
import subprocess
import sysconfig
import tempfile
from pathlib import Path


def fail(reason: str) -> None:
    raise SystemExit(f"hermes-sealed-runtime-probe: failed:{reason}")


def real_directory(path: Path, reason: str) -> Path:
    try:
        if path.is_symlink() or not path.is_dir():
            fail(reason)
        return path.resolve(strict=True)
    except OSError:
        fail(reason)


def real_file(path: Path, reason: str) -> Path:
    try:
        if path.is_symlink() or not path.is_file():
            fail(reason)
        return path.resolve(strict=True)
    except OSError:
        fail(reason)


def contained(file: str | None, root: Path) -> bool:
    if not file:
        return False
    try:
        Path(file).resolve(strict=True).relative_to(root)
        return True
    except (OSError, ValueError):
        return False


def scratch_identity(home: Path) -> tuple[int, int] | None:
    try:
        metadata = home.lstat()
    except OSError:
        return None
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        return None
    return metadata.st_dev, metadata.st_ino


def run_cli_version(hermes: Path) -> subprocess.CompletedProcess[str]:
    home: Path | None = None
    identity: tuple[int, int] | None = None
    cli: subprocess.CompletedProcess[str] | None = None
    failure: str | None = None
    try:
        home = Path(tempfile.mkdtemp(prefix="ran-agent-hermes-probe-home-", dir="/tmp"))
        identity = scratch_identity(home)
        if identity is None or any(home.iterdir()):
            failure = "hermes_cli_home_invalid"
        else:
            cli = subprocess.run(
                [str(hermes), "version"],
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
                env={
                    "PATH": "/usr/bin:/bin",
                    "HOME": str(home),
                    "TMPDIR": str(home),
                    "XDG_CACHE_HOME": str(home / ".cache"),
                    "XDG_CONFIG_HOME": str(home / ".config"),
                    "XDG_STATE_HOME": str(home / ".local/state"),
                    "XDG_DATA_HOME": str(home / ".local/share"),
                    "PYTHONNOUSERSITE": "1",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONSAFEPATH": "1",
                },
            )
            if cli.returncode != 0:
                failure = "hermes_cli_version_failed"
            if scratch_identity(home) != identity:
                failure = failure or "hermes_cli_home_invalid"
    except (OSError, subprocess.TimeoutExpired):
        if failure is None:
            failure = "hermes_cli_version_failed" if home is not None else "hermes_cli_home_unavailable"
    cleanup_failed = False
    if home is not None:
        if identity is None or scratch_identity(home) != identity:
            cleanup_failed = home.exists() or home.is_symlink()
        else:
            try:
                shutil.rmtree(home)
            except OSError:
                cleanup_failed = True
            else:
                cleanup_failed = home.exists() or home.is_symlink()
    if cleanup_failed:
        failure = f"{failure}:hermes_cli_home_cleanup_failed" if failure else "hermes_cli_home_cleanup_failed"
    if failure:
        fail(failure)
    if cli is None:
        fail("hermes_cli_version_failed")
    return cli


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--install-root", type=Path, required=True)
    parser.add_argument("--hermes", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.expected_version):
        fail("expected_version_invalid")
    root = real_directory(args.install_root, "install_root_invalid")
    hermes = real_file(args.hermes, "hermes_executable_invalid")
    python = real_file(args.python, "runtime_python_invalid")
    if hermes != root / "bin/hermes":
        fail("hermes_root_mismatch")
    if Path(sys.executable).resolve(strict=True) != python:
        fail("runtime_python_process_mismatch")
    if python.parent != root / "python/bin" or not re.fullmatch(r"python[0-9]+\.[0-9]+", python.name):
        fail("runtime_python_root_mismatch")

    app = real_directory(root / "app", "runtime_app_invalid")
    expected_site = real_directory(
        root / f"python/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages",
        "runtime_site_packages_invalid",
    )
    try:
        actual_site = Path(sysconfig.get_path("purelib")).resolve(strict=True)
    except OSError:
        fail("runtime_site_packages_invalid")
    if actual_site != expected_site:
        fail("runtime_site_packages_mismatch")

    try:
        distribution = importlib.metadata.distribution("hermes-agent")
        metadata_version = distribution.version
        metadata_root = Path(distribution.locate_file("")).resolve(strict=True)
    except (importlib.metadata.PackageNotFoundError, OSError):
        fail("hermes_metadata_unavailable")
    if metadata_root != expected_site or metadata_version != args.expected_version:
        fail("hermes_metadata_version_mismatch")

    sys.path.insert(0, str(app))
    for name in ("gateway", "hermes_cli"):
        try:
            module = importlib.import_module(name)
        except Exception:
            fail(f"runtime_app_import_failed:{name}")
        if not contained(getattr(module, "__file__", None), app):
            fail(f"runtime_app_origin_mismatch:{name}")
    for name in ("httpx", "openai"):
        try:
            module = importlib.import_module(name)
        except Exception:
            fail(f"runtime_dependency_import_failed:{name}")
        if not contained(getattr(module, "__file__", None), expected_site):
            fail(f"runtime_dependency_origin_mismatch:{name}")

    cli = run_cli_version(hermes)
    versions = re.findall(
        r"(?m)^Hermes Agent v([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)",
        cli.stdout,
    )
    if versions != [args.expected_version]:
        fail("hermes_cli_version_mismatch")

    print(json.dumps({
        "appRoot": str(app),
        "cliVersion": versions[0],
        "hermesExecutable": str(hermes),
        "metadataVersion": metadata_version,
        "pythonExecutable": str(python),
        "sitePackages": str(expected_site),
        "status": "PASS",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
