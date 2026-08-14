from __future__ import annotations

import importlib.util
import json
import os
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "reconcile-core-managed-wake.py"
SPEC = importlib.util.spec_from_file_location("core_managed_wake_reconcile", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

WAKE_BYTES = b"#!/bin/sh\nexit 0\n"


def make_args(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str = "verify", *, target: bool = True,
) -> tuple[Namespace, dict[str, object], Path, Path]:
    home = tmp_path / "home"
    profile_home = home / "profiles/ran-agent-companion"
    manifest = tmp_path / "repo/docs/governance/core_managed_wake.v1.json"
    source = tmp_path / "repo/hermes/profile/scripts/core-wake.sh"
    script_target = profile_home / "scripts/core-wake.sh"
    source.parent.mkdir(parents=True)
    source.write_bytes(WAKE_BYTES)
    job = {
        "name": "ran-agent-core-wake", "schedule": "every 1m", "repeat": "forever",
        "script": "core-wake.sh",
        "scriptTarget": str(script_target), "scriptSource": MODULE.WAKE_SCRIPT_SOURCE,
        "workdir": "/opt/ran_agent", "no_agent": True, "deliver": "local",
        "enabled": False, "state": "paused",
        "pauseReason": "awaiting-owner-s12-production-authorization",
    }
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({
        "schemaVersion": 1, "status": "CURRENT",
        "runtime": {
            "provider": "hermes-cron", "home": str(home),
            "profile": "ran-agent-companion", "scriptTimeoutSeconds": 30,
        },
        "job": job,
    }))
    if target:
        script_target.parent.mkdir(parents=True)
        script_target.write_bytes(WAKE_BYTES)
        script_target.chmod(0o755)
    monkeypatch.setattr(MODULE, "SUPPORTED_HOME", home)
    monkeypatch.setattr(MODULE.pwd, "getpwnam", lambda _name: SimpleNamespace(
        pw_uid=os.getuid(), pw_gid=os.getgid(),
    ))
    return Namespace(
        manifest=manifest, hermes_home=home, hermes_bin=tmp_path / "hermes",
        mode=mode, core_db=tmp_path / "core.sqlite3", expect_active=False,
    ), job, profile_home, script_target


def stored_job(desired: dict[str, object], *, active: bool = False, completed: int = 0) -> dict[str, object]:
    return {
        "id": "job-1", "name": desired["name"], "schedule_display": desired["schedule"],
        "repeat": {"times": None, "completed": completed},
        "script": desired["script"], "workdir": desired["workdir"], "deliver": "local",
        "no_agent": True, "state": "scheduled" if active else "paused", "enabled": active,
        **({"next_run_at": "later"} if active else {}),
    }


def write_jobs(home: Path, jobs: list[dict[str, object]]) -> None:
    cron = home / "cron"
    cron.mkdir(parents=True, exist_ok=True)
    (cron / "jobs.json").write_text(json.dumps({"jobs": jobs}))


@pytest.mark.parametrize("profile", [None, "wrong-profile"])
def test_manifest_missing_or_wrong_profile_fails_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, profile: str | None,
) -> None:
    value, _desired, _profile_home, _target = make_args(tmp_path, monkeypatch)
    manifest = json.loads(value.manifest.read_text())
    if profile is None:
        del manifest["runtime"]["profile"]
    else:
        manifest["runtime"]["profile"] = profile
    value.manifest.write_text(json.dumps(manifest))
    with pytest.raises(MODULE.ReconcileError, match="manifest is invalid"):
        MODULE.reconcile(value)


def test_plain_verify_reads_only_profile_store_and_ignores_root_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, target=False)
    write_jobs(value.hermes_home, [stored_job(desired, active=True)])
    before = (value.hermes_home / "cron/jobs.json").read_bytes()
    monkeypatch.setattr(MODULE, "run_hermes", lambda *_args: pytest.fail("verify mutated cron"))

    assert MODULE.reconcile(value) == {"status": "verified", "present": False, "active": False}
    assert (value.hermes_home / "cron/jobs.json").read_bytes() == before


def test_exact_profile_store_job_satisfies_active_verifier(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, profile_home, _target = make_args(tmp_path, monkeypatch)
    value.expect_active = True
    write_jobs(profile_home, [stored_job(desired, active=True)])
    assert MODULE.reconcile(value) == {"status": "verified", "present": True, "active": True}


def test_job_metadata_still_rejects_multiple_or_wrong_state() -> None:
    desired = {"name": "wake", "schedule": "every 1m", "script": "wake.sh", "workdir": "/x", "deliver": "local"}
    job = stored_job(desired)
    assert MODULE.inspect_job([job], desired, active=False) == job
    with pytest.raises(MODULE.ReconcileError):
        MODULE.inspect_job([job, dict(job, id="job-2")], desired, active=False)
    with pytest.raises(MODULE.ReconcileError):
        MODULE.inspect_job([dict(job, enabled=True, state="scheduled")], desired, active=False)


@pytest.mark.parametrize("mode", ["prepare", "activate", "active-verify"])
def test_prepare_activate_and_active_verify_require_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mode: str,
) -> None:
    value, _desired, _profile_home, _target = make_args(
        tmp_path, monkeypatch, "verify" if mode == "active-verify" else mode, target=False,
    )
    value.expect_active = mode == "active-verify"
    with pytest.raises(MODULE.ReconcileError, match="target is absent"):
        MODULE.reconcile(value)


@pytest.mark.parametrize("defect", ["symlink", "bytes", "mode", "owner", "group"])
def test_target_validation_rejects_identity_and_content_defects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, defect: str,
) -> None:
    value, desired, _profile_home, target = make_args(tmp_path, monkeypatch)
    if defect == "symlink":
        target.unlink()
        target.symlink_to(tmp_path / "repo/hermes/profile/scripts/core-wake.sh")
    elif defect == "bytes":
        target.write_bytes(b"wrong\n")
    elif defect == "mode":
        target.chmod(0o644)
    else:
        monkeypatch.setattr(MODULE.pwd, "getpwnam", lambda _name: SimpleNamespace(
            pw_uid=os.getuid() + (defect == "owner"), pw_gid=os.getgid() + (defect == "group"),
        ))
    with pytest.raises(MODULE.ReconcileError):
        MODULE.verify_wake_script(value.manifest, desired)


def test_remove_keeps_cutover_safety_without_requiring_script_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "remove", target=False)
    stores = iter([[stored_job(desired)], []])
    commands = []
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    monkeypatch.setattr(MODULE, "assert_no_cutover", lambda _db: None)
    monkeypatch.setattr(MODULE, "run_hermes", lambda _binary, _home, _profile, *command: commands.append(command))
    assert MODULE.reconcile(value)["status"] == "removed"
    assert commands == [("remove", "job-1")]


def test_activation_replay_accepts_exact_active_profile_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "activate")
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: [stored_job(desired, active=True)])
    monkeypatch.setattr(MODULE, "assert_cutover", lambda _db: None)
    monkeypatch.setattr(MODULE, "run_hermes", lambda *_args: pytest.fail("active wake resumed twice"))
    assert MODULE.reconcile(value)["status"] == "already_active"


@pytest.mark.parametrize("repeat", [None, "3", 1])
def test_manifest_missing_or_wrong_repeat_fails_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, repeat: object,
) -> None:
    value, _desired, _profile_home, _target = make_args(tmp_path, monkeypatch)
    manifest = json.loads(value.manifest.read_text())
    if repeat is None:
        del manifest["job"]["repeat"]
    else:
        manifest["job"]["repeat"] = repeat
    value.manifest.write_text(json.dumps(manifest))
    with pytest.raises(MODULE.ReconcileError, match="manifest is invalid"):
        MODULE.reconcile(value)


@pytest.mark.parametrize("active", [False, True])
@pytest.mark.parametrize("repeat", [
    {"times": 1, "completed": 0},
    {"completed": 0},
    {"times": None},
    {"times": None, "completed": True},
])
def test_incomplete_or_bounded_repeat_never_satisfies_verification(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, repeat: dict[str, object], active: bool,
) -> None:
    value, desired, profile_home, _target = make_args(tmp_path, monkeypatch)
    value.expect_active = active
    job = stored_job(desired, active=active)
    job["repeat"] = repeat
    write_jobs(profile_home, [job])
    with pytest.raises(MODULE.ReconcileError, match="not in expected"):
        MODULE.reconcile(value)


def test_forever_repeat_with_completed_executions_still_verifies(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, profile_home, _target = make_args(tmp_path, monkeypatch)
    value.expect_active = True
    write_jobs(profile_home, [stored_job(desired, active=True, completed=5)])
    assert MODULE.reconcile(value) == {"status": "verified", "present": True, "active": True}


def test_prepare_converges_a_missing_times_repeat_with_exactly_one_edit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "prepare")
    drifted = {**stored_job(desired), "id": "job-5", "repeat": {"completed": 0}}
    converged = {**stored_job(desired), "id": "job-5"}
    stores = iter([[drifted], [converged]])
    commands = []
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    monkeypatch.setattr(MODULE, "run_hermes", lambda _binary, _home, _profile, *command: commands.append(command))
    assert MODULE.reconcile(value) == {"status": "prepared", "jobId": "job-5", "active": False}
    assert commands == [("edit", "job-5", "--schedule", "every 1m", "--repeat", "0")]


def test_prepare_creates_paused_forever_job_through_crash_safe_staging(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "prepare")
    created = {
        **stored_job(desired), "id": "job-9",
        "schedule_display": "once at 2099-01-01 00:00", "repeat": {"times": 1, "completed": 0},
    }
    converged = {**stored_job(desired), "id": "job-9"}
    stores = iter([[], [created], [converged]])
    commands = []
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    monkeypatch.setattr(MODULE, "run_hermes", lambda _binary, _home, _profile, *command: commands.append(command))
    assert MODULE.reconcile(value) == {"status": "prepared", "jobId": "job-9", "active": False}
    assert commands == [
        ("create", "2099-01-01T00:00", "--name", "ran-agent-core-wake",
         "--deliver", "local", "--script", "core-wake.sh",
         "--no-agent", "--workdir", "/opt/ran_agent", "--repeat", "0"),
        ("pause", "job-9"),
        ("edit", "job-9", "--schedule", "every 1m", "--repeat", "0"),
    ]


def test_prepare_converges_completed_job_in_place_and_activate_resumes_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "prepare")
    completed_fingerprint = {
        **stored_job(desired, completed=1), "id": "job-7",
        "state": "completed", "enabled": False, "next_run_at": None,
        "repeat": {"times": 1, "completed": 1},
    }
    paused = {**completed_fingerprint, "state": "paused", "repeat": {"times": None, "completed": 1}}
    active = {**paused, "state": "scheduled", "enabled": True, "next_run_at": "later"}
    monkeypatch.setattr(MODULE, "assert_cutover", lambda _db: None)
    commands = []
    monkeypatch.setattr(MODULE, "run_hermes", lambda _binary, _home, _profile, *command: commands.append(command))

    stores = iter([[completed_fingerprint], [paused]])
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    assert MODULE.reconcile(value) == {"status": "prepared", "jobId": "job-7", "active": False}
    assert commands == [
        ("pause", "job-7"),
        ("edit", "job-7", "--schedule", "every 1m", "--repeat", "0"),
    ]

    value.mode = "activate"
    commands.clear()
    stores = iter([[paused], [active]])
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    assert MODULE.reconcile(value) == {"status": "activated", "jobId": "job-7", "active": True}
    assert commands == [("resume", "job-7")]


def test_prepare_is_a_bounded_noop_for_the_exact_paused_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    value, desired, _profile_home, _target = make_args(tmp_path, monkeypatch, "prepare")
    job = stored_job(desired)
    stores = iter([[job], [job]])
    monkeypatch.setattr(MODULE, "load_jobs", lambda _home: next(stores))
    monkeypatch.setattr(
        MODULE, "run_hermes",
        lambda *_args: pytest.fail("exact paused job must not be mutated"),
    )
    assert MODULE.reconcile(value) == {"status": "prepared", "jobId": "job-1", "active": False}


def test_wake_script_owns_exact_minimal_environment() -> None:
    script = (Path(__file__).parents[1] / "hermes/profile/scripts/core-wake.sh").read_text(encoding="utf-8")
    assert script == (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "\n"
        "export RAN_AGENT_STATE_DIR=/opt/ran_agent/.ran_agent_state\n"
        "export RAN_AGENT_CORE_WAKE_ENABLED=true\n"
        "\n"
        "exec /opt/nodejs/node-v22.22.2-linux-x64/bin/node /opt/ran_agent/scripts/core-wake.mjs\n"
    )


def test_hermes_mutation_uses_exact_profile_context(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    calls = []
    monkeypatch.setattr(MODULE.subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs)))
    binary, home = tmp_path / "hermes", tmp_path / "home"
    MODULE.run_hermes(binary, home, "ran-agent-companion", "remove", "job-1")
    assert calls == [([
        "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
        "HOME=/home/ubuntu", f"HERMES_HOME={home}", "PATH=/usr/bin:/bin",
        str(binary), "-p", "ran-agent-companion", "cron", "remove", "job-1",
    ], {"check": True})]
