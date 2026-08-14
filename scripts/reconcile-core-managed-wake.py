#!/usr/bin/env python3
"""Prepare or activate the single Hermes no-agent Core wake job."""

from __future__ import annotations

import argparse
import json
import pwd
import sqlite3
import stat
import subprocess
from pathlib import Path


class ReconcileError(RuntimeError):
    pass


SUPPORTED_HOME = Path("/home/ubuntu/.hermes-ran-agent/lite")
SUPPORTED_PROFILE = "ran-agent-companion"
WAKE_SCRIPT_SOURCE = "hermes/profile/scripts/core-wake.sh"


def desired_contract(manifest: object) -> tuple[Path, str, dict[str, object]]:
    if not isinstance(manifest, dict):
        raise ReconcileError("managed wake manifest is invalid")
    runtime = manifest.get("runtime")
    job = manifest.get("job")
    target = SUPPORTED_HOME / f"profiles/{SUPPORTED_PROFILE}/scripts/core-wake.sh"
    expected_job = {
        "name": "ran-agent-core-wake",
        "schedule": "every 1m",
        "repeat": "forever",
        "script": "core-wake.sh",
        "scriptTarget": str(target),
        "scriptSource": WAKE_SCRIPT_SOURCE,
        "workdir": "/opt/ran_agent",
        "no_agent": True,
        "deliver": "local",
        "enabled": False,
        "state": "paused",
        "pauseReason": "awaiting-owner-s12-production-authorization",
    }
    if (
        set(manifest) != {"schemaVersion", "status", "runtime", "job"}
        or manifest.get("schemaVersion") != 1
        or manifest.get("status") != "CURRENT"
        or not isinstance(runtime, dict)
        or set(runtime) != {"provider", "home", "profile", "scriptTimeoutSeconds"}
        or runtime != {
            "provider": "hermes-cron", "home": str(SUPPORTED_HOME),
            "profile": SUPPORTED_PROFILE, "scriptTimeoutSeconds": 30,
        }
        or not isinstance(job, dict)
        or job != expected_job
    ):
        raise ReconcileError("managed wake manifest is invalid")
    return SUPPORTED_HOME, SUPPORTED_PROFILE, job


def verify_wake_script(manifest_path: Path, desired: dict[str, object]) -> None:
    source = manifest_path.resolve().parents[2] / str(desired["scriptSource"])
    target = Path(str(desired["scriptTarget"]))
    if source.is_symlink() or not source.is_file():
        raise ReconcileError("managed wake script source is absent")
    if target.is_symlink() or not target.is_file():
        raise ReconcileError("managed wake script target is absent")
    value = target.stat()
    account = pwd.getpwnam("ubuntu")
    if (
        value.st_uid != account.pw_uid or value.st_gid != account.pw_gid
        or stat.S_IMODE(value.st_mode) != 0o755
        or target.read_bytes() != source.read_bytes()
    ):
        raise ReconcileError("managed wake script target is invalid")


def load_jobs(home: Path) -> list[dict[str, object]]:
    path = home / "cron" / "jobs.json"
    if not path.exists():
        return []
    stored = json.loads(path.read_text(encoding="utf-8-sig"))
    jobs = stored.get("jobs", []) if isinstance(stored, dict) else stored
    if not isinstance(jobs, list) or not all(isinstance(item, dict) for item in jobs):
        raise ReconcileError("Hermes cron store is invalid")
    return jobs


def forever_repeat(job: dict[str, object]) -> bool:
    """Stored pinned-runtime shape of the manifest's ``repeat: "forever"`` contract."""
    repeat = job.get("repeat")
    if not isinstance(repeat, dict):
        return False
    if "times" not in repeat or "completed" not in repeat:
        return False
    completed = repeat["completed"]
    return (
        repeat["times"] is None
        and isinstance(completed, int)
        and not isinstance(completed, bool)
        and completed >= 0
    )


def inspect_job(jobs: list[dict[str, object]], desired: dict[str, object], *, active: bool) -> dict[str, object] | None:
    if not jobs:
        return None
    if len(jobs) != 1 or jobs[0].get("name") != desired.get("name"):
        raise ReconcileError("Hermes cron must contain only the managed Core wake job")
    job = jobs[0]
    deliver = job.get("deliver")
    if isinstance(deliver, list):
        deliver = deliver[0] if len(deliver) == 1 else None
    expected_state = "scheduled" if active else "paused"
    expected_enabled = active
    valid = (
        job.get("schedule_display") == desired.get("schedule")
        and forever_repeat(job)
        and job.get("script") == desired.get("script")
        and job.get("workdir") == desired.get("workdir")
        and job.get("no_agent") is True
        and deliver == desired.get("deliver")
        and job.get("state") == expected_state
        and job.get("enabled") is expected_enabled
    )
    if active:
        valid = valid and bool(job.get("next_run_at"))
    if not valid:
        raise ReconcileError(f"managed Core wake job is not in expected {expected_state} state")
    return job


def run_hermes(binary: Path, home: Path, profile: str, *args: str) -> None:
    subprocess.run([
        "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
        "HOME=/home/ubuntu", f"HERMES_HOME={home}", "PATH=/usr/bin:/bin",
        str(binary), "-p", profile, "cron", *args,
    ], check=True)


def assert_cutover(core_db: Path) -> None:
    with sqlite3.connect(f"file:{core_db}?mode=ro", uri=True) as database:
        row = database.execute(
            "SELECT 1 FROM journal_event WHERE journal_event_id='core-cutover:v1' "
            "AND event_type='core_cutover_committed_at' AND source_kind='core-cutover:v1'"
        ).fetchone()
    if row is None:
        raise ReconcileError("Core cutover marker is absent")


def assert_no_cutover(core_db: Path | None) -> None:
    if core_db is None or not core_db.exists():
        return
    with sqlite3.connect(f"file:{core_db}?mode=ro", uri=True) as database:
        row = database.execute(
            "SELECT 1 FROM journal_event WHERE journal_event_id='core-cutover:v1'"
        ).fetchone()
    if row is not None:
        raise ReconcileError("managed Core wake cannot be removed after cutover")


def reconcile(args: argparse.Namespace) -> dict[str, object]:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    home, profile, desired = desired_contract(manifest)
    if args.hermes_home != home:
        raise ReconcileError("--hermes-home differs from the managed wake manifest")
    store_home = home / "profiles" / profile
    if args.mode in {"prepare", "activate"} or (args.mode == "verify" and args.expect_active):
        verify_wake_script(args.manifest, desired)
    jobs = load_jobs(store_home)
    if args.mode == "verify":
        job = inspect_job(jobs, desired, active=args.expect_active)
        return {"status": "verified", "present": job is not None,
                "active": job is not None and args.expect_active}
    if args.mode == "prepare":
        if not jobs:
            run_hermes(
                args.hermes_bin, home, profile,
                "create", "2099-01-01T00:00", "--name", str(desired["name"]),
                "--deliver", str(desired["deliver"]), "--script", str(desired["script"]),
                "--no-agent", "--workdir", str(desired["workdir"]), "--repeat", "0",
            )
            created = load_jobs(store_home)
            if len(created) != 1 or created[0].get("name") != desired.get("name"):
                raise ReconcileError("Hermes did not create exactly one managed wake job")
            job_id = str(created[0]["id"])
            run_hermes(args.hermes_bin, home, profile, "pause", job_id)
            run_hermes(args.hermes_bin, home, profile, "edit", job_id,
                       "--schedule", str(desired["schedule"]), "--repeat", "0")
        else:
            if len(jobs) != 1 or jobs[0].get("name") != desired.get("name"):
                raise ReconcileError("Hermes cron must contain only the managed Core wake job")
            job = jobs[0]
            if job.get("state") != "paused" or job.get("enabled") is not False:
                run_hermes(args.hermes_bin, home, profile, "pause", str(job["id"]))
            if not (job.get("schedule_display") == desired.get("schedule") and forever_repeat(job)):
                run_hermes(args.hermes_bin, home, profile, "edit", str(job["id"]),
                           "--schedule", str(desired["schedule"]), "--repeat", "0")
        job = inspect_job(load_jobs(store_home), desired, active=False)
        return {"status": "prepared", "jobId": str(job["id"]), "active": False}
    if args.mode == "remove":
        assert_no_cutover(args.core_db)
        job = inspect_job(jobs, desired, active=False) if jobs else None
        if job is not None:
            run_hermes(args.hermes_bin, home, profile, "remove", str(job["id"]))
        if load_jobs(store_home):
            raise ReconcileError("managed Core wake removal did not restore an empty cron store")
        return {"status": "removed", "active": False}
    if args.core_db is None:
        raise ReconcileError("activation requires --core-db")
    assert_cutover(args.core_db)
    try:
        active = inspect_job(jobs, desired, active=True)
    except ReconcileError:
        active = None
    if active is not None:
        return {"status": "already_active", "jobId": str(active["id"]), "active": True}
    job = inspect_job(jobs, desired, active=False)
    if job is None:
        raise ReconcileError("managed wake job must be prepared before activation")
    run_hermes(args.hermes_bin, home, profile, "resume", str(job["id"]))
    active = inspect_job(load_jobs(store_home), desired, active=True)
    return {"status": "activated", "jobId": str(active["id"]), "active": True}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("verify", "prepare", "activate", "remove"), default="verify")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--hermes-home", type=Path, required=True)
    parser.add_argument("--hermes-bin", type=Path, required=True)
    parser.add_argument("--core-db", type=Path)
    parser.add_argument("--expect-active", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        print(json.dumps(reconcile(parse_args()), sort_keys=True))
    except (OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError, ReconcileError) as error:
        print(json.dumps({"status": "failed", "errorClass": type(error).__name__}, sort_keys=True))
        raise SystemExit(1) from None
