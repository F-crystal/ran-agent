from __future__ import annotations

import importlib.util
import copy
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts/s12-cutover.py"
SPEC = importlib.util.spec_from_file_location("s12_cutover", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeOperations:
    def __init__(self):
        self.calls: list[str] = []
        self.committed = False
        self.fail: str | None = None
        self.acceptance_waits = 0
        self.recovered_source: dict[str, object] | None = None
        self.marker_calls = 0

    def _call(self, name: str, result: dict[str, object] | None = None):
        self.calls.append(name)
        if self.fail == name:
            raise MODULE.S12Error(f"failed:{name}")
        return result or {"status": name}

    def marker(self):
        self.marker_calls += 1
        return {"candidateSha": "a" * 40} if self.committed else None

    def verify(self): return self._call("verify")
    def source_apply(self): return self._call("source_apply", {"snapshot": "/source/snapshot"})
    def recover_source_apply(self):
        self.calls.append("recover_source_apply")
        return self.recovered_source
    def core_prepare(self): return self._call("core_prepare")
    def legacy_reconcile(self): return self._call("legacy_reconcile")
    def quiesce(self): return self._call("quiesce")

    def cutover(self):
        result = self._call("cutover")
        self.committed = True
        return result

    def activate_worker(self): return self._call("activate_worker", {"workProducingWriters": 1})
    def activate_wake(self): return self._call("activate_wake", {"workProducingClocks": 1})
    def acceptance(self, mode: str):
        return self._call(f"acceptance_{mode}", {"status": "ENQUEUED", "outboxId": "outbox"})

    def wait_acceptance(self):
        self.acceptance_waits += 1
        return self._call("acceptance_wait", {"status": "TERMINAL_RECEIPT", "receiptId": "receipt"})

    def final_verify(self): return self._call("final_verify", {"status": "ACCEPTED"})
    def inspect_accepted(self, _marker):
        return self._call("inspect_accepted", {"status": "ACCEPTED"})

    def rollback_pre_cutover(self, source_snapshot):
        self.calls.append(f"rollback:{source_snapshot}")



def journal(tmp_path: Path):
    identity = {
        "transactionId": "s12-test", "candidateSha": "a" * 40,
        "ownerId": "owner", "authorizationRef": "auth",
        "productionBaselineSha": "b" * 40, "committedAt": "2026-08-12T00:00:00Z",
        "coreDb": str(tmp_path / "core.sqlite3"),
    }
    value = MODULE.Journal(tmp_path, identity)
    value.open()
    return value


def mark_accepted(value: MODULE.Journal) -> None:
    value.state.update({
        "phase": MODULE.PHASES[-1], "completedPhases": list(MODULE.PHASES),
        "status": "ACCEPTED", "cutoverCommitted": True, "cutoverAttempted": True,
    })
    value.write()


def write_core_marker(
    path: Path, *, owner: str = "owner", authorization: str = "auth",
    candidate: str = "a" * 40, semantics: str | None = None,
) -> None:
    payload = semantics or json.dumps({
        "candidateSha": candidate,
        "ambiguousOutboxDisposition": "terminal_no_resend",
        "pendingOutboundDisposition": "suppress",
        "migrationSnapshotDigest": "sha256:migration",
        "scheduleManifestDigest": "sha256:schedule",
        "watermark": "2026-08-12T00:00:00Z",
    })
    with sqlite3.connect(path) as database:
        database.execute(
            "CREATE TABLE journal_event (journal_event_id TEXT PRIMARY KEY,event_type TEXT,"
            "owner_id TEXT,origin_ref TEXT,correlation_id TEXT,source_kind TEXT,source_ref TEXT)"
        )
        database.execute(
            "INSERT INTO journal_event VALUES(?,?,?,?,?,?,?)",
            ("core-cutover:v1", "core_cutover_committed_at", owner, authorization,
             candidate, "core-cutover:v1", payload),
        )


def accepted_operations(core_db: Path) -> MODULE.ProductionOperations:
    return MODULE.ProductionOperations(SimpleNamespace(
        core_db=core_db, owner_id="owner", authorization_ref="auth", candidate="a" * 40,
    ), core_db.parent / "transaction", Path("/candidate"))


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        digest.update(str(path.relative_to(root)).encode())
        if path.is_file() and not path.is_symlink():
            digest.update(path.read_bytes())
        else:
            digest.update(str(path.lstat().st_mode).encode())
    return digest.hexdigest()


class ComposedRollbackOperations(MODULE.ProductionOperations):
    """Stateful subordinate harness; rollback_pre_cutover stays production code."""

    SOURCE_KEYS = {
        "head", "sourcePointer", "sourceSnapshotPhase", "env", "profile", "dropin",
        "services", "legacyClock", "writers", "clocks",
    }

    def __init__(self, transaction_dir: Path):
        super().__init__(SimpleNamespace(), transaction_dir, Path("/candidate"))
        self.authority = {
            "head": "baseline", "sourcePointer": "baseline", "sourceSnapshotPhase": "accepted",
            "env": b"BASE_ENV\n", "profile": b"legacy\n", "dropin": b"legacy-dropin\n",
            "services": {"node": "active", "python": "active"},
            "legacyClock": True, "managedWake": "absent", "coreMarker": False,
            "coreWriter": False, "effects": [], "adapterInvocations": 0, "results": [],
            "writers": 1, "clocks": 1, "inactiveCore": "no-authority",
        }
        self.snapshots: dict[str, dict[str, object]] = {}
        self.recovered_source: dict[str, object] | None = None

    def vector(self) -> dict[str, object]:
        return copy.deepcopy(self.authority)

    def marker(self):
        return {"candidateSha": "candidate"} if self.authority["coreMarker"] else None

    def verify(self):
        return {"status": "VERIFIED"}

    def source(self, mode: str, snapshot: str | None = None):
        if mode == "apply":
            name = "/source/composed-snapshot"
            self.snapshots[name] = {
                key: copy.deepcopy(self.authority[key]) for key in self.SOURCE_KEYS
            }
            self.authority.update({
                "head": "candidate", "sourcePointer": "candidate",
                "sourceSnapshotPhase": "accepted", "env": b"CANDIDATE_ENV\n",
                "profile": b"companion\n", "dropin": b"core-dropin\n",
            })
            return {"status": "SOURCE_APPLIED", "snapshot": name}
        if mode == "rollback":
            assert snapshot in self.snapshots
            self.authority.update(copy.deepcopy(self.snapshots[snapshot]))
            return {"status": "SOURCE_ROLLED_BACK", "snapshot": snapshot}
        raise AssertionError(f"unexpected source mode: {mode}")

    def source_apply(self):
        return self.source("apply")

    def recover_source_apply(self):
        return self.recovered_source

    def core_prepare(self):
        self.authority["inactiveCore"] = "no-authority"
        return {"status": "CORE_PREPARED"}

    def legacy_reconcile(self):
        return {"status": "LEGACY_RECONCILED"}

    def wake(self, mode: str, **_kwargs):
        if mode == "prepare":
            self.authority["managedWake"] = "paused"
        elif mode == "remove":
            self.authority["managedWake"] = "absent"
        else:
            raise AssertionError(f"unexpected wake mode: {mode}")
        return {"status": mode, "active": False}

    def quiesce(self):
        self.wake("prepare")
        self.authority.update({
            "env": b"QUIESCED_ENV\n", "services": {"node": "inactive", "python": "inactive"},
            "legacyClock": False, "writers": 0, "clocks": 0,
        })
        return {"status": "QUIESCED"}

    def cutover(self):
        self.authority["coreMarker"] = True
        return {"status": "COMMITTED"}

    def activate_worker(self):
        raise AssertionError("post-marker action is outside composed pre-marker proof")

    def activate_wake(self):
        raise AssertionError("post-marker action is outside composed pre-marker proof")

    def acceptance(self, _mode: str):
        raise AssertionError("acceptance is outside composed pre-marker proof")

    def wait_acceptance(self):
        raise AssertionError("acceptance is outside composed pre-marker proof")

    def final_verify(self):
        raise AssertionError("acceptance is outside composed pre-marker proof")


@pytest.mark.parametrize("phase", MODULE.PHASES[:5])
def test_composed_pre_marker_failure_restores_complete_authority_vector(
    tmp_path: Path, phase: str,
) -> None:
    operations = ComposedRollbackOperations(tmp_path / "transaction")
    before = operations.vector()
    state = journal(tmp_path / "journal")
    with pytest.raises(MODULE.S12Error, match="injected failure"):
        MODULE.run_apply(operations, state, fail_after=phase)
    assert state.state["status"] == "ROLLED_BACK"
    assert operations.vector() == before
    assert operations.rollback_pre_cutover.__func__ is MODULE.ProductionOperations.rollback_pre_cutover
    assert operations.authority["coreMarker"] is False
    assert operations.authority["managedWake"] == "absent"
    assert operations.authority["effects"] == []
    assert operations.authority["adapterInvocations"] == 0
    assert operations.authority["results"] == []
    assert operations.authority["writers"] == 1
    assert operations.authority["clocks"] == 1


def test_composed_source_apply_before_p1_recovery_still_restores_complete_authority(
    tmp_path: Path,
) -> None:
    operations = ComposedRollbackOperations(tmp_path / "transaction")
    before = operations.vector()
    recovered = operations.source_apply()
    operations.recovered_source = {
        "status": "SOURCE_APPLIED_RECOVERED", "snapshot": recovered["snapshot"],
    }
    state = journal(tmp_path / "journal")
    state.complete("P0_VERIFIED", lastReceipt={"status": "VERIFIED"})
    with pytest.raises(MODULE.S12Error, match="injected failure"):
        MODULE.run_apply(operations, state, fail_after="P2_CORE_PREPARED")
    assert state.state["phaseReceipts"]["P1_SOURCE_APPLIED"]["status"] == "SOURCE_APPLIED_RECOVERED"
    assert operations.vector() == before


def test_failure_immediately_before_core_commit_rolls_back(tmp_path: Path) -> None:
    operations = FakeOperations()
    operations.fail = "cutover"
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="failed:cutover"):
        MODULE.run_apply(operations, state)
    assert operations.calls[:2] == ["verify", "source_apply"]
    assert state.state["status"] == "ROLLED_BACK"
    assert operations.calls[-1] == "rollback:/source/snapshot"


def test_source_crash_recovery_binds_pointer_snapshot_and_prior_head(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    baseline = "b" * 40
    candidate = "a" * 40
    snapshots = tmp_path / "source-snapshots"
    snapshot = snapshots / "source-accepted"
    snapshot.mkdir(parents=True)
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "phase": "accepted", "priorHead": baseline,
    }))
    pointer = snapshots / "current-source.json"
    pointer.write_text(json.dumps({
        "schemaVersion": 1, "candidate": candidate, "snapshot": str(snapshot),
    }))
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshots)
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", pointer)
    operations = MODULE.ProductionOperations(SimpleNamespace(
        candidate=candidate, production_baseline=baseline,
    ), tmp_path / "transaction", tmp_path / "candidate")
    monkeypatch.setattr(operations, "git", lambda *_args: candidate)
    assert operations.recover_source_apply() == {
        "status": "SOURCE_APPLIED_RECOVERED", "snapshot": str(snapshot),
    }
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "phase": "accepted", "priorHead": "c" * 40,
    }))
    with pytest.raises(MODULE.S12Error, match="conflicts with transaction authority"):
        operations.recover_source_apply()


@pytest.mark.parametrize("phase", MODULE.PHASES[5:10])
def test_each_post_marker_failure_is_forward_only(tmp_path: Path, phase: str) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="injected failure"):
        MODULE.run_apply(operations, state, fail_after=phase)
    assert state.state["status"] == "FORWARD_RECOVERY_REQUIRED"
    assert all(not call.startswith("rollback:") for call in operations.calls)
    assert operations.committed is True


def test_sqlite_marker_precedes_stale_journal_and_resumes_forward(tmp_path: Path) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    with pytest.raises(MODULE.SimulatedCrash):
        MODULE.run_apply(operations, state, fail_after="P5_SQLITE_COMMIT_BEFORE_JOURNAL")
    assert state.state["phase"] == "P4_QUIESCED"
    assert operations.committed is True
    resumed = MODULE.run_apply(operations, state)
    assert resumed["status"] == "ACCEPTED"
    assert resumed["completedPhases"] == list(MODULE.PHASES)
    assert operations.calls.count("cutover") == 1
    assert not any(call.startswith("rollback:") for call in operations.calls)


def test_crash_after_enqueue_resumes_receipt_without_registering_again(tmp_path: Path) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="injected failure"):
        MODULE.run_apply(operations, state, fail_after="P8_ACCEPTANCE_EFFECT_COMMITTED")
    resumed = MODULE.run_apply(operations, state)
    assert resumed["status"] == "ACCEPTED"
    assert operations.calls.count("acceptance_register") == 1
    assert operations.acceptance_waits == 1


def test_ambiguous_send_never_reenqueues_and_requires_forward_reconciliation(tmp_path: Path) -> None:
    operations = FakeOperations()
    operations.fail = "acceptance_wait"
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="failed:acceptance_wait"):
        MODULE.run_apply(operations, state)
    assert state.state["status"] == "FORWARD_RECOVERY_REQUIRED"
    assert operations.calls.count("acceptance_register") == 1
    operations.fail = None
    MODULE.run_apply(operations, state)
    assert operations.calls.count("acceptance_register") == 1


def test_exact_terminal_replay_is_a_noop(tmp_path: Path) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    first = MODULE.run_apply(operations, state)
    journal_bytes = state.path.read_bytes()
    external_calls = operations.calls.count("acceptance_register")
    replay_start = len(operations.calls)
    second = MODULE.run_apply(operations, state)
    assert first == second
    assert operations.calls[replay_start:] == ["inspect_accepted"]
    assert operations.calls.count("acceptance_register") == external_calls
    assert state.path.read_bytes() == journal_bytes


def test_accepted_replay_reads_and_validates_sqlite_before_returning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    core_db = tmp_path / "core.sqlite3"
    write_core_marker(core_db)
    operations = accepted_operations(core_db)
    inspected = []
    marker_calls = []
    real_marker = operations.marker
    monkeypatch.setattr(
        operations, "marker", lambda: marker_calls.append("marker") or real_marker(),
    )
    monkeypatch.setattr(operations, "inspect_accepted", lambda marker: inspected.append(marker))
    state = journal(tmp_path / "journal")
    mark_accepted(state)
    before = state.path.read_bytes()

    assert MODULE.run_apply(operations, state)["status"] == "ACCEPTED"
    assert marker_calls == ["marker"]
    assert inspected == [{
        "ownerId": "owner", "authorizationRef": "auth", "candidateSha": "a" * 40,
        "migrationSnapshotDigest": "sha256:migration",
        "scheduleManifestDigest": "sha256:schedule",
        "watermark": "2026-08-12T00:00:00Z",
    }]
    assert state.path.read_bytes() == before


@pytest.mark.parametrize(
    ("case", "marker_kwargs", "malformed_db", "message"),
    (
        ("missing", None, False, "lacks the Core authority marker"),
        ("malformed-db", None, True, "database is unreadable"),
        ("owner", {"owner": "other"}, False, "conflicts with S12 authority"),
        ("authorization", {"authorization": "other"}, False, "conflicts with S12 authority"),
        ("candidate", {"candidate": "c" * 40}, False, "conflicts with S12 authority"),
        ("semantics", {"semantics": "{}"}, False, "semantics conflict"),
        ("malformed-semantics", {"semantics": "{"}, False, "semantics are malformed"),
    ),
)
def test_accepted_journal_never_overrides_missing_corrupt_or_conflicting_sqlite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str,
    marker_kwargs: dict[str, str] | None, malformed_db: bool, message: str,
) -> None:
    core_db = tmp_path / f"{case}.sqlite3"
    if malformed_db:
        core_db.write_bytes(b"not sqlite")
    elif marker_kwargs is not None:
        write_core_marker(core_db, **marker_kwargs)
    operations = accepted_operations(core_db)
    inspected = []
    marker_calls = []
    real_marker = operations.marker
    monkeypatch.setattr(
        operations, "marker", lambda: marker_calls.append("marker") or real_marker(),
    )
    monkeypatch.setattr(operations, "inspect_accepted", lambda marker: inspected.append(marker))
    state = journal(tmp_path / "journal")
    mark_accepted(state)

    with pytest.raises(MODULE.S12Error, match=message):
        MODULE.run_apply(operations, state)
    assert marker_calls == ["marker"]
    assert inspected == []
    assert state.state["status"] == "FORWARD_RECOVERY_REQUIRED"


def test_stale_rolled_back_journal_cannot_override_a_committed_marker(tmp_path: Path) -> None:
    operations = FakeOperations()
    operations.committed = True
    state = journal(tmp_path)
    state.state["status"] = "ROLLED_BACK"
    state.write()
    with pytest.raises(MODULE.S12Error, match="overrides the stale rollback journal"):
        MODULE.run_apply(operations, state)
    assert operations.marker_calls == 1
    assert state.state["status"] == "FORWARD_RECOVERY_REQUIRED"
    assert "verify" not in operations.calls


def test_read_only_accepted_inspection_requires_writer_clock_and_terminal_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    core_db = tmp_path / "core.sqlite3"
    write_core_marker(core_db)
    with sqlite3.connect(core_db) as database:
        database.execute(
            "CREATE TABLE presentation_outbox (presentation_outbox_id TEXT,state TEXT,attempt_count INTEGER)"
        )
        database.execute("INSERT INTO presentation_outbox VALUES('outbox','sent',1)")
        database.execute(
            "INSERT INTO journal_event VALUES(?,?,?,?,?,?,?)",
            ("receipt", "package_b_presentation_result_recorded", "owner", "auth",
             "outbox", "acceptance", "{}"),
        )
    operations = accepted_operations(core_db)
    monkeypatch.setattr(
        operations, "acceptance",
        lambda mode: {"status": "TERMINAL_RECEIPT", "outboxId": "outbox", "receiptId": "receipt"},
    )
    monkeypatch.setattr(operations, "wake", lambda mode, **_kwargs: {"active": True})
    monkeypatch.setattr(
        operations, "activate_worker_status",
        lambda: {"workProducingWriters": 1, "nodePid": 11, "pythonPid": 12},
    )
    receipt = operations.inspect_accepted(operations.marker())
    assert receipt["status"] == "ACCEPTED"
    assert receipt["workProducingWriters"] == 1
    assert receipt["workProducingClocks"] == 1
    assert receipt["terminalReceipt"] == "receipt"
    assert receipt["adapterInvocationBound"] == 1


def test_rerun_after_pre_cutover_rollback_reuses_the_inactive_core_candidate(tmp_path: Path) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error):
        MODULE.run_apply(operations, state, fail_after="P2_CORE_PREPARED")
    MODULE.run_apply(operations, state)
    assert operations.allow_inactive_core_reuse is True
    assert state.state["status"] == "ACCEPTED"


def test_unreadable_marker_after_cutover_attempt_never_rolls_back(tmp_path: Path) -> None:
    class UnreadableMarker(FakeOperations):
        def marker(self):
            if self.committed:
                raise MODULE.S12Error("marker unreadable")
            return None

    operations = UnreadableMarker()
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="marker unreadable"):
        MODULE.run_apply(operations, state)
    assert state.state["status"] == "FORWARD_RECOVERY_REQUIRED"
    assert all(not call.startswith("rollback:") for call in operations.calls)


def test_journal_identity_mismatch_fails_closed(tmp_path: Path) -> None:
    first = journal(tmp_path)
    conflicting = dict(first.identity)
    conflicting["ownerId"] = "other-owner"
    with pytest.raises(MODULE.S12Error, match="identity conflicts"):
        MODULE.Journal(tmp_path, conflicting).open()


def test_journal_phase_chain_tampering_fails_closed(tmp_path: Path) -> None:
    value = journal(tmp_path)
    stored = json.loads(value.path.read_text())
    stored["completedPhases"] = ["P0_VERIFIED", "P2_CORE_PREPARED"]
    stored["phase"] = "P2_CORE_PREPARED"
    value.path.write_text(json.dumps(stored))
    value.path.chmod(0o600)
    with pytest.raises(MODULE.S12Error, match="schema or phase chain"):
        MODULE.Journal(tmp_path, value.identity).open()


def test_journal_binds_required_authority_and_mode(tmp_path: Path) -> None:
    value = journal(tmp_path)
    stored = json.loads(value.path.read_text())
    assert stored["candidateSha"] == "a" * 40
    assert stored["authorizationRef"] == "auth"
    assert stored["productionBaselineSha"] == "b" * 40
    assert stored["acceptance"]["idempotencyKey"] == "s12-test"
    assert value.path.stat().st_mode & 0o777 == 0o600
    assert value.directory.stat().st_mode & 0o777 == 0o700


def test_exclusive_lock_rejects_a_second_attempt(tmp_path: Path) -> None:
    lock = tmp_path / "s12.lock"
    with MODULE.transaction_lock(lock):
        with pytest.raises(MODULE.S12Error, match="another S12 transaction"):
            with MODULE.transaction_lock(lock):
                pass


def test_verify_plan_is_read_only_state_machine_surface() -> None:
    assert MODULE.PHASES == (
        "P0_VERIFIED", "P1_SOURCE_APPLIED", "P2_CORE_PREPARED", "P3_LEGACY_RECONCILED",
        "P4_QUIESCED", "P5_CORE_AUTHORITY_COMMITTED", "P6_CORE_WORKER_ACTIVE",
        "P7_CORE_WAKE_ACTIVE", "P8_ACCEPTANCE_EFFECT_COMMITTED",
        "P9_ACCEPTANCE_RECEIPT_TERMINAL", "P10_ACCEPTED",
    )


def test_candidate_execution_closure_is_exact_read_only_and_import_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = SCRIPT.parents[1]
    candidate = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], check=True,
        text=True, stdout=subprocess.PIPE,
    ).stdout.strip()
    monkeypatch.setattr(MODULE, "PRODUCTION_STATE_ROOT", repository)
    node = (os.environ.get("RAN_AGENT_NODE_BIN") or os.environ.get("ARCHIVE_NODE_BIN")
            or shutil.which("node"))
    if not node:
        pytest.skip("Node executable is required for candidate import closure proof")

    with MODULE.candidate_execution_closure(candidate) as closure:
        retained = closure
        assert stat.S_IMODE(closure.stat().st_mode) == 0o555
        for relative in (
            "scripts/rehearse-core-schedule-migration.mjs",
            "scripts/core-cutover.mjs",
            "scripts/core-s12-acceptance.mjs",
            "node_bridge/src/core/coreDb.mjs",
        ):
            target = closure / relative
            assert target.is_file() and not target.is_symlink()
            assert target.stat().st_mode & 0o222 == 0
            expected = subprocess.run(
                ["git", "-C", str(repository), "show", f"{candidate}:{relative}"],
                check=True, stdout=subprocess.PIPE,
            ).stdout
            assert target.read_bytes() == expected
        for script, expected_error in (
            ("scripts/rehearse-core-schedule-migration.mjs", "--manifest is required"),
            ("scripts/core-cutover.mjs", "--core-db is required"),
            ("scripts/core-s12-acceptance.mjs", "--mode is required"),
            ("scripts/core-wake.mjs", "CORE_WAKE_DISABLED"),
        ):
            result = subprocess.run(
                [node, str(closure / script)], text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            assert result.returncode != 0
            assert expected_error in result.stderr
            assert "ERR_MODULE_NOT_FOUND" not in result.stderr
    assert not retained.exists()


def test_p0_routes_candidate_code_against_old_or_conflicting_production_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = SCRIPT.parents[1]
    archived_candidate = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], check=True,
        text=True, stdout=subprocess.PIPE,
    ).stdout.strip()
    production = tmp_path / "old-production"
    transaction = tmp_path / "verify"
    scratch_root = tmp_path / "scratch"
    production.mkdir()
    transaction.mkdir()
    tampered = production / "scripts/core-cutover.mjs"
    tampered.parent.mkdir(parents=True)
    tampered.write_text("candidate-b-live\n")
    monkeypatch.setattr(MODULE, "PRODUCTION_STATE_ROOT", repository)

    class RoutingOperations(MODULE.ProductionOperations):
        def __init__(self, candidate: Path):
            super().__init__(SimpleNamespace(
                core_db=tmp_path / "absent-core.sqlite3",
                production_baseline="baseline", visible_binding=tmp_path / "binding.json",
                candidate="a" * 40, committed_at="2026-08-12T00:00:00Z",
                legacy_db=tmp_path / "legacy.sqlite3", state_dir=tmp_path / "state",
            ), transaction, candidate)
            self.commands: list[list[str]] = []
            self.scratch_count = 0

        def assert_candidate_binding(self): pass

        @contextmanager
        def runtime_scratch(self):
            self.scratch_count += 1
            scratch = scratch_root / str(self.scratch_count)
            scratch.mkdir(parents=True)
            try:
                yield scratch
            finally:
                shutil.rmtree(scratch)

        def run(self, command, **_kwargs):
            self.commands.append(command)
            if "reconcile-core-managed-wake.py" in command[1]:
                return {"status": "verified", "active": False, "present": False}
            return {"status": "SOURCE_VERIFY_OK" if command[0] == "bash" else "CUTOVER_VERIFY_OK"}

        def runtime_run(self, command, **_kwargs):
            self.commands.append(command)
            output = Path(command[command.index("--output") + 1])
            output.write_text('{"status":"REHEARSED","cutoverBlockers":[]}\n')
            return {"status": "REHEARSED", "cutoverBlockers": []}

    with MODULE.candidate_execution_closure(archived_candidate) as candidate:
        monkeypatch.setattr(MODULE, "PRODUCTION_STATE_ROOT", production)
        assert not (production / "scripts/rehearse-core-schedule-migration.mjs").exists()
        assert not (production / "scripts/reconcile-core-managed-wake.py").exists()
        operations = RoutingOperations(candidate)
        receipt = operations.verify()
        assert receipt["status"] == "VERIFIED"
        invoked = "\n".join(" ".join(command) for command in operations.commands)
        assert str(candidate / "scripts/bootstrap-hermes-release.sh") in invoked
        assert str(candidate / "scripts/reconcile-core-managed-wake.py") in invoked
        assert str(candidate / "scripts/rehearse-core-schedule-migration.mjs") in invoked
        assert str(candidate / "scripts/core-cutover.mjs") in invoked
        assert str(candidate / MODULE.MANAGED_WAKE_MANIFEST_PATH) in invoked
        assert str(candidate / MODULE.MIGRATION_MANIFEST_PATH) in invoked
        assert str(candidate / MODULE.SCHEDULE_MANIFEST_PATH) in invoked
        assert str(tampered) not in invoked
        assert all("--apply" not in command for command in operations.commands)


def test_s12_git_observation_disables_optional_locks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed = []
    monkeypatch.setattr(MODULE.subprocess, "run", lambda command, **kwargs: (
        observed.append((command, kwargs["env"]))
        or SimpleNamespace(stdout="", stderr="", returncode=0)
    ))
    operations = MODULE.ProductionOperations(SimpleNamespace(), tmp_path, tmp_path / "candidate")
    assert operations.git("status", "--porcelain") == ""
    assert observed[0][1]["GIT_OPTIONAL_LOCKS"] == "0"


def test_s12_verify_preserves_the_complete_persistent_state_vector(
    tmp_path: Path,
) -> None:
    persistent = tmp_path / "persistent"
    transaction = tmp_path / "ephemeral-verify"
    scratch = tmp_path / "ephemeral-runtime"
    for relative, payload in {
        "git/HEAD": b"baseline\n",
        "git/worktree-porcelain": b"",
        "git/origin-main": b"candidate\n",
        "git/source-candidate-refs": b"",
        "release/current-source.json": b'{"candidate":"baseline"}\n',
        "release/source-snapshots/inventory": b"accepted\n",
        "release/s12-transactions/inventory": b"empty\n",
        "core/production-db.sha256": b"absent\n",
        "config/env": b"BASE_ENV\n",
        "config/profile": b"legacy\n",
        "services/state": b"node=active python=active\n",
        "wake/state": b"absent\n",
        "effects/count": b"0\n",
    }.items():
        path = persistent / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)

    class ReadOnlyVerifyOperations(MODULE.ProductionOperations):
        def __init__(self):
            super().__init__(SimpleNamespace(core_db=tmp_path / "absent-core.sqlite3",
                                             production_baseline="baseline",
                                             visible_binding=tmp_path / "binding.json",
                                             candidate="a" * 40,
                                             committed_at="2026-08-12T00:00:00Z"),
                             transaction, tmp_path / "candidate")
            self.source_modes: list[str] = []

        def assert_candidate_binding(self): pass
        def source(self, mode: str, snapshot: str | None = None):
            self.source_modes.append(mode)
            return {"status": "SOURCE_VERIFY_OK"}
        def marker(self): return None
        def wake(self, mode: str, **_kwargs): return {"active": False, "present": False}
        @contextmanager
        def runtime_scratch(self):
            scratch.mkdir()
            try:
                yield scratch
            finally:
                for path in sorted(scratch.rglob("*"), reverse=True):
                    path.unlink() if path.is_file() else path.rmdir()
                scratch.rmdir()
        def rehearse(self, core_db: Path | None, output: Path):
            assert core_db is not None and core_db.parent == scratch
            core_db.write_bytes(b"ephemeral sqlite")
            MODULE.atomic_json(output, {"status": "REHEARSED"})
            return {"status": "REHEARSED"}
        def run(self, _command, **_kwargs): return {"status": "CUTOVER_VERIFY_OK"}

    transaction.mkdir()
    operations = ReadOnlyVerifyOperations()
    before = tree_digest(persistent)
    receipt = operations.verify()
    assert receipt["status"] == "VERIFIED"
    assert operations.source_modes == ["verify"]
    assert tree_digest(persistent) == before
    assert not scratch.exists()


def test_core_handoff_env_is_replay_safe_and_quiescence_is_bounded() -> None:
    original = b"SECRET=keep\nRAN_AGENT_CORE_ENABLED=false\nRAN_AGENT_S12_INGRESS_QUIESCED=true\n"
    quiesced = MODULE.ProductionOperations.patch_env(original, ingress_quiesced=True).decode()
    assert quiesced.count("RAN_AGENT_CORE_ENABLED=true") == 1
    assert quiesced.count("RAN_AGENT_CORE_WAKE_ENABLED=true") == 1
    assert quiesced.count("RAN_AGENT_S12_INGRESS_QUIESCED=true") == 1
    active = MODULE.ProductionOperations.patch_env(quiesced.encode(), ingress_quiesced=False).decode()
    assert "RAN_AGENT_S12_INGRESS_QUIESCED" not in active
    assert "SECRET=keep" in active


def test_worker_status_rejects_zero_or_duplicate_node_writers(monkeypatch: pytest.MonkeyPatch) -> None:
    operations = MODULE.ProductionOperations(
        SimpleNamespace(), Path("/transaction"), Path("/candidate"),
    )
    monkeypatch.setattr(operations, "main_pid", lambda unit: 11 if "node" in unit else 12)
    monkeypatch.setattr(operations, "process_env", lambda _pid: {"RAN_AGENT_CORE_ENABLED": "true"})
    for writers in ([], [11, 13]):
        monkeypatch.setattr(operations, "node_writer_pids", lambda value=writers: value)
        with pytest.raises(MODULE.S12Error, match="exactly one work-producing writer"):
            operations.activate_worker_status()
    monkeypatch.setattr(operations, "node_writer_pids", lambda: [11])
    assert operations.activate_worker_status()["workProducingWriters"] == 1


def test_visible_binding_input_is_owner_only_regular_and_digest_bound(tmp_path: Path) -> None:
    binding = tmp_path / "visible-binding.json"
    binding.write_text('{"bindingId":"owner"}\n')
    binding.chmod(0o600)
    assert MODULE.protected_file_digest(binding).startswith("sha256:")
    binding.chmod(0o644)
    with pytest.raises(MODULE.S12Error, match="identity/mode/link count"):
        MODULE.protected_file_digest(binding)
