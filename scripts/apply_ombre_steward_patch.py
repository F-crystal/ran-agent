#!/usr/bin/env python3
"""Deterministically apply and identify ran-agent's pinned Ombre Steward patch."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "third_party/ombre-brain/manifest.v1.json"
EXCLUDED_DIRS = {".git", ".venv", "__pycache__", "buckets", "logs"}
EXCLUDED_FILES = {"config.yaml"}
EXCLUDED_SUFFIXES = {".pyc"}


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(*args: str, cwd: Path) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def load_manifest(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "schema_version",
        "base_repository",
        "base_upstream_commit",
        "apply_algorithm",
        "identity_algorithm",
        "patches",
        "overlay_files",
        "api_schema",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise SystemExit("manifest schema invalid")
    return value


def verify_inputs(manifest: dict, manifest_path: Path) -> None:
    patch_root = manifest_path.parent / "patches/steward-api-v1"
    for entry in manifest["patches"]:
        path = patch_root / entry["path"]
        if sha256_file(path) != entry["sha256"]:
            raise SystemExit(f"patch digest mismatch: {entry['path']}")
    for entry in manifest["overlay_files"]:
        path = patch_root / "overlay" / entry["path"]
        if sha256_file(path) != entry["sha256"]:
            raise SystemExit(f"overlay digest mismatch: {entry['path']}")
    schema = manifest_path.parent / manifest["api_schema"]["path"]
    if sha256_file(schema) != manifest["api_schema"]["sha256"]:
        raise SystemExit("API schema digest mismatch")


def tree_identity(checkout: Path) -> str:
    entries: list[list[str]] = []
    for root_name in ("src",):
        root = checkout / root_name
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(checkout)
            if any(part in EXCLUDED_DIRS for part in relative.parts):
                continue
            if path.is_symlink() or not path.is_file():
                continue
            if path.name in EXCLUDED_FILES or path.suffix in EXCLUDED_SUFFIXES:
                continue
            entries.append([relative.as_posix(), sha256_file(path)])
    version = checkout / "VERSION"
    entries.append(["VERSION", sha256_file(version)])
    return sha256_bytes(canonical(entries))


def apply(checkout: Path, manifest_path: Path, identity_output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    verify_inputs(manifest, manifest_path)
    if run("git", "rev-parse", "HEAD", cwd=checkout) != manifest["base_upstream_commit"]:
        raise SystemExit("base commit mismatch")
    if run("git", "status", "--porcelain", cwd=checkout):
        raise SystemExit("base checkout must be clean")
    patch_root = manifest_path.parent / "patches/steward-api-v1"
    for entry in manifest["patches"]:
        patch = patch_root / entry["path"]
        run("git", "apply", "--check", str(patch), cwd=checkout)
        run("git", "apply", str(patch), cwd=checkout)
    for entry in manifest["overlay_files"]:
        source = patch_root / "overlay" / entry["path"]
        target = checkout / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)[1])
        try:
            shutil.copyfile(source, temporary)
            os.chmod(temporary, entry["mode"])
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
    identity = {
        "base_upstream_commit": manifest["base_upstream_commit"],
        "patch_manifest_sha256": sha256_bytes(canonical(manifest)),
        "api_schema_sha256": manifest["api_schema"]["sha256"],
        "effective_source_tree_sha256": tree_identity(checkout),
    }
    identity_output.parent.mkdir(parents=True, exist_ok=True)
    temporary = identity_output.with_name(identity_output.name + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(canonical(identity) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, identity_output)
    return identity


def verify(checkout: Path, manifest_path: Path, identity_output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    verify_inputs(manifest, manifest_path)
    try:
        identity = json.loads(identity_output.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit("effective identity unavailable") from exc
    expected = {
        "base_upstream_commit": manifest["base_upstream_commit"],
        "patch_manifest_sha256": sha256_bytes(canonical(manifest)),
        "api_schema_sha256": manifest["api_schema"]["sha256"],
        "effective_source_tree_sha256": tree_identity(checkout),
    }
    if run("git", "rev-parse", "HEAD", cwd=checkout) != manifest["base_upstream_commit"]:
        raise SystemExit("base commit mismatch")
    if identity != expected:
        raise SystemExit("effective identity mismatch")
    return expected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--identity-output", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    action = verify if args.verify else apply
    print(json.dumps(action(
        args.checkout.resolve(),
        args.manifest.resolve(),
        args.identity_output.resolve(),
    ), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
