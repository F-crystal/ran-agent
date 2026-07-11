"""SQLite-authoritative durable Core jobs with lease and CAS transitions."""

from __future__ import annotations

import logging
import re
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from personal_agent.db import Database


TERMINAL_STATES = ("completed", "blocked", "stopped", "expired")
REGISTERED_CORE_JOB_KINDS = frozenset({
    "core.memory-maintenance",
    "core.reflection",
    "core.night-cycle",
    "core.external-activity",
})
_ROW_SELECT = """
    SELECT job_id, actor_key, goal_digest, job_kind, payload_ref, state, next_run_at,
           lease_owner, lease_until, revision, terminal_state,
           result_ref, created_at, updated_at
    FROM durable_jobs
"""
_SAFE_KEY = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
_SAFE_WORKER = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_SAFE_REF = re.compile(r"^[A-Za-z0-9_.:/-]{1,240}$")
_SAFE_KIND = re.compile(r"^[a-z][a-z0-9_.:-]{2,120}$")
_GOAL_DIGEST = re.compile(r"^[a-f0-9]{32,128}$")


class DurableJobConflict(RuntimeError):
    """Raised when a stale or conflicting worker attempts a state transition."""


def is_registered_core_job_kind(value: str) -> bool:
    """Return whether a private API request has a restart-safe Core handler."""

    return str(value).strip() in REGISTERED_CORE_JOB_KINDS


@dataclass(frozen=True, slots=True)
class DurableJobReceipt:
    job_id: str
    actor_key: str
    goal_digest: str
    status: str
    next_run_at: str
    terminal_states: tuple[str, ...] = TERMINAL_STATES


@dataclass(frozen=True, slots=True)
class DurableJobRecord:
    job_id: str
    actor_key: str
    goal_digest: str
    job_kind: str
    payload_ref: str
    state: str
    next_run_at: str
    lease_owner: str
    lease_until: str
    revision: int
    terminal_state: str
    result_ref: str
    created_at: str
    updated_at: str

    def receipt(self) -> DurableJobReceipt:
        return DurableJobReceipt(
            job_id=self.job_id,
            actor_key=self.actor_key,
            goal_digest=self.goal_digest,
            status=self.terminal_state if self.state == "terminal" else "active",
            next_run_at=self.next_run_at,
        )


@dataclass(frozen=True, slots=True)
class DurableJobOutcome:
    next_run_at: datetime | str | None = None
    terminal_state: str = ""
    result_ref: str = ""

    @classmethod
    def checkpoint(cls, next_run_at: datetime | str) -> DurableJobOutcome:
        return cls(next_run_at=next_run_at)

    @classmethod
    def terminal(cls, terminal_state: str, result_ref: str = "") -> DurableJobOutcome:
        return cls(terminal_state=terminal_state, result_ref=result_ref)


class DurableJobStore:
    """Own transactional durable job creation, leases, checkpoints, and terminals."""

    def __init__(self, database: Database) -> None:
        self._database = database

    def create_job(
        self,
        *,
        actor_key: str,
        goal_digest: str,
        next_run_at: datetime | str,
        job_kind: str = "legacy",
        payload_ref: str = "",
        now: datetime | str | None = None,
        job_id: str | None = None,
    ) -> DurableJobRecord:
        actor = _validated(actor_key, _SAFE_KEY, "actor_key")
        goal = _validated(goal_digest, _GOAL_DIGEST, "goal_digest")
        kind = _validated(job_kind, _SAFE_KIND, "job_kind")
        payload = "" if payload_ref == "" else _validated(payload_ref, _SAFE_REF, "payload_ref")
        next_wake = _utc_iso(next_run_at)
        timestamp = _utc_iso(now or datetime.now(timezone.utc))
        identifier = _validated(job_id or f"job_{uuid4().hex}", _SAFE_KEY, "job_id")
        with self._database.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(
                    f"{_ROW_SELECT} WHERE actor_key = ? AND goal_digest = ? AND state != 'terminal'",
                    (actor, goal),
                ).fetchone()
                if existing is not None:
                    conn.commit()
                    return _record(existing)
                conn.execute(
                    """
                    INSERT INTO durable_jobs (
                        job_id, actor_key, goal_digest, job_kind, payload_ref, state, next_run_at,
                        lease_owner, lease_until, revision, terminal_state,
                        result_ref, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', ?, '', '', 0, '', '', ?, ?)
                    """,
                    (identifier, actor, goal, kind, payload, next_wake, timestamp, timestamp),
                )
                row = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        if row is None:
            raise RuntimeError("durable job commit did not produce a row")
        return _record(row)


    def get_job(self, job_id: str) -> DurableJobRecord | None:
        identifier = _validated(job_id, _SAFE_KEY, "job_id")
        with self._database.connection() as conn:
            row = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
        return _record(row) if row is not None else None

    def query_active_job(self, actor_key: str, goal_digest: str) -> DurableJobRecord | None:
        actor = _validated(actor_key, _SAFE_KEY, "actor_key")
        goal = _validated(goal_digest, _GOAL_DIGEST, "goal_digest")
        with self._database.connection() as conn:
            row = conn.execute(
                f"{_ROW_SELECT} WHERE actor_key = ? AND goal_digest = ? AND state != 'terminal'",
                (actor, goal),
            ).fetchone()
        return _record(row) if row is not None else None

    def claim_due_jobs(
        self,
        lease_owner: str,
        *,
        now: datetime | str | None = None,
        lease_seconds: int = 60,
        limit: int = 10,
        skip_job_kinds: tuple[str, ...] = (),
    ) -> list[DurableJobRecord]:
        owner = _validated(lease_owner, _SAFE_WORKER, "lease_owner")
        if not isinstance(lease_seconds, int) or lease_seconds <= 0:
            raise ValueError("lease_seconds must be a positive integer")
        if not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        skipped_kinds = tuple(
            _validated(job_kind, _SAFE_KIND, "job_kind")
            for job_kind in skip_job_kinds
        )
        current = _utc_datetime(now or datetime.now(timezone.utc))
        current_iso = _utc_iso(current)
        lease_until = _utc_iso(current + timedelta(seconds=lease_seconds))
        claimed: list[DurableJobRecord] = []
        with self._database.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                skip_clause = ""
                parameters: tuple[object, ...] = (current_iso, current_iso)
                if skipped_kinds:
                    placeholders = ", ".join("?" for _ in skipped_kinds)
                    skip_clause = f" AND job_kind NOT IN ({placeholders})"
                    parameters += skipped_kinds
                parameters += (min(limit, 100),)
                rows = conn.execute(
                    f"""
                    {_ROW_SELECT}
                    WHERE ((state = 'active' AND next_run_at <= ?)
                       OR (state = 'leased' AND lease_until <= ?)){skip_clause}
                    ORDER BY next_run_at ASC, created_at ASC, job_id ASC
                    LIMIT ?
                    """,
                    parameters,
                ).fetchall()
                for row in rows:
                    cursor = conn.execute(
                        """
                        UPDATE durable_jobs
                        SET state = 'leased', lease_owner = ?, lease_until = ?,
                            revision = revision + 1, updated_at = ?
                        WHERE job_id = ? AND revision = ?
                          AND ((state = 'active' AND next_run_at <= ?)
                            OR (state = 'leased' AND lease_until <= ?))
                        """,
                        (owner, lease_until, current_iso, row["job_id"], row["revision"], current_iso, current_iso),
                    )
                    if cursor.rowcount == 1:
                        claimed_row = conn.execute(
                            f"{_ROW_SELECT} WHERE job_id = ?", (row["job_id"],)
                        ).fetchone()
                        if claimed_row is not None:
                            claimed.append(_record(claimed_row))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return claimed

    def checkpoint_job(
        self,
        job_id: str,
        *,
        lease_owner: str,
        expected_revision: int,
        next_run_at: datetime | str,
        now: datetime | str | None = None,
    ) -> DurableJobRecord:
        identifier = _validated(job_id, _SAFE_KEY, "job_id")
        owner = _validated(lease_owner, _SAFE_WORKER, "lease_owner")
        revision = _revision(expected_revision)
        next_wake = _utc_iso(next_run_at)
        timestamp = _utc_iso(now or datetime.now(timezone.utc))
        with self._database.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                cursor = conn.execute(
                    """
                    UPDATE durable_jobs
                    SET state = 'active', next_run_at = ?, lease_owner = '',
                        lease_until = '', revision = revision + 1, updated_at = ?
                    WHERE job_id = ? AND state = 'leased'
                      AND lease_owner = ? AND revision = ?
                    """,
                    (next_wake, timestamp, identifier, owner, revision),
                )
                if cursor.rowcount != 1:
                    conn.rollback()
                    raise DurableJobConflict("stale job checkpoint")
                row = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                conn.commit()
            except DurableJobConflict:
                raise
            except Exception:
                conn.rollback()
                raise
        if row is None:
            raise RuntimeError("durable job checkpoint lost its row")
        return _record(row)

    def finish_job(
        self,
        job_id: str,
        *,
        lease_owner: str,
        expected_revision: int,
        terminal_state: str,
        result_ref: str = "",
        now: datetime | str | None = None,
    ) -> DurableJobRecord:
        identifier = _validated(job_id, _SAFE_KEY, "job_id")
        owner = _validated(lease_owner, _SAFE_WORKER, "lease_owner")
        revision = _revision(expected_revision)
        terminal = str(terminal_state or "").strip().lower()
        if terminal not in TERMINAL_STATES:
            raise ValueError("invalid durable job terminal state")
        result = "" if result_ref == "" else _validated(result_ref, _SAFE_REF, "result_ref")
        timestamp = _utc_iso(now or datetime.now(timezone.utc))
        with self._database.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                if existing is None:
                    conn.rollback()
                    raise KeyError("durable job not found")
                current = _record(existing)
                if current.state == "terminal":
                    conn.commit()
                    if current.terminal_state == terminal and current.result_ref == result:
                        return current
                    raise DurableJobConflict("terminal result conflict")
                cursor = conn.execute(
                    """
                    UPDATE durable_jobs
                    SET state = 'terminal', lease_owner = '', lease_until = '',
                        revision = revision + 1, terminal_state = ?, result_ref = ?,
                        updated_at = ?
                    WHERE job_id = ? AND state = 'leased'
                      AND lease_owner = ? AND revision = ?
                    """,
                    (terminal, result, timestamp, identifier, owner, revision),
                )
                if cursor.rowcount != 1:
                    conn.rollback()
                    raise DurableJobConflict("stale job terminal")
                row = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                conn.commit()
            except (DurableJobConflict, KeyError):
                raise
            except Exception:
                conn.rollback()
                raise
        if row is None:
            raise RuntimeError("durable job terminal transition lost its row")
        return _record(row)

    def terminalize_external_job(
        self,
        job_id: str,
        *,
        terminal_state: str,
        result_ref: str,
        now: datetime | str | None = None,
    ) -> DurableJobRecord:
        """Idempotently terminalize a bridge-owned external activity job.

        External activity work has its own persisted checkpoint/lease state, so
        it must not be claimed by the Core dispatcher merely to record stop or
        completion. This narrow path accepts only the dedicated job kind.
        """
        identifier = _validated(job_id, _SAFE_KEY, "job_id")
        terminal = str(terminal_state or "").strip().lower()
        if terminal not in TERMINAL_STATES:
            raise ValueError("invalid durable job terminal state")
        result = _validated(result_ref, _SAFE_REF, "result_ref")
        timestamp = _utc_iso(now or datetime.now(timezone.utc))
        with self._database.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                if existing is None:
                    conn.rollback()
                    raise KeyError("durable job not found")
                current = _record(existing)
                if current.job_kind != "core.external-activity":
                    conn.rollback()
                    raise ValueError("durable job kind is not external activity")
                if current.state == "terminal":
                    conn.commit()
                    if current.terminal_state == terminal and current.result_ref == result:
                        return current
                    raise DurableJobConflict("terminal result conflict")
                cursor = conn.execute(
                    """
                    UPDATE durable_jobs
                    SET state = 'terminal', lease_owner = '', lease_until = '',
                        revision = revision + 1, terminal_state = ?, result_ref = ?,
                        updated_at = ?
                    WHERE job_id = ? AND job_kind = 'core.external-activity'
                      AND state != 'terminal' AND revision = ?
                    """,
                    (terminal, result, timestamp, identifier, current.revision),
                )
                if cursor.rowcount != 1:
                    conn.rollback()
                    raise DurableJobConflict("stale external job terminal")
                row = conn.execute(f"{_ROW_SELECT} WHERE job_id = ?", (identifier,)).fetchone()
                conn.commit()
            except (DurableJobConflict, KeyError, ValueError):
                raise
            except Exception:
                conn.rollback()
                raise
        if row is None:
            raise RuntimeError("external durable job terminal transition lost its row")
        return _record(row)


DurableJobHandler = Callable[[DurableJobRecord], DurableJobOutcome]


class DurableJobDispatcher:
    """Wake due SQLite jobs and apply explicit handler outcomes through CAS."""

    def __init__(
        self,
        store: DurableJobStore,
        *,
        handlers: Mapping[str, DurableJobHandler],
        kind_handlers: Mapping[str, DurableJobHandler] | None = None,
        worker_id: str,
        logger: logging.Logger,
        lease_seconds: int = 60,
    ) -> None:
        self._store = store
        self._handlers = {
            _validated(goal_digest, _GOAL_DIGEST, "goal_digest"): handler
            for goal_digest, handler in handlers.items()
            if callable(handler)
        }
        if len(self._handlers) != len(handlers):
            raise ValueError("durable job handlers must be callable")
        kind_handlers = kind_handlers or {}
        self._kind_handlers = {
            _validated(job_kind, _SAFE_KIND, "job_kind"): handler
            for job_kind, handler in kind_handlers.items()
            if callable(handler)
        }
        if len(self._kind_handlers) != len(kind_handlers):
            raise ValueError("durable job kind handlers must be callable")
        self._worker_id = _validated(worker_id, _SAFE_WORKER, "lease_owner")
        if not isinstance(lease_seconds, int) or lease_seconds <= 0:
            raise ValueError("lease_seconds must be a positive integer")
        self._lease_seconds = lease_seconds
        self._logger = logger

    def dispatch_due(
        self,
        *,
        now: datetime | str | None = None,
        limit: int = 10,
    ) -> list[DurableJobRecord]:
        claimed = self._store.claim_due_jobs(
            self._worker_id,
            now=now,
            lease_seconds=self._lease_seconds,
            limit=limit,
            # These records are exclusively driven by the Node autonomy
            # runtime. Claiming one here would turn a healthy bridge activity
            # into a false Core "unregistered handler" terminal state.
            skip_job_kinds=("core.external-activity",),
        )
        transitioned: list[DurableJobRecord] = []
        for record in claimed:
            handler = self._kind_handlers.get(record.job_kind) or self._handlers.get(record.goal_digest)
            if handler is None:
                self._logger.warning("durable job has no registered handler")
                try:
                    result = self._store.finish_job(
                        record.job_id,
                        lease_owner=self._worker_id,
                        expected_revision=record.revision,
                        terminal_state="blocked",
                        result_ref="job:unregistered-handler",
                    )
                except DurableJobConflict:
                    self._logger.warning("durable job CAS conflict")
                    continue
                transitioned.append(result)
                continue
            try:
                outcome = handler(record)
                if not isinstance(outcome, DurableJobOutcome):
                    raise TypeError("durable job handler returned an invalid outcome")
                has_checkpoint = outcome.next_run_at is not None
                has_terminal = bool(outcome.terminal_state)
                if has_checkpoint == has_terminal:
                    raise ValueError("durable job outcome must choose checkpoint or terminal")
                if has_checkpoint:
                    result = self._store.checkpoint_job(
                        record.job_id,
                        lease_owner=self._worker_id,
                        expected_revision=record.revision,
                        next_run_at=outcome.next_run_at,
                    )
                else:
                    result = self._store.finish_job(
                        record.job_id,
                        lease_owner=self._worker_id,
                        expected_revision=record.revision,
                        terminal_state=outcome.terminal_state,
                        result_ref=outcome.result_ref,
                    )
            except DurableJobConflict:
                self._logger.warning("durable job CAS conflict")
                continue
            except Exception:
                self._logger.exception("durable job handler failed; lease left for expiry recovery")
                continue
            transitioned.append(result)
        return transitioned


def _record(row: sqlite3.Row) -> DurableJobRecord:
    return DurableJobRecord(
        job_id=str(row["job_id"]),
        actor_key=str(row["actor_key"]),
        goal_digest=str(row["goal_digest"]),
        job_kind=str(row["job_kind"]),
        payload_ref=str(row["payload_ref"]),
        state=str(row["state"]),
        next_run_at=str(row["next_run_at"]),
        lease_owner=str(row["lease_owner"]),
        lease_until=str(row["lease_until"]),
        revision=int(row["revision"]),
        terminal_state=str(row["terminal_state"]),
        result_ref=str(row["result_ref"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _validated(value: str, pattern: re.Pattern[str], field: str) -> str:
    normalized = str(value or "").strip()
    if normalized != value or not pattern.fullmatch(normalized):
        raise ValueError(f"invalid durable job {field}")
    return normalized


def _revision(value: int) -> int:
    if not isinstance(value, int) or value < 0:
        raise ValueError("expected_revision must be a non-negative integer")
    return value


def _utc_datetime(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("invalid durable job timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("durable job timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def _utc_iso(value: datetime | str) -> str:
    return _utc_datetime(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")
