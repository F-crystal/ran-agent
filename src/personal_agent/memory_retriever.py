"""Lightweight local-first memory retrieval helpers."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING
from typing import Mapping, Protocol, Sequence

from personal_agent.db import Database
from personal_agent.memory import parse_memory_content, render_memory_for_prompt

if TYPE_CHECKING:
    from personal_agent.config import AppConfig


@dataclass(frozen=True)
class MemoryRetrievalHit:
    """One scored memory returned by the hybrid retriever."""

    id: int
    content: str
    memory_type: str
    importance: int
    created_at: str
    updated_at: str
    rendered_text: str
    score: float
    keyword_score: float
    importance_score: float
    recency_score: float
    matched_terms: tuple[str, ...] = ()


class VectorMemoryBackend(Protocol):
    """Future vector retrieval hook."""

    def search(
        self,
        query: str,
        limit: int,
        memory_types: Sequence[str] | None = None,
    ) -> Sequence[MemoryRetrievalHit | Mapping[str, object]]:
        """Return vector-ranked memory candidates."""


class HybridMemoryRetriever:
    """Rank local memories by keyword overlap, importance, and recency."""

    def __init__(
        self,
        database: Database,
        logger: logging.Logger,
        *,
        config: AppConfig | None = None,
        candidate_limit: int = 200,
        vector_backend: VectorMemoryBackend | None = None,
    ) -> None:
        self._database = database
        self._logger = logger
        self._candidate_limit = getattr(config, "vector_memory_candidate_limit", candidate_limit)
        self._vector_backend = vector_backend

    def retrieve(
        self,
        user_text: str,
        limit: int = 3,
        memory_types: Sequence[str] | None = None,
    ) -> tuple[MemoryRetrievalHit, ...]:
        """Return the best local memories for one user query."""

        hits, _ = self.retrieve_with_status(user_text, limit, memory_types)
        return hits

    def retrieve_with_status(
        self,
        user_text: str,
        limit: int = 3,
        memory_types: Sequence[str] | None = None,
    ) -> tuple[tuple[MemoryRetrievalHit, ...], str]:
        """Return ranked memories and the semantic backend outcome."""

        normalized_query = _normalize_text(user_text)
        if not normalized_query:
            return (), "empty"

        local_rows = self._database.get_memories_for_retrieval(
            limit=self._candidate_limit,
            memory_types=memory_types,
        )
        scored_hits = [
            self._score_row(row=row, normalized_query=normalized_query)
            for row in local_rows
        ]

        vector_hits, vector_outcome = self._vector_hits(
            user_text=user_text,
            limit=limit,
            memory_types=memory_types,
        )
        scored_hits.extend(vector_hits)

        deduped: dict[tuple[str, str], MemoryRetrievalHit] = {}
        for hit in scored_hits:
            if hit.keyword_score <= 0 and hit.score < 0.7:
                continue
            key = (hit.memory_type, _normalize_text(hit.content))
            current = deduped.get(key)
            if current is None or hit.score > current.score:
                deduped[key] = hit

        ranked_hits = sorted(
            deduped.values(),
            key=lambda item: (
                -item.score,
                -item.importance,
                -_sort_timestamp_value(item.updated_at),
                -item.id,
            ),
        )
        return tuple(ranked_hits[:limit]), vector_outcome

    def _vector_hits(
        self,
        *,
        user_text: str,
        limit: int,
        memory_types: Sequence[str] | None,
    ) -> tuple[list[MemoryRetrievalHit], str]:
        if self._vector_backend is None:
            return [], "disabled"

        try:
            candidates = self._vector_backend.search(user_text, limit, memory_types=memory_types)
        except Exception as exc:  # pragma: no cover - defensive integration guard
            self._logger.warning("vector memory retrieval failed: %s", exc)
            return [], "degraded"

        hits: list[MemoryRetrievalHit] = []
        for candidate in candidates:
            hit = self._coerce_hit(candidate)
            if hit is not None:
                hits.append(hit)
        return hits, "hit" if hits else "empty"

    def _score_row(self, row, normalized_query: str) -> MemoryRetrievalHit:
        raw_content = str(row["content"])
        rendered_text = render_memory_for_prompt(raw_content).strip()
        payload = parse_memory_content(raw_content)

        searchable_parts = [
            raw_content,
            rendered_text,
            str(row["type"]),
            str(row["importance"]),
        ]
        if payload:
            for key in ("summary", "topic", "trait", "category", "state", "time_scope"):
                value = str(payload.get(key, "")).strip()
                if value:
                    searchable_parts.append(value)

        searchable_text = _normalize_text(" ".join(part for part in searchable_parts if part))
        query_terms = _tokenize_text(normalized_query)
        memory_terms = _tokenize_text(searchable_text)
        matched_terms = tuple(sorted(query_terms & memory_terms))

        keyword_score = _keyword_score(
            normalized_query=normalized_query,
            searchable_text=searchable_text,
            matched_terms=matched_terms,
            query_term_count=len(query_terms),
        )
        importance_score = _importance_score(int(row["importance"]))
        recency_score = _recency_score(str(row["updated_at"] or row["created_at"]))
        score = round(
            0.6 * keyword_score + 0.25 * importance_score + 0.15 * recency_score,
            4,
        )
        return MemoryRetrievalHit(
            id=int(row["id"]),
            content=raw_content,
            memory_type=str(row["type"]),
            importance=int(row["importance"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            rendered_text=rendered_text or raw_content,
            score=score,
            keyword_score=round(keyword_score, 4),
            importance_score=round(importance_score, 4),
            recency_score=round(recency_score, 4),
            matched_terms=matched_terms,
        )

    def _coerce_hit(
        self,
        candidate: MemoryRetrievalHit | Mapping[str, object],
    ) -> MemoryRetrievalHit | None:
        if isinstance(candidate, MemoryRetrievalHit):
            return candidate

        try:
            raw_content = str(candidate["content"])
            rendered_text = str(candidate.get("rendered_text") or render_memory_for_prompt(raw_content)).strip()
            importance = int(candidate.get("importance", 0) or 0)
            score = float(candidate.get("score", 0.0) or 0.0)
        except (KeyError, TypeError, ValueError):
            return None

        return MemoryRetrievalHit(
            id=int(candidate.get("id", 0) or 0),
            content=raw_content,
            memory_type=str(candidate.get("memory_type") or candidate.get("type") or ""),
            importance=importance,
            created_at=str(candidate.get("created_at") or ""),
            updated_at=str(candidate.get("updated_at") or ""),
            rendered_text=rendered_text or raw_content,
            score=score,
            keyword_score=float(candidate.get("keyword_score", 0.0) or 0.0),
            importance_score=float(candidate.get("importance_score", 0.0) or 0.0),
            recency_score=float(candidate.get("recency_score", 0.0) or 0.0),
            matched_terms=_coerce_terms(candidate.get("matched_terms", ())),
        )


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", text).strip().lower()


def _tokenize_text(text: str) -> set[str]:
    tokens: set[str] = set()
    normalized = _normalize_text(text)
    if not normalized:
        return tokens

    tokens.update(re.findall(r"[a-z0-9]+", normalized))
    for chunk in re.findall(r"[\u4e00-\u9fff]+", normalized):
        if len(chunk) < 2:
            continue
        tokens.add(chunk)
        max_window = min(4, len(chunk))
        for size in range(2, max_window + 1):
            for start in range(0, len(chunk) - size + 1):
                tokens.add(chunk[start : start + size])
                if len(tokens) >= 128:
                    return tokens
    return tokens


def _keyword_score(
    *,
    normalized_query: str,
    searchable_text: str,
    matched_terms: tuple[str, ...],
    query_term_count: int,
) -> float:
    if not normalized_query:
        return 0.0

    if normalized_query in searchable_text or searchable_text in normalized_query:
        return 1.0

    coverage = len(matched_terms) / max(query_term_count, 1)
    substring_bonus = 0.0
    if matched_terms:
        substring_bonus = min(0.25, 0.05 * len(matched_terms))
    return min(1.0, coverage + substring_bonus)


def _importance_score(importance: int) -> float:
    capped = max(0, min(importance, 5))
    return capped / 5.0


def _recency_score(timestamp_value: str) -> float:
    if not timestamp_value.strip():
        return 0.5

    timestamp = _parse_timestamp(timestamp_value)
    if timestamp is None:
        return 0.5

    age_seconds = max((datetime.now() - timestamp).total_seconds(), 0.0)
    return 1.0 / (1.0 + age_seconds / 86400.0)


def _parse_timestamp(value: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _sort_timestamp_value(value: str) -> float:
    timestamp = _parse_timestamp(value)
    if timestamp is None:
        return 0.0
    return timestamp.timestamp()


def _coerce_terms(raw_terms: object) -> tuple[str, ...]:
    if isinstance(raw_terms, str):
        raw_terms = [raw_terms]
    if not isinstance(raw_terms, Sequence):
        return ()
    return tuple(str(term) for term in raw_terms if str(term).strip())
