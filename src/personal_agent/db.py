"""SQLite initialization and lightweight data access helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Iterator, Sequence

from personal_agent.config import AppConfig


SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'working',
        importance INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS handoff_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS reply_review_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL DEFAULT '',
        sender_id TEXT NOT NULL DEFAULT '',
        route TEXT NOT NULL DEFAULT '',
        response_mode TEXT NOT NULL DEFAULT '',
        current_topic TEXT NOT NULL DEFAULT '',
        intimacy_level INTEGER NOT NULL DEFAULT 0,
        recent_turn_summary TEXT NOT NULL DEFAULT '',
        time_of_day TEXT NOT NULL DEFAULT '',
        user_message TEXT NOT NULL DEFAULT '',
        first_draft TEXT NOT NULL DEFAULT '',
        final_reply TEXT NOT NULL DEFAULT '',
        review_triggered INTEGER NOT NULL DEFAULT 0,
        review_reasons TEXT NOT NULL DEFAULT '[]',
        retry_performed INTEGER NOT NULL DEFAULT 0,
        retry_success INTEGER NOT NULL DEFAULT 0,
        false_positive_candidate INTEGER NOT NULL DEFAULT 0,
        user_dissatisfaction_signal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        reminder_at TEXT,
        last_reminded_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    # Media deduplication tables (Phase 1: SHA256 exact dedup)
    """
    CREATE TABLE IF NOT EXISTS media_dedup (
        sha256 TEXT PRIMARY KEY,
        phash TEXT,
        rel_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        reference_count INTEGER NOT NULL DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS media_dedup_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_column TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sha256) REFERENCES media_dedup(sha256)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_media_dedup_refs_sha256 
    ON media_dedup_refs(sha256)
    """,
    """
    CREATE TABLE IF NOT EXISTS personal_learning_records (
        learning_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        statement TEXT NOT NULL,
        source TEXT NOT NULL,
        evidence_digests TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL DEFAULT '',
        superseded_by TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_personal_learning_subject_status
    ON personal_learning_records(subject_key, status, last_observed_at)
    """,
    """
    CREATE TABLE IF NOT EXISTS durable_jobs (
        job_id TEXT PRIMARY KEY,
        actor_key TEXT NOT NULL,
        goal_digest TEXT NOT NULL,
        job_kind TEXT NOT NULL DEFAULT 'legacy',
        payload_ref TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        terminal_state TEXT NOT NULL DEFAULT '',
        result_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (revision >= 0),
        CHECK (state IN ('active', 'leased', 'terminal')),
        CHECK (
            (state = 'terminal' AND terminal_state IN ('completed', 'blocked', 'stopped', 'expired'))
            OR (state != 'terminal' AND terminal_state = '')
        ),
        CHECK (
            (state = 'leased' AND lease_owner != '' AND lease_until != '')
            OR (state != 'leased' AND lease_owner = '' AND lease_until = '')
        )
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_jobs_active_goal
    ON durable_jobs(actor_key, goal_digest)
    WHERE state != 'terminal'
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_due
    ON durable_jobs(state, next_run_at, lease_until)
    """,
    """
    CREATE TABLE IF NOT EXISTS ingest_event_receipts (
        event_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
)


class Database:
    """Owns SQLite setup and small helper operations for Phase 1."""

    def __init__(self, config: AppConfig, logger: logging.Logger) -> None:
        self._config = config
        self._logger = logger

    @property
    def config(self) -> AppConfig:
        """Expose runtime config to collaborating modules."""

        return self._config

    def initialize(self) -> None:
        """Create the SQLite file and required tables."""

        self._config.data_dir.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            for statement in SCHEMA_STATEMENTS:
                conn.execute(statement)
            self._ensure_memories_schema(conn)
            self._ensure_todos_schema(conn)
            self._ensure_durable_jobs_schema(conn)
            conn.commit()
        self._logger.info("database initialized at %s", self._config.database_path)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """Open a connection with row access by column name."""

        conn = sqlite3.connect(self._config.database_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def record_timeline_event(
        self,
        source: str,
        event_type: str,
        content: str,
        tags: str = "",
        importance: int = 0,
    ) -> int:
        """Write an event into the timeline for debugging and continuity."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO timeline_events (source, event_type, content, tags, importance)
                VALUES (?, ?, ?, ?, ?)
                """,
                (source, event_type, content, tags, importance),
            )
            conn.commit()
        self._logger.info("timeline event recorded event_type=%s importance=%s", event_type, importance)
        return int(cursor.lastrowid)

    def record_external_exchange_once(
        self,
        *,
        event_id: str,
        channel: str,
        sender_id: str,
        user_text: str,
        reply_text: str,
        source: str,
        media_refs: tuple[str, ...] = (),
    ) -> str:
        """Atomically persist an externally delivered exchange once per durable event.

        The event identifier is intentionally never written to logs.  A digest of
        the complete projection detects accidental identifier reuse without
        retaining a duplicate payload in the receipt table.
        """

        payload_digest = hashlib.sha256(
            json.dumps(
                {
                    "channel": channel,
                    "sender_id": sender_id,
                    "user_text": user_text,
                    "reply_text": reply_text,
                    "source": source,
                    "media_refs": list(media_refs),
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload_digest FROM ingest_event_receipts WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if existing is not None:
                return "duplicate" if str(existing["payload_digest"]) == payload_digest else "conflict"

            conn.execute(
                """
                INSERT INTO timeline_events (source, event_type, content, tags, importance)
                VALUES (?, ?, ?, ?, ?)
                """,
                (channel, "user_message", user_text, f"message,user,{source}", 1),
            )
            conn.execute(
                """
                INSERT INTO timeline_events (source, event_type, content, tags, importance)
                VALUES (?, ?, ?, ?, ?)
                """,
                ("agent", "agent_reply", reply_text, f"message,reply,{channel},{source}", 1),
            )
            conn.execute(
                "INSERT INTO ingest_event_receipts (event_id, payload_digest) VALUES (?, ?)",
                (event_id, payload_digest),
            )
            conn.commit()
        return "stored"

    def fetch_timeline_events(self) -> list[sqlite3.Row]:
        """Return timeline events in insertion order for verification and debugging."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, source, event_type, content, tags, importance, created_at
                FROM timeline_events
                ORDER BY id ASC
                """
            ).fetchall()
        return list(rows)

    def store_memory(self, content: str, memory_type: str, importance: int = 1) -> int:
        """Insert a memory item and update its timestamps."""

        with self.connection() as conn:
            memory_columns = self._get_memories_columns(conn)
            if "title" in memory_columns:
                cursor = conn.execute(
                    """
                    INSERT INTO memories (title, content, type, importance, updated_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (content, content, memory_type, importance),
                )
            else:
                cursor = conn.execute(
                    """
                    INSERT INTO memories (content, type, importance, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (content, memory_type, importance),
                )
            conn.commit()
        self._logger.info(
            "memory stored type=%s importance=%s content=%s",
            memory_type,
            importance,
            content,
        )
        return int(cursor.lastrowid)

    def get_profile_memories(self, limit: int = 5) -> list[sqlite3.Row]:
        """Return profile memories ordered by importance and recency."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, content, type, importance, created_at, updated_at
                FROM memories
                WHERE type = 'profile'
                ORDER BY importance DESC, updated_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return list(rows)

    def get_working_memories(self, limit: int = 3) -> list[sqlite3.Row]:
        """Return recent working memories ordered by recency."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, content, type, importance, created_at, updated_at
                FROM memories
                WHERE type = 'working'
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return list(rows)

    def delete_old_working_memories(self, keep_limit: int) -> int:
        """Delete working memories beyond the retained recent window."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                DELETE FROM memories
                WHERE type = 'working'
                  AND id NOT IN (
                      SELECT id
                      FROM memories
                      WHERE type = 'working'
                      ORDER BY created_at DESC, id DESC
                      LIMIT ?
                  )
                """,
                (keep_limit,),
            )
            conn.commit()
        deleted = int(cursor.rowcount if cursor.rowcount != -1 else 0)
        if deleted:
            self._logger.info("old working memories deleted count=%s", deleted)
        return deleted

    def get_recent_user_messages(self, limit: int) -> list[str]:
        """Return recent user messages for profile-memory repeat detection."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT content
                FROM timeline_events
                WHERE event_type = 'user_message'
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [str(row["content"]) for row in reversed(rows)]

    def get_memories_by_type(self, memory_type: str) -> list[sqlite3.Row]:
        """Return all memories of a given type for deduplication and verification."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, content, type, importance, created_at, updated_at
                FROM memories
                WHERE type = ?
                ORDER BY id ASC
                """,
                (memory_type,),
            ).fetchall()
        return list(rows)

    def get_memories_snapshot(self, memory_types: Sequence[str] | None = None) -> tuple[int, int, str]:
        """Return a compact signature for memory-table change detection."""

        with self.connection() as conn:
            query = [
                "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id, COALESCE(MAX(updated_at), '') AS max_updated_at",
                "FROM memories",
            ]
            params: list[object] = []
            if memory_types:
                placeholders = ", ".join("?" for _ in memory_types)
                query.append(f"WHERE type IN ({placeholders})")
                params.extend(memory_types)
            row = conn.execute("\n".join(query), params).fetchone()
        if row is None:
            return (0, 0, "")
        return (int(row["count"]), int(row["max_id"]), str(row["max_updated_at"]))

    def get_memories_for_vector_index(self, memory_types: Sequence[str] | None = None) -> list[sqlite3.Row]:
        """Return all memories that should be indexed for semantic recall."""

        with self.connection() as conn:
            query = [
                "SELECT id, content, type, importance, created_at, updated_at",
                "FROM memories",
            ]
            params: list[object] = []
            if memory_types:
                placeholders = ", ".join("?" for _ in memory_types)
                query.append(f"WHERE type IN ({placeholders})")
                params.extend(memory_types)
            query.append("ORDER BY id ASC")
            rows = conn.execute("\n".join(query), params).fetchall()
        return list(rows)

    def get_memories_by_ids(self, memory_ids: Sequence[int]) -> list[sqlite3.Row]:
        """Return memories for a specific set of ids."""

        unique_ids = [int(memory_id) for memory_id in dict.fromkeys(memory_ids)]
        if not unique_ids:
            return []

        with self.connection() as conn:
            placeholders = ", ".join("?" for _ in unique_ids)
            rows = conn.execute(
                f"""
                SELECT id, content, type, importance, created_at, updated_at
                FROM memories
                WHERE id IN ({placeholders})
                """,
                unique_ids,
            ).fetchall()
        return list(rows)

    def get_memories_for_retrieval(
        self,
        limit: int = 200,
        memory_types: Sequence[str] | None = None,
    ) -> list[sqlite3.Row]:
        """Return recent memory candidates for lightweight ranking."""

        with self.connection() as conn:
            query = [
                "SELECT id, content, type, importance, created_at, updated_at",
                "FROM memories",
            ]
            params: list[object] = []
            if memory_types:
                placeholders = ", ".join("?" for _ in memory_types)
                query.append(f"WHERE type IN ({placeholders})")
                params.extend(memory_types)
            query.append("ORDER BY importance DESC, updated_at DESC, id DESC")
            query.append("LIMIT ?")
            params.append(limit)
            rows = conn.execute("\n".join(query), params).fetchall()
        return list(rows)

    def get_last_wechat_activity_at(self) -> datetime | None:
        """Return the latest wechat conversation activity timestamp in UTC."""

        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT created_at
                FROM timeline_events
                WHERE (source = 'wechat' AND event_type = 'user_message')
                   OR (
                       source = 'agent'
                       AND event_type IN ('agent_reply', 'agent_proactive')
                       AND tags LIKE '%wechat%'
                   )
                ORDER BY id DESC
                LIMIT 1
                """
            ).fetchone()

        if row is None or not row["created_at"]:
            return None
        return datetime.strptime(str(row["created_at"]), "%Y-%m-%d %H:%M:%S")

    def count_today_proactive_messages(self, local_date: str) -> int:
        """Return how many proactive wechat messages were sent on the local day."""

        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM timeline_events
                WHERE source = 'agent'
                  AND event_type = 'agent_proactive'
                  AND tags LIKE '%wechat%'
                  AND date(created_at, 'localtime') = ?
                """,
                (local_date,),
            ).fetchone()
        return int(row["count"]) if row is not None else 0

    def get_recent_wechat_user_messages(self, limit: int) -> list[str]:
        """Return recent wechat user messages for proactive topic selection."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT content
                FROM timeline_events
                WHERE source = 'wechat'
                  AND event_type = 'user_message'
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [str(row["content"]) for row in rows]

    def get_handoff_value(self, key: str) -> str | None:
        """Return one short-lived handoff value by key."""

        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT value
                FROM handoff_memory
                WHERE key = ?
                LIMIT 1
                """,
                (key,),
            ).fetchone()
        if row is None:
            return None
        return str(row["value"])

    def set_handoff_value(self, key: str, value: str) -> None:
        """Upsert one short-lived handoff value."""

        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO handoff_memory (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, value),
            )
            conn.commit()

    def delete_handoff_by_prefix(self, prefix: str) -> int:
        """Delete short-lived handoff values matching one prefix."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                DELETE FROM handoff_memory
                WHERE key LIKE ?
                """,
                (f"{prefix}%",),
            )
            conn.commit()
        return int(cursor.rowcount if cursor.rowcount != -1 else 0)

    def get_recent_channel_messages(self, channel: str, limit: int) -> list[str]:
        """Return recent user messages for one channel for near-term context building."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT content
                FROM timeline_events
                WHERE source = ?
                  AND event_type = 'user_message'
                ORDER BY id DESC
                LIMIT ?
                """,
                (channel, limit),
            ).fetchall()
        return [str(row["content"]) for row in reversed(rows)]

    def get_timeline_events_for_local_date(self, local_date: str, limit: int = 200) -> list[sqlite3.Row]:
        """Return timeline events that fall on one local calendar day."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, source, event_type, content, tags, importance, created_at
                FROM timeline_events
                WHERE date(created_at, 'localtime') = ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (local_date, limit),
            ).fetchall()
        return list(rows)

    def record_reply_review_observation(
        self,
        *,
        channel: str,
        sender_id: str,
        route: str,
        response_mode: str,
        current_topic: str,
        intimacy_level: int,
        recent_turn_summary: str,
        time_of_day: str,
        user_message: str,
        first_draft: str,
        final_reply: str,
        review_triggered: bool,
        review_reasons: str,
        retry_performed: bool,
        retry_success: bool,
        false_positive_candidate: bool,
        user_dissatisfaction_signal: bool,
    ) -> int:
        """Store one lightweight reply-review observation for offline reflection."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO reply_review_observations (
                    channel,
                    sender_id,
                    route,
                    response_mode,
                    current_topic,
                    intimacy_level,
                    recent_turn_summary,
                    time_of_day,
                    user_message,
                    first_draft,
                    final_reply,
                    review_triggered,
                    review_reasons,
                    retry_performed,
                    retry_success,
                    false_positive_candidate,
                    user_dissatisfaction_signal
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    channel,
                    sender_id,
                    route,
                    response_mode,
                    current_topic,
                    intimacy_level,
                    recent_turn_summary,
                    time_of_day,
                    user_message,
                    first_draft,
                    final_reply,
                    int(review_triggered),
                    review_reasons,
                    int(retry_performed),
                    int(retry_success),
                    int(false_positive_candidate),
                    int(user_dissatisfaction_signal),
                ),
            )
            conn.commit()
        return int(cursor.lastrowid)

    def get_recent_reply_review_observations(self, limit: int) -> list[sqlite3.Row]:
        """Return recent review observations for offline reflection jobs."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT
                    id,
                    channel,
                    sender_id,
                    route,
                    response_mode,
                    current_topic,
                    intimacy_level,
                    recent_turn_summary,
                    time_of_day,
                    user_message,
                    first_draft,
                    final_reply,
                    review_triggered,
                    review_reasons,
                    retry_performed,
                    retry_success,
                    false_positive_candidate,
                    user_dissatisfaction_signal,
                    created_at
                FROM reply_review_observations
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return list(rows)

    def _ensure_memories_schema(self, conn: sqlite3.Connection) -> None:
        """Backfill required memory columns without breaking existing databases."""

        columns = self._get_memories_columns(conn)
        if not columns:
            return

        if "content" not in columns:
            conn.execute("ALTER TABLE memories ADD COLUMN content TEXT NOT NULL DEFAULT ''")
        if "type" not in columns:
            conn.execute(
                "ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'working'"
            )
        if "importance" not in columns:
            conn.execute(
                "ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 1"
            )
        if "created_at" not in columns:
            conn.execute(
                "ALTER TABLE memories ADD COLUMN created_at TEXT NOT NULL DEFAULT ''"
            )
            conn.execute(
                "UPDATE memories SET created_at = CURRENT_TIMESTAMP WHERE created_at = ''"
            )
        if "updated_at" not in columns:
            conn.execute(
                "ALTER TABLE memories ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"
            )
            conn.execute(
                "UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = ''"
            )

    def _get_memories_columns(self, conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
        """Return current memories-table columns keyed by column name."""

        return {
            row["name"]: row
            for row in conn.execute("PRAGMA table_info(memories)").fetchall()
        }

    def _ensure_todos_schema(self, conn: sqlite3.Connection) -> None:
        columns = {
            row["name"]: row
            for row in conn.execute("PRAGMA table_info(todos)").fetchall()
        }
        if not columns:
            return
        if "last_reminded_at" not in columns:
            conn.execute("ALTER TABLE todos ADD COLUMN last_reminded_at TEXT")

    def _ensure_durable_jobs_schema(self, conn: sqlite3.Connection) -> None:
        """Add typed durable-job metadata without rewriting existing job truth."""

        columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(durable_jobs)").fetchall()
        }
        if "job_kind" not in columns:
            conn.execute("ALTER TABLE durable_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'legacy'")
        if "payload_ref" not in columns:
            conn.execute("ALTER TABLE durable_jobs ADD COLUMN payload_ref TEXT NOT NULL DEFAULT ''")

    # Todo / Reminder methods

    def create_todo(self, content: str, reminder_at: str | None = None, source: str = "user") -> int:
        """Create a new todo item with optional reminder time."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO todos (content, reminder_at, last_reminded_at, status, source, updated_at)
                VALUES (?, ?, NULL, 'pending', ?, CURRENT_TIMESTAMP)
                """,
                (content, reminder_at, source),
            )
            conn.commit()
        self._logger.info(
            "todo created content=%s reminder_at=%s",
            content[:50],
            reminder_at,
        )
        return int(cursor.lastrowid)

    def get_pending_todos(self, limit: int = 10) -> list[sqlite3.Row]:
        """Return pending todos ordered by reminder time."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, content, reminder_at, last_reminded_at, status, source, created_at
                FROM todos
                WHERE status = 'pending'
                ORDER BY 
                    CASE WHEN reminder_at IS NULL THEN 1 ELSE 0 END,
                    reminder_at ASC,
                    id ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return list(rows)

    def get_due_reminders(self, before_time: str) -> list[sqlite3.Row]:
        """Return todos with reminder_at <= before_time and status = pending."""

        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, content, reminder_at, last_reminded_at, status, source, created_at
                FROM todos
                WHERE status = 'pending'
                  AND reminder_at IS NOT NULL
                  AND reminder_at <= ?
                  AND (last_reminded_at IS NULL OR last_reminded_at < reminder_at)
                ORDER BY reminder_at ASC
                """,
                (before_time,),
            ).fetchall()
        return list(rows)

    def mark_todo_reminded(self, todo_id: int, reminded_at: str | None = None) -> bool:
        timestamp = reminded_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE todos
                SET last_reminded_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (timestamp, todo_id),
            )
            conn.commit()
        return cursor.rowcount > 0

    def mark_todo_done(self, todo_id: int) -> bool:
        """Mark a todo as completed."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE todos
                SET status = 'done', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (todo_id,),
            )
            conn.commit()
        updated = cursor.rowcount > 0
        if updated:
            self._logger.info("todo marked done id=%s", todo_id)
        return updated

    def mark_todo_cancelled(self, todo_id: int) -> bool:
        """Mark a todo as cancelled."""

        with self.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE todos
                SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (todo_id,),
            )
            conn.commit()
        updated = cursor.rowcount > 0
        if updated:
            self._logger.info("todo marked cancelled id=%s", todo_id)
        return updated

    def get_todo_by_id(self, todo_id: int) -> sqlite3.Row | None:
        """Get a single todo by ID."""

        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT id, content, reminder_at, last_reminded_at, status, source, created_at
                FROM todos
                WHERE id = ?
                """,
                (todo_id,),
            ).fetchone()
        return row

    def get_best_pending_todo_for_completion(self) -> sqlite3.Row | None:
        """Return the most likely pending todo the user is referring to when they say it is done."""

        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT id, content, reminder_at, last_reminded_at, status, source, created_at
                FROM todos
                WHERE status = 'pending'
                ORDER BY
                    CASE
                        WHEN reminder_at IS NOT NULL AND reminder_at <= datetime('now', 'localtime') THEN 0
                        WHEN reminder_at IS NOT NULL THEN 1
                        ELSE 2
                    END,
                    CASE WHEN reminder_at IS NULL THEN '9999-12-31 23:59:59' ELSE reminder_at END ASC,
                    id DESC
                LIMIT 1
                """
            ).fetchone()
        return row

    def has_recent_proactive_seed(self, *, channel: str, seed: str, window_minutes: int = 30) -> bool:
        if not seed:
            return False
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM timeline_events
                WHERE source = 'agent'
                  AND event_type = 'agent_proactive'
                  AND tags LIKE ?
                  AND tags LIKE ?
                  AND datetime(created_at) >= datetime('now', ?)
                ORDER BY id DESC
                LIMIT 1
                """,
                (f"%{channel}%", f"%seed:{seed}%", f"-{int(window_minutes)} minutes"),
            ).fetchone()
        return row is not None
