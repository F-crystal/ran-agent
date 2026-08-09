from __future__ import annotations

import importlib.util
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
