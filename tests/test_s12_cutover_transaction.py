from __future__ import annotations

import importlib.util
import json
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

    def _call(self, name: str, result: dict[str, object] | None = None):
        self.calls.append(name)
        if self.fail == name:
            raise MODULE.S12Error(f"failed:{name}")
        return result or {"status": name}

    def marker(self):
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


@pytest.mark.parametrize("phase", MODULE.PHASES[:5])
def test_each_pre_marker_failure_restores_source_authority(tmp_path: Path, phase: str) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="injected failure"):
        MODULE.run_apply(operations, state, fail_after=phase)
    assert state.state["status"] == "ROLLED_BACK"
    expected_snapshot = None if phase == "P0_VERIFIED" else "/source/snapshot"
    assert operations.calls[-1] == f"rollback:{expected_snapshot}"
    assert operations.committed is False


def test_failure_immediately_before_core_commit_rolls_back(tmp_path: Path) -> None:
    operations = FakeOperations()
    operations.fail = "cutover"
    state = journal(tmp_path)
    with pytest.raises(MODULE.S12Error, match="failed:cutover"):
        MODULE.run_apply(operations, state)
    assert state.state["status"] == "ROLLED_BACK"
    assert operations.calls[-1] == "rollback:/source/snapshot"


def test_crash_after_source_commit_recovers_the_exact_snapshot_before_continuing(tmp_path: Path) -> None:
    operations = FakeOperations()
    state = journal(tmp_path)
    state.complete("P0_VERIFIED", lastReceipt={"status": "VERIFIED"})
    operations.recovered_source = {
        "status": "SOURCE_APPLIED_RECOVERED", "snapshot": "/source/recovered",
    }
    MODULE.run_apply(operations, state)
    assert state.state["phaseReceipts"]["P1_SOURCE_APPLIED"]["snapshot"] == "/source/recovered"
    assert state.state["sourceSnapshot"] == "/source/recovered"
    assert "source_apply" not in operations.calls


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
    ), tmp_path / "transaction")
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
    calls = list(operations.calls)
    second = MODULE.run_apply(operations, state)
    assert first == second
    assert operations.calls == calls


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
    operations = MODULE.ProductionOperations(SimpleNamespace(), Path("/transaction"))
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
