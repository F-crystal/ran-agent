#!/usr/bin/env python3
"""Single resumable S12 Core authority-transfer transaction."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pwd
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path("/opt/ran_agent")
ARTIFACT_ROOT = Path("/opt/ran_agent-release")
TRANSACTION_ROOT = ARTIFACT_ROOT / "s12-transactions"
LOCK_PATH = ARTIFACT_ROOT / ".s12-cutover.lock"
SOURCE_SNAPSHOT_ROOT = ARTIFACT_ROOT / "source-snapshots"
SOURCE_POINTER = SOURCE_SNAPSHOT_ROOT / "current-source.json"
CONTROLLER_PATH = "scripts/s12-cutover.py"
BOOTSTRAP_PATH = "scripts/bootstrap-hermes-release.sh"
NODE_BIN = Path("/opt/nodejs/node-v22.22.2-linux-x64/bin/node")
HERMES_BIN = Path("/opt/ran-agent-runtimes/hermes-v0.20.0-3049a082c0d1/bin/hermes")
HERMES_HOME = Path("/home/ubuntu/.hermes-ran-agent/lite")
MANAGED_WAKE_MANIFEST = REPO / "docs/governance/core_managed_wake.v1.json"
SCHEDULE_MANIFEST = REPO / "docs/governance/core_system_schedules.v1.json"
MIGRATION_MANIFEST = REPO / "docs/governance/core_schedule_migration.v1.json"
ENV_FILES = (REPO / ".env.local", REPO / "node_bridge/.env.local")
PHASES = (
    "P0_VERIFIED",
    "P1_SOURCE_APPLIED",
    "P2_CORE_PREPARED",
    "P3_LEGACY_RECONCILED",
    "P4_QUIESCED",
    "P5_CORE_AUTHORITY_COMMITTED",
    "P6_CORE_WORKER_ACTIVE",
    "P7_CORE_WAKE_ACTIVE",
    "P8_ACCEPTANCE_EFFECT_COMMITTED",
    "P9_ACCEPTANCE_RECEIPT_TERMINAL",
    "P10_ACCEPTED",
)


class S12Error(RuntimeError):
    pass


class SimulatedCrash(BaseException):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def transaction_id(candidate: str, owner: str, authorization_ref: str) -> str:
    digest = hashlib.sha256(f"{candidate}\0{owner}\0{authorization_ref}".encode()).hexdigest()
    return f"s12-{digest[:24]}"


def protected_file_digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise S12Error("S12 protected input is not a regular file")
    value = path.stat()
    if (value.st_uid != os.geteuid() or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != 0o600):
        raise S12Error("S12 protected input identity/mode/link count is invalid")
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


class Journal:
    def __init__(self, root: Path, identity: dict[str, str]):
        self.identity = identity
        self.directory = root / identity["transactionId"]
        self.path = self.directory / "transaction.json"
        self.state: dict[str, Any]

    def open(self) -> dict[str, Any]:
        if self.directory.is_symlink():
            raise S12Error("S12 transaction directory is a symlink")
        if self.directory.exists():
            value = self.directory.lstat()
            if (not stat.S_ISDIR(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o700
                    or value.st_uid != os.geteuid()):
                raise S12Error("S12 transaction directory identity/mode is invalid")
        if self.path.exists():
            if self.path.is_symlink() or not self.path.is_file():
                raise S12Error("S12 transaction journal is invalid")
            self.state = json.loads(self.path.read_text(encoding="utf-8"))
            value = self.path.stat()
            if (value.st_uid != os.geteuid() or value.st_nlink != 1
                    or stat.S_IMODE(value.st_mode) != 0o600):
                raise S12Error("S12 transaction journal identity/mode/link count is invalid")
            if any(self.state.get(key) != value for key, value in self.identity.items()):
                raise S12Error("S12 transaction identity conflicts with its journal")
            completed = self.state.get("completedPhases")
            if (self.state.get("schemaVersion") != 1 or not isinstance(completed, list)
                    or completed != list(PHASES[:len(completed)])
                    or self.state.get("phase") != (completed[-1] if completed else None)
                    or not isinstance(self.state.get("phaseReceipts"), dict)
                    or not isinstance(self.state.get("acceptance"), dict)
                    or not isinstance(self.state.get("attemptHistory"), list)
                    or not isinstance(self.state.get("attempt"), int)
                    or self.state.get("status") not in {
                        "IN_PROGRESS", "ROLLED_BACK", "FORWARD_RECOVERY",
                        "FORWARD_RECOVERY_REQUIRED", "PRE_CUTOVER_RECONCILIATION_REQUIRED", "ACCEPTED",
                    }):
                raise S12Error("S12 transaction journal schema or phase chain is invalid")
            return self.state
        self.directory.mkdir(parents=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.state = {
            "schemaVersion": 1,
            **self.identity,
            "phase": None,
            "completedPhases": [],
            "phaseReceipts": {},
            "status": "IN_PROGRESS",
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "sourceSnapshot": None,
            "coreDb": self.identity["coreDb"],
            "cutoverCommitted": False,
            "cutoverAttempted": False,
            "acceptance": {"idempotencyKey": self.identity["transactionId"], "status": "NOT_CREATED"},
            "attempt": 1,
            "attemptHistory": [],
        }
        self.write()
        return self.state

    def write(self) -> None:
        self.state["updatedAt"] = utc_now()
        atomic_json(self.path, self.state)

    def complete(self, phase: str, **values: Any) -> None:
        if phase not in PHASES:
            raise S12Error(f"unknown S12 phase: {phase}")
        completed = self.state["completedPhases"]
        if phase not in completed:
            expected = PHASES[len(completed)]
            if phase != expected:
                raise S12Error(f"S12 phase order violation: expected {expected}, got {phase}")
            completed.append(phase)
        self.state.update(values)
        if "lastReceipt" in values:
            self.state["phaseReceipts"][phase] = values["lastReceipt"]
        self.state["phase"] = phase
        self.write()

    def restart_after_rollback(self) -> None:
        self.state["attemptHistory"].append({
            "attempt": self.state.get("attempt"), "status": self.state.get("status"),
            "phase": self.state.get("phase"), "completedPhases": self.state.get("completedPhases"),
            "phaseReceipts": self.state.get("phaseReceipts"), "failure": self.state.get("failure"),
            "sourceSnapshot": self.state.get("sourceSnapshot"), "endedAt": utc_now(),
        })
        self.state.update({
            "phase": None, "completedPhases": [], "phaseReceipts": {}, "status": "IN_PROGRESS",
            "sourceSnapshot": None, "cutoverCommitted": False,
            "cutoverAttempted": False,
            "acceptance": {"idempotencyKey": self.identity["transactionId"], "status": "NOT_CREATED"},
            "attempt": int(self.state.get("attempt", 1)) + 1,
        })
        self.state.pop("failure", None)
        self.state.pop("rollbackFailure", None)
        self.write()


@contextlib.contextmanager
def transaction_lock(path: Path):
    if not hasattr(os, "O_NOFOLLOW"):
        raise S12Error("S12 lock requires O_NOFOLLOW")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        value = os.fstat(descriptor)
        if (not stat.S_ISREG(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o600
                or value.st_uid != os.geteuid() or value.st_nlink != 1):
            raise S12Error("S12 lock identity/mode/link count is invalid")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise S12Error("another S12 transaction holds the lock") from exc
        yield
    finally:
        os.close(descriptor)


def parse_json_output(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    for line in reversed(result.stdout.splitlines()):
        with contextlib.suppress(json.JSONDecodeError):
            value = json.loads(line)
            if isinstance(value, dict):
                return value
    raise S12Error("subordinate command returned no JSON receipt")


class ProductionOperations:
    def __init__(self, args: argparse.Namespace, transaction_dir: Path):
        self.args = args
        self.transaction_dir = transaction_dir
        self.snapshot = transaction_dir / "migration-snapshot.json"
        self.final_snapshot = transaction_dir / "quiesced-migration-snapshot.json"
        self.allow_inactive_core_reuse = False

    def run(self, command: list[str], *, env: dict[str, str] | None = None, check: bool = True,
            pass_fds: tuple[int, ...] = ()) -> dict[str, Any]:
        result = subprocess.run(command, check=check, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, pass_fds=pass_fds)
        return parse_json_output(result)

    def runtime_run(self, command: list[str], *, pass_fds: tuple[int, ...] = ()) -> dict[str, Any]:
        return self.run([
            "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
            "HOME=/home/ubuntu", "PATH=/opt/nodejs/node-v22.22.2-linux-x64/bin:/usr/bin:/bin",
            *command,
        ], pass_fds=pass_fds)

    @contextlib.contextmanager
    def runtime_scratch(self):
        result = subprocess.run([
            "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/mktemp", "-d",
            "/tmp/ran-agent-s12.XXXXXX",
        ], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        directory = Path(result.stdout.strip())
        if directory.parent != Path("/tmp") or not directory.name.startswith("ran-agent-s12."):
            raise S12Error("runtime scratch path is invalid")
        account = pwd.getpwnam("ubuntu")
        created = directory.lstat()
        if (not stat.S_ISDIR(created.st_mode) or stat.S_IMODE(created.st_mode) != 0o700
                or created.st_uid != account.pw_uid or created.st_gid != account.pw_gid):
            raise S12Error("runtime scratch identity/mode is invalid")
        try:
            yield directory
        finally:
            current = directory.lstat()
            if ((current.st_dev, current.st_ino, current.st_uid, current.st_gid)
                    != (created.st_dev, created.st_ino, created.st_uid, created.st_gid)
                    or not stat.S_ISDIR(current.st_mode)):
                raise S12Error("runtime scratch identity changed before cleanup")
            shutil.rmtree(directory)

    def git(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(["git", "-c", f"safe.directory={REPO}", "-C", str(REPO), *args],
                                check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.stdout.strip()

    def assert_candidate_binding(self) -> None:
        candidate = self.args.candidate
        if len(candidate) != 40 or any(value not in "0123456789abcdef" for value in candidate):
            raise S12Error("candidate must be an exact lowercase SHA")
        if self.git("rev-parse", "--verify", f"{candidate}^{{commit}}") != candidate:
            raise S12Error("candidate object mismatch")
        if self.git("rev-parse", "--verify", "refs/remotes/origin/main") != candidate:
            raise S12Error("candidate is not exact archived main")
        if self.git("rev-parse", "HEAD") != self.args.production_baseline:
            raise S12Error("production source baseline differs")
        if self.git("status", "--porcelain"):
            raise S12Error("production worktree is dirty")
        for path, raw_local in ((CONTROLLER_PATH, Path(__file__)), (BOOTSTRAP_PATH, self.args.bootstrap)):
            if raw_local.is_symlink() or not raw_local.is_file():
                raise S12Error(f"running {path} is not a regular candidate file")
            local = raw_local.resolve()
            expected = subprocess.run(["git", "-C", str(REPO), "show", f"{candidate}:{path}"],
                                      check=True, stdout=subprocess.PIPE).stdout
            if local.read_bytes() != expected:
                raise S12Error(f"running {path} is not candidate-extracted")

    def source(self, mode: str, snapshot: str | None = None) -> dict[str, Any]:
        command = ["bash", str(self.args.bootstrap), f"--{mode}", self.args.candidate]
        if snapshot:
            command.append(snapshot)
        environment = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "RAN_AGENT_RELEASE_UNIFIED_SOURCE": "1",
            "RAN_AGENT_RELEASE_CONTROL_ROOT": str(REPO),
            "RAN_AGENT_RELEASE_ARTIFACT_ROOT": str(ARTIFACT_ROOT),
        }
        return self.run(command, env=environment)

    def rehearse(self, core_db: Path | None, output: Path) -> dict[str, Any]:
        with self.runtime_scratch() as scratch:
            actual_core = core_db or scratch / "core.sqlite3"
            scratch_output = scratch / "snapshot.json"
            result = self.runtime_run([
                str(NODE_BIN), str(REPO / "scripts/rehearse-core-schedule-migration.mjs"),
                "--manifest", str(MIGRATION_MANIFEST), "--legacy-db", str(self.args.legacy_db),
                "--state-dir", str(self.args.state_dir), "--core-db", str(actual_core),
                "--watermark", self.args.committed_at, "--output", str(scratch_output),
            ])
            atomic_json(output, json.loads(scratch_output.read_text(encoding="utf-8")))
            return {**result, "output": str(output)}

    def wake(self, mode: str, *, expect_active: bool = False) -> dict[str, Any]:
        command = [
            sys.executable, str(REPO / "scripts/reconcile-core-managed-wake.py"),
            "--mode", mode, "--manifest", str(MANAGED_WAKE_MANIFEST),
            "--hermes-home", str(HERMES_HOME), "--hermes-bin", str(HERMES_BIN),
            "--core-db", str(self.args.core_db),
        ]
        if expect_active:
            command.append("--expect-active")
        return self.run(command)

    def verify(self) -> dict[str, Any]:
        self.assert_candidate_binding()
        self.source("verify")
        if self.args.core_db.exists():
            marker = self.marker()
            if marker is None and not self.allow_inactive_core_reuse:
                raise S12Error("inactive Core candidate database already exists")
        wake = self.wake("verify")
        if wake.get("active") or wake.get("present"):
            raise S12Error("managed Core wake must be absent before S12")
        verify_snapshot = self.transaction_dir / "verify-migration-snapshot.json"
        with self.runtime_scratch() as scratch:
            verify_core = scratch / "core.sqlite3"
            rehearsal = self.rehearse(verify_core, verify_snapshot)
            cutover = self.run([
                str(NODE_BIN), str(REPO / "scripts/core-cutover.mjs"), "--mode", "verify",
                "--core-db", str(verify_core), "--snapshot", str(verify_snapshot),
                "--system-manifest", str(SCHEDULE_MANIFEST), "--visible-binding", str(self.args.visible_binding),
                "--candidate-sha", self.args.candidate, "--committed-at", self.args.committed_at,
            ])
        return {
            "status": "VERIFIED", "productionBaseline": self.args.production_baseline,
            "migration": rehearsal, "coreCutover": cutover, "mutationPlan": list(PHASES[1:]),
        }

    def source_apply(self) -> dict[str, Any]:
        receipt = self.source("apply")
        if receipt.get("status") != "SOURCE_APPLIED" or not receipt.get("snapshot"):
            raise S12Error("source apply returned no accepted snapshot")
        return receipt

    def recover_source_apply(self) -> dict[str, Any] | None:
        head = self.git("rev-parse", "HEAD")
        if head == self.args.production_baseline:
            return None
        if head != self.args.candidate or SOURCE_POINTER.is_symlink() or not SOURCE_POINTER.is_file():
            raise S12Error("source authority changed without an accepted S12 source snapshot")
        pointer = json.loads(SOURCE_POINTER.read_text(encoding="utf-8"))
        snapshot = Path(str(pointer.get("snapshot", "")))
        state_path = snapshot / "state.json"
        if (pointer.get("schemaVersion") != 1 or pointer.get("candidate") != self.args.candidate
                or snapshot.parent != SOURCE_SNAPSHOT_ROOT or snapshot.is_symlink() or not snapshot.is_dir()
                or state_path.is_symlink() or not state_path.is_file()):
            raise S12Error("accepted S12 source pointer is invalid")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if (state.get("candidate") != self.args.candidate or state.get("phase") != "accepted"
                or state.get("priorHead") != self.args.production_baseline):
            raise S12Error("accepted S12 source snapshot conflicts with transaction authority")
        return {"status": "SOURCE_APPLIED_RECOVERED", "snapshot": str(snapshot)}

    def core_prepare(self) -> dict[str, Any]:
        if not self.args.core_db.exists():
            return self.rehearse(self.args.core_db, self.snapshot)
        rehearsal = self.rehearse(None, self.snapshot)
        snapshot_fd = os.open(self.snapshot, os.O_RDONLY | os.O_NOFOLLOW)
        binding_fd = os.open(self.args.visible_binding, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            verified = self.runtime_run([
                str(NODE_BIN), str(REPO / "scripts/core-cutover.mjs"), "--mode", "verify",
                "--core-db", str(self.args.core_db), "--snapshot", f"/proc/self/fd/{snapshot_fd}",
                "--system-manifest", str(SCHEDULE_MANIFEST), "--visible-binding", f"/proc/self/fd/{binding_fd}",
                "--candidate-sha", self.args.candidate, "--committed-at", self.args.committed_at,
            ], pass_fds=(snapshot_fd, binding_fd))
        finally:
            os.close(binding_fd)
            os.close(snapshot_fd)
        return {**rehearsal, "inactiveCoreReused": True, "coreVerification": verified}

    def legacy_reconcile(self) -> dict[str, Any]:
        snapshot = json.loads(self.snapshot.read_text(encoding="utf-8"))
        blockers = set(snapshot.get("cutoverBlockers", []))
        if blockers - {"legacy_pending_outbound_requires_reconciliation"}:
            raise S12Error("legacy migration snapshot has unsafe blockers")
        return {"status": "LEGACY_RECONCILED", "snapshot": str(self.snapshot)}

    @staticmethod
    def patch_env(data: bytes, *, ingress_quiesced: bool) -> bytes:
        values = {"RAN_AGENT_CORE_ENABLED": "true", "RAN_AGENT_CORE_WAKE_ENABLED": "true"}
        if ingress_quiesced:
            values["RAN_AGENT_S12_INGRESS_QUIESCED"] = "true"
        lines = []
        for line in data.decode().splitlines():
            key = line.split("=", 1)[0] if "=" in line else ""
            if key not in {*values, "RAN_AGENT_S12_INGRESS_QUIESCED"}:
                lines.append(line)
        lines.extend(f"{key}={value}" for key, value in values.items())
        return ("\n".join(lines) + "\n").encode()

    def quiesce(self) -> dict[str, Any]:
        prepared = self.wake("prepare")
        for unit in ("ran-agent-node.service", "ran-agent-python.service"):
            subprocess.run(["systemctl", "stop", unit], check=True)
        for path in ENV_FILES:
            if path.is_symlink() or not path.is_file():
                raise S12Error(f"runtime env file is invalid: {path}")
            value = path.stat()
            payload = self.patch_env(path.read_bytes(), ingress_quiesced=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            try:
                os.fchmod(descriptor, stat.S_IMODE(value.st_mode))
                os.fchown(descriptor, value.st_uid, value.st_gid)
                with os.fdopen(descriptor, "wb") as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)
        final = self.rehearse(None, self.final_snapshot)
        if set(final.get("cutoverBlockers", [])) - {"legacy_pending_outbound_requires_reconciliation"}:
            raise S12Error("quiesced legacy state has unsafe blockers")
        return {"status": "QUIESCED", "managedWake": prepared, "snapshot": str(self.final_snapshot)}

    def cutover(self) -> dict[str, Any]:
        journal_fd = os.open(self.transaction_dir / "transaction.json", os.O_RDONLY | os.O_NOFOLLOW)
        snapshot_fd = os.open(self.final_snapshot, os.O_RDONLY | os.O_NOFOLLOW)
        binding_fd = os.open(self.args.visible_binding, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            return self.runtime_run([
                str(NODE_BIN), str(REPO / "scripts/core-cutover.mjs"), "--mode", "apply",
                "--core-db", str(self.args.core_db), "--snapshot", f"/proc/self/fd/{snapshot_fd}",
                "--system-manifest", str(SCHEDULE_MANIFEST), "--visible-binding", f"/proc/self/fd/{binding_fd}",
                "--candidate-sha", self.args.candidate, "--committed-at", self.args.committed_at,
                "--owner-id", self.args.owner_id, "--authorization-ref", self.args.authorization_ref,
                "--s12-transaction-fd", str(journal_fd),
            ], pass_fds=(journal_fd, snapshot_fd, binding_fd))
        finally:
            os.close(binding_fd)
            os.close(snapshot_fd)
            os.close(journal_fd)

    def marker(self) -> dict[str, Any] | None:
        if not self.args.core_db.exists():
            return None
        try:
            with sqlite3.connect(f"file:{self.args.core_db}?mode=ro", uri=True) as database:
                row = database.execute("SELECT owner_id,origin_ref,correlation_id,source_kind,event_type,source_ref "
                                       "FROM journal_event WHERE journal_event_id='core-cutover:v1'").fetchone()
        except sqlite3.Error as exc:
            raise S12Error("Core marker database is unreadable") from exc
        if row is None:
            return None
        if row[:5] != (self.args.owner_id, self.args.authorization_ref, self.args.candidate,
                      "core-cutover:v1", "core_cutover_committed_at"):
            raise S12Error("Core cutover marker conflicts with S12 authority")
        try:
            semantics = json.loads(row[5])
        except (TypeError, json.JSONDecodeError) as exc:
            raise S12Error("Core cutover marker semantics are malformed") from exc
        if (semantics.get("candidateSha") != self.args.candidate
                or semantics.get("ambiguousOutboxDisposition") != "terminal_no_resend"
                or semantics.get("pendingOutboundDisposition") != "suppress"):
            raise S12Error("Core cutover marker semantics conflict with S12 authority")
        return {"ownerId": row[0], "authorizationRef": row[1], "candidateSha": row[2],
                "migrationSnapshotDigest": semantics.get("migrationSnapshotDigest"),
                "scheduleManifestDigest": semantics.get("scheduleManifestDigest"),
                "watermark": semantics.get("watermark")}

    @staticmethod
    def main_pid(unit: str) -> int:
        result = subprocess.run(["systemctl", "show", unit, "--property=MainPID", "--value"],
                                check=True, text=True, stdout=subprocess.PIPE)
        pid = int(result.stdout.strip())
        if pid <= 0:
            raise S12Error(f"service has no MainPID: {unit}")
        return pid

    @staticmethod
    def process_env(pid: int) -> dict[str, str]:
        values = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        return {item.split(b"=", 1)[0].decode(): item.split(b"=", 1)[1].decode()
                for item in values if b"=" in item}

    @staticmethod
    def node_writer_pids() -> list[int]:
        expected = str(REPO / "node_bridge/src/index.mjs").encode()
        found = []
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            with contextlib.suppress(FileNotFoundError, PermissionError, ProcessLookupError):
                argv = (process / "cmdline").read_bytes().split(b"\0")
                if expected in argv:
                    found.append(int(process.name))
        return sorted(found)

    def activate_worker(self) -> dict[str, Any]:
        subprocess.run(["systemctl", "restart", "ran-agent-python.service", "ran-agent-node.service"], check=True)
        python_pid = self.main_pid("ran-agent-python.service")
        node_pid = self.main_pid("ran-agent-node.service")
        writers = self.node_writer_pids()
        if (self.process_env(python_pid).get("RAN_AGENT_CORE_ENABLED") != "true"
                or self.process_env(node_pid).get("RAN_AGENT_CORE_ENABLED") != "true"):
            raise S12Error("Core worker/legacy scheduler handoff is not active")
        if writers != [node_pid]:
            raise S12Error("Core requires exactly one work-producing writer")
        return {"status": "CORE_WORKER_ACTIVE", "pythonPid": python_pid, "nodePid": node_pid,
                "workProducingWriters": len(writers)}

    def activate_wake(self) -> dict[str, Any]:
        result = self.wake("activate")
        verified = self.wake("verify", expect_active=True)
        if not verified.get("active"):
            raise S12Error("managed Core wake did not activate")
        return {**result, "workProducingClocks": 1}

    def acceptance(self, mode: str) -> dict[str, Any]:
        binding = json.loads(self.args.visible_binding.read_text(encoding="utf-8"))
        command = [
            str(NODE_BIN), str(REPO / "scripts/core-s12-acceptance.mjs"), "--mode", mode,
            "--core-db", str(self.args.core_db), "--transaction-id", self.args.transaction_id,
            "--candidate-sha", self.args.candidate, "--owner-id", self.args.owner_id,
            "--authorization-ref", self.args.authorization_ref,
        ]
        scheduled_timestamp = None
        if mode == "register":
            scheduled = datetime.fromtimestamp(
                int(datetime.now(timezone.utc).timestamp()) + 1, timezone.utc
            ).isoformat().replace("+00:00", "Z")
            scheduled_timestamp = datetime.fromisoformat(scheduled.replace("Z", "+00:00")).timestamp()
            command.extend(["--conversation-id", binding["conversationId"], "--binding-id", binding["bindingId"],
                            "--scheduled-at", scheduled])
        journal_fd = os.open(self.transaction_dir / "transaction.json", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            command.extend(["--s12-transaction-fd", str(journal_fd)])
            result = self.runtime_run(command, pass_fds=(journal_fd,))
        finally:
            os.close(journal_fd)
        if scheduled_timestamp is not None:
            time.sleep(max(0, scheduled_timestamp - time.time() + 0.05))
            wake = self.run([
                "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
                "HOME=/home/ubuntu", "PATH=/opt/nodejs/node-v22.22.2-linux-x64/bin:/usr/bin:/bin",
                f"RAN_AGENT_STATE_DIR={self.args.state_dir}", "RAN_AGENT_CORE_WAKE_ENABLED=true",
                str(NODE_BIN), str(REPO / "scripts/core-wake.mjs"),
            ])
            result = {**result, "initialWake": wake}
        return result

    def wait_acceptance(self) -> dict[str, Any]:
        deadline = time.monotonic() + self.args.acceptance_timeout
        last = None
        while time.monotonic() < deadline:
            last = self.acceptance("inspect")
            if last.get("status") == "TERMINAL_RECEIPT":
                return last
            if last.get("status") == "FORWARD_RECOVERY_REQUIRED":
                raise S12Error("acceptance requires forward-only delivery reconciliation")
            time.sleep(2)
        raise S12Error(f"acceptance terminal receipt timed out: {last}")

    def inspect_accepted(self, marker: dict[str, Any]) -> dict[str, Any]:
        receipt = self.acceptance("inspect")
        wake = self.wake("verify", expect_active=True)
        worker = self.activate_worker_status()
        with sqlite3.connect(f"file:{self.args.core_db}?mode=ro", uri=True) as database:
            outbox = database.execute(
                "SELECT state,attempt_count FROM presentation_outbox WHERE presentation_outbox_id=?",
                (receipt.get("outboxId"),),
            ).fetchall()
            results = database.execute(
                "SELECT count(*) FROM journal_event WHERE event_type='package_b_presentation_result_recorded' "
                "AND correlation_id=?", (receipt.get("outboxId"),),
            ).fetchone()[0]
        if (receipt.get("status") != "TERMINAL_RECEIPT" or not wake.get("active")
                or outbox != [("sent", 1)] or results != 1):
            raise S12Error("final S12 reconciliation failed")
        return {"status": "ACCEPTED", **worker, "workProducingClocks": 1,
                "terminalReceipt": receipt["receiptId"], "adapterInvocationBound": 1,
                "coreMarker": marker}

    def final_verify(self) -> dict[str, Any]:
        for path in ENV_FILES:
            value = path.stat()
            payload = self.patch_env(path.read_bytes(), ingress_quiesced=False)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            try:
                os.fchmod(descriptor, stat.S_IMODE(value.st_mode))
                os.fchown(descriptor, value.st_uid, value.st_gid)
                with os.fdopen(descriptor, "wb") as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)
        subprocess.run(["systemctl", "restart", "ran-agent-node.service"], check=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            with socket.socket() as connection:
                connection.settimeout(0.5)
                if connection.connect_ex(("127.0.0.1", 8791)) == 0:
                    break
            time.sleep(0.5)
        else:
            raise S12Error("Node ingress did not resume after acceptance")
        marker = self.marker()
        if marker is None:
            raise S12Error("final S12 reconciliation lacks the Core authority marker")
        return self.inspect_accepted(marker)

    def activate_worker_status(self) -> dict[str, Any]:
        node_pid = self.main_pid("ran-agent-node.service")
        python_pid = self.main_pid("ran-agent-python.service")
        writers = self.node_writer_pids()
        if (self.process_env(node_pid).get("RAN_AGENT_CORE_ENABLED") != "true"
                or self.process_env(python_pid).get("RAN_AGENT_CORE_ENABLED") != "true"):
            raise S12Error("Core worker authority is not active")
        if writers != [node_pid]:
            raise S12Error("Core requires exactly one work-producing writer")
        return {"nodePid": node_pid, "pythonPid": python_pid, "workProducingWriters": len(writers)}

    def rollback_pre_cutover(self, source_snapshot: str | None) -> None:
        self.wake("remove")
        if source_snapshot:
            self.source("rollback", source_snapshot)

def run_apply(ops: ProductionOperations, journal: Journal, *, fail_after: str | None = None) -> dict[str, Any]:
    state = journal.state
    try:
        marker = ops.marker()
    except BaseException as exc:
        if (state.get("cutoverAttempted") or state.get("cutoverCommitted")
                or state.get("status") in {"ACCEPTED", "FORWARD_RECOVERY", "FORWARD_RECOVERY_REQUIRED"}):
            state.update({"status": "FORWARD_RECOVERY_REQUIRED", "failure": type(exc).__name__})
            journal.write()
        raise
    if state.get("status") == "ACCEPTED":
        if marker is None:
            state.update({"status": "FORWARD_RECOVERY_REQUIRED", "failure": "CoreMarkerMissing"})
            journal.write()
            raise S12Error("accepted S12 journal lacks the Core authority marker")
        ops.inspect_accepted(marker)
        return state
    if state.get("status") == "ROLLED_BACK":
        if marker is not None:
            state.update({"status": "FORWARD_RECOVERY_REQUIRED", "cutoverCommitted": True,
                          "coreMarker": marker, "failure": "StaleRollbackJournal"})
            journal.write()
            raise S12Error("Core authority marker overrides the stale rollback journal")
        ops.allow_inactive_core_reuse = True
        journal.restart_after_rollback()
        state = journal.state
    if marker is None and (state.get("cutoverCommitted")
                           or "P5_CORE_AUTHORITY_COMMITTED" in state["completedPhases"]):
        state.update({"status": "FORWARD_RECOVERY_REQUIRED", "failure": "CoreMarkerMissing"})
        journal.write()
        raise S12Error("journal claims Core authority without its SQLite marker")
    if marker and "P5_CORE_AUTHORITY_COMMITTED" not in state["completedPhases"]:
        if state["completedPhases"] != list(PHASES[:5]):
            state.update({"status": "FORWARD_RECOVERY_REQUIRED", "cutoverCommitted": True,
                          "coreMarker": marker, "failure": "StalePreCutoverJournal"})
            journal.write()
            raise S12Error("Core marker exists without the durable pre-cutover phase chain")
        state["completedPhases"] = list(PHASES[:6])
        state["phaseReceipts"]["P5_CORE_AUTHORITY_COMMITTED"] = marker
        state.update({"phase": PHASES[5], "cutoverCommitted": True,
                      "status": "FORWARD_RECOVERY", "coreMarker": marker})
        journal.write()
    if state["completedPhases"] == ["P0_VERIFIED"]:
        recovered_source = ops.recover_source_apply()
        if recovered_source is not None:
            state["sourceSnapshot"] = recovered_source["snapshot"]
            journal.complete("P1_SOURCE_APPLIED", lastReceipt=recovered_source)
    actions = {
        "P0_VERIFIED": ops.verify,
        "P1_SOURCE_APPLIED": ops.source_apply,
        "P2_CORE_PREPARED": ops.core_prepare,
        "P3_LEGACY_RECONCILED": ops.legacy_reconcile,
        "P4_QUIESCED": ops.quiesce,
        "P5_CORE_AUTHORITY_COMMITTED": ops.cutover,
        "P6_CORE_WORKER_ACTIVE": ops.activate_worker,
        "P7_CORE_WAKE_ACTIVE": ops.activate_wake,
        "P8_ACCEPTANCE_EFFECT_COMMITTED": lambda: ops.acceptance("register"),
        "P9_ACCEPTANCE_RECEIPT_TERMINAL": ops.wait_acceptance,
        "P10_ACCEPTED": ops.final_verify,
    }
    try:
        for phase in PHASES:
            if phase in state["completedPhases"]:
                continue
            if phase == "P5_CORE_AUTHORITY_COMMITTED":
                state["cutoverAttempted"] = True
                journal.write()
            result = actions[phase]()
            if phase == "P1_SOURCE_APPLIED":
                state["sourceSnapshot"] = result["snapshot"]
            if phase == "P5_CORE_AUTHORITY_COMMITTED":
                if ops.marker() is None:
                    raise S12Error("Core cutover command returned without its authoritative marker")
                if fail_after == "P5_SQLITE_COMMIT_BEFORE_JOURNAL":
                    raise SimulatedCrash()
                state["cutoverCommitted"] = True
                state["coreMarker"] = ops.marker()
            if phase.startswith("P8_") or phase.startswith("P9_"):
                state["acceptance"] = {**state["acceptance"], **result, "status": result.get("status", "ENQUEUED")}
            journal.complete(phase, lastReceipt=result)
            if fail_after == phase:
                raise S12Error(f"injected failure after {phase}")
        state["status"] = "ACCEPTED"
        journal.write()
        return state
    except SimulatedCrash:
        raise
    except BaseException as exc:
        try:
            committed = ops.marker() is not None
        except BaseException:
            if state.get("cutoverAttempted"):
                state.update({"status": "FORWARD_RECOVERY_REQUIRED", "failure": type(exc).__name__})
                journal.write()
                raise
            committed = False
        if committed or state.get("cutoverCommitted"):
            state.update({"status": "FORWARD_RECOVERY_REQUIRED", "failure": type(exc).__name__})
            journal.write()
        else:
            try:
                ops.rollback_pre_cutover(state.get("sourceSnapshot"))
                state.update({"status": "ROLLED_BACK", "failure": type(exc).__name__})
                journal.write()
            except BaseException as rollback_error:
                state.update({"status": "PRE_CUTOVER_RECONCILIATION_REQUIRED",
                              "failure": type(exc).__name__, "rollbackFailure": type(rollback_error).__name__})
                journal.write()
                raise S12Error("pre-cutover failure could not restore authority") from rollback_error
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("verify", "apply"), required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--production-baseline", required=True)
    parser.add_argument("--owner-id")
    parser.add_argument("--authorization-ref")
    parser.add_argument("--bootstrap", type=Path, required=True)
    parser.add_argument("--legacy-db", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--core-db", type=Path, required=True)
    parser.add_argument("--visible-binding", type=Path, required=True)
    parser.add_argument("--committed-at", required=True)
    parser.add_argument("--acceptance-timeout", type=int, default=180)
    args = parser.parse_args()
    if args.mode == "apply" and (not args.owner_id or not args.authorization_ref):
        parser.error("--mode apply requires --owner-id and --authorization-ref")
    return args


def main() -> int:
    args = parse_args()
    if os.geteuid() != 0:
        raise S12Error("S12 controller must run as root")
    if ARTIFACT_ROOT.is_symlink() or not ARTIFACT_ROOT.is_dir():
        raise S12Error("release artifact authority root is absent")
    root = ARTIFACT_ROOT.stat()
    if root.st_uid != 0 or root.st_gid != 0 or stat.S_IMODE(root.st_mode) != 0o700:
        raise S12Error("release artifact authority root identity/mode is invalid")
    owner = args.owner_id or "verify-only"
    authorization = args.authorization_ref or "verify-only"
    visible_binding_digest = protected_file_digest(args.visible_binding)
    identity = {
        "transactionId": transaction_id(args.candidate, owner, authorization),
        "candidateSha": args.candidate,
        "ownerId": owner,
        "authorizationRef": authorization,
        "productionBaselineSha": args.production_baseline,
        "committedAt": args.committed_at,
        "visibleBindingSha256": visible_binding_digest,
        "coreDb": str(args.core_db.resolve()),
    }
    args.transaction_id = identity["transactionId"]
    if args.mode == "verify":
        with tempfile.TemporaryDirectory(prefix="s12-verify-") as temporary:
            result = ProductionOperations(args, Path(temporary)).verify()
        print(json.dumps(result, sort_keys=True))
        return 0
    TRANSACTION_ROOT.mkdir(mode=0o700, exist_ok=True)
    transaction_root = TRANSACTION_ROOT.lstat()
    if (not stat.S_ISDIR(transaction_root.st_mode) or stat.S_IMODE(transaction_root.st_mode) != 0o700
            or transaction_root.st_uid != 0):
        raise S12Error("S12 transaction authority root identity/mode is invalid")
    with transaction_lock(LOCK_PATH):
        journal = Journal(TRANSACTION_ROOT, identity)
        journal.open()
        result = run_apply(ProductionOperations(args, journal.directory), journal)
    print(json.dumps({"status": result["status"], "transaction": str(journal.path),
                      "phase": result["phase"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (S12Error, OSError, ValueError, json.JSONDecodeError,
            sqlite3.Error, subprocess.CalledProcessError) as error:
        detail = str(error) if isinstance(error, S12Error) else type(error).__name__
        print(f"s12-cutover: failed:{detail}", file=sys.stderr)
        raise SystemExit(1)
