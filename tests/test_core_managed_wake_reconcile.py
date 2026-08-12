from __future__ import annotations

import importlib.util
from argparse import Namespace
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "reconcile-core-managed-wake.py"
SPEC = importlib.util.spec_from_file_location("core_managed_wake_reconcile", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

DESIRED = {
    "name": "ran-agent-core-wake",
    "schedule": "every 1m",
    "script": "core-wake.sh",
    "workdir": "/opt/ran_agent",
    "deliver": "local",
}


def test_managed_job_accepts_only_one_exact_paused_projection() -> None:
    job = {
        "id": "job-1", "name": DESIRED["name"], "schedule_display": DESIRED["schedule"],
        "script": DESIRED["script"], "workdir": DESIRED["workdir"], "deliver": "local",
        "no_agent": True, "state": "paused", "enabled": False,
    }
    assert MODULE.inspect_job([job], DESIRED, active=False) == job
    with pytest.raises(MODULE.ReconcileError):
        MODULE.inspect_job([job, dict(job, id="job-2")], DESIRED, active=False)
    with pytest.raises(MODULE.ReconcileError):
        MODULE.inspect_job([dict(job, enabled=True, state="scheduled")], DESIRED, active=False)


def test_active_projection_rejects_zero_or_two_work_producing_clocks() -> None:
    job = {
        "id": "job-1", "name": DESIRED["name"], "schedule_display": DESIRED["schedule"],
        "script": DESIRED["script"], "workdir": DESIRED["workdir"], "deliver": "local",
        "no_agent": True, "state": "scheduled", "enabled": True, "next_run_at": "later",
    }
    assert MODULE.inspect_job([], DESIRED, active=True) is None
    with pytest.raises(MODULE.ReconcileError):
        MODULE.inspect_job([job, dict(job, id="job-2")], DESIRED, active=True)


def test_active_verify_does_not_false_green_an_absent_clock(tmp_path: Path) -> None:
    value = args(tmp_path, "verify")
    value.expect_active = True
    assert MODULE.reconcile(value) == {
        "status": "verified", "present": False, "active": False,
    }


def args(tmp_path: Path, mode: str) -> Namespace:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"schemaVersion":1,"job":' + __import__("json").dumps(DESIRED) + "}")
    return Namespace(
        manifest=manifest, hermes_home=tmp_path / "home", hermes_bin=tmp_path / "hermes",
        mode=mode, core_db=tmp_path / "core.sqlite3", expect_active=False,
    )


def test_pre_cutover_remove_deletes_only_the_exact_paused_managed_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job = {
        "id": "job-1", "name": DESIRED["name"], "schedule_display": DESIRED["schedule"],
        "script": DESIRED["script"], "workdir": DESIRED["workdir"], "deliver": "local",
        "no_agent": True, "state": "paused", "enabled": False,
    }
    stores = iter([[job], []])
    commands = []
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    monkeypatch.setattr(MODULE, "assert_no_cutover", lambda _db: None)
    monkeypatch.setattr(MODULE, "run_hermes", lambda _binary, _home, *command: commands.append(command))
    assert MODULE.reconcile(args(tmp_path, "remove"))["status"] == "removed"
    assert commands == [("remove", "job-1")]


def test_activation_replay_accepts_the_already_active_exact_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job = {
        "id": "job-1", "name": DESIRED["name"], "schedule_display": DESIRED["schedule"],
        "script": DESIRED["script"], "workdir": DESIRED["workdir"], "deliver": "local",
        "no_agent": True, "state": "scheduled", "enabled": True, "next_run_at": "later",
    }
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: [job])
    monkeypatch.setattr(MODULE, "assert_cutover", lambda _db: None)
    monkeypatch.setattr(MODULE, "run_hermes", lambda *_args: pytest.fail("active wake must not be resumed twice"))
    assert MODULE.reconcile(args(tmp_path, "activate"))["status"] == "already_active"


def test_hermes_mutation_uses_the_governed_runtime_identity_and_exact_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    calls = []
    monkeypatch.setattr(MODULE.subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs)))
    binary = tmp_path / "hermes"
    home = tmp_path / "home"
    MODULE.run_hermes(binary, home, "remove", "job-1")
    assert calls == [([
        "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
        "HOME=/home/ubuntu", f"HERMES_HOME={home}", "PATH=/usr/bin:/bin",
        str(binary), "cron", "remove", "job-1",
    ], {"check": True})]
