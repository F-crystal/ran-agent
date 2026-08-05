#!/usr/bin/env python3
"""Candidate-bound, runtime-only Hermes transaction.

This controller deliberately does not deploy the ran_agent checkout. It only
applies docs/governance/hermes_runtime_mutation.v1.json from an exact commit.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import pwd
import grp
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import unicodedata
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


REPO = Path("/opt/ran_agent")
ARTIFACT_ROOT = Path("/opt/ran_agent-release")
RUNTIME_ROOT = Path("/opt/ran-agent-runtimes")
SNAPSHOT_ROOT = ARTIFACT_ROOT / "runtime-snapshots"
LOCK_PATH = ARTIFACT_ROOT / ".release-transaction.lock"
TOPOLOGY_MARKER = ARTIFACT_ROOT / "runtime-topology.v1.json"
LITE_HOME = Path("/home/ubuntu/.hermes-ran-agent/lite")
LITE_UNIT = Path("/etc/systemd/system/ran-agent-hermes.service")
FULL_UNIT = Path("/etc/systemd/system/ran-agent-hermes-full.service")
FULL_BLOCK_DROPIN = FULL_UNIT.with_suffix(".service.d") / "99-unified-topology.conf"
FULL_BLOCK_DROPIN_BYTES = b"[Unit]\nConditionPathExists=/run/ran-agent-retired-full-must-not-start\n"
ENV_FILES = (REPO / ".env.local", REPO / "node_bridge/.env.local")
SERVICES = (
    "ran-agent-node.service",
    "ran-agent-hermes.service",
    "ran-agent-hermes-full.service",
    "ran-agent-hermes-lite-soft-reset.timer",
)
MANIFEST_PATH = "docs/governance/hermes_runtime_artifact.v1.json"
LINUX_EVIDENCE_PATH = "docs/governance/hermes_runtime_linux_verification.v1.json"
MUTATION_PATH = "docs/governance/hermes_runtime_mutation.v1.json"
PROFILE_PATH = "hermes/profile/config.companion.yaml"
UNIT_SOURCE_PATH = "hermes/systemd/ran-agent-hermes-unified.service"
BUILDER_PATH = "scripts/build-hermes-runtime-artifact.py"
CONTROLLER_PATH = "scripts/deploy-hermes-runtime-release.py"
RELEASE_CANDIDATE_STATUS = "RELEASE_CANDIDATE_READY_FOR_RUNTIME_APPLY"
CANDIDATE_REF_ROOT = "refs/ran-agent/runtime-candidates"


class ReleaseError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], *, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=check, capture_output=True, text=text)


def git(repo: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess:
    return run(["git", "-c", f"safe.directory={repo}", "-C", str(repo), *args], text=text)


def candidate_blob(repo: Path, candidate: str, path: str) -> bytes:
    result = git(repo, "show", f"{candidate}:{path}", text=False)
    return result.stdout


def load_candidate_json(repo: Path, candidate: str, path: str) -> dict[str, Any]:
    value = json.loads(candidate_blob(repo, candidate, path))
    if not isinstance(value, dict):
        raise ReleaseError(f"candidate JSON is not an object: {path}")
    return value


def require_release_candidate_status(status: object) -> None:
    if status != RELEASE_CANDIDATE_STATUS:
        raise ReleaseError("runtime mutation is not a release-candidate contract")


def atomic_write(path: Path, data: bytes, *, mode: int, uid: int | None = None, gid: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, mode)
        if uid is not None and gid is not None:
            os.chown(temporary_path, uid, gid)
        os.replace(temporary_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary_path.unlink(missing_ok=True)


def atomic_write_existing(path: Path, data: bytes, *, mode: int, uid: int, gid: int) -> None:
    """Replace an existing file through an anchored, no-follow directory fd."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open("/", flags)
    temporary: str | None = None
    try:
        for part in path.parent.parts[1:]:
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        parent_identity = os.fstat(descriptor)
        target = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
        if not stat.S_ISREG(target.st_mode):
            raise ReleaseError(f"privileged write target is not a regular file: {path}")
        temporary = f".{path.name}.runtime-release-{os.getpid()}"
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            mode,
            dir_fd=descriptor,
        )
        try:
            with os.fdopen(temporary_fd, "wb", closefd=False) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.fchmod(temporary_fd, mode)
            os.fchown(temporary_fd, uid, gid)
        finally:
            os.close(temporary_fd)
        os.replace(temporary, path.name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
        temporary = None
        os.fsync(descriptor)
        current_parent = os.stat(path.parent, follow_symlinks=False)
        if (current_parent.st_dev, current_parent.st_ino) != (parent_identity.st_dev, parent_identity.st_ino):
            raise ReleaseError(f"privileged write parent changed during replacement: {path.parent}")
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=descriptor)
        os.close(descriptor)


def patch_env_bytes(original: bytes, values: dict[str, str]) -> bytes:
    text = original.decode("utf-8")
    kept = []
    for line in text.splitlines():
        key = line.split("=", 1)[0] if "=" in line else None
        if key not in values:
            kept.append(line)
    kept.extend(f"{key}={value}" for key, value in values.items())
    return ("\n".join(kept) + "\n").encode("utf-8")


def write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), mode=0o600)


def service_state(unit: str) -> dict[str, str]:
    active = run(["systemctl", "is-active", unit], check=False).stdout.strip()
    enabled = run(["systemctl", "is-enabled", unit], check=False).stdout.strip()
    loaded = run(["systemctl", "show", unit, "--property=LoadState", "--value"], check=False).stdout.strip()
    return {"active": active or "unknown", "enabled": enabled or "unknown", "load": loaded or "unknown"}


def set_enabled(unit: str, state: str) -> None:
    if state == "enabled":
        run(["systemctl", "enable", unit])
    elif state == "enabled-runtime":
        run(["systemctl", "enable", "--runtime", unit])
    elif state == "disabled":
        run(["systemctl", "disable", unit])
    elif state == "masked":
        run(["systemctl", "mask", unit])
    else:
        raise ReleaseError(f"unsupported service enabled state: {unit}={state}")


def check_candidate(repo: Path, candidate: str) -> None:
    if len(candidate) != 40 or any(character not in "0123456789abcdef" for character in candidate):
        raise ReleaseError("candidate must be an exact lowercase 40-character SHA")
    resolved = git(repo, "rev-parse", "--verify", f"{candidate}^{{commit}}").stdout.strip()
    if resolved != candidate:
        raise ReleaseError("candidate object mismatch")
    candidate_ref = f"{CANDIDATE_REF_ROOT}/{candidate}"
    try:
        referenced = git(repo, "rev-parse", "--verify", f"{candidate_ref}^{{commit}}").stdout.strip()
    except subprocess.CalledProcessError as exc:
        raise ReleaseError("persistent runtime candidate ref is absent") from exc
    if referenced != candidate:
        raise ReleaseError("persistent runtime candidate ref mismatch")
    if git(repo, "status", "--porcelain").stdout:
        raise ReleaseError("production worktree is dirty")


def validate_candidate_controller(repo: Path, candidate: str) -> None:
    check_candidate(repo, candidate)
    if Path(__file__).read_bytes() != candidate_blob(repo, candidate, CONTROLLER_PATH):
        raise ReleaseError("running controller is not the candidate controller")


def require_private_root(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise ReleaseError(f"private root is not a regular directory: {path}")
    value = path.stat()
    if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o700:
        raise ReleaseError(f"private root identity/mode mismatch: {path}")


@contextlib.contextmanager
def release_lock():
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(LOCK_PATH, flags, 0o600)
    try:
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
            raise ReleaseError("release lock identity/mode mismatch")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ReleaseError("another release transaction holds the lock") from exc
        yield
    finally:
        os.close(descriptor)


def load_builder(builder_bytes: bytes, directory: Path):
    path = directory / "build-hermes-runtime-artifact.py"
    path.write_bytes(builder_bytes)
    spec = importlib.util.spec_from_file_location("runtime_artifact_builder", path)
    if spec is None or spec.loader is None:
        raise ReleaseError("candidate artifact builder cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cron_job_count(home: Path) -> int:
    jobs_file = home / "cron/jobs.json"
    if not jobs_file.exists():
        return 0
    stored = json.loads(jobs_file.read_text(encoding="utf-8"))
    jobs = stored.get("jobs", []) if isinstance(stored, dict) else stored
    if not isinstance(jobs, list):
        raise ReleaseError("Hermes cron store schema is invalid")
    return len(jobs)


def cron_execution_count(home: Path) -> int:
    database = home / "cron/executions.db"
    if not database.exists():
        return 0
    if database.is_symlink() or not database.is_file():
        raise ReleaseError("Hermes cron execution ledger is not a regular file")
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'"
        ).fetchone()
        return int(connection.execute("SELECT COUNT(*) FROM executions").fetchone()[0]) if table else 0
    finally:
        connection.close()


def allocated_bytes(path: Path) -> int:
    total = path.lstat().st_blocks * 512
    for root, directories, files in os.walk(path, followlinks=False):
        for name in [*directories, *files]:
            total += Path(root, name).lstat().st_blocks * 512
    return total


def snapshot_capacity_bytes(path: Path) -> int:
    allocated = allocated_bytes(path)
    logical = 0
    members = 1
    for item in path.rglob("*"):
        members += 1
        value = item.lstat()
        if stat.S_ISREG(value.st_mode):
            logical += value.st_size
    return max(allocated, logical + members * 1024 + 1024 * 1024)


def validate_manifests(
    repo: Path, candidate: str, artifact_path: Path
) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes, bytes]:
    mutation = load_candidate_json(repo, candidate, MUTATION_PATH)
    manifest_bytes = candidate_blob(repo, candidate, MANIFEST_PATH)
    manifest = json.loads(manifest_bytes)
    evidence = load_candidate_json(repo, candidate, LINUX_EVIDENCE_PATH)
    profile = candidate_blob(repo, candidate, PROFILE_PATH)
    unit = candidate_blob(repo, candidate, UNIT_SOURCE_PATH)
    builder = candidate_blob(repo, candidate, BUILDER_PATH)
    if mutation.get("phase") != "runtime-only" or mutation.get("schemaVersion") != 1:
        raise ReleaseError("runtime mutation contract is invalid")
    require_release_candidate_status(mutation.get("status"))
    if evidence.get("result") != "LINUX_VERIFIED" or evidence.get("stage") != "LOCAL_VERIFIED":
        raise ReleaseError("artifact lacks exact Linux verification")
    artifact = manifest.get("artifact", {})
    if evidence.get("artifact", {}).get("manifestSha256") != sha256_bytes(manifest_bytes):
        raise ReleaseError("Linux evidence does not bind the artifact manifest")
    if evidence.get("verifiers", {}).get("builder", {}).get("sha256") != sha256_bytes(builder):
        raise ReleaseError("Linux evidence does not bind the candidate builder")
    for key in ("bytes", "tarGzSha256", "treeSha256"):
        if evidence.get("artifact", {}).get(key) != artifact.get(key):
            raise ReleaseError(f"Linux evidence artifact mismatch: {key}")
    if mutation.get("artifactManifest", {}).get("tarGzSha256") != artifact.get("tarGzSha256"):
        raise ReleaseError("mutation/archive digest mismatch")
    if mutation.get("artifactManifest", {}).get("treeSha256") != artifact.get("treeSha256"):
        raise ReleaseError("mutation/tree digest mismatch")
    expected_profile = mutation.get("companionProfile", {}).get("sourceSha256")
    if expected_profile != sha256_bytes(profile):
        raise ReleaseError("mutation/profile digest mismatch")
    if evidence.get("profile", {}).get("sha256") != sha256_bytes(profile):
        raise ReleaseError("Linux evidence does not bind the candidate profile")
    expected_unit = mutation.get("unifiedUnit", {}).get("sourceSha256")
    if expected_unit != sha256_bytes(unit):
        raise ReleaseError("mutation/unit digest mismatch")

    if artifact_path.is_symlink() or not artifact_path.is_file():
        raise ReleaseError("artifact must be a regular non-symlink file")
    if artifact_path.stat().st_size != artifact.get("bytes"):
        raise ReleaseError("artifact byte count mismatch")
    if sha256_file(artifact_path) != artifact.get("tarGzSha256"):
        raise ReleaseError("artifact archive digest mismatch")
    return mutation, manifest, profile, unit, builder


def capacity_admission(
    repo: Path,
    mutation: dict[str, Any],
    *,
    preallocated_bytes: int = 0,
    lite_home_bytes: int | None = None,
    required_inodes: int = 0,
) -> dict[str, int]:
    admission = mutation.get("admission", {})
    peak = admission.get("peakNewAllocatedBytes")
    observation = admission.get("capacityObservation", {})
    floor = observation.get("floorBytes")
    if not isinstance(peak, int) or not isinstance(floor, int) or peak <= 0 or floor <= 0:
        raise ReleaseError("capacity contract is invalid")
    inventory = admission.get("peakInventoryBytes", {})
    contracted_home = inventory.get("completeLiteHomeSnapshot")
    if not isinstance(contracted_home, int) or contracted_home <= 0:
        raise ReleaseError("Lite-home capacity contract is invalid")
    current_home = contracted_home if lite_home_bytes is None else lite_home_bytes
    peak += max(0, current_home - contracted_home)
    required = floor + peak
    free_now = shutil.disk_usage(repo).free
    free_before = free_now + preallocated_bytes
    if free_before < required:
        raise ReleaseError(f"capacity admission failed: free_before={free_before} required={required}")
    free_inodes = os.statvfs(repo).f_favail
    if free_inodes < required_inodes:
        raise ReleaseError(f"inode admission failed: free={free_inodes} required={required_inodes}")
    return {
        "freeBytesNow": free_now,
        "preallocatedBytes": preallocated_bytes,
        "freeBytesBeforeStaging": free_before,
        "requiredBytes": required,
        "headroomBytes": free_before - required,
        "liteHomeAllocatedBytes": current_home,
        "contractedLiteHomeBytes": contracted_home,
        "freeInodes": free_inodes,
        "requiredInodes": required_inodes,
    }


def require_real_directory_chain(root: Path, target: Path) -> None:
    root = root.resolve(strict=True)
    target.relative_to(root)
    current = root
    for part in target.relative_to(root).parts:
        current = current / part
        if current.is_symlink() or not current.is_dir():
            raise ReleaseError(f"directory chain is not real: {current}")


def require_allowed_dropins() -> None:
    directory = LITE_UNIT.with_suffix(".service.d")
    if not directory.exists():
        return
    if directory.is_symlink() or not directory.is_dir():
        raise ReleaseError("Hermes drop-in path is not a real directory")
    entries = list(directory.iterdir())
    if len(entries) != 1 or entries[0].name != "20-timeout.conf" or entries[0].is_symlink():
        raise ReleaseError("unreviewed Hermes service drop-in is present")
    if entries[0].read_text(encoding="utf-8") != "[Service]\nTimeoutStopSec=240\n":
        raise ReleaseError("Hermes timeout drop-in differs from the reviewed value")


def validate_preflight(repo: Path, candidate: str, artifact_path: Path) -> dict[str, Any]:
    check_candidate(repo, candidate)
    if LITE_HOME.is_symlink() or not LITE_HOME.is_dir():
        raise ReleaseError("Lite home must be a real directory")
    for path in (*ENV_FILES, LITE_UNIT, FULL_UNIT):
        if path.is_symlink() or not path.is_file():
            raise ReleaseError(f"required production path is not a regular file: {path}")
    full_dropin_directory = FULL_BLOCK_DROPIN.parent
    if full_dropin_directory.exists() and (
        full_dropin_directory.is_symlink() or not full_dropin_directory.is_dir()
    ):
        raise ReleaseError("retired Full runtime drop-in path is unsafe")
    require_real_directory_chain(LITE_HOME, LITE_HOME / "profiles/ran-assistant-lite")
    require_allowed_dropins()
    artifact_stage = ARTIFACT_ROOT / "runtime-artifacts"
    if artifact_stage.is_symlink() or artifact_path.parent != artifact_stage:
        raise ReleaseError("artifact is outside the private runtime-artifact stage")
    artifact_stat = artifact_path.stat()
    if artifact_stat.st_uid != 0 or artifact_stat.st_gid != 0 or artifact_stat.st_mode & 0o222:
        raise ReleaseError("artifact stage file must be root-owned and non-writable")
    if RUNTIME_ROOT.is_symlink() or not RUNTIME_ROOT.is_dir():
        raise ReleaseError("authorized runtime root is absent or not a real directory")
    runtime_stat = RUNTIME_ROOT.stat()
    if runtime_stat.st_uid != 0 or runtime_stat.st_gid != 0 or stat.S_IMODE(runtime_stat.st_mode) != 0o755:
        raise ReleaseError("runtime root identity/mode mismatch")
    if artifact_stage.stat().st_uid != 0 or artifact_stage.stat().st_gid != 0 or stat.S_IMODE(artifact_stage.stat().st_mode) != 0o700:
        raise ReleaseError("runtime-artifact stage identity/mode mismatch")
    if SNAPSHOT_ROOT.is_symlink() or not SNAPSHOT_ROOT.is_dir():
        raise ReleaseError("authorized runtime snapshot root is absent")
    require_private_root(SNAPSHOT_ROOT)
    devices = {path.stat().st_dev for path in (repo, artifact_path, ARTIFACT_ROOT, SNAPSHOT_ROOT, LITE_HOME, RUNTIME_ROOT)}
    if len(devices) != 1:
        raise ReleaseError("runtime transaction paths must share one filesystem")
    mutation, manifest, profile, unit, builder = validate_manifests(repo, candidate, artifact_path)
    production_head = git(repo, "rev-parse", "HEAD").stdout.strip()
    if production_head != mutation.get("requiredProductionHead"):
        raise ReleaseError("production checkout is not the audited runtime-only baseline")
    install_root = Path(mutation["artifactManifest"]["installRoot"])
    if install_root != RUNTIME_ROOT / "hermes-v0.20.0-0b8cdb8152ff":
        raise ReleaseError("install root is outside the approved exact target")
    if install_root.exists():
        raise ReleaseError("exact runtime install root already exists")
    if cron_job_count(LITE_HOME) != 0 or cron_execution_count(LITE_HOME) != 0:
        raise ReleaseError("Runtime Phase requires empty Hermes cron jobs and execution ledger")
    all_service_states = {unit: service_state(unit) for unit in SERVICES}
    for unit, state_value in all_service_states.items():
        if state_value["load"] not in {"loaded", "not-found"}:
            raise ReleaseError(f"unsupported service load state: {unit}={state_value['load']}")
        if state_value["load"] == "loaded" and (
            state_value["active"] not in {"active", "inactive"}
            or state_value["enabled"] not in {"enabled", "disabled"}
        ):
            raise ReleaseError(f"unsupported service baseline state: {unit}={state_value}")
    baseline_services = {unit: all_service_states[unit] for unit in SERVICES[:3]}
    if any(state["active"] != "active" for state in baseline_services.values()):
        raise ReleaseError("legacy Node/Lite/Full baseline is not fully active")
    if any(baseline_services[unit]["enabled"] != "enabled" for unit in SERVICES[1:3]):
        raise ReleaseError("legacy Lite/Full baseline is not enabled")
    legacy_paths = (repo / ".venv/bin/hermes", repo / ".venv/bin/python")
    if any(path.is_symlink() or not path.is_file() for path in (legacy_paths[0],)) or not legacy_paths[1].resolve().is_file():
        raise ReleaseError("legacy v0.13 runtime path is unavailable")
    legacy_version = run([str(legacy_paths[0]), "--version"]).stdout.strip()
    if "0.13.0" not in legacy_version:
        raise ReleaseError("legacy rollback runtime is not Hermes v0.13.0")
    wait_for_gateway(8642, process_environment("ran-agent-hermes.service"), "ran-assistant-lite")
    wait_for_gateway(8643, process_environment("ran-agent-hermes-full.service"), "ran-assistant")
    with tarfile.open(artifact_path, "r:gz") as source:
        artifact_members = len(source.getmembers())
    preallocated = artifact_path.stat().st_size if artifact_path.stat().st_dev == repo.stat().st_dev else 0
    capacity = capacity_admission(
        repo,
        mutation,
        preallocated_bytes=preallocated,
        lite_home_bytes=snapshot_capacity_bytes(LITE_HOME),
        required_inodes=artifact_members + 4096,
    )
    return {
        "mutation": mutation,
        "manifest": manifest,
        "profile": profile,
        "unit": unit,
        "builder": builder,
        "installRoot": install_root,
        "capacity": capacity,
        "productionHead": production_head,
        "legacyRuntime": {str(path): sha256_file(path.resolve()) for path in legacy_paths},
    }


def backup_path(snapshot: Path, path: Path, index: int) -> dict[str, Any]:
    record = {
        "path": str(path),
        "index": index,
        "present": path.exists() or path.is_symlink(),
        "metadata": path_metadata(path) if path.exists() or path.is_symlink() else [],
    }
    if record["present"]:
        destination = snapshot / "files" / str(index)
        if path.is_dir() and not path.is_symlink():
            shutil.copytree(path, destination, symlinks=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination, follow_symlinks=False)
        fsync_tree(destination)
        fsync_directory(destination.parent)
        record["integrity"] = path_integrity(destination)
    return record


def path_integrity(path: Path) -> list[dict[str, Any]]:
    paths = [path]
    if path.is_dir() and not path.is_symlink():
        paths.extend(Path(root, name) for root, directories, files in os.walk(path) for name in [*directories, *files])
    result: list[dict[str, Any]] = []
    for item in paths:
        relative = "." if item == path else str(item.relative_to(path))
        value = item.lstat()
        if stat.S_ISREG(value.st_mode):
            result.append({"relative": relative, "type": "file", "bytes": value.st_size, "sha256": sha256_file(item)})
        elif stat.S_ISDIR(value.st_mode):
            result.append({"relative": relative, "type": "directory"})
        elif stat.S_ISLNK(value.st_mode):
            result.append({"relative": relative, "type": "symlink", "target": os.readlink(item)})
        else:
            raise ReleaseError(f"unsupported rollback backup member: {item}")
    return sorted(result, key=lambda item: item["relative"])


def fsync_tree(path: Path) -> None:
    paths = [path]
    if path.is_dir() and not path.is_symlink():
        paths.extend(Path(root, name) for root, directories, files in os.walk(path) for name in [*directories, *files])
    for item in paths:
        if item.is_file() and not item.is_symlink():
            descriptor = os.open(item, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    directories = [item for item in paths if item.is_dir() and not item.is_symlink()]
    for item in sorted(directories, key=lambda entry: len(entry.parts), reverse=True):
        descriptor = os.open(item, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def path_metadata(path: Path) -> list[dict[str, Any]]:
    paths = [path]
    if path.is_dir() and not path.is_symlink():
        paths.extend(Path(root, name) for root, directories, files in os.walk(path) for name in [*directories, *files])
    result = []
    for item in paths:
        value = item.lstat()
        result.append({
            "relative": "." if item == path else str(item.relative_to(path)),
            "uid": value.st_uid,
            "gid": value.st_gid,
            "mode": stat.S_IMODE(value.st_mode),
            "symlink": item.is_symlink(),
        })
    return result


def restore_metadata(path: Path, records: list[dict[str, Any]]) -> None:
    for record in records:
        target = path if record["relative"] == "." else path / record["relative"]
        os.chown(target, record["uid"], record["gid"], follow_symlinks=False)
    for record in sorted(records, key=lambda item: item["relative"].count("/"), reverse=True):
        if not record["symlink"]:
            target = path if record["relative"] == "." else path / record["relative"]
            os.chmod(target, record["mode"])


def snapshot_metadata(snapshot: Path, context: dict[str, Any], candidate: str) -> dict[str, Any]:
    paths = rollback_paths()
    records = [backup_path(snapshot, path, index) for index, path in enumerate(paths)]
    builder_path = snapshot / "candidate-builder.py"
    atomic_write(builder_path, context["builder"], mode=0o400, uid=0, gid=0)
    state = {
        "schemaVersion": 1,
        "candidate": candidate,
        "phase": "snapshot-created",
        "productionHead": context["productionHead"],
        "services": {unit: service_state(unit) for unit in SERVICES},
        "paths": records,
        "installRoot": str(context["installRoot"]),
        "candidateBuilderSha256": sha256_file(builder_path),
        "legacyRuntime": context["legacyRuntime"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    write_json(snapshot / "state.json", state)
    return state


def rollback_paths() -> list[Path]:
    return [
        LITE_UNIT,
        FULL_UNIT,
        LITE_UNIT.with_suffix(".service.d"),
        FULL_UNIT.with_suffix(".service.d"),
        *ENV_FILES,
        TOPOLOGY_MARKER,
    ]


def update_phase(snapshot: Path, state: dict[str, Any], phase: str) -> None:
    state["phase"] = phase
    state["updatedAt"] = datetime.now(timezone.utc).isoformat()
    write_json(snapshot / "state.json", state)


def wait_for_gateway(port: int, env_values: dict[str, str], expected_model: str) -> None:
    key = env_values.get("API_SERVER_KEY") or env_values.get("HERMES_API_KEY")
    last_error: Exception | None = None
    for _ in range(120):
        try:
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/models", headers=headers)
            with urllib.request.urlopen(request, timeout=1) as response:
                payload = json.loads(response.read())
            if expected_model not in json.dumps(payload):
                raise ReleaseError("gateway returned the wrong profile model")
            return
        except Exception as exc:
            last_error = exc
            time.sleep(0.5)
    raise ReleaseError(f"gateway did not become ready: {type(last_error).__name__}")


def service_main_pid(unit: str) -> int:
    raw = run(["systemctl", "show", unit, "--property=MainPID", "--value"]).stdout.strip()
    if not raw.isdigit() or int(raw) <= 1:
        raise ReleaseError(f"service has no live MainPID: {unit}")
    return int(raw)


def process_environment(unit: str) -> dict[str, str]:
    data = Path(f"/proc/{service_main_pid(unit)}/environ").read_bytes()
    values: dict[str, str] = {}
    for entry in data.split(b"\0"):
        if b"=" in entry:
            key, value = entry.split(b"=", 1)
            values[key.decode(errors="strict")] = value.decode(errors="strict")
    return values


def validate_gateway_process(context: dict[str, Any]) -> dict[str, str]:
    pid = service_main_pid("ran-agent-hermes.service")
    executable = Path(f"/proc/{pid}/exe").resolve()
    expected_executable = (context["installRoot"] / "python/bin/python3.12").resolve()
    if executable != expected_executable:
        raise ReleaseError("Hermes MainPID is not the exact candidate runtime")
    if sha256_file(executable) != context["manifest"]["python"]["executableSha256"]:
        raise ReleaseError("Hermes MainPID interpreter digest mismatch")
    environment = process_environment("ran-agent-hermes.service")
    expected = {
        "HERMES_HOME": str(LITE_HOME),
        "HERMES_PROFILE": "ran-assistant-lite",
        "API_SERVER_HOST": "127.0.0.1",
        "API_SERVER_PORT": "8642",
        "API_SERVER_MODEL_NAME": "ran-assistant-lite",
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "TIRITH_ENABLED": "false",
    }
    if any(environment.get(key) != value for key, value in expected.items()):
        raise ReleaseError("Hermes MainPID environment differs from the canonical runtime contract")
    return environment


def validate_listener_topology(expected_pid: int) -> None:
    output = run(["ss", "-Hlnpt"], check=False).stdout
    listeners_8642: list[tuple[str, int]] = []
    listeners_8643: list[tuple[str, int]] = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        local = fields[3]
        pid_match = re.search(r"pid=(\d+)", line)
        pid = int(pid_match.group(1)) if pid_match else -1
        if re.search(r":8642$", local):
            listeners_8642.append((local, pid))
        if re.search(r":8643$", local):
            listeners_8643.append((local, pid))
    if listeners_8642 != [("127.0.0.1:8642", expected_pid)] or listeners_8643:
        raise ReleaseError("Hermes listener topology is not exactly one IPv4 loopback 8642 listener")


def read_env_values(paths: tuple[Path, ...]) -> dict[str, str]:
    values: dict[str, str] = {}
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value
    return values


def port_open(port: int) -> bool:
    with socket.socket() as client:
        client.settimeout(0.5)
        return client.connect_ex(("127.0.0.1", port)) == 0


def runtime_is_read_only(root: Path) -> bool:
    paths = [root]
    paths.extend(Path(directory, name) for directory, directories, files in os.walk(root) for name in [*directories, *files])
    return all(
        path.is_symlink()
        or (not (path.lstat().st_mode & 0o222) and path.lstat().st_uid == 0 and path.lstat().st_gid == 0)
        for path in paths
    )


def validate_installed_runtime(context: dict[str, Any]) -> dict[str, str]:
    if not runtime_is_read_only(context["installRoot"]):
        raise ReleaseError("installed runtime is writable")
    expected_profile = sha256_bytes(context["profile"])
    for target in (LITE_HOME / "config.yaml", LITE_HOME / "profiles/ran-assistant-lite/config.yaml"):
        if sha256_file(target) != expected_profile:
            raise ReleaseError("installed profile digest mismatch")
    if sha256_file(LITE_UNIT) != sha256_bytes(context["unit"]):
        raise ReleaseError("installed unit digest mismatch")
    expected = context["mutation"]["envMutations"][0]["values"]
    for path in ENV_FILES:
        values = read_env_values((path,))
        if any(values.get(key) != value for key, value in expected.items()):
            raise ReleaseError(f"compatibility env contract mismatch: {path}")
    hermes_environment = validate_gateway_process(context)
    wait_for_gateway(8642, hermes_environment, "ran-assistant-lite")
    validate_listener_topology(service_main_pid("ran-agent-hermes.service"))
    return hermes_environment


def validate_node_routes() -> None:
    node_environment = process_environment("ran-agent-node.service")
    for key in ("HERMES_API_BASE_URL", "HERMES_LITE_API_BASE_URL", "HERMES_FULL_API_BASE_URL", "CO_READING_HERMES_API_BASE_URL"):
        if node_environment.get(key) != "http://127.0.0.1:8642/v1":
            raise ReleaseError(f"Node effective compatibility route mismatch: {key}")


def stop_for_snapshot() -> None:
    run(["systemctl", "stop", "ran-agent-node.service"])
    for _ in range(120):
        connections = run(["ss", "-Htn", "state", "established"], check=False).stdout
        if not any(f":{port}" in connections for port in (8642, 8643)):
            break
        time.sleep(0.5)
    else:
        raise ReleaseError("gateway connections did not drain")
    run(["systemctl", "stop", "ran-agent-hermes-lite-soft-reset.timer"], check=False)
    run(["systemctl", "stop", "ran-agent-hermes.service", "ran-agent-hermes-full.service"])


def archive_lite_home(snapshot: Path) -> str:
    archive = snapshot / "lite-home.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=1) as output:
        output.add(LITE_HOME, arcname="lite", recursive=True)
    with archive.open("rb") as handle:
        os.fsync(handle.fileno())
    validate_snapshot_archive(archive)
    return sha256_file(archive)


def validate_snapshot_archive(archive: Path) -> None:
    with tarfile.open(archive, "r:gz") as source:
        names: set[str] = set()
        folded: set[str] = set()
        symlinks: set[PurePosixPath] = set()
        members = source.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            normalized = path.as_posix().rstrip("/")
            if not normalized or path.is_absolute() or ".." in path.parts:
                raise ReleaseError("unsafe Lite-home snapshot path")
            if path.parts[0] != "lite" or normalized in names:
                raise ReleaseError("unexpected or duplicate Lite-home snapshot path")
            names.add(normalized)
            casefolded = unicodedata.normalize("NFD", normalized).casefold()
            if casefolded in folded:
                raise ReleaseError("casefold collision in Lite-home snapshot")
            folded.add(casefolded)
            if member.islnk() or not (member.isfile() or member.isdir() or member.issym()):
                raise ReleaseError("unsupported Lite-home snapshot member")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise ReleaseError("absolute Lite-home symlink")
                resolved: list[str] = []
                for part in (*path.parent.parts, *target.parts):
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if not resolved:
                            raise ReleaseError("escaping Lite-home symlink")
                        resolved.pop()
                    else:
                        resolved.append(part)
                if not resolved or resolved[0] != "lite":
                    raise ReleaseError("escaping Lite-home symlink")
                symlinks.add(path)
        for member in members:
            if any(parent in symlinks for parent in PurePosixPath(member.name).parents):
                raise ReleaseError("Lite-home member exists below a symlink")


def install_runtime(context: dict[str, Any], artifact_path: Path, snapshot: Path) -> None:
    install_root: Path = context["installRoot"]
    require_private_runtime_root()
    incoming = RUNTIME_ROOT / f".incoming-{install_root.name}-{os.getpid()}"
    if incoming.exists():
        raise ReleaseError("runtime incoming path already exists")
    if sha256_file(artifact_path) != context["manifest"]["artifact"]["tarGzSha256"]:
        raise ReleaseError("sealed artifact changed after preflight")
    incoming.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(dir=snapshot) as module_dir:
            builder = load_builder(context["builder"], Path(module_dir))
            builder.safe_extract_tar(artifact_path, incoming)
            runtime = incoming / context["manifest"]["artifact"]["archiveRoot"]
            digest = builder.tree_digest(runtime)
            if digest != context["manifest"]["artifact"]["treeSha256"]:
                raise ReleaseError("extracted runtime tree digest mismatch")
            os.replace(runtime, install_root)
        incoming.rmdir()
        for root, directories, files in os.walk(install_root):
            for name in [*directories, *files]:
                path = Path(root, name)
                if path.is_symlink():
                    continue
                os.chown(path, 0, 0)
                os.chmod(path, stat.S_IMODE(path.stat().st_mode) & ~0o222)
        os.chown(install_root, 0, 0)
        os.chmod(install_root, stat.S_IMODE(install_root.stat().st_mode) & ~0o222)
        fsync_tree(install_root)
        fsync_directory(RUNTIME_ROOT)
    finally:
        if incoming.exists():
            shutil.rmtree(incoming)


def require_private_runtime_root() -> None:
    if RUNTIME_ROOT.is_symlink() or not RUNTIME_ROOT.is_dir():
        raise ReleaseError("runtime root is unavailable")
    value = RUNTIME_ROOT.stat()
    if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o755:
        raise ReleaseError("runtime root identity/mode mismatch")


def install_profile(profile: bytes) -> None:
    account = pwd.getpwnam("ubuntu")
    group = grp.getgrnam("ubuntu")
    targets = (LITE_HOME / "config.yaml", LITE_HOME / "profiles/ran-assistant-lite/config.yaml")
    for target in targets:
        atomic_write_existing(target, profile, mode=0o644, uid=account.pw_uid, gid=group.gr_gid)


def install_unit(unit: bytes) -> None:
    atomic_write(LITE_UNIT, unit, mode=0o644, uid=0, gid=0)


def install_full_block() -> None:
    directory = FULL_BLOCK_DROPIN.parent
    if directory.exists() and (directory.is_symlink() or not directory.is_dir()):
        raise ReleaseError("retired Full runtime drop-in path is unsafe")
    atomic_write(FULL_BLOCK_DROPIN, FULL_BLOCK_DROPIN_BYTES, mode=0o644, uid=0, gid=0)


def patch_runtime_env() -> None:
    values = {
        "HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_LITE_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_FULL_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "CO_READING_HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_PROFILE": "ran-assistant-lite",
        "HERMES_LITE_PROFILE": "ran-assistant-lite",
        "HERMES_FULL_PROFILE": "ran-assistant-lite",
    }
    for path in ENV_FILES:
        source_stat = path.stat()
        updated = patch_env_bytes(path.read_bytes(), values)
        atomic_write_existing(
            path,
            updated,
            mode=stat.S_IMODE(source_stat.st_mode),
            uid=source_stat.st_uid,
            gid=source_stat.st_gid,
        )


def restore_path(snapshot: Path, record: dict[str, Any]) -> None:
    path = Path(record["path"])
    if path.exists() or path.is_symlink():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    if record["present"]:
        source = snapshot / "files" / str(record["index"])
        if source.is_dir() and not source.is_symlink():
            shutil.copytree(source, path, symlinks=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, path, follow_symlinks=False)
        restore_metadata(path, record["metadata"])
        fsync_tree(path)
    fsync_directory(path.parent)


def remove_transaction_runtime(path: Path) -> None:
    paths = [path]
    paths.extend(Path(root, name) for root, directories, files in os.walk(path) for name in [*directories, *files])
    for item in reversed(paths):
        if not item.is_symlink():
            os.chmod(item, stat.S_IMODE(item.stat().st_mode) | stat.S_IWUSR)
    shutil.rmtree(path)
    fsync_directory(path.parent)


def safe_restore_lite(snapshot: Path, state: dict[str, Any]) -> None:
    archive = snapshot / "lite-home.tar.gz"
    if not archive.is_file() or archive.is_symlink():
        raise ReleaseError("Lite-home rollback archive is missing")
    if sha256_file(archive) != state.get("liteHomeArchiveSha256"):
        raise ReleaseError("Lite-home rollback archive digest mismatch")
    builder_path = snapshot / "candidate-builder.py"
    if sha256_file(builder_path) != state.get("candidateBuilderSha256"):
        raise ReleaseError("sealed rollback builder digest mismatch")
    with tempfile.TemporaryDirectory(dir=snapshot) as module_dir:
        builder = load_builder(builder_path.read_bytes(), Path(module_dir))
        if LITE_HOME.exists():
            shutil.rmtree(LITE_HOME)
        builder.safe_extract_tar(archive, LITE_HOME.parent)
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            path = LITE_HOME.parent / member.name
            os.chown(path, member.uid, member.gid, follow_symlinks=False)
    fsync_tree(LITE_HOME)
    fsync_directory(LITE_HOME.parent)


def restore_service_states(state: dict[str, Any]) -> None:
    run(["systemctl", "daemon-reload"])
    for unit, prior in state["services"].items():
        if prior["load"] == "not-found":
            continue
        set_enabled(unit, prior["enabled"])
    for unit in ("ran-agent-hermes.service", "ran-agent-hermes-full.service"):
        prior = state["services"][unit]
        if prior["load"] == "not-found":
            continue
        if prior["active"] == "active":
            run(["systemctl", "start", unit])
        else:
            run(["systemctl", "stop", unit], check=False)
    if state["services"]["ran-agent-hermes.service"]["active"] == "active":
        wait_for_gateway(8642, process_environment("ran-agent-hermes.service"), "ran-assistant-lite")
    if state["services"]["ran-agent-hermes-full.service"]["active"] == "active":
        wait_for_gateway(8643, process_environment("ran-agent-hermes-full.service"), "ran-assistant")
    node_prior = state["services"]["ran-agent-node.service"]
    if node_prior["active"] == "active":
        run(["systemctl", "start", "ran-agent-node.service"])
    else:
        run(["systemctl", "stop", "ran-agent-node.service"], check=False)
    timer_prior = state["services"]["ran-agent-hermes-lite-soft-reset.timer"]
    if timer_prior["load"] != "not-found":
        if timer_prior["active"] == "active":
            run(["systemctl", "start", "ran-agent-hermes-lite-soft-reset.timer"])
        else:
            run(["systemctl", "stop", "ran-agent-hermes-lite-soft-reset.timer"], check=False)
    for unit, prior in state["services"].items():
        actual = service_state(unit)
        if actual != prior:
            raise ReleaseError(f"service state did not restore exactly: {unit} expected={prior} actual={actual}")


def validate_rollback(snapshot: Path, expected_candidate: str | None = None) -> dict[str, Any]:
    state_path = snapshot / "state.json"
    if snapshot.parent != SNAPSHOT_ROOT or not state_path.is_file() or state_path.is_symlink():
        raise ReleaseError("rollback snapshot is outside the governed root")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if state.get("schemaVersion") != 1 or state.get("phase") not in {
        "snapshot-created",
        "quiesced-and-snapshotted",
        "opening-ingress",
        "accepted",
        "rolled-back",
    }:
        raise ReleaseError("rollback transaction state is invalid")
    if expected_candidate is not None and state.get("candidate") != expected_candidate:
        raise ReleaseError("rollback candidate does not match snapshot")
    if git(REPO, "rev-parse", "HEAD").stdout.strip() != state.get("productionHead") or git(
        REPO, "status", "--porcelain"
    ).stdout:
        raise ReleaseError("production checkout changed before runtime rollback")
    for path, digest in state.get("legacyRuntime", {}).items():
        runtime = Path(path).resolve()
        if not runtime.is_file() or sha256_file(runtime) != digest:
            raise ReleaseError("legacy v0.13 runtime identity changed before rollback")
    install_root = Path(str(state.get("installRoot", "")))
    if install_root.parent != RUNTIME_ROOT:
        raise ReleaseError("rollback install root is outside the governed runtime root")
    records = state.get("paths")
    if not isinstance(records, list):
        raise ReleaseError("rollback path records are invalid")
    expected_paths = rollback_paths()
    if len(records) != len(expected_paths):
        raise ReleaseError("rollback path record count is invalid")
    for index, (record, expected_path) in enumerate(zip(records, expected_paths)):
        if not isinstance(record, dict) or not isinstance(record.get("metadata"), list):
            raise ReleaseError("rollback path record is invalid")
        if record.get("index") != index or record.get("path") != str(expected_path):
            raise ReleaseError("rollback path authority mismatch")
        metadata_relatives: set[str] = set()
        for metadata in record["metadata"]:
            relative = PurePosixPath(str(metadata.get("relative", "")))
            if relative.is_absolute() or ".." in relative.parts or str(relative) in metadata_relatives:
                raise ReleaseError("rollback metadata path is invalid")
            metadata_relatives.add(str(relative))
        if record.get("present"):
            backup = snapshot / "files" / str(record.get("index"))
            if not (backup.exists() or backup.is_symlink()):
                raise ReleaseError("rollback file backup is missing")
            if path_integrity(backup) != record.get("integrity"):
                raise ReleaseError("rollback file backup integrity mismatch")
            integrity_relatives = {item["relative"] for item in record["integrity"]}
            if metadata_relatives != integrity_relatives:
                raise ReleaseError("rollback metadata does not bind the backup tree")
        elif record["metadata"] or record.get("integrity") is not None:
            raise ReleaseError("absent rollback path carries unexpected backup state")
    archive_required = state["phase"] != "snapshot-created"
    if archive_required and not state.get("liteHomeArchiveSha256"):
        raise ReleaseError("rollback phase lacks a complete Lite-home archive")
    if state.get("liteHomeArchiveSha256"):
        archive = snapshot / "lite-home.tar.gz"
        builder = snapshot / "candidate-builder.py"
        if archive.is_symlink() or not archive.is_file() or sha256_file(archive) != state["liteHomeArchiveSha256"]:
            raise ReleaseError("Lite-home rollback archive digest mismatch")
        validate_snapshot_archive(archive)
        if builder.is_symlink() or not builder.is_file() or sha256_file(builder) != state.get("candidateBuilderSha256"):
            raise ReleaseError("sealed rollback builder digest mismatch")
    return state


def rollback(snapshot: Path, expected_candidate: str | None = None) -> None:
    state = validate_rollback(snapshot, expected_candidate)
    prior_phase = state.get("phase")
    if prior_phase == "rolled-back":
        return
    run(["systemctl", "stop", "ran-agent-node.service", "ran-agent-hermes.service", "ran-agent-hermes-full.service"], check=False)
    run(["systemctl", "stop", "ran-agent-hermes-lite-soft-reset.timer"], check=False)
    if state.get("liteHomeArchiveSha256"):
        safe_restore_lite(snapshot, state)
    if prior_phase not in {"accepted", "rolled-back"}:
        install_root = Path(state["installRoot"])
        if install_root.exists() and install_root.parent == RUNTIME_ROOT:
            remove_transaction_runtime(install_root)
    for record in state["paths"]:
        restore_path(snapshot, record)
    restore_service_states(state)
    current_head = git(REPO, "rev-parse", "HEAD").stdout.strip()
    if current_head != state["productionHead"] or git(REPO, "status", "--porcelain").stdout:
        raise ReleaseError("production checkout changed across runtime rollback")
    for path, digest in state.get("legacyRuntime", {}).items():
        if sha256_file(Path(path).resolve()) != digest:
            raise ReleaseError("legacy v0.13 runtime identity changed across rollback")
    update_phase(snapshot, state, "rolled-back")


def refuse_unfinished_transaction(candidate: str) -> None:
    if not SNAPSHOT_ROOT.exists():
        return
    for state_path in SNAPSHOT_ROOT.glob("*/state.json"):
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ReleaseError(f"unreadable runtime transaction state: {state_path}") from exc
        if state.get("phase") not in {"accepted", "rolled-back"}:
            run(["systemctl", "stop", "ran-agent-node.service"], check=False)
            raise ReleaseError(f"unfinished runtime transaction requires explicit rollback: {state_path.parent}")
        if state.get("phase") == "accepted" and state.get("candidate") == candidate:
            raise ReleaseError(f"candidate is already accepted: {state_path.parent}")


def apply(candidate: str, artifact_path: Path, context: dict[str, Any]) -> Path:
    require_private_root(SNAPSHOT_ROOT)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snapshot = SNAPSHOT_ROOT / f"runtime-{timestamp}-{candidate[:12]}"
    snapshot.mkdir(parents=True, mode=0o700)
    fsync_directory(SNAPSHOT_ROOT)
    state = snapshot_metadata(snapshot, context, candidate)
    try:
        stop_for_snapshot()
        state["liteHomeArchiveSha256"] = archive_lite_home(snapshot)
        update_phase(snapshot, state, "quiesced-and-snapshotted")
        if cron_job_count(LITE_HOME) != 0 or cron_execution_count(LITE_HOME) != 0:
            raise ReleaseError("Hermes cron changed during quiesce")
        install_full_block()
        install_runtime(context, artifact_path, snapshot)
        install_profile(context["profile"])
        install_unit(context["unit"])
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "ran-agent-hermes.service"])
        run(["systemctl", "start", "ran-agent-hermes.service"])
        hermes_environment = validate_gateway_process(context)
        wait_for_gateway(8642, hermes_environment, "ran-assistant-lite")
        patch_runtime_env()
        run(["systemctl", "disable", "ran-agent-hermes-full.service"])
        run(["systemctl", "stop", "ran-agent-hermes-full.service"])
        if sha256_file(FULL_BLOCK_DROPIN) != sha256_bytes(FULL_BLOCK_DROPIN_BYTES):
            raise ReleaseError("retired Full runtime interlock digest mismatch")
        if not port_open(8642) or port_open(8643):
            raise ReleaseError("unified gateway port acceptance failed")
        if cron_job_count(LITE_HOME) != 0 or cron_execution_count(LITE_HOME) != 0:
            raise ReleaseError("Runtime Phase unexpectedly created cron work")
        hermes_environment = validate_installed_runtime(context)
        if git(REPO, "rev-parse", "HEAD").stdout.strip() != context["productionHead"]:
            raise ReleaseError("production checkout SHA changed")
        if git(REPO, "status", "--porcelain").stdout:
            raise ReleaseError("production checkout became dirty")
        atomic_write(
            TOPOLOGY_MARKER,
            (json.dumps({"schemaVersion": 1, "candidate": candidate, "topology": "unified-hermes-v0.20"}, sort_keys=True) + "\n").encode(),
            mode=0o600,
            uid=0,
            gid=0,
        )
        update_phase(snapshot, state, "opening-ingress")
        run(["systemctl", "start", "ran-agent-node.service"])
        if service_state("ran-agent-node.service")["active"] != "active":
            raise ReleaseError("Node bridge did not recover")
        validate_node_routes()
        prior_timer = state["services"]["ran-agent-hermes-lite-soft-reset.timer"]
        if prior_timer["load"] != "not-found" and prior_timer["active"] == "active":
            run(["systemctl", "start", "ran-agent-hermes-lite-soft-reset.timer"])
        update_phase(snapshot, state, "accepted")
        return snapshot
    except BaseException:
        try:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            rollback(snapshot)
        except Exception as rollback_error:
            print(f"runtime rollback incomplete: {rollback_error}", file=sys.stderr)
            raise SystemExit(70) from rollback_error
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--mode", choices=("dry-run", "apply", "rollback"), required=True)
    parser.add_argument("--snapshot", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ReleaseError("runtime release controller must run as root")
    if ARTIFACT_ROOT.is_symlink() or not ARTIFACT_ROOT.is_dir():
        raise ReleaseError("authorized release artifact root is absent")
    require_private_root(ARTIFACT_ROOT)
    with release_lock():
        validate_candidate_controller(REPO, args.candidate)
        if args.mode == "rollback":
            if args.snapshot is None:
                raise ReleaseError("rollback requires --snapshot")
            rollback(args.snapshot.resolve(), args.candidate)
            print(json.dumps({"status": "ROLLED_BACK", "snapshot": str(args.snapshot.resolve())}, sort_keys=True))
            return 0
        refuse_unfinished_transaction(args.candidate)
        if args.artifact is None:
            raise ReleaseError("dry-run/apply require --artifact")
        if args.artifact.is_symlink() or not args.artifact.is_file():
            raise ReleaseError("artifact must be a regular non-symlink file")
        artifact = args.artifact.resolve(strict=True)
        context = validate_preflight(REPO, args.candidate, artifact)
        if args.mode == "dry-run":
            print(json.dumps({"status": "DRY_RUN_OK", "candidate": args.candidate, **context["capacity"]}, sort_keys=True))
            return 0
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        snapshot = apply(args.candidate, artifact, context)
        print(json.dumps({"status": "APPLIED", "candidate": args.candidate, "snapshot": str(snapshot)}, sort_keys=True))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as exc:
        print(f"deploy-hermes-runtime-release: failed:{exc}", file=sys.stderr)
        raise SystemExit(1)
