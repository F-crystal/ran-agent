#!/usr/bin/env python3
"""Fail-closed structural probe for the sealed Hermes runtime."""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import sysconfig
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

    cli = subprocess.run(
        [str(hermes), "version"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": "/nonexistent",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONSAFEPATH": "1",
        },
    )
    if cli.returncode != 0:
        fail("hermes_cli_version_failed")
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
