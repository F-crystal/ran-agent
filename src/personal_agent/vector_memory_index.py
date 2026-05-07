"""Semantic vector memory index backed by ANN search."""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
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


@dataclass(frozen=True)
class _IndexMetadata:
    signature: tuple[int, int, str]
    dimension: int
    item_count: int
    embedding_model: str
    embedding_base_url: str
    query_text_type: str
    document_text_type: str


class EmbeddingAPIClient:
    """OpenAI-compatible embeddings client."""

    def __init__(
        self,
        *,
        api_key_env_var: str,
        base_url: str,
        model: str,
        timeout_seconds: int,
        logger: logging.Logger,
    ) -> None:
        self._api_key_env_var = api_key_env_var
        self._base_url = base_url.strip().rstrip("/")
        self._model = model.strip()
        self._timeout_seconds = timeout_seconds
        self._logger = logger

    def embed_texts(self, texts: Sequence[str], *, text_type: str) -> Sequence[Sequence[float]]:
        cleaned_texts = [str(text).strip() for text in texts if str(text).strip()]
        if not cleaned_texts:
            return ()

        api_key = os.getenv(self._api_key_env_var, "").strip()
        if not api_key:
            raise RuntimeError(f"embedding api key missing env_var={self._api_key_env_var}")

        payload: dict[str, object] = {
            "model": self._model,
            "input": cleaned_texts,
        }
        if text_type.strip():
            payload["text_type"] = text_type.strip()

        request = urllib.request.Request(
            url=self._build_request_url(),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
            response_data = json.loads(response.read().decode("utf-8"))

        data = response_data.get("data", [])
        if not isinstance(data, list):
            raise RuntimeError("embedding response did not contain a data list")

        ordered_embeddings: list[tuple[int, list[float]]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            embedding = item.get("embedding")
            if not isinstance(embedding, list):
                continue
            index = int(item.get("index", len(ordered_embeddings)))
            ordered_embeddings.append((index, [float(value) for value in embedding]))

        ordered_embeddings.sort(key=lambda item: item[0])
        return [embedding for _, embedding in ordered_embeddings]

    def _build_request_url(self) -> str:
        if not self._base_url:
            return "https://api.openai.com/v1/embeddings"
        if self._base_url.endswith("/embeddings"):
            return self._base_url
        return f"{self._base_url}/embeddings"


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
        embedding_model: str | None = None,
        embedding_base_url: str | None = None,
        embedding_api_key_env_var: str | None = None,
        embedding_timeout_seconds: int | None = None,
        query_text_type: str | None = None,
        document_text_type: str | None = None,
    ) -> None:
        self._database = database
        self._logger = logger

        if config is not None:
            index_path = index_path or getattr(config, "vector_memory_index_path", None)
            metadata_path = metadata_path or getattr(config, "vector_memory_metadata_path", None)
            enabled = getattr(config, "vector_memory_enabled", enabled if enabled is not None else True)
            embedding_model = embedding_model or getattr(config, "vector_memory_embedding_model", None)
            embedding_base_url = embedding_base_url or getattr(config, "vector_memory_embedding_base_url", None)
            embedding_api_key_env_var = embedding_api_key_env_var or getattr(
                config, "vector_memory_embedding_api_key_env_var", None
            )
            query_text_type = query_text_type or "query"
            document_text_type = document_text_type or "document"
            if embedding_timeout_seconds is None:
                embedding_timeout_seconds = getattr(config, "vector_memory_embedding_timeout_seconds", 30)

        self._enabled = bool(True if enabled is None else enabled)
        self._index_path = Path(index_path or (database.config.data_dir / "vector_memory.index"))
        self._meta_path = Path(metadata_path or self._index_path.with_suffix(self._index_path.suffix + ".meta.json"))
        self._index_path.parent.mkdir(parents=True, exist_ok=True)
        self._embedding_model = embedding_model or "text-embedding-3-small"
        self._embedding_base_url = (embedding_base_url or "https://api.openai.com/v1").strip().rstrip("/")
        self._query_text_type = (query_text_type or "query").strip()
        self._document_text_type = (document_text_type or "document").strip()
        self._embedding_client = embedding_client or EmbeddingAPIClient(
            api_key_env_var=embedding_api_key_env_var or "OPENAI_API_KEY",
            base_url=self._embedding_base_url,
            model=self._embedding_model,
            timeout_seconds=embedding_timeout_seconds or 30,
            logger=logger,
        )
        self._hnswlib = hnswlib
        self._index = None
        self._dimension = 0
        self._snapshot: tuple[int, int, str] | None = None
        self._item_count = 0

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
        if not self._enabled or limit <= 0:
            return ()

        cleaned_query = str(query).strip()
        if not cleaned_query:
            return ()

        if not self._ensure_index_current():
            return ()
        if self._index is None or self._item_count <= 0:
            return ()

        try:
            query_embeddings = self._embedding_client.embed_texts([cleaned_query], text_type=self._query_text_type)
        except Exception as exc:  # pragma: no cover - defensive integration guard
            self._logger.warning("vector query embedding failed: %s", exc)
            return ()

        query_vector = self._coerce_vector(query_embeddings)
        if query_vector is None:
            return ()

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
            embeddings = self._embedding_client.embed_texts(texts, text_type=self._document_text_type)
        except Exception as exc:  # pragma: no cover - network/client guard
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
                        "embedding_base_url": self._embedding_base_url,
                        "query_text_type": self._query_text_type,
                        "document_text_type": self._document_text_type,
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


class NumpyVectorIndex:
    """Tiny cosine backend used by compatibility tests."""

    def __init__(self) -> None:
        self._vectors: np.ndarray | None = None
        self._ids: np.ndarray | None = None

    def fit(self, vectors: np.ndarray, ids: np.ndarray) -> None:
        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim != 2 or matrix.shape[0] == 0:
            self._vectors = None
            self._ids = None
            return
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self._vectors = matrix / norms
        self._ids = np.asarray(ids, dtype=np.int64)

    def search(self, vector: np.ndarray, limit: int) -> tuple[np.ndarray, np.ndarray]:
        if self._vectors is None or self._ids is None or limit <= 0:
            empty_ids = np.asarray([], dtype=np.int64)
            return empty_ids, np.asarray([], dtype=np.float32)

        query = np.asarray(vector, dtype=np.float32).reshape(1, -1)
        norm = np.linalg.norm(query, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        query = query / norm
        scores = (self._vectors @ query.T).reshape(-1)
        order = np.argsort(-scores)[: min(limit, len(scores))]
        labels = self._ids[order]
        distances = 1.0 - scores[order]
        return labels.astype(np.int64), distances.astype(np.float32)


class FileBackedMemoryVectorIndex(VectorMemoryBackend):
    """Legacy file-backed compatibility layer."""

    def __init__(
        self,
        *,
        database: Database,
        config: AppConfig,
        logger: logging.Logger,
        embedding_client: object,
        ann_backend: NumpyVectorIndex | None = None,
    ) -> None:
        self._database = database
        self._config = config
        self._logger = logger
        self._embedding_client = embedding_client
        self._ann_backend = ann_backend or NumpyVectorIndex()
        self._index_path = config.data_dir / "memory_vector_index.npy"
        self._meta_path = config.data_dir / "memory_vector_index.json"
        self._index_path.parent.mkdir(parents=True, exist_ok=True)
        self._snapshot: tuple[int, int, str] | None = None
        self._loaded = False

    def search(
        self,
        query: str,
        limit: int,
        memory_types: Sequence[str] | None = None,
    ) -> Sequence[MemoryRetrievalHit | dict[str, object]]:
        if limit <= 0:
            return ()
        cleaned_query = str(query).strip()
        if not cleaned_query:
            return ()
        if not self._ensure_index_current():
            return ()
        query_vector = self._embed_query(cleaned_query)
        if query_vector is None:
            return ()
        labels, distances = self._ann_backend.search(query_vector, limit=min(limit * 10, 32))
        if len(labels) == 0:
            return ()
        rows = self._database.get_memories_by_ids([int(label) for label in labels if int(label) > 0])
        row_map = {int(row["id"]): row for row in rows}
        hits: list[MemoryRetrievalHit] = []
        for label, distance in zip(labels, distances):
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
            hits.append(
                MemoryRetrievalHit(
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
            )
            if len(hits) >= limit:
                break
        return tuple(hits)

    def _ensure_index_current(self) -> bool:
        snapshot = self._database.get_memories_snapshot()
        if self._loaded and self._snapshot == snapshot:
            return True
        if self._load_from_disk(snapshot):
            return True
        return self._rebuild(snapshot)

    def _load_from_disk(self, snapshot: tuple[int, int, str]) -> bool:
        if not self._index_path.exists() or not self._meta_path.exists():
            return False
        try:
            metadata = json.loads(self._meta_path.read_text(encoding="utf-8"))
            if tuple(metadata.get("snapshot", ())) != tuple(snapshot):
                return False
            matrix = np.load(self._index_path)
            ids = np.asarray(metadata.get("ids", []), dtype=np.int64)
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            return False
        if matrix.ndim != 2 or matrix.shape[0] == 0 or len(ids) != matrix.shape[0]:
            return False
        self._ann_backend.fit(matrix, ids)
        self._snapshot = snapshot
        self._loaded = True
        return True

    def _rebuild(self, snapshot: tuple[int, int, str]) -> bool:
        rows = self._database.get_memories_for_vector_index()
        if not rows:
            self._remove_disk_state()
            self._ann_backend.fit(np.asarray([], dtype=np.float32).reshape(0, 0), np.asarray([], dtype=np.int64))
            self._snapshot = snapshot
            self._loaded = True
            return True

        documents = [self._memory_text_for_index(row) for row in rows]
        embeddings = self._embed_documents(documents)
        matrix = self._coerce_matrix(embeddings)
        if matrix is None:
            return False
        ids = np.asarray([int(row["id"]) for row in rows], dtype=np.int64)
        self._ann_backend.fit(matrix, ids)
        try:
            np.save(self._index_path, matrix)
            self._meta_path.write_text(
                json.dumps(
                    {
                        "snapshot": list(snapshot),
                        "ids": ids.tolist(),
                        "dimension": int(matrix.shape[1]),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError as exc:  # pragma: no cover - filesystem guard
            self._logger.warning("legacy vector index persistence failed: %s", exc)
            return False
        self._snapshot = snapshot
        self._loaded = True
        return True

    def _remove_disk_state(self) -> None:
        for path in (self._index_path, self._meta_path):
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                continue

    def _embed_documents(self, texts: Sequence[str]) -> Sequence[Sequence[float]]:
        if hasattr(self._embedding_client, "embed_documents"):
            return getattr(self._embedding_client, "embed_documents")(list(texts))
        if hasattr(self._embedding_client, "embed_texts"):
            return getattr(self._embedding_client, "embed_texts")(list(texts), text_type="document")
        raise RuntimeError("embedding client does not support document embeddings")

    def _embed_query(self, text: str) -> np.ndarray | None:
        if hasattr(self._embedding_client, "embed_query"):
            vector = getattr(self._embedding_client, "embed_query")(text)
        elif hasattr(self._embedding_client, "embed_texts"):
            vectors = getattr(self._embedding_client, "embed_texts")([text], text_type="query")
            if not vectors:
                return None
            vector = vectors[0]
        else:
            raise RuntimeError("embedding client does not support query embeddings")
        try:
            array = np.asarray([float(value) for value in vector], dtype=np.float32)
        except (TypeError, ValueError):
            return None
        if array.ndim != 1 or array.size == 0:
            return None
        norm = np.linalg.norm(array)
        if norm > 0:
            array = array / norm
        return array

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
