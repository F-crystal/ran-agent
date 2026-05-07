"""Lightweight vault knowledge retrieval for chat-time context injection."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from personal_agent.config import AppConfig


@dataclass(frozen=True)
class KnowledgeHit:
    path: str
    title: str
    snippet: str
    score: float


class KnowledgeRetriever:
    """Read-only keyword-based vault retriever with low runtime overhead."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config

    def retrieve(self, user_text: str, limit: int | None = None) -> tuple[KnowledgeHit, ...]:
        query = _normalize_text(user_text)
        if not query:
            return ()
        resolved_limit = self._config.knowledge_recall_limit if limit is None else limit
        if resolved_limit <= 0:
            return ()
        query_terms = _tokenize(query)
        if not query_terms:
            return ()

        candidates: list[KnowledgeHit] = []
        for path in self._iter_candidate_files():
            try:
                raw = path.read_text(encoding="utf-8")
            except OSError:
                continue
            title = _extract_title(raw, path)
            snippet = _extract_snippet(raw)
            searchable = _normalize_text(f"{title}\n{snippet}")
            matched_terms = query_terms & _tokenize(searchable)
            if not matched_terms:
                continue
            score = len(matched_terms) / max(len(query_terms), 1)
            if query in searchable:
                score += 0.5
            candidates.append(
                KnowledgeHit(
                    path=str(path.relative_to(self._config.vault_dir)),
                    title=title,
                    snippet=snippet[: self._config.knowledge_snippet_max_chars],
                    score=round(score, 4),
                )
            )

        ranked = sorted(candidates, key=lambda item: (-item.score, item.path))
        return tuple(ranked[:resolved_limit])

    def _iter_candidate_files(self):
        wiki_dir = self._config.vault_dir / "wiki"
        if not wiki_dir.exists():
            return []
        return [
            path
            for path in wiki_dir.rglob("*.md")
            if path.is_file() and all(not part.startswith(".") for part in path.parts)
        ]


def _extract_title(raw: str, path: Path) -> str:
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return path.stem


def _extract_snippet(raw: str) -> str:
    lines = [line.strip() for line in raw.splitlines() if line.strip() and not line.strip().startswith("#")]
    return " ".join(lines[:8]).strip()


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).strip().lower()


def _tokenize(text: str) -> set[str]:
    tokens: set[str] = set()
    normalized = _normalize_text(text)
    if not normalized:
        return tokens
    tokens.update(re.findall(r"[a-z0-9]+", normalized))
    for chunk in re.findall(r"[\u4e00-\u9fff]+", normalized):
        if len(chunk) < 2:
            continue
        tokens.add(chunk)
        for size in range(2, min(len(chunk), 4) + 1):
            for start in range(0, len(chunk) - size + 1):
                tokens.add(chunk[start:start + size])
                if len(tokens) >= 128:
                    return tokens
    return tokens
