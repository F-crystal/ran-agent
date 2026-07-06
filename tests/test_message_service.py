"""Unit tests for the minimal personal-agent message service flow."""

from __future__ import annotations

import logging
import tempfile
import unittest
import dataclasses
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.interfaces.chat import IncomingMessage, OutgoingMessage
from personal_agent.interfaces.model import ModelRequest, ModelResponse, PlaceholderModelClient
from personal_agent.knowledge_agent import KnowledgeState, save_knowledge_state
from personal_agent.life_loop import LifeOpportunity
from personal_agent.memory import build_memory_context
from personal_agent.memory_llm import MemoryExtractionResult
from personal_agent.service import PersonalAgentService


def build_test_logger() -> logging.Logger:
    """Create a quiet logger for isolated service tests."""

    logger = logging.getLogger("personal_agent.tests.message_service")
    logger.handlers.clear()
    logger.addHandler(logging.NullHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class CapturingModelClient:
    """Test double that records the last model request."""

    def __init__(self) -> None:
        self.last_request: ModelRequest | None = None

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        self.last_request = request
        return ModelResponse(text="test reply", provider="test")


class NamedCapturingModelClient:
    """Test double that records which path handled the request."""

    def __init__(self, provider: str, reply_text: str) -> None:
        self.provider = provider
        self.reply_text = reply_text
        self.last_request: ModelRequest | None = None

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        self.last_request = request
        return ModelResponse(text=self.reply_text, provider=self.provider)


class SequentialModelClient:
    """Test double that returns a sequence of replies for review retry tests."""

    def __init__(self, replies: list[str], provider: str = "test") -> None:
        self._replies = replies
        self.provider = provider
        self.requests: list[ModelRequest] = []

    def generate_reply(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(request)
        index = min(len(self.requests) - 1, len(self._replies) - 1)
        return ModelResponse(text=self._replies[index], provider=self.provider)


class NoopFallbackMemoryExtractor:
    """Test helper that skips LLM extraction and forces rule fallback without model calls."""

    def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
        return MemoryExtractionResult(
            decision="skip",
            memory=None,
            source="test",
            should_fallback=True,
        )


class StubOutboundClient:
    """Test double that records proactive sends without any network call."""

    def __init__(self) -> None:
        self.sent_texts: list[str] = []
        self.events: list[dict[str, object]] = []

    def send_text(self, text: str, **_: object) -> dict[str, object]:
        self.sent_texts.append(text)
        return {"ok": True}

    def send_proactive_event(self, event: dict[str, object]) -> dict[str, object]:
        self.events.append(event)
        return {"ok": True, "status": "sent", "notified": True}


class PersonalAgentServiceTest(unittest.TestCase):
    """Covers the core local message flow without external integrations."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.config = AppConfig(
            base_dir=base_dir,
            data_dir=base_dir / "data",
            logs_dir=base_dir / "logs",
            vault_dir=base_dir / "vault",
            database_path=base_dir / "data" / "personal_agent.db",
            log_file_path=base_dir / "logs" / "personal_agent.log",
        )
        self.logger = build_test_logger()
        self.database = Database(self.config, self.logger)
        self.database.initialize()
        self.service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_handle_incoming_message_records_user_and_reply_events(self) -> None:
        message = IncomingMessage(
            channel="test_channel",
            sender_id="user-123",
            text="今天想散步一下",
        )

        reply = self.service.handle_incoming_message(message)
        events = self.database.fetch_timeline_events()

        self.assertIsInstance(reply, OutgoingMessage)
        self.assertEqual(reply.channel, "test_channel")
        self.assertEqual(reply.recipient_id, "user-123")
        self.assertTrue(reply.text.startswith("收到。这是本地占位回复："))
        self.assertIn("今天想散步一下", reply.text)

        self.assertEqual(len(events), 2)

        user_event = events[0]
        self.assertEqual(user_event["source"], "test_channel")
        self.assertEqual(user_event["event_type"], "user_message")
        self.assertEqual(user_event["content"], "今天想散步一下")
        self.assertEqual(user_event["tags"], "message,user")

        reply_event = events[1]
        self.assertEqual(reply_event["source"], "agent")
        self.assertEqual(reply_event["event_type"], "agent_reply")
        self.assertEqual(reply_event["content"], reply.text)
        self.assertEqual(reply_event["tags"], "message,reply,test_channel")

    def test_placeholder_model_client_returns_non_empty_reply_for_blank_text(self) -> None:
        message = IncomingMessage(
            channel="test_channel",
            sender_id="user-blank",
            text="   ",
        )

        reply = self.service.handle_incoming_message(message)
        events = self.database.fetch_timeline_events()

        self.assertEqual(reply.text, "我在这里。你可以再多说一点。")
        self.assertEqual(events[0]["event_type"], "user_message")
        self.assertEqual(events[0]["content"], "   ")
        self.assertEqual(events[1]["event_type"], "agent_reply")
        self.assertEqual(events[1]["content"], "我在这里。你可以再多说一点。")

    def test_model_request_keeps_non_memory_prompt_slots_available(self) -> None:
        request = ModelRequest(
            system_prompt="system",
            user_message="今天有点累",
            memory_context="用户最近睡得晚。",
            daily_context="今天下雨。",
            reflection_context="昨晚写过简短总结。",
        )

        built_prompt = request.build_user_prompt()

        self.assertNotIn("[长期记忆]", built_prompt)
        self.assertIn("[当日状态]", built_prompt)
        self.assertIn("[夜间总结]", built_prompt)
        self.assertIn("[用户消息]", built_prompt)
        self.assertIn("今天有点累", built_prompt)

    def test_service_injects_system_prompt_into_model_request(self) -> None:
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="你要温和、自然、克制地回应。",
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-456",
                text="我今天有点空。",
            )
        )

        self.assertEqual(reply.text, "test reply")
        self.assertIsNotNone(capturing_client.last_request)
        assert capturing_client.last_request is not None
        self.assertIn("## 1. 身份与语气（Identity & Tone）", capturing_client.last_request.system_prompt)
        self.assertIn("## 2. 行为规则（Behavior Rules）", capturing_client.last_request.system_prompt)
        self.assertIn("## 3. Session Continuity Context", capturing_client.last_request.system_prompt)
        self.assertIn("## 4. Memory Context（动态注入）", capturing_client.last_request.system_prompt)
        self.assertIn("## 5. Memory 使用规则", capturing_client.last_request.system_prompt)
        self.assertIn("你要温和、自然、克制地回应。", capturing_client.last_request.system_prompt)
        self.assertEqual(capturing_client.last_request.user_message, "我今天有点空。")

    def test_service_injects_lightweight_knowledge_state_into_continuity_context(self) -> None:
        save_knowledge_state(
            self.config,
            KnowledgeState(
                updated_at="2026-04-11 20:00:00",
                last_run_at="2026-04-11 19:45:00",
                last_status="ok",
                pending_knowledge_maintenance=True,
                recent_curated_topics=("论文", "睡眠"),
                recent_source_additions=("notion_dump",),
            ),
        )
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-knowledge-state",
                text="今天有点累。",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("知识侧有待整理项", capturing_client.last_request.system_prompt)
        self.assertIn("最近整理过的主题：论文、睡眠", capturing_client.last_request.system_prompt)
        self.assertIn("最近新增来源：notion_dump", capturing_client.last_request.system_prompt)

    def test_service_injects_relevant_vault_knowledge_snippet_into_continuity_context(self) -> None:
        wiki_dir = self.config.vault_dir / "wiki" / "concepts"
        wiki_dir.mkdir(parents=True, exist_ok=True)
        (wiki_dir / "sleep.md").write_text(
            "# 睡眠\n\n稳定作息、减少熬夜、晚间降低刺激，通常有助于恢复精神状态。\n",
            encoding="utf-8",
        )
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-knowledge-recall",
                text="最近睡眠很差，有什么调整建议",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("本轮可参考的知识片段", capturing_client.last_request.system_prompt)
        self.assertIn("睡眠", capturing_client.last_request.system_prompt)
        self.assertIn("稳定作息", capturing_client.last_request.system_prompt)

    def test_service_compacts_channel_history_for_manual_compact(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.record_external_exchange(
            channel="wechat",
            sender_id="compact-user",
            user_text="我们先定一下 API 设计。",
            reply_text="好，先看接口边界。",
            source="hermes",
        )
        service.record_external_exchange(
            channel="wechat",
            sender_id="compact-user",
            user_text="后面再统一错误处理。",
            reply_text="可以，错误模型再收拢。",
            source="hermes",
        )

        result = service.compact_conversation_context(
            channel="wechat",
            sender_id="compact-user",
            focus="API设计决策",
        )

        self.assertEqual(result["status"], "compacted")
        self.assertIn("用户关注：API设计决策", result["summary"])
        self.assertIn("API设计决策", result["reply_text"])

        session_state_raw = self.database.get_handoff_value("conversation_session_state:wechat:compact-user")
        self.assertIsNotNone(session_state_raw)
        self.assertIn("API设计决策", session_state_raw or "")

    def test_service_compacts_only_the_target_sender_history(self) -> None:
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.record_external_exchange(
            channel="wechat",
            sender_id="target-user",
            user_text="目标用户在聊 API 设计。",
            reply_text="先定接口。",
            source="hermes",
        )
        service.record_external_exchange(
            channel="wechat",
            sender_id="other-user",
            user_text="另一个用户在问健身计划。",
            reply_text="先看训练频率。",
            source="hermes",
        )

        result = service.compact_conversation_context(
            channel="wechat",
            sender_id="target-user",
            focus="API设计决策",
        )

        self.assertEqual(result["status"], "compacted")
        self.assertIn("API设计决策", result["summary"])
        self.assertNotIn("健身计划", result["summary"])

    def test_service_caps_memory_and_knowledge_context_for_token_budget(self) -> None:
        compact_config = dataclasses.replace(
            self.config,
            memory_context_max_chars=120,
            continuity_context_max_chars=420,
            knowledge_recall_limit=1,
            knowledge_snippet_max_chars=80,
        )
        long_profile = "用户喜欢安静环境。" + ("这是一段应该被裁剪的长期偏好。" * 20)
        long_working = "用户最近在处理论文。" + ("这是一段应该被裁剪的近期状态。" * 20)
        self.database.store_memory(long_profile, "profile", importance=2)
        self.database.store_memory(long_working, "working", importance=1)
        wiki_dir = compact_config.vault_dir / "wiki" / "concepts"
        wiki_dir.mkdir(parents=True, exist_ok=True)
        (wiki_dir / "paper.md").write_text(
            "# 论文\n\n" + ("论文修改建议要先看结构，再看表达。" * 40),
            encoding="utf-8",
        )
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=compact_config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-budget",
                text="今天论文还是改不动",
            )
        )

        assert capturing_client.last_request is not None
        self.assertLessEqual(len(capturing_client.last_request.memory_context), 120)
        continuity_section = capturing_client.last_request.system_prompt.split("## 3. Session Continuity Context", 1)[1].split("## 4. Memory Context", 1)[0]
        self.assertLessEqual(len(continuity_section), 420)
        self.assertIn("论文", capturing_client.last_request.system_prompt)
        self.assertNotIn("论文修改建议要先看结构，再看表达。" * 10, capturing_client.last_request.system_prompt)

    def test_service_appends_memory_context_to_system_prompt(self) -> None:
        self.database.store_memory("用户喜欢安静一点的环境", "profile", importance=2)
        self.database.store_memory("用户最近在处理论文，情绪有些烦躁", "working", importance=1)
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-789",
                text="今天还在改论文。",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("基础 system prompt", capturing_client.last_request.system_prompt)
        self.assertIn("memory 只用于辅助理解用户", capturing_client.last_request.system_prompt)
        self.assertIn("不暴露来源", capturing_client.last_request.system_prompt)
        self.assertIn("自然记得", capturing_client.last_request.system_prompt)
        self.assertIn("【你对用户的了解】", capturing_client.last_request.system_prompt)
        self.assertIn("【用户当前状态（近期）】", capturing_client.last_request.system_prompt)
        self.assertIn("用户喜欢安静一点的环境", capturing_client.last_request.memory_context)
        self.assertIn("用户最近在处理论文，情绪有些烦躁", capturing_client.last_request.memory_context)
        self.assertIn("论文", capturing_client.last_request.memory_context)

    def test_service_skips_memory_for_short_low_information_message(self) -> None:
        self.database.store_memory("用户喜欢安静一点的环境", "profile", importance=2)
        self.database.store_memory("用户最近在处理论文，情绪有些烦躁", "working", importance=1)
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-short",
                text="嗯",
            )
        )

        assert capturing_client.last_request is not None
        self.assertEqual(capturing_client.last_request.memory_context, "")
        self.assertIn("当前没有可用的 memory context。", capturing_client.last_request.system_prompt)

    def test_service_skips_memory_for_task_like_message(self) -> None:
        self.database.store_memory("用户喜欢安静一点的环境", "profile", importance=2)
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-task",
                text="帮我看下这个 Python 报错",
            )
        )

        assert capturing_client.last_request is not None
        self.assertEqual(capturing_client.last_request.memory_context, "")

    def test_service_keeps_memory_for_stateful_chat_message(self) -> None:
        self.database.store_memory("用户喜欢安静一点的环境", "profile", importance=2)
        self.database.store_memory("用户最近在处理论文，情绪有些烦躁", "working", importance=1)
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-state",
                text="今天有点累",
            )
        )

        assert capturing_client.last_request is not None
        self.assertNotEqual(capturing_client.last_request.memory_context, "")
        self.assertIn("【你对用户的了解】", capturing_client.last_request.memory_context)

    def test_service_routes_explicit_search_requests_to_tool_model(self) -> None:
        text_client = NamedCapturingModelClient(provider="deepseek", reply_text="text reply")
        tool_client = NamedCapturingModelClient(provider="qwen", reply_text="search reply")
        service = PersonalAgentService(
            database=self.database,
            model_client=text_client,
            tool_model_client=tool_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-search",
                text="帮我搜一下今天上海天气最新情况",
            )
        )

        self.assertEqual(reply.text, "search reply")
        self.assertIsNone(text_client.last_request)
        assert tool_client.last_request is not None
        self.assertEqual(tool_client.last_request.tool_name, "web_search")
        self.assertIn(self.config.tool_use_system_prompt, tool_client.last_request.system_prompt)
        self.assertIn("## 3. Session Continuity Context", tool_client.last_request.system_prompt)

    def test_service_routes_image_requests_to_tool_model(self) -> None:
        text_client = NamedCapturingModelClient(provider="deepseek", reply_text="text reply")
        tool_client = NamedCapturingModelClient(provider="qwen", reply_text="vision reply")
        service = PersonalAgentService(
            database=self.database,
            model_client=text_client,
            tool_model_client=tool_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-image",
                text="帮我看看这张图",
                image_urls=("https://example.com/test.jpg",),
            )
        )

        self.assertEqual(reply.text, "vision reply")
        self.assertIsNone(text_client.last_request)
        assert tool_client.last_request is not None
        self.assertEqual(tool_client.last_request.tool_name, "")
        self.assertEqual(tool_client.last_request.image_urls, ("https://example.com/test.jpg",))

    def test_image_only_message_is_recorded_in_timeline(self) -> None:
        tool_client = NamedCapturingModelClient(provider="qwen", reply_text="vision reply")
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            tool_model_client=tool_client,
            logger=self.logger,
            config=self.config,
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-image-only",
                text="",
                image_urls=("https://example.com/only-image.jpg",),
            )
        )

        events = self.database.fetch_timeline_events()
        self.assertEqual(events[0]["content"], "[image]")

    def test_service_respects_explicit_llm_skip_without_rule_fallback(self) -> None:
        class SkipMemoryExtractor:
            def extract(self, user_text: str, recent_history: list[str]) -> MemoryExtractionResult:
                return MemoryExtractionResult(
                    decision="skip",
                    memory=None,
                    source="llm",
                    should_fallback=False,
                )

        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            memory_extractor=SkipMemoryExtractor(),
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="test_channel",
                sender_id="user-skip",
                text="今天一直在改论文，越改越烦",
            )
        )

        self.assertEqual(self.database.get_working_memories(limit=5), [])
        self.assertEqual(self.database.get_profile_memories(limit=5), [])

    def test_system_prompt_keeps_memory_after_behavior_rules(self) -> None:
        structured_prompt = self.service._conversation_agent._build_system_prompt(
            "【你对用户的了解】\n- 用户喜欢安静\n\n【用户当前状态（近期）】\n- 用户最近有些累",
            "- 当前 response mode：casual_chat",
        )

        self.assertLess(
            structured_prompt.index("## 1. 身份与语气（Identity & Tone）"),
            structured_prompt.index("## 2. 行为规则（Behavior Rules）"),
        )
        self.assertLess(
            structured_prompt.index("## 2. 行为规则（Behavior Rules）"),
            structured_prompt.index("## 3. Session Continuity Context"),
        )
        self.assertLess(
            structured_prompt.index("## 3. Session Continuity Context"),
            structured_prompt.index("## 4. Memory Context（动态注入）"),
        )
        self.assertLess(
            structured_prompt.index("## 4. Memory Context（动态注入）"),
            structured_prompt.index("## 5. Memory 使用规则"),
        )

    def test_service_runs_knowledge_maintenance_with_structured_result(self) -> None:
        class StubKnowledgeAgent:
            def __init__(self) -> None:
                self.calls: list[tuple[str, str]] = []

            def run(self, *, action: str, trigger: str, now_local: datetime | None = None):
                self.calls.append((action, trigger))
                return type(
                    "Result",
                    (),
                    {
                        "action": action,
                        "trigger": trigger,
                        "status": "ok",
                        "started_at": "2026-04-14 09:00:00",
                        "finished_at": "2026-04-14 09:00:01",
                        "inbox_count_before": 2,
                        "inbox_count_after": 1,
                        "processed_inbox_count": 1,
                        "pending_knowledge_maintenance": True,
                        "recent_curated_topics": ("论文",),
                        "recent_source_additions": ("inbox_note",),
                        "output_excerpt": "done",
                        "error": "",
                    },
                )()

            def auto_run(self, *, trigger: str, now_local: datetime | None = None):
                return self.run(action="apply", trigger=trigger, now_local=now_local)

        stub_agent = StubKnowledgeAgent()
        service = PersonalAgentService(
            database=self.database,
            model_client=PlaceholderModelClient(),
            logger=self.logger,
            config=self.config,
            knowledge_agent=stub_agent,
        )

        result = service.run_knowledge_maintenance(action="plan", trigger="manual")

        self.assertEqual(stub_agent.calls, [("plan", "manual")])
        self.assertEqual(result["action"], "plan")
        self.assertEqual(result["trigger"], "manual")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["inbox_count_before"], 2)
        self.assertEqual(result["inbox_count_after"], 1)
        self.assertEqual(result["processed_inbox_count"], 1)
        self.assertEqual(result["pending_knowledge_maintenance"], True)
        self.assertEqual(result["recent_curated_topics"], ["论文"])
        self.assertEqual(result["recent_source_additions"], ["inbox_note"])
        self.assertEqual(result["output_excerpt"], "done")

    def test_service_injects_response_mode_and_temporal_context(self) -> None:
        capturing_client = CapturingModelClient()
        self.database.store_memory(
            '{"type":"working","time_scope":"today","topic":"处理论文","state":"情绪有些烦躁","summary":"用户今天在处理论文，情绪有些烦躁"}',
            "working",
            importance=1,
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-emotion",
                text="今天改论文改得有点烦",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("当前 response mode：emotional_support", capturing_client.last_request.system_prompt)
        self.assertIn("当前较明确的进行中主题", capturing_client.last_request.system_prompt)

    def test_service_persists_session_state_between_turns(self) -> None:
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-thread",
                text="我最近在准备答辩，有点慌",
            )
        )
        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-thread",
                text="其实主要还是怕讲不好",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("最近几轮压缩摘要", capturing_client.last_request.system_prompt)
        self.assertIn("上一轮较明确的用户意图", capturing_client.last_request.system_prompt)

    def test_reply_reviewer_retries_blacklisted_opening_once(self) -> None:
        model_client = SequentialModelClient(
            replies=[
                "哈哈，那你可以先别急着想太多。",
                "先不急，慢慢说也可以。",
            ]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-review",
                text="我有点乱，不知道怎么说",
            )
        )

        self.assertEqual(reply.text, "先不急，慢慢说也可以。")
        self.assertEqual(len(model_client.requests), 2)
        self.assertIn("[Reviewer Retry]", model_client.requests[1].system_prompt)
        stats = service.get_reviewer_stats()
        self.assertEqual(stats["reviewer_trigger_count"], 1)
        self.assertEqual(stats["blacklisted_opening_count"], 1)
        self.assertEqual(stats["retry_success_count"], 1)
        observations = self.database.get_recent_reply_review_observations(limit=5)
        self.assertEqual(len(observations), 1)
        self.assertEqual(int(observations[0]["review_triggered"]), 1)
        self.assertIn("blacklisted_opening", str(observations[0]["review_reasons"]))

    def test_reply_reviewer_only_retries_once_even_if_second_reply_is_still_bad(self) -> None:
        model_client = SequentialModelClient(
            replies=[
                "哈哈，那你可以先别急着想太多。",
                "哈哈，建议你还是先休息一下。",
            ]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-review-once",
                text="我有点乱，不知道怎么说",
            )
        )

        self.assertEqual(reply.text, "哈哈，建议你还是先休息一下。")
        self.assertEqual(len(model_client.requests), 2)

    def test_reviewer_can_be_disabled_without_breaking_main_flow(self) -> None:
        disabled_config = AppConfig(
            base_dir=self.config.base_dir,
            data_dir=self.config.data_dir,
            logs_dir=self.config.logs_dir,
            vault_dir=self.config.vault_dir,
            database_path=self.config.database_path,
            log_file_path=self.config.log_file_path,
            reviewer_enabled=False,
        )
        model_client = SequentialModelClient(
            replies=["哈哈，那你可以先别急着想太多。"]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=disabled_config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-review-disabled",
                text="我有点乱，不知道怎么说",
            )
        )

        self.assertEqual(reply.text, "哈哈，那你可以先别急着想太多。")
        self.assertEqual(len(model_client.requests), 1)
        self.assertEqual(service.get_reviewer_stats()["reviewer_trigger_count"], 0)

    def test_casual_light_reply_is_not_over_blocked(self) -> None:
        model_client = SequentialModelClient(
            replies=["那就先随便聊聊，你现在最想吐槽哪一块？"]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-casual-safe",
                text="今天脑子有点乱",
            )
        )

        self.assertEqual(reply.text, "那就先随便聊聊，你现在最想吐槽哪一块？")
        self.assertEqual(len(model_client.requests), 1)
        self.assertEqual(service.get_reviewer_stats()["reviewer_trigger_count"], 0)

    def test_natural_topic_shift_is_not_forced_into_off_topic_retry(self) -> None:
        model_client = SequentialModelClient(
            replies=["今天上海像是要下雨，出门的话记得带伞。"]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )
        self.database.set_handoff_value(
            "conversation_session_state:wechat:user-topic-shift",
            (
                '{"session_id":"wechat:user-topic-shift","current_topic":"论文","current_mode":"casual_chat",'
                '"pending_thread":"","last_user_intent":"还在改论文","intimacy_level":0,"recent_turn_summary":["话题:论文；意图:还在改论文"]}'
            ),
        )

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-topic-shift",
                text="先不说论文了，今天上海天气怎么样",
            )
        )

        self.assertEqual(reply.text, "今天上海像是要下雨，出门的话记得带伞。")
        self.assertEqual(len(model_client.requests), 1)
        self.assertEqual(service.get_reviewer_stats()["off_topic_count"], 0)

    def test_recent_turn_summary_is_short_and_fact_like(self) -> None:
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-summary",
                text="我最近在准备答辩，还没想好开头",
            )
        )
        raw_state = self.database.get_handoff_value("conversation_session_state:wechat:user-summary")
        assert raw_state is not None

        self.assertIn("话题:", raw_state)
        self.assertNotIn("回复里接了", raw_state)

    def test_playful_context_marks_intimacy_as_weak_signal_only(self) -> None:
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-playful",
                text="晚安宝，想我没",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("弱控制信号", capturing_client.last_request.system_prompt)

    def test_temporal_awareness_adds_time_context_and_immediate_state_rule(self) -> None:
        capturing_client = CapturingModelClient()
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )
        service._get_local_now = lambda: datetime(2026, 4, 11, 1, 20, 0)  # type: ignore[method-assign]

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-time-aware",
                text="我好困",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("当前本地时间：01:20", capturing_client.last_request.system_prompt)
        self.assertIn("当前时间段：深夜", capturing_client.last_request.system_prompt)
        self.assertIn("先直接回应当下感受，不要立刻推测长期原因", capturing_client.last_request.system_prompt)

        raw_state = self.database.get_handoff_value("conversation_session_state:wechat:user-time-aware")
        assert raw_state is not None
        self.assertIn('"current_time_of_day":"late_night"', raw_state)
        self.assertIn('"last_user_ts":"2026-04-11 01:20:00"', raw_state)
        self.assertIn('"last_agent_ts":"2026-04-11 01:20:00"', raw_state)

    def test_service_loads_daily_context_and_night_digest_on_next_day(self) -> None:
        capturing_client = CapturingModelClient()
        self.database.set_handoff_value(
            "daily_context:latest",
            "2026-04-11 的连续感摘要：\n- 昨天主要围绕：论文/答辩",
        )
        self.database.set_handoff_value(
            "night_cycle:latest_reflection_digest",
            "- casual 场景里少一点建议腔。\n- 深夜状态先回应当下。",
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=capturing_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )

        service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-next-day",
                text="早，我起来了",
            )
        )

        assert capturing_client.last_request is not None
        self.assertIn("论文/答辩", capturing_client.last_request.build_user_prompt())
        self.assertIn("深夜状态先回应当下", capturing_client.last_request.build_user_prompt())

    def test_reviewer_retries_recent_state_over_inference(self) -> None:
        model_client = SequentialModelClient(
            replies=[
                "你这多半是最近熬夜把作息弄乱了。",
                "那先别硬撑了，困就早点歇一会儿。",
            ]
        )
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
            memory_extractor=NoopFallbackMemoryExtractor(),
        )
        service._get_local_now = lambda: datetime(2026, 4, 11, 1, 20, 0)  # type: ignore[method-assign]

        reply = service.handle_incoming_message(
            IncomingMessage(
                channel="wechat",
                sender_id="user-over-infer",
                text="我好困",
            )
        )

        self.assertEqual(reply.text, "那先别硬撑了，困就早点歇一会儿。")
        self.assertEqual(len(model_client.requests), 2)
        self.assertEqual(service.get_reviewer_stats()["recent_state_over_inference_count"], 1)

    def test_default_system_prompt_matches_wechat_style_constraints(self) -> None:
        system_prompt = self.config.agent_system_prompt

        self.assertIn("在微信里和用户聊天", system_prompt)
        self.assertIn("温柔、自然、简洁", system_prompt)
        self.assertIn("不要写括号里的动作、停顿、表情说明或舞台说明", system_prompt)
        self.assertIn("不要角色扮演", system_prompt)
        self.assertIn("通常2到4句", system_prompt)

    def test_service_retires_proactive_companion_message_without_trace(self) -> None:
        self.database.record_timeline_event(
            source="wechat",
            event_type="user_message",
            content="今天一直在改论文，越改越烦",
            tags="message,user",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"working","time_scope":"recent","topic":"处理论文","state":"情绪有些烦躁","summary":"用户最近在处理论文，情绪有些烦躁"}',
            "working",
            importance=1,
        )
        self.database.store_memory(
            '{"type":"profile","category":"study","trait":"写论文","summary":"用户长期在学术写作上投入较多"}',
            "profile",
            importance=2,
        )
        model_client = SequentialModelClient(
            replies=["刚想到你最近一直在忙论文，今天还顺吗。"]
        )
        self.config = dataclasses.replace(self.config, proactive_enabled=True)
        service = PersonalAgentService(
            database=self.database,
            model_client=model_client,
            logger=self.logger,
            config=self.config,
            system_prompt="基础 system prompt",
        )
        outbound_client = StubOutboundClient()
        service._outbound_client = outbound_client  # type: ignore[attr-defined]

        batch = service.evaluate_life_opportunities(
            (
                LifeOpportunity(
                    id="companion-9",
                    kind="companion",
                    source="life_loop",
                    consumer="orchestrator_agent",
                    attention_hint="worth_a_look",
                    reason="natural opening available",
                    context={"channel": "wechat"},
                    signals={"user_interrupt_risk": "low"},
                    payload={
                        "opener_clue": "最近一直在忙论文",
                        "seed": "论文",
                    },
                    created_at="2026-04-11 21:00:00",
                    expires_at="2026-04-11 21:30:00",
                ),
            ),
            now_local=datetime(2026, 4, 11, 21, 10, 0),
        )

        self.assertEqual(len(batch.outbound_messages), 0)
        self.assertEqual(len(outbound_client.sent_texts), 0)
        self.assertEqual(len(outbound_client.events), 0)
        self.assertEqual(batch.judgments[0].reason, "legacy_companion_proactive_retired")

        events = self.database.fetch_timeline_events()
        self.assertNotEqual(events[-1]["event_type"], "agent_proactive")

        raw_state = self.database.get_handoff_value("agent_internal_state")
        self.assertTrue(raw_state is None or '"last_proactive_at":"2026-04-11 21:10:00"' not in raw_state)


if __name__ == "__main__":
    unittest.main()
