from __future__ import annotations

import logging
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.durable_jobs import (
    DurableJobConflict,
    DurableJobDispatcher,
    DurableJobOutcome,
    DurableJobStore,
)
from personal_agent.scheduler import create_scheduler


UTC = timezone.utc


@pytest.fixture()
def jobs(tmp_path: Path) -> tuple[DurableJobStore, Database]:
    database = Database(make_test_config(tmp_path), logging.getLogger("test.durable_jobs"))
    database.initialize()
    return DurableJobStore(database), database


def test_create_query_and_active_dedup_return_an_immutable_receipt(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "a" * 32,
        goal_digest="b" * 64,
        next_run_at=due,
        now=due - timedelta(minutes=1),
    )
    duplicate = store.create_job(
        actor_key=created.actor_key,
        goal_digest=created.goal_digest,
        next_run_at=due + timedelta(hours=1),
        now=due,
    )

    assert duplicate.job_id == created.job_id
    assert store.get_job(created.job_id) == created
    assert store.query_active_job(created.actor_key, created.goal_digest) == created
    receipt = created.receipt()
    assert receipt.status == "active"
    assert receipt.next_run_at == created.next_run_at
    assert receipt.terminal_states == ("completed", "blocked", "stopped", "expired")
    with pytest.raises(FrozenInstanceError):
        receipt.status = "completed"  # type: ignore[misc]


def test_crash_before_row_commit_leaves_no_job_truth_after_restart(jobs) -> None:
    store, database = jobs
    now = datetime(2026, 7, 10, 10, 0, tzinfo=UTC).isoformat().replace("+00:00", "Z")
    with database.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO durable_jobs (
                job_id, actor_key, goal_digest, state, next_run_at,
                lease_owner, lease_until, revision, terminal_state,
                result_ref, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, '', '', 0, '', '', ?, ?)
            """,
            ("job_uncommitted", "actor:" + "c" * 32, "d" * 64, now, now, now),
        )
        # Process death before commit is represented by closing this connection.

    restarted = DurableJobStore(database)
    assert restarted.get_job("job_uncommitted") is None
    assert store.claim_due_jobs("worker-a", now=now) == []


def test_restart_claims_committed_first_wake_once_and_blocks_parallel_lease(jobs) -> None:
    store, database = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "e" * 32,
        goal_digest="f" * 64,
        next_run_at=due,
        now=due - timedelta(minutes=1),
    )

    restarted = DurableJobStore(database)
    [claimed] = restarted.claim_due_jobs("worker-a", now=due, lease_seconds=30)
    assert claimed.job_id == created.job_id
    assert claimed.state == "leased"
    assert claimed.lease_owner == "worker-a"
    assert claimed.revision == 1
    assert store.claim_due_jobs("worker-b", now=due + timedelta(seconds=5)) == []


def test_expired_lease_and_preterminal_crash_recover_with_new_revision(jobs) -> None:
    store, database = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "1" * 32,
        goal_digest="2" * 64,
        next_run_at=due,
        now=due,
    )
    [first_claim] = store.claim_due_jobs("worker-a", now=due, lease_seconds=10)

    # A crash before terminal CAS leaves the lease as the only transient fact.
    restarted = DurableJobStore(database)
    [reclaimed] = restarted.claim_due_jobs("worker-b", now=due + timedelta(seconds=11), lease_seconds=30)
    assert reclaimed.job_id == created.job_id
    assert reclaimed.lease_owner == "worker-b"
    assert reclaimed.revision == first_claim.revision + 1
    with pytest.raises(DurableJobConflict, match="stale job terminal"):
        restarted.finish_job(
            created.job_id,
            lease_owner="worker-a",
            expected_revision=first_claim.revision,
            terminal_state="completed",
            result_ref="outbox:stale-worker",
            now=due + timedelta(seconds=12),
        )
    assert restarted.get_job(created.job_id) == reclaimed


def test_checkpoint_uses_revision_and_stale_writer_cannot_overwrite_schedule(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "3" * 32,
        goal_digest="4" * 64,
        next_run_at=due,
        now=due,
    )
    [claimed] = store.claim_due_jobs("worker-a", now=due)
    next_wake = due + timedelta(hours=1)
    checkpoint = store.checkpoint_job(
        created.job_id,
        lease_owner="worker-a",
        expected_revision=claimed.revision,
        next_run_at=next_wake,
        now=due + timedelta(minutes=1),
    )
    assert checkpoint.state == "active"
    assert checkpoint.revision == claimed.revision + 1
    assert checkpoint.next_run_at == next_wake.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    with pytest.raises(DurableJobConflict, match="stale job checkpoint"):
        store.checkpoint_job(
            created.job_id,
            lease_owner="worker-a",
            expected_revision=claimed.revision,
            next_run_at=due + timedelta(hours=2),
            now=due + timedelta(minutes=2),
        )
    assert store.get_job(created.job_id) == checkpoint


def test_terminal_cas_is_exactly_once_idempotent_or_conflicting(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "5" * 32,
        goal_digest="6" * 64,
        next_run_at=due,
        now=due,
    )
    [claimed] = store.claim_due_jobs("worker-a", now=due)
    completed = store.finish_job(
        created.job_id,
        lease_owner="worker-a",
        expected_revision=claimed.revision,
        terminal_state="completed",
        result_ref="outbox:result-1",
        now=due + timedelta(minutes=1),
    )
    duplicate = store.finish_job(
        created.job_id,
        lease_owner="worker-a",
        expected_revision=claimed.revision,
        terminal_state="completed",
        result_ref="outbox:result-1",
        now=due + timedelta(minutes=2),
    )
    assert duplicate == completed
    assert completed.state == "terminal"
    assert completed.terminal_state == "completed"
    assert completed.receipt().status == "completed"

    with pytest.raises(DurableJobConflict, match="terminal result conflict"):
        store.finish_job(
            created.job_id,
            lease_owner="worker-a",
            expected_revision=completed.revision,
            terminal_state="blocked",
            result_ref="outbox:result-2",
            now=due + timedelta(minutes=3),
        )
    assert store.claim_due_jobs("worker-b", now=due + timedelta(days=1)) == []


def test_dispatcher_calls_explicit_handler_and_checkpoints_with_cas(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    goal = "7" * 64
    created = store.create_job(
        actor_key="actor:" + "8" * 32,
        goal_digest=goal,
        next_run_at=due,
        now=due,
    )
    handled = []

    def handler(record):
        handled.append(record)
        return DurableJobOutcome.checkpoint(due + timedelta(hours=1))

    dispatcher = DurableJobDispatcher(
        store,
        handlers={goal: handler},
        worker_id="dispatcher-a",
        logger=logging.getLogger("test.durable_jobs.dispatcher"),
    )
    [transitioned] = dispatcher.dispatch_due(now=due)

    assert handled[0].job_id == created.job_id
    assert handled[0].state == "leased"
    assert transitioned.state == "active"
    assert transitioned.revision == 2
    assert store.claim_due_jobs("other-worker", now=due + timedelta(minutes=30)) == []


def test_registered_job_kind_and_payload_ref_survive_restart_and_dispatch(jobs) -> None:
    store, database = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "0" * 32,
        goal_digest="a" * 64,
        job_kind="core.test",
        payload_ref="payload:restart-safe",
        next_run_at=due,
        now=due,
    )
    assert created.job_kind == "core.test"
    assert created.payload_ref == "payload:restart-safe"

    restarted = DurableJobDispatcher(
        DurableJobStore(database),
        handlers={},
        kind_handlers={
            "core.test": lambda record: (
                DurableJobOutcome.terminal("completed", f"job:{record.payload_ref}")
            )
        },
        worker_id="kind-dispatcher",
        logger=logging.getLogger("test.durable_jobs.kind"),
    )
    [terminal] = restarted.dispatch_due(now=due)

    assert terminal.terminal_state == "completed"
    assert terminal.result_ref == "job:payload:restart-safe"


def test_dispatcher_blocks_unknown_job_kind_instead_of_leaving_a_false_active_promise(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "b" * 32,
        goal_digest="c" * 64,
        job_kind="core.unknown",
        payload_ref="payload:unknown",
        next_run_at=due,
        now=due,
    )
    dispatcher = DurableJobDispatcher(
        store,
        handlers={},
        kind_handlers={},
        worker_id="unknown-dispatcher",
        logger=logging.getLogger("test.durable_jobs.unknown"),
    )

    [blocked] = dispatcher.dispatch_due(now=due)

    assert blocked.job_id == created.job_id
    assert blocked.terminal_state == "blocked"
    assert blocked.result_ref == "job:unregistered-handler"


def test_dispatcher_leaves_node_owned_external_activity_jobs_for_the_bridge(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    created = store.create_job(
        actor_key="actor:" + "d" * 32,
        goal_digest="e" * 64,
        job_kind="core.external-activity",
        payload_ref="activity:bridge-owned",
        next_run_at=due,
        now=due,
    )
    dispatcher = DurableJobDispatcher(
        store,
        handlers={},
        kind_handlers={},
        worker_id="core-dispatcher",
        logger=logging.getLogger("test.durable_jobs.external"),
    )

    assert dispatcher.dispatch_due(now=due) == []
    preserved = store.get_job(created.job_id)
    assert preserved is not None
    assert preserved.state == "active"
    assert preserved.terminal_state == ""
    assert preserved.revision == 0


def test_dispatcher_terminal_is_single_and_not_replayed(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    goal = "9" * 64
    created = store.create_job(
        actor_key="actor:" + "a" * 32,
        goal_digest=goal,
        next_run_at=due,
        now=due,
    )
    calls = 0

    def handler(_record):
        nonlocal calls
        calls += 1
        return DurableJobOutcome.terminal("completed", "outbox:durable-result")

    dispatcher = DurableJobDispatcher(
        store,
        handlers={goal: handler},
        worker_id="dispatcher-a",
        logger=logging.getLogger("test.durable_jobs.terminal"),
    )
    [terminal] = dispatcher.dispatch_due(now=due)
    assert terminal.job_id == created.job_id
    assert terminal.terminal_state == "completed"
    assert dispatcher.dispatch_due(now=due + timedelta(days=1)) == []
    assert calls == 1


def test_dispatcher_crash_leaves_lease_and_recovers_after_expiry(jobs) -> None:
    store, _ = jobs
    due = datetime(2026, 7, 10, 10, 0, tzinfo=UTC)
    goal = "c" * 64
    created = store.create_job(
        actor_key="actor:" + "d" * 32,
        goal_digest=goal,
        next_run_at=due,
        now=due,
    )

    def crashing_handler(_record):
        raise RuntimeError("simulated worker crash")

    crashed = DurableJobDispatcher(
        store,
        handlers={goal: crashing_handler},
        worker_id="dispatcher-crashed",
        logger=logging.getLogger("test.durable_jobs.crash"),
        lease_seconds=10,
    )
    assert crashed.dispatch_due(now=due) == []
    leased = store.get_job(created.job_id)
    assert leased is not None and leased.state == "leased"

    recovered = DurableJobDispatcher(
        store,
        handlers={goal: lambda _record: DurableJobOutcome.terminal("blocked", "job:recovered")},
        worker_id="dispatcher-recovered",
        logger=logging.getLogger("test.durable_jobs.recovered"),
    )
    assert recovered.dispatch_due(now=due + timedelta(seconds=9)) == []
    [terminal] = recovered.dispatch_due(now=due + timedelta(seconds=11))
    assert terminal.terminal_state == "blocked"
    assert terminal.revision == 3


def test_scheduler_scans_immediately_then_registers_one_store_backed_wakeup(jobs) -> None:
    store, database = jobs
    due = datetime.now(UTC) - timedelta(seconds=1)
    goal = "e" * 64
    first = store.create_job(
        actor_key="actor:" + "f" * 32,
        goal_digest=goal,
        next_run_at=due,
        now=due,
    )

    class FakeScheduler:
        def __init__(self, timezone: str) -> None:
            self.timezone = timezone
            self.jobs = []

        def add_job(self, func, trigger, id, name, replace_existing, kwargs):
            self.jobs.append({
                "func": func,
                "trigger": trigger,
                "id": id,
                "name": name,
                "replace_existing": replace_existing,
                "kwargs": kwargs,
            })

    fake = FakeScheduler(timezone="Asia/Shanghai")
    config = database.config
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("personal_agent.scheduler.BackgroundScheduler", lambda timezone: fake)
        scheduler = create_scheduler(
            config=config,
            database=database,
            message_service=object(),
            logger=logging.getLogger("test.durable_jobs.scheduler"),
            durable_job_handlers={
                goal: lambda _record: DurableJobOutcome.terminal("completed", "job:startup")
            },
            durable_worker_id="startup-dispatcher",
        )

    assert scheduler is fake
    assert store.get_job(first.job_id).terminal_state == "completed"
    wakeups = [job for job in fake.jobs if job["id"] == "durable_job_dispatch"]
    assert len(wakeups) == 1
    assert set(wakeups[0]["kwargs"]) == {"dispatcher"}

    second = store.create_job(
        actor_key=first.actor_key,
        goal_digest=goal,
        next_run_at=due,
        now=due,
    )
    wakeups[0]["func"](**wakeups[0]["kwargs"])
    assert store.get_job(second.job_id).terminal_state == "completed"


def test_scheduler_uses_registered_core_kind_handler_after_restart(jobs) -> None:
    store, database = jobs
    due = datetime.now(UTC) - timedelta(seconds=1)
    created = store.create_job(
        actor_key="actor:" + "f" * 32,
        goal_digest="1" * 64,
        job_kind="core.memory-maintenance",
        payload_ref="payload:maintenance",
        next_run_at=due,
        now=due,
    )

    class FakeScheduler:
        def add_job(self, *args, **kwargs):
            del args, kwargs

    class FakeMemorySpecialist:
        calls = 0

        def execute_background_maintenance(self):
            self.calls += 1
            return {"status": "completed"}

    class FakeService:
        memory = FakeMemorySpecialist()

        def get_memory_specialist(self):
            return self.memory

        def run_reflection(self):
            return {"status": "completed"}

        def run_night_cycle_state(self):
            return {"summary_date": "2026-07-10"}

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("personal_agent.scheduler.BackgroundScheduler", lambda timezone: FakeScheduler())
        create_scheduler(
            config=database.config,
            database=database,
            message_service=FakeService(),
            logger=logging.getLogger("test.durable_jobs.core_kind"),
        )

    completed = store.get_job(created.job_id)
    assert completed is not None and completed.terminal_state == "completed"
    assert completed.result_ref == "job:memory-maintenance"
