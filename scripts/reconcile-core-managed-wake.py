#!/usr/bin/env python3
"""Prepare or activate the single Hermes no-agent Core wake job."""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
from pathlib import Path


class ReconcileError(RuntimeError):
    pass


def load_jobs(home: Path) -> list[dict[str, object]]:
    path = home / "cron" / "jobs.json"
    if not path.exists():
        return []
    stored = json.loads(path.read_text(encoding="utf-8-sig"))
    jobs = stored.get("jobs", []) if isinstance(stored, dict) else stored
    if not isinstance(jobs, list) or not all(isinstance(item, dict) for item in jobs):
        raise ReconcileError("Hermes cron store is invalid")
    return jobs


def desired_job(manifest: dict[str, object]) -> dict[str, object]:
    job = manifest.get("job")
    if manifest.get("schemaVersion") != 1 or not isinstance(job, dict):
        raise ReconcileError("managed wake manifest is invalid")
    return job


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


def run_hermes(binary: Path, home: Path, *args: str) -> None:
    subprocess.run([
        "/usr/sbin/runuser", "-u", "ubuntu", "--", "/usr/bin/env", "-i",
        "HOME=/home/ubuntu", f"HERMES_HOME={home}", "PATH=/usr/bin:/bin",
        str(binary), "cron", *args,
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
    desired = desired_job(manifest)
    jobs = load_jobs(args.hermes_home)
    if args.mode == "verify":
        job = inspect_job(jobs, desired, active=args.expect_active)
        return {"status": "verified", "present": job is not None,
                "active": job is not None and args.expect_active}
    if args.mode == "prepare":
        existing = inspect_job(jobs, desired, active=False) if jobs else None
        if existing is None:
            run_hermes(
                args.hermes_bin, args.hermes_home,
                "create", "2099-01-01T00:00", "--name", str(desired["name"]),
                "--deliver", str(desired["deliver"]), "--script", str(desired["script"]),
                "--no-agent", "--workdir", str(desired["workdir"]),
            )
            created = load_jobs(args.hermes_home)
            if len(created) != 1 or created[0].get("name") != desired.get("name"):
                raise ReconcileError("Hermes did not create exactly one managed wake job")
            job_id = str(created[0]["id"])
            run_hermes(args.hermes_bin, args.hermes_home, "pause", job_id)
            run_hermes(args.hermes_bin, args.hermes_home, "edit", job_id, "--schedule", str(desired["schedule"]))
        job = inspect_job(load_jobs(args.hermes_home), desired, active=False)
        return {"status": "prepared", "jobId": str(job["id"]), "active": False}
    if args.mode == "remove":
        assert_no_cutover(args.core_db)
        job = inspect_job(jobs, desired, active=False) if jobs else None
        if job is not None:
            run_hermes(args.hermes_bin, args.hermes_home, "remove", str(job["id"]))
        if load_jobs(args.hermes_home):
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
    run_hermes(args.hermes_bin, args.hermes_home, "resume", str(job["id"]))
    active = inspect_job(load_jobs(args.hermes_home), desired, active=True)
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
