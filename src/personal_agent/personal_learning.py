"""Evidence-backed personal learning without replacing existing memory systems."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from personal_agent.config import AppConfig
from personal_agent.db import Database


KINDS = {"preference", "correction", "relationship", "routine", "operating_lesson"}
SOURCES = {"explicit_user", "repeated_observation", "verified_outcome"}
STATUSES = {"candidate", "active", "superseded", "forgotten"}
_UNSAFE = re.compile(
    r"(?:authorization\s*:\s*bearer|cookie\s*=|sessionid\s*=|"
    r"\b(?:api[_-]?key|token|secret|password|sessdata)\s*[:=]|"
    r"https?://\S+|/(?:private|tmp|opt|home|users|var|etc)(?:/|\b)|"
    r"\b[a-z]:[\\/]+|\\\\+|\.env(?:\.|\b)|"
    r"traceback \(most recent call last\)|raw[_ -]?tool[_ -]?output|"
    r"x-amz-(?:signature|credential)|signed[_ -]?url)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PersonalLearningRecord:
    learning_id: str
    kind: str
    subject_key: str
    statement: str
    source: str
    evidence_digests: tuple[str, ...]
    confidence: float
    status: str
    observation_count: int
    created_at: str
    last_observed_at: str
    last_confirmed_at: str = ""
    superseded_by: str = ""


class PersonalLearningStore:
    """Own the additive learning lifecycle while legacy memory stays independent."""

    def __init__(self, *, database: Database, config: AppConfig) -> None:
        self._database = database
        self._config = config

    def observe(
        self,
        *,
        kind: str,
        subject_key: str,
        statement: str,
        source: str,
        evidence_digests: list[str] | tuple[str, ...],
        confidence: float,
        now: datetime | None = None,
    ) -> PersonalLearningRecord:
        normalized_kind = _choice(kind, KINDS, "kind")
        normalized_source = _choice(source, SOURCES, "source")
        normalized_subject = _subject_key(subject_key)
        normalized_statement = _statement(statement)
        digests = _evidence_digests(evidence_digests)
        normalized_confidence = float(confidence)
        if not math.isfinite(normalized_confidence):
            raise ValueError("confidence must be finite")
        normalized_confidence = max(0.0, min(1.0, normalized_confidence))
        timestamp = _iso(now)
        immediate = normalized_source in {"explicit_user", "verified_outcome"}

        with self._database.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            exact = conn.execute(
                """
                SELECT * FROM personal_learning_records
                WHERE subject_key = ? AND statement = ?
                  AND status IN ('candidate', 'active')
                ORDER BY created_at DESC LIMIT 1
                """,
                (normalized_subject, normalized_statement),
            ).fetchone()

            if immediate:
                learning_id = f"learn_{uuid4().hex[:20]}"
                conn.execute(
                    """
                    UPDATE personal_learning_records
                    SET status = 'superseded', superseded_by = ?, last_observed_at = ?
                    WHERE subject_key = ? AND status IN ('candidate', 'active')
                    """,
                    (learning_id, timestamp, normalized_subject),
                )
                conn.execute(
                    """
                    INSERT INTO personal_learning_records (
                      learning_id, kind, subject_key, statement, source,
                      evidence_digests, confidence, status, observation_count,
                      created_at, last_observed_at, last_confirmed_at, superseded_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, '')
                    """,
                    (
                        learning_id,
                        normalized_kind,
                        normalized_subject,
                        normalized_statement,
                        normalized_source,
                        json.dumps(digests),
                        normalized_confidence,
                        timestamp,
                        timestamp,
                        timestamp,
                    ),
                )
            elif exact is None:
                learning_id = f"learn_{uuid4().hex[:20]}"
                conn.execute(
                    """
                    INSERT INTO personal_learning_records (
                      learning_id, kind, subject_key, statement, source,
                      evidence_digests, confidence, status, observation_count,
                      created_at, last_observed_at, last_confirmed_at, superseded_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?, '', '')
                    """,
                    (
                        learning_id,
                        normalized_kind,
                        normalized_subject,
                        normalized_statement,
                        normalized_source,
                        json.dumps(digests),
                        normalized_confidence,
                        timestamp,
                        timestamp,
                    ),
                )
            else:
                learning_id = str(exact["learning_id"])
                existing_digests = tuple(json.loads(exact["evidence_digests"]))
                if normalized_source == "repeated_observation" and not set(digests).difference(existing_digests):
                    conn.commit()
                    record = self.get(learning_id)
                    if record is None:  # pragma: no cover - transaction invariant
                        raise RuntimeError("personal learning transaction did not persist")
                    return record
                observation_count = int(exact["observation_count"]) + 1
                status = "active" if exact["status"] == "active" or observation_count >= 2 else "candidate"
                merged = tuple(dict.fromkeys((*existing_digests, *digests)))
                if status == "active":
                    conn.execute(
                        """
                        UPDATE personal_learning_records
                        SET status = 'superseded', superseded_by = ?, last_observed_at = ?
                        WHERE subject_key = ? AND status = 'active' AND learning_id != ?
                        """,
                        (learning_id, timestamp, normalized_subject, learning_id),
                    )
                conn.execute(
                    """
                    UPDATE personal_learning_records
                    SET evidence_digests = ?, confidence = ?, status = ?,
                        observation_count = ?, last_observed_at = ?,
                        last_confirmed_at = CASE WHEN ? = 'active' THEN ? ELSE last_confirmed_at END
                    WHERE learning_id = ?
                    """,
                    (
                        json.dumps(merged),
                        max(float(exact["confidence"]), normalized_confidence),
                        status,
                        observation_count,
                        timestamp,
                        status,
                        timestamp,
                        learning_id,
                    ),
                )
            conn.commit()
        record = self.get(learning_id)
        if record is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("personal learning transaction did not persist")
        return record

    def get(self, learning_id: str) -> PersonalLearningRecord | None:
        with self._database.connection() as conn:
            row = conn.execute(
                "SELECT * FROM personal_learning_records WHERE learning_id = ?",
                (str(learning_id),),
            ).fetchone()
        return _record(row) if row is not None else None

    def list_active(self, *, subject_prefix: str = "", limit: int = 50) -> list[PersonalLearningRecord]:
        query = "SELECT * FROM personal_learning_records WHERE status = 'active'"
        params: list[object] = []
        if subject_prefix:
            query += " AND subject_key LIKE ?"
            params.append(f"{_subject_key(subject_prefix)}%")
        query += " ORDER BY last_confirmed_at DESC, learning_id ASC LIMIT ?"
        params.append(max(1, min(int(limit), 200)))
        with self._database.connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [_record(row) for row in rows]

    def recall_relevant(self, query: str, *, limit: int = 5) -> list[PersonalLearningRecord]:
        """Select a small deterministic subset of active records for one turn."""

        query_tokens = _semantic_tokens(query)
        if not query_tokens:
            return []
        ranked: list[tuple[int, str, PersonalLearningRecord]] = []
        for record in self.list_active(limit=200):
            record_tokens = _semantic_tokens(f"{record.subject_key} {record.statement}")
            overlap = query_tokens & record_tokens
            if not overlap:
                continue
            score = sum(len(token) for token in overlap)
            ranked.append((score, record.last_confirmed_at, record))
        ranked.sort(key=lambda item: (-item[0], item[1], item[2].learning_id))
        bounded_limit = max(1, min(int(limit), 10))
        return [item[2] for item in ranked[:bounded_limit]]

    def forget(self, subject_key: str) -> int:
        with self._database.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE personal_learning_records
                SET status = 'forgotten', superseded_by = ''
                WHERE subject_key = ? AND status IN ('candidate', 'active')
                """,
                (_subject_key(subject_key),),
            )
            conn.commit()
        return int(cursor.rowcount)

    def expire_candidates(self, *, older_than_days: int, now: datetime | None = None) -> int:
        cutoff = (_utc(now) - timedelta(days=max(1, int(older_than_days)))).isoformat()
        with self._database.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE personal_learning_records SET status = 'forgotten'
                WHERE status = 'candidate' AND last_observed_at < ?
                """,
                (cutoff,),
            )
            conn.commit()
        return int(cursor.rowcount)

    def project_compatibility_views(self) -> dict[str, str]:
        active = [
            {"kind": item.kind, "subject_key": item.subject_key, "statement": item.statement}
            for item in sorted(self.list_active(), key=lambda item: (item.subject_key, item.learning_id))
        ]
        json_path = self._config.data_dir / "preference_profile.json"
        payload: dict[str, object] = {}
        if json_path.exists():
            try:
                parsed = json.loads(json_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    payload = parsed
            except (OSError, json.JSONDecodeError):
                payload = {}
        payload["active_learnings"] = active
        _write_atomic(json_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

        markdown_path = self._config.reflections_dir / "personal_learning_active.md"
        lines = ["# Active Personal Learning", ""]
        lines.extend(f"- {item['subject_key']}: {item['statement']}" for item in active)
        if not active:
            lines.append("- None")
        _write_atomic(markdown_path, "\n".join(lines) + "\n")
        return {"json_path": str(json_path), "markdown_path": str(markdown_path)}


def _record(row) -> PersonalLearningRecord:
    return PersonalLearningRecord(
        learning_id=str(row["learning_id"]),
        kind=str(row["kind"]),
        subject_key=str(row["subject_key"]),
        statement=str(row["statement"]),
        source=str(row["source"]),
        evidence_digests=tuple(json.loads(row["evidence_digests"])),
        confidence=float(row["confidence"]),
        status=str(row["status"]),
        observation_count=int(row["observation_count"]),
        created_at=str(row["created_at"]),
        last_observed_at=str(row["last_observed_at"]),
        last_confirmed_at=str(row["last_confirmed_at"]),
        superseded_by=str(row["superseded_by"]),
    )


def _choice(value: str, allowed: set[str], label: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in allowed:
        raise ValueError(f"invalid personal learning {label}")
    return normalized


def _subject_key(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized or len(normalized) > 120 or not re.fullmatch(r"[a-z0-9_.:-]+", normalized):
        raise ValueError("invalid personal learning subject_key")
    return normalized


def _statement(value: str) -> str:
    normalized = " ".join(str(value or "").split()).strip()
    if not normalized or len(normalized) > 300 or _UNSAFE.search(normalized):
        raise ValueError("unsafe personal learning statement")
    return normalized


def _evidence_digests(values) -> tuple[str, ...]:
    result = tuple(dict.fromkeys(str(item).strip().lower() for item in values or ()))
    if not result or any(not re.fullmatch(r"[a-f0-9]{16,128}", item) for item in result):
        raise ValueError("invalid personal learning evidence digest")
    return result[:8]


def _semantic_tokens(value: str) -> set[str]:
    normalized = " ".join(str(value or "").lower().split())
    tokens = set(re.findall(r"[a-z0-9]{2,}", normalized))
    for segment in re.findall(r"[\u3400-\u9fff]+", normalized):
        if len(segment) == 1:
            tokens.add(segment)
        else:
            tokens.update(segment[index : index + 2] for index in range(len(segment) - 1))
    return tokens


def _utc(value: datetime | None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str:
    return _utc(value).isoformat()


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
