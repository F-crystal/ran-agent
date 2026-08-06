"""Unit tests for the minimal memory extraction and storage flow."""

from __future__ import annotations

import logging
import sqlite3
import sys
import tempfile
import types
import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.interfaces.chat import IncomingMessage
from personal_agent.interfaces.model import ModelRequest, ModelResponse, PlaceholderModelClient
from personal_agent.memory import (
    build_memory_context,
    extract_profile_memory,
    extract_working_memory,
    parse_memory_content,
    render_memory_for_prompt,
    serialize_memory_content,
)
from personal_agent.memory_llm import LLMMemoryExtractor
from personal_agent.memory_retriever import HybridMemoryRetriever
from personal_agent.service import PersonalAgentService
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.vector_memory_index import (
    FastEmbedClient,
    VectorMemoryIndex,
)


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated memory tests."""

    logger = logging.getLogger("personal_agent.tests.memory")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class MemoryFlowTest(unittest.TestCase):
    """Covers memory extraction, storage, ordering, and migration behavior."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = make_test_config(
            base_dir,
            working_memory_retention_limit=2,
            profile_memory_history_limit=10,
            profile_memory_repeat_threshold=2,
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()
        self.service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="test system prompt",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_enabled_memory_llm_uses_the_existing_model_client(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=replace(self.config, memory_llm_enabled=True),
        )
        self.addCleanup(service.shutdown)

        self.assertIsInstance(service._memory_extractor, LLMMemoryExtractor)

    def test_fastembed_client_uses_local_query_and_document_paths(self) -> None:
        calls = []

        class FakeTextEmbedding:
            def __init__(self, **kwargs):
                calls.append(("init", kwargs))

            def query_embed(self, texts):
                calls.append(("query", list(texts)))
                return ([1.0, 0.0] for _ in texts)

            def embed(self, texts):
                calls.append(("document", list(texts)))
                return ([0.0, 1.0] for _ in texts)

        fake_module = types.ModuleType("fastembed")
        fake_module.TextEmbedding = FakeTextEmbedding
        client = FastEmbedClient(cache_dir=self.config.data_dir / "fastembed_cache")

        with patch.dict(sys.modules, {"fastembed": fake_module}):
            self.assertEqual(client.embed_texts(["查询"], text_type="query"), ((1.0, 0.0),))
            self.assertEqual(client.embed_texts(["文档"], text_type="document"), ((0.0, 1.0),))

        self.assertEqual(calls[0][0], "init")
        self.assertTrue(calls[0][1]["local_files_only"])
        self.assertEqual([call[0] for call in calls], ["init", "query", "document"])

    def test_llm_memory_extractor_returns_structured_working_memory(self) -> None:
        class JsonModelClient:
            def generate_reply(self, request: ModelRequest) -> ModelResponse:
                self.last_request = request
                return ModelResponse(
                    text=(
                        '{"decision":"working","memory":{"layer":"working","type":"working",'
                        '"category":"task_state","topic":"论文","summary":"用户今天在处理论文，情绪有些烦躁",'
                        '"evidence":"今天一直在改论文，越改越烦","confidence":0.88,"ttl_days":7}}'
                    ),
                    provider="test-llm",
                )

        extractor = LLMMemoryExtractor(
            model_client=JsonModelClient(),
            logger=self.logger,
            config=replace(self.config, memory_llm_enabled=True),
        )

        result = extractor.extract(
            user_text="今天一直在改论文，越改越烦",
            recent_history=["昨天也在改论文"],
        )

        self.assertEqual(result.decision, "working")
        self.assertFalse(result.should_fallback)
        assert result.memory is not None
        self.assertEqual(result.memory["type"], "working")
        self.assertEqual(result.memory["topic"], "论文")
        self.assertEqual(result.memory["confidence"], 0.88)
        self.assertEqual(result.memory["ttl_days"], 7)

    def test_llm_memory_extractor_requests_fallback_for_invalid_json(self) -> None:
        class InvalidJsonModelClient:
            def generate_reply(self, request: ModelRequest) -> ModelResponse:
                return ModelResponse(text="not json", provider="test-llm")

        extractor = LLMMemoryExtractor(
            model_client=InvalidJsonModelClient(),
            logger=self.logger,
            config=replace(self.config, memory_llm_enabled=True),
        )

        result = extractor.extract(
            user_text="今天一直在改论文，越改越烦",
            recent_history=[],
        )

        self.assertEqual(result.decision, "skip")
        self.assertTrue(result.should_fallback)
        self.assertIsNone(result.memory)

    def test_extract_working_memory_summarizes_current_state(self) -> None:
        memory = extract_working_memory("今天一直在改论文，越改越烦")

        self.assertEqual(
            memory,
            {
                "type": "working",
                "time_scope": "today",
                "topic": "处理论文",
                "state": "情绪有些烦躁",
                "summary": "用户今天在处理论文，情绪有些烦躁",
            },
        )

    def test_extract_working_memory_keeps_explicit_project_decision(self) -> None:
        memory = extract_working_memory(
            "我决定把 Hermes 升级到 v0.20 作为统一前台运行时"
        )

        self.assertEqual(memory["topic"], "项目决策")
        self.assertIn("Hermes", memory["summary"])

    def test_extract_profile_memory_requires_repeat_before_writing(self) -> None:
        first_result = extract_profile_memory(
            "我平时喜欢晚上散步",
            history=["昨天加班到很晚"],
            repeat_threshold=2,
        )
        second_result = extract_profile_memory(
            "我平时喜欢晚上散步",
            history=["我平时喜欢晚上散步", "昨天加班到很晚"],
            repeat_threshold=2,
        )

        self.assertIsNone(first_result)
        self.assertEqual(
            second_result,
            {
                "type": "profile",
                "category": "habit",
                "trait": "喜欢晚上散步",
                "summary": "用户平时喜欢晚上散步",
            },
        )

    def test_memory_context_omits_empty_sections(self) -> None:
        profile_only = build_memory_context(
            profile_memories=[
                serialize_memory_content(
                    {
                        "type": "profile",
                        "category": "preference",
                        "trait": "安静一点的环境",
                        "summary": "用户喜欢安静一点的环境",
                    }
                )
            ],
            working_memories=[],
        )
        working_only = build_memory_context(
            profile_memories=[],
            working_memories=[
                serialize_memory_content(
                    {
                        "type": "working",
                        "time_scope": "recent",
                        "topic": "处理论文",
                        "state": "情绪有些烦躁",
                        "summary": "用户最近在处理论文，情绪有些烦躁",
                    }
                )
            ],
        )

        self.assertIn("【你对用户的了解】", profile_only)
        self.assertNotIn("【用户当前状态（近期）】", profile_only)
        self.assertNotIn("【你对用户的了解】", working_only)
        self.assertIn("【用户当前状态（近期）】", working_only)

    def test_service_writes_working_and_profile_memories(self) -> None:
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="我平时喜欢晚上散步")
        )
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="我平时喜欢晚上散步")
        )
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="今天一直在改论文，越改越烦")
        )

        profile_memories = self.database.get_profile_memories(limit=5)
        working_memories = self.database.get_working_memories(limit=5)

        self.assertEqual(len(profile_memories), 1)
        self.assertEqual(
            [parse_memory_content(str(row["content"])) for row in profile_memories],
            [
                {
                    "type": "profile",
                    "category": "habit",
                    "trait": "喜欢晚上散步",
                    "summary": "用户平时喜欢晚上散步",
                }
            ],
        )
        self.assertEqual(
            [parse_memory_content(str(row["content"])) for row in working_memories],
            [
                {
                    "type": "working",
                    "time_scope": "today",
                    "topic": "处理论文",
                    "state": "情绪有些烦躁",
                    "summary": "用户今天在处理论文，情绪有些烦躁",
                }
            ],
        )

    def test_service_uses_llm_memory_result_when_available(self) -> None:
        class StaticMemoryExtractor:
            def extract(self, user_text: str, recent_history: list[str]):
                from personal_agent.memory_llm import MemoryExtractionResult

                return MemoryExtractionResult(
                    decision="profile",
                    memory={
                        "type": "profile",
                        "layer": "profile",
                        "category": "preference",
                        "topic": "安静环境",
                        "summary": "对安静一点的环境会更舒服",
                        "evidence": "我还是喜欢安静一点的环境",
                        "confidence": 0.82,
                        "ttl_days": 90,
                    },
                    source="llm",
                )

        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="test system prompt",
            memory_extractor=StaticMemoryExtractor(),
        )

        service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="我还是喜欢安静一点的环境")
        )

        profile_memories = self.database.get_profile_memories(limit=5)
        self.assertEqual(len(profile_memories), 1)
        parsed = parse_memory_content(str(profile_memories[0]["content"]))
        assert parsed is not None
        self.assertEqual(parsed["topic"], "安静环境")
        self.assertEqual(parsed["confidence"], 0.82)

    def test_service_falls_back_to_rule_based_memory_when_llm_extractor_fails(self) -> None:
        class FallbackExtractor:
            def extract(self, user_text: str, recent_history: list[str]):
                from personal_agent.memory_llm import MemoryExtractionResult

                return MemoryExtractionResult(
                    decision="skip",
                    memory=None,
                    source="llm",
                    should_fallback=True,
                )

        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="test system prompt",
            memory_extractor=FallbackExtractor(),
        )

        service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="今天一直在改论文，越改越烦")
        )

        working_memories = self.database.get_working_memories(limit=5)
        self.assertEqual(len(working_memories), 1)
        parsed = parse_memory_content(str(working_memories[0]["content"]))
        self.assertEqual(
            parsed,
            {
                "type": "working",
                "time_scope": "today",
                "topic": "处理论文",
                "state": "情绪有些烦躁",
                "summary": "用户今天在处理论文，情绪有些烦躁",
            },
        )

    def test_memory_reading_uses_expected_sort_order(self) -> None:
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "preference",
                    "trait": "独处",
                    "summary": "用户喜欢独处",
                }
            ),
            "profile",
            importance=1,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "稳定关系",
                    "summary": "用户重视稳定关系",
                }
            ),
            "profile",
            importance=3,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "working",
                    "time_scope": "recent",
                    "topic": "准备考试",
                    "state": "",
                    "summary": "用户最近在准备考试",
                }
            ),
            "working",
            importance=1,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "working",
                    "time_scope": "today",
                    "topic": "",
                    "state": "有些疲惫",
                    "summary": "用户今天有些疲惫",
                }
            ),
            "working",
            importance=1,
        )

        profile_memories = self.database.get_profile_memories(limit=5)
        working_memories = self.database.get_working_memories(limit=5)

        self.assertEqual(
            [render_memory_for_prompt(str(row["content"])) for row in profile_memories],
            ["看起来会把稳定关系看得很重", "看起来对独处是有明显偏好的"],
        )
        rendered_working = [render_memory_for_prompt(str(row["content"])) for row in working_memories]
        self.assertIn("今天", rendered_working[0])
        self.assertIn("疲惫", rendered_working[0])
        self.assertIn("准备考试", rendered_working[1])

    def test_hybrid_memory_retriever_ranks_keyword_importance_and_recency(self) -> None:
        older_ts = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d %H:%M:%S")
        newer_ts = (datetime.now() - timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S")

        first_id = self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩",
                }
            ),
            "profile",
            importance=1,
        )
        second_id = self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩并且推进顺利",
                }
            ),
            "profile",
            importance=5,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "preference",
                    "trait": "安静一点的环境",
                    "summary": "用户喜欢安静一点的环境",
                }
            ),
            "profile",
            importance=5,
        )

        with self.database.connection() as conn:
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (older_ts, first_id))
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (newer_ts, second_id))
            conn.execute("UPDATE memories SET updated_at = ? WHERE type = 'profile' AND id != ?", (newer_ts, second_id))
            conn.commit()

        retriever = HybridMemoryRetriever(database=self.database, logger=self.logger)
        hits = retriever.retrieve("今天答辩有点紧张", limit=2, memory_types=("profile",))

        self.assertEqual(len(hits), 2)
        self.assertIn("推进顺利", hits[0].content)
        self.assertIn("答辩", hits[0].rendered_text)
        self.assertIn("答辩", hits[1].rendered_text)
        self.assertGreater(hits[0].score, hits[1].score)
        self.assertGreater(hits[0].importance_score, hits[1].importance_score)

    def test_memory_specialist_uses_hybrid_retriever_for_associations(self) -> None:
        older_ts = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d %H:%M:%S")
        newer_ts = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")

        first_id = self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩",
                }
            ),
            "profile",
            importance=1,
        )
        second_id = self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩并且推进顺利",
                }
            ),
            "profile",
            importance=5,
        )
        with self.database.connection() as conn:
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (older_ts, first_id))
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (newer_ts, second_id))
            conn.commit()

        specialist = MemorySpecialist(
            database=self.database,
            logger=self.logger,
            config=self.config,
        )

        recall = specialist.recall_for_turn(
            user_text="今天答辩有点紧张",
            route="text_chat",
            response_mode="casual_chat",
        )

        self.assertTrue(recall.should_inject)
        self.assertGreaterEqual(len(recall.topic_associations), 1)
        self.assertIn("答辩", recall.topic_associations[0])

    def test_vector_memory_index_persists_and_reuses_document_embeddings(self) -> None:
        class FakeEmbeddingClient:
            def __init__(self) -> None:
                self.document_calls = 0
                self.query_calls = 0

            def embed_texts(self, texts, *, text_type):
                if text_type == "document":
                    self.document_calls += 1
                else:
                    self.query_calls += 1
                return [self._embed(text) for text in texts]

            @staticmethod
            def _embed(text: str) -> list[float]:
                normalized = text.lower()
                if "散步" in normalized or "走走" in normalized:
                    return [1.0, 0.0, 0.0]
                if "答辩" in normalized:
                    return [0.0, 1.0, 0.0]
                return [0.0, 0.0, 1.0]

        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "habit",
                    "trait": "喜欢散步",
                    "summary": "用户平时喜欢散步",
                }
            ),
            "profile",
            importance=4,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩",
                }
            ),
            "profile",
            importance=3,
        )

        embedder = FakeEmbeddingClient()
        index = VectorMemoryIndex(
            database=self.database,
            logger=self.logger,
            index_path=self.config.vector_memory_index_path,
            metadata_path=self.config.vector_memory_metadata_path,
            embedding_client=embedder,
            enabled=True,
        )

        first_hits = index.search("晚上出去走走会放松一点", limit=1)
        second_hits = index.search("晚上出去走走会放松一点", limit=1)

        self.assertEqual(len(first_hits), 1)
        self.assertEqual(first_hits[0].memory_type, "profile")
        self.assertIn("散步", first_hits[0].rendered_text)
        self.assertEqual(second_hits[0].id, first_hits[0].id)
        self.assertEqual(embedder.document_calls, 1)
        self.assertEqual(embedder.query_calls, 2)
        self.assertTrue((self.config.data_dir / "memory_vector_index.json").exists())
        self.assertTrue(self.config.vector_memory_index_path.exists())

    def test_hybrid_memory_retriever_can_return_vector_hit_without_keyword_overlap(self) -> None:
        class FakeEmbeddingClient:
            def embed_texts(self, texts, *, text_type):
                if text_type == "query":
                    return [[1.0, 0.0]]
                return [[1.0, 0.0], [0.0, 1.0]]

        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "habit",
                    "trait": "夜里散步",
                    "summary": "用户习惯夜里散步来放松",
                }
            ),
            "profile",
            importance=4,
        )
        self.database.store_memory(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "value",
                    "trait": "答辩",
                    "summary": "用户最近在准备答辩",
                }
            ),
            "profile",
            importance=3,
        )

        vector_backend = VectorMemoryIndex(
            database=self.database,
            logger=self.logger,
            index_path=self.config.vector_memory_index_path,
            metadata_path=self.config.vector_memory_metadata_path,
            embedding_client=FakeEmbeddingClient(),
            enabled=True,
        )
        retriever = HybridMemoryRetriever(
            database=self.database,
            logger=self.logger,
            vector_backend=vector_backend,
        )

        hits = retriever.retrieve("出去走走放空一下", limit=1, memory_types=("profile",))

        self.assertEqual(len(hits), 1)
        self.assertIn("散步", hits[0].rendered_text)
        self.assertGreaterEqual(hits[0].score, 0.7)

    def test_working_memory_retention_keeps_recent_items(self) -> None:
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="今天在准备答辩，心里有点慌")
        )
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="最近一直在处理工作，脑子有点乱")
        )
        self.service.handle_incoming_message(
            IncomingMessage(channel="wechat", sender_id="u1", text="今天开会开得有点累")
        )

        working_memories = self.database.get_working_memories(limit=10)

        self.assertEqual(len(working_memories), 2)
        rendered = [render_memory_for_prompt(str(row["content"])) for row in working_memories]
        self.assertIn("开会", rendered[0])
        self.assertTrue(any(marker in rendered[0] for marker in ("疲惫", "有点累")))
        self.assertIn("处理工作", rendered[1])
        self.assertIn("乱", rendered[1])

    def test_database_initialize_migrates_legacy_memories_table(self) -> None:
        legacy_path = self.config.database_path
        if legacy_path.exists():
            legacy_path.unlink()
        self.config.data_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(legacy_path)
        conn.execute(
            """
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '',
                importance INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()
        conn.close()

        migrated_database = Database(self.config, self.logger)
        migrated_database.initialize()
        migrated_database.store_memory("用户平时喜欢散步", "profile", importance=2)

        rows = migrated_database.get_profile_memories(limit=5)
        self.assertEqual([row["content"] for row in rows], ["用户平时喜欢散步"])

    def test_json_memory_is_rendered_to_prompt_text(self) -> None:
        json_content = serialize_memory_content(
            {
                "type": "working",
                "time_scope": "recent",
                "topic": "处理论文",
                "state": "情绪有些烦躁",
                "summary": "用户最近在处理论文，情绪有些烦躁",
            }
        )

        rendered = render_memory_for_prompt(json_content)
        self.assertIn("处理论文", rendered)
        self.assertTrue(
            any(marker in rendered for marker in ("最近", "这段时间", "精力", "状态"))
        )
        self.assertTrue(
            any(marker in rendered for marker in ("烦躁", "情绪", "有点烦"))
        )

    def test_legacy_plain_text_memory_still_works(self) -> None:
        legacy_content = "用户最近睡得晚。"

        self.assertIsNone(parse_memory_content(legacy_content))
        self.assertEqual(render_memory_for_prompt(legacy_content), "用户最近睡得晚。")

    def test_profile_memory_rendering_uses_natural_non_label_language(self) -> None:
        rendered = render_memory_for_prompt(
            serialize_memory_content(
                {
                    "type": "profile",
                    "category": "preference",
                    "trait": "安静一点的环境",
                    "summary": "用户喜欢安静一点的环境",
                }
            )
        )

        self.assertIn("安静一点的环境", rendered)
        self.assertNotEqual(rendered, "用户喜欢安静一点的环境")
        self.assertFalse(rendered.startswith("用户"))

    def test_working_memory_rendering_has_multiple_natural_variants(self) -> None:
        rendered_one = render_memory_for_prompt(
            serialize_memory_content(
                {
                    "type": "working",
                    "time_scope": "today",
                    "topic": "处理论文",
                    "state": "情绪有些烦躁",
                    "summary": "用户今天在处理论文，情绪有些烦躁",
                }
            )
        )
        rendered_two = render_memory_for_prompt(
            serialize_memory_content(
                {
                    "type": "working",
                    "time_scope": "recent",
                    "topic": "处理论文",
                    "state": "情绪有些烦躁",
                    "summary": "用户最近在处理论文，情绪有些烦躁",
                }
            )
        )

        self.assertNotEqual(rendered_one, rendered_two)
        self.assertIn("处理论文", rendered_one)
        self.assertIn("处理论文", rendered_two)


if __name__ == "__main__":
    unittest.main()
