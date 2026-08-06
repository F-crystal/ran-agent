"""Semantic vector memory index backed by ANN search."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Protocol, Sequence

import numpy as np

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.memory import render_memory_for_prompt
from personal_agent.memory_retriever import MemoryRetrievalHit, VectorMemoryBackend

try:  # pragma: no cover - import availability is environment-dependent
    import hnswlib
except ImportError:  # pragma: no cover - safe fallback
    hnswlib = None


class EmbeddingClient(Protocol):
    """Minimal embedding client contract."""

    def embed_texts(self, texts: Sequence[str], *, text_type: str) -> Sequence[Sequence[float]]:
        """Return one embedding per input text."""


FASTEMBED_MODEL = "BAAI/bge-small-zh-v1.5"


class FastEmbedClient:
    """Free local Chinese embeddings via Qdrant's maintained ONNX runtime."""

    def __init__(self, *, cache_dir: Path) -> None:
        self._cache_dir = cache_dir
        self._model = None

    def embed_texts(self, texts: Sequence[str], *, text_type: str) -> Sequence[Sequence[float]]:
        cleaned_texts = [str(text).strip() for text in texts if str(text).strip()]
        if not cleaned_texts:
            return ()
        if self._model is None:
            from fastembed import TextEmbedding

            extracted_model = self._cache_dir / "fast-bge-small-zh-v1.5"
            self._model = TextEmbedding(
                model_name=FASTEMBED_MODEL,
                cache_dir=str(self._cache_dir),
                local_files_only=True,
                threads=2,
                **(
                    {"specific_model_path": str(extracted_model)}
                    if extracted_model.is_dir()
                    else {}
                ),
            )
        vectors = (
            self._model.query_embed(cleaned_texts)
            if text_type == "query"
            else self._model.embed(cleaned_texts)
        )
        return tuple(tuple(float(value) for value in vector) for vector in vectors)


class VectorMemoryIndex(VectorMemoryBackend):
    """Primary ANN-backed semantic memory index."""

    def __init__(
        self,
        *,
        database: Database,
        logger: logging.Logger,
        config: AppConfig | None = None,
        index_path: Path | None = None,
        metadata_path: Path | None = None,
        embedding_client: EmbeddingClient | None = None,
        enabled: bool | None = None,
    ) -> None:
        self._database = database
        self._logger = logger

        if config is not None:
            index_path = index_path or getattr(config, "vector_memory_index_path", None)
            metadata_path = metadata_path or getattr(config, "vector_memory_metadata_path", None)
            enabled = getattr(config, "vector_memory_enabled", enabled if enabled is not None else True)

        self._enabled = bool(True if enabled is None else enabled)
        self._index_path = Path(index_path or (database.config.data_dir / "vector_memory.index"))
        self._meta_path = Path(metadata_path or self._index_path.with_suffix(self._index_path.suffix + ".meta.json"))
        self._index_path.parent.mkdir(parents=True, exist_ok=True)
        self._embedding_model = FASTEMBED_MODEL
        self._embedding_client = embedding_client or FastEmbedClient(
            cache_dir=database.config.data_dir / "fastembed_cache",
        )
        self._hnswlib = hnswlib
        self._index = None
        self._dimension = 0
        self._snapshot: tuple[int, int, str] | None = None
        self._item_count = 0
        self._lock = RLock()

        if not self._enabled:
            self._logger.info("vector memory index disabled")
        elif self._hnswlib is None:
            self._logger.warning("vector memory index unavailable because hnswlib could not be imported")

    def search(
        self,
        query: str,
        limit: int,
        memory_types: Sequence[str] | None = None,
    ) -> Sequence[MemoryRetrievalHit | dict[str, object]]:
        with self._lock:
            return self._search(query, limit, memory_types)

    def _search(
        self,
        query: str,
        limit: int,
        memory_types: Sequence[str] | None,
    ) -> Sequence[MemoryRetrievalHit | dict[str, object]]:
        if not self._enabled or limit <= 0:
            return ()

        cleaned_query = str(query).strip()
        if not cleaned_query:
            return ()

        if not self._ensure_index_current():
            raise RuntimeError("vector index unavailable")
        if self._index is None or self._item_count <= 0:
            return ()

        try:
            query_embeddings = self._embedding_client.embed_texts([cleaned_query], text_type="query")
        except Exception as exc:  # pragma: no cover - defensive integration guard
            raise RuntimeError("vector query embedding failed") from exc

        query_vector = self._coerce_vector(query_embeddings)
        if query_vector is None:
            raise RuntimeError("vector query embedding invalid")

        search_limit = min(self._item_count, max(limit * 10, limit + 10))
        labels, distances = self._index.knn_query(query_vector, k=search_limit)
        if len(labels) == 0:
            return ()

        candidate_ids = [int(label) for label in labels[0] if int(label) > 0]
        if not candidate_ids:
            return ()

        rows = self._database.get_memories_by_ids(candidate_ids)
        row_map = {int(row["id"]): row for row in rows}
        hits: list[MemoryRetrievalHit] = []
        for label, distance in zip(labels[0], distances[0]):
            memory_id = int(label)
            if memory_id <= 0:
                continue
            row = row_map.get(memory_id)
            if row is None:
                continue
            if memory_types and str(row["type"]) not in memory_types:
                continue
            rendered_text = render_memory_for_prompt(str(row["content"])).strip()
            similarity = max(0.0, min(1.0, 1.0 - float(distance)))
            hit = MemoryRetrievalHit(
                id=memory_id,
                content=str(row["content"]),
                memory_type=str(row["type"]),
                importance=int(row["importance"]),
                created_at=str(row["created_at"]),
                updated_at=str(row["updated_at"]),
                rendered_text=rendered_text or str(row["content"]),
                score=round(
                    min(
                        1.0,
                        0.8 * similarity
                        + 0.12 * _importance_score(int(row["importance"]))
                        + 0.08 * _recency_score(str(row["updated_at"] or row["created_at"])),
                    ),
                    4,
                ),
                keyword_score=0.0,
                importance_score=_importance_score(int(row["importance"])),
                recency_score=_recency_score(str(row["updated_at"] or row["created_at"])),
                matched_terms=(),
            )
            hits.append(hit)
            if len(hits) >= limit:
                break
        return tuple(hits)

    def _ensure_index_current(self) -> bool:
        snapshot = self._database.get_memories_snapshot()
        if self._index is not None and self._snapshot == snapshot:
            return True
        if self._load_persisted_index(snapshot):
            return True
        return self._rebuild_index(snapshot)

    def _load_persisted_index(self, snapshot: tuple[int, int, str]) -> bool:
        if self._hnswlib is None or not self._index_path.exists() or not self._meta_path.exists():
            return False

        try:
            metadata = json.loads(self._meta_path.read_text(encoding="utf-8"))
            if tuple(metadata.get("signature", ())) != tuple(snapshot):
                return False
            if metadata.get("embedding_model") != self._embedding_model:
                return False
            index_dimension = int(metadata.get("dimension", 0))
            item_count = int(metadata.get("item_count", 0))
            if index_dimension <= 0 or item_count <= 0:
                return False
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return False

        try:
            index = self._hnswlib.Index(space="cosine", dim=index_dimension)
            index.init_index(max_elements=max(item_count, 1), ef_construction=200, M=16)
            index.load_index(str(self._index_path))
            index.set_ef(min(max(item_count, 1), 64))
        except Exception as exc:  # pragma: no cover - filesystem or binary guard
            self._logger.warning("vector index load failed: %s", exc)
            return False

        self._index = index
        self._dimension = index_dimension
        self._snapshot = snapshot
        self._item_count = item_count
        return True

    def _rebuild_index(self, snapshot: tuple[int, int, str]) -> bool:
        if self._hnswlib is None:
            return False

        rows = self._database.get_memories_for_vector_index()
        if not rows:
            self._clear_persisted_index()
            self._index = None
            self._dimension = 0
            self._snapshot = snapshot
            self._item_count = 0
            return True

        texts = [self._memory_text_for_index(row) for row in rows]
        try:
            embeddings = self._embedding_client.embed_texts(texts, text_type="document")
        except Exception as exc:  # pragma: no cover - local model/runtime guard
            self._logger.warning("vector index build embedding failed: %s", exc)
            return False

        matrix = self._coerce_matrix(embeddings)
        if matrix is None:
            return False

        ids = np.asarray([int(row["id"]) for row in rows], dtype=np.int64)
        index = self._hnswlib.Index(space="cosine", dim=int(matrix.shape[1]))
        index.init_index(max_elements=len(rows), ef_construction=200, M=16)
        index.add_items(matrix, ids)
        index.set_ef(min(max(len(rows), 1), 64))

        try:
            index.save_index(str(self._index_path))
            self._meta_path.write_text(
                json.dumps(
                    {
                        "signature": list(snapshot),
                        "dimension": int(matrix.shape[1]),
                        "item_count": len(rows),
                        "embedding_model": self._embedding_model,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError as exc:  # pragma: no cover - filesystem guard
            self._logger.warning("vector index persistence failed: %s", exc)
            return False

        self._index = index
        self._dimension = int(matrix.shape[1])
        self._snapshot = snapshot
        self._item_count = len(rows)
        return True

    def _clear_persisted_index(self) -> None:
        for path in (self._index_path, self._meta_path):
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                continue

    def _coerce_vector(self, embeddings: Sequence[Sequence[float]]) -> np.ndarray | None:
        if not embeddings:
            return None
        try:
            vector = np.asarray([float(value) for value in embeddings[0]], dtype=np.float32)
        except (TypeError, ValueError):
            return None
        if vector.ndim != 1 or vector.size == 0:
            return None
        if self._dimension and vector.size != self._dimension:
            return None
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm
        return vector

    def _coerce_matrix(self, embeddings: Sequence[Sequence[float]]) -> np.ndarray | None:
        try:
            matrix = np.asarray([[float(value) for value in embedding] for embedding in embeddings], dtype=np.float32)
        except (TypeError, ValueError):
            return None
        if matrix.ndim != 2 or matrix.shape[0] == 0 or matrix.shape[1] == 0:
            return None
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return matrix / norms

    def _memory_text_for_index(self, row) -> str:
        rendered = render_memory_for_prompt(str(row["content"])).strip()
        return rendered or str(row["content"]).strip()


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
