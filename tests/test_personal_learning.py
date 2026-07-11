from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conftest import make_test_config
from personal_agent.db import Database
from personal_agent.interfaces.chat import IncomingMessage
from personal_agent.interfaces.model import ModelResponse, PlaceholderModelClient
from personal_agent.personal_learning import PersonalLearningStore
from personal_agent.service import PersonalAgentService


@pytest.fixture()
def learning(tmp_path: Path) -> tuple[PersonalLearningStore, Database]:
    config = make_test_config(tmp_path)
    database = Database(config, logging.getLogger("test.personal_learning"))
    database.initialize()
    return PersonalLearningStore(database=database, config=config), database


def test_explicit_correction_activates_and_supersedes_atomically(learning) -> None:
    store, _ = learning
    first = store.observe(
        kind="preference",
        subject_key="reply:verbosity",
        statement="喜欢简洁回复",
        source="explicit_user",
        evidence_digests=["a" * 64],
        confidence=1.0,
    )
    second = store.observe(
        kind="correction",
        subject_key="reply:verbosity",
        statement="复杂问题可以解释得详细一些",
        source="explicit_user",
        evidence_digests=["b" * 64],
        confidence=1.0,
    )

    assert first.status == "active"
    assert second.status == "active"
    assert [record.statement for record in store.list_active()] == [second.statement]
    assert store.get(first.learning_id).status == "superseded"
    assert store.get(first.learning_id).superseded_by == second.learning_id


def test_inferred_learning_requires_repeated_noncontradictory_observation(learning) -> None:
    store, _ = learning
    first = store.observe(
        kind="routine",
        subject_key="routine:night_reading",
        statement="晚上喜欢一起读书",
        source="repeated_observation",
        evidence_digests=["c" * 64],
        confidence=0.8,
    )
    contradictory = store.observe(
        kind="routine",
        subject_key="routine:night_reading",
        statement="晚上不想读书",
        source="repeated_observation",
        evidence_digests=["d" * 64],
        confidence=0.8,
    )
    promoted = store.observe(
        kind="routine",
        subject_key="routine:night_reading",
        statement="晚上喜欢一起读书",
        source="repeated_observation",
        evidence_digests=["e" * 64],
        confidence=0.9,
    )

    assert first.status == "candidate"
    assert contradictory.status == "candidate"
    assert promoted.status == "active"
    assert promoted.observation_count == 2


def test_repeated_learning_replay_with_the_same_evidence_stays_a_candidate(learning) -> None:
    store, _ = learning
    first = store.observe(
        kind="preference",
        subject_key="reply:replay-safe",
        statement="喜欢简洁回复",
        source="repeated_observation",
        evidence_digests=["d" * 64],
        confidence=0.8,
    )
    replay = store.observe(
        kind="preference",
        subject_key="reply:replay-safe",
        statement="喜欢简洁回复",
        source="repeated_observation",
        evidence_digests=["d" * 64],
        confidence=0.8,
    )

    assert first.learning_id == replay.learning_id
    assert replay.status == "candidate"
    assert replay.observation_count == 1


def test_learning_rejects_non_finite_confidence(learning) -> None:
    store, _ = learning
    with pytest.raises(ValueError, match="confidence"):
        store.observe(
            kind="preference",
            subject_key="reply:confidence",
            statement="喜欢简洁回复",
            source="explicit_user",
            evidence_digests=["f" * 64],
            confidence=float("nan"),
        )


def test_recall_is_bounded_relevant_and_active_only(learning) -> None:
    store, _ = learning
    store.observe(
        kind="preference",
        subject_key="reply:structure",
        statement="复杂问题先说结论再解释依据",
        source="explicit_user",
        evidence_digests=["6" * 64],
        confidence=1,
    )
    store.observe(
        kind="routine",
        subject_key="routine:reading",
        statement="周末喜欢一起读书",
        source="repeated_observation",
        evidence_digests=["7" * 64],
        confidence=0.8,
    )
    store.observe(
        kind="preference",
        subject_key="food:flavor",
        statement="偏好清淡口味",
        source="explicit_user",
        evidence_digests=["8" * 64],
        confidence=1,
    )

    recalled = store.recall_relevant("这个复杂问题请按我喜欢的回复结构回答", limit=1)

    assert [record.subject_key for record in recalled] == ["reply:structure"]
    assert store.recall_relevant("聊聊今天的天气") == []


def test_forget_and_expire_candidates_do_not_affect_legacy_memory(learning) -> None:
    store, database = learning
    database.store_memory("legacy memory stays", "profile")
    old = datetime.now(timezone.utc) - timedelta(days=40)
    candidate = store.observe(
        kind="relationship",
        subject_key="person:test",
        statement="测试人物关系",
        source="repeated_observation",
        evidence_digests=["f" * 64],
        confidence=0.7,
        now=old,
    )
    assert store.expire_candidates(older_than_days=30) == 1
    assert store.get(candidate.learning_id).status == "forgotten"

    active = store.observe(
        kind="preference",
        subject_key="food:test",
        statement="喜欢清淡",
        source="explicit_user",
        evidence_digests=["1" * 64],
        confidence=1,
    )
    assert store.forget("food:test") == 1
    assert store.get(active.learning_id).status == "forgotten"
    assert [row["content"] for row in database.get_profile_memories()] == ["legacy memory stays"]


@pytest.mark.parametrize(
    "statement",
    [
        "Authorization: Bearer secret-token",
        "cookie=sessionid=private",
        "/opt/ran_agent/.env.local",
        "/private/var/folders/session.txt",
        "/tmp/raw-tool-output.json",
        r"C:\Users\owner\AppData\Local\private.txt",
        r"\\server\share\private.txt",
        "https://example.com/article",
        "https://www.xiaohongshu.com/explore/123456",
        "https://www.bilibili.com/video/BV1xx411c7mD",
        "https://social.example.com/posts/123?access_token=secret",
        "Traceback (most recent call last): raw log",
        "https://cdn.example/file.jpg?X-Amz-Signature=secret",
        "raw_tool_output: {\"token\":\"private\"}",
    ],
)
def test_poisoned_or_private_payload_never_becomes_learning(learning, statement: str) -> None:
    store, _ = learning
    with pytest.raises(ValueError, match="unsafe personal learning statement"):
        store.observe(
            kind="preference",
            subject_key="unsafe:test",
            statement=statement,
            source="explicit_user",
            evidence_digests=["2" * 64],
            confidence=1,
        )
    assert store.list_active() == []


def test_preference_projection_is_idempotent_and_preserves_existing_profile(learning) -> None:
    store, database = learning
    config = database.config
    profile_path = config.data_dir / "preference_profile.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(
        json.dumps({"stable_dislikes": [{"label": "不要机械复述"}], "custom": "keep"}, ensure_ascii=False),
        encoding="utf-8",
    )
    store.observe(
        kind="preference",
        subject_key="reply:tone",
        statement="技术结论先说结果",
        source="explicit_user",
        evidence_digests=["3" * 64],
        confidence=1,
    )

    first = store.project_compatibility_views()
    second = store.project_compatibility_views()
    payload = json.loads(profile_path.read_text(encoding="utf-8"))

    assert first == second
    assert payload["custom"] == "keep"
    assert payload["stable_dislikes"] == [{"label": "不要机械复述"}]
    assert payload["active_learnings"] == [
        {"kind": "preference", "subject_key": "reply:tone", "statement": "技术结论先说结果"}
    ]
    assert Path(first["markdown_path"]).exists()


def test_service_exposes_one_personal_learning_lifecycle(learning) -> None:
    _, database = learning
    service = PersonalAgentService(
        database=database,
        model_client=PlaceholderModelClient(),
        logger=logging.getLogger("test.personal_learning.service"),
        config=database.config,
    )

    remembered = service.observe_personal_learning(
        kind="preference",
        subject_key="reply:structure",
        statement="先说结论",
        source="explicit_user",
        evidence_digests=["4" * 64],
        confidence=1.0,
    )
    corrected = service.observe_personal_learning(
        kind="correction",
        subject_key="reply:structure",
        statement="复杂问题先说结论再解释依据",
        source="explicit_user",
        evidence_digests=["5" * 64],
        confidence=1.0,
    )

    assert remembered["status"] == "active"
    assert corrected["status"] == "active"
    assert service.query_personal_learning(subject_prefix="reply:") == [corrected]
    assert service.forget_personal_learning("reply:structure") == {"forgotten_count": 1}
    assert service.query_personal_learning(subject_prefix="reply:") == []
    service.shutdown()


def test_service_injects_only_relevant_active_learning(learning) -> None:
    class CapturingModel:
        request = None

        def generate_reply(self, request):
            self.request = request
            return ModelResponse(text="收到", provider="test")

    _, database = learning
    model = CapturingModel()
    service = PersonalAgentService(
        database=database,
        model_client=model,
        logger=logging.getLogger("test.personal_learning.prompt"),
        config=database.config,
    )
    service.observe_personal_learning(
        kind="preference",
        subject_key="reply:structure",
        statement="复杂问题先说结论再解释依据",
        source="explicit_user",
        evidence_digests=["9" * 64],
        confidence=1,
    )
    service.observe_personal_learning(
        kind="preference",
        subject_key="reply:candidate",
        statement="回复里总是使用诗歌形式",
        source="repeated_observation",
        evidence_digests=["a" * 63 + "b"],
        confidence=0.6,
    )

    service.handle_incoming_message(
        IncomingMessage(channel="test", sender_id="owner", text="这个复杂问题按回复结构回答")
    )

    assert "复杂问题先说结论再解释依据" in model.request.memory_context
    assert "回复里总是使用诗歌形式" not in model.request.memory_context
    service.shutdown()


def test_external_user_turn_repeated_preference_promotes_through_learning_lifecycle(learning) -> None:
    """The live Node->Python projection, not the retired chat route, feeds learning."""

    _, database = learning
    service = PersonalAgentService(
        database=database,
        model_client=PlaceholderModelClient(),
        logger=logging.getLogger("test.personal_learning.external_turn"),
        config=database.config,
    )

    for event_id in ("outbox_" + "1" * 32, "outbox_" + "2" * 32):
        assert service.record_external_exchange(
            channel="wechat",
            sender_id="owner",
            user_text="我很喜欢简洁回复",
            reply_text="收到",
            source="node_bridge",
            event_id=event_id,
        ) == "stored"

    assert service.query_personal_learning(subject_prefix="preference:") == [
        {
            **service.query_personal_learning(subject_prefix="preference:")[0],
            "kind": "preference",
            "statement": "用户喜欢简洁回复",
            "source": "repeated_observation",
            "status": "active",
            "observation_count": 2,
        }
    ]
    service.shutdown()


def test_verified_ambiguous_delivery_records_only_a_safe_operating_lesson(learning) -> None:
    _, database = learning
    service = PersonalAgentService(
        database=database,
        model_client=PlaceholderModelClient(),
        logger=logging.getLogger("test.personal_learning.delivery_outcome"),
        config=database.config,
    )

    recorded = service.record_verified_delivery_outcome(
        outcome="ambiguous",
        event_id="outbox_" + "3" * 32,
    )

    assert recorded["kind"] == "operating_lesson"
    assert recorded["source"] == "verified_outcome"
    assert recorded["status"] == "active"
    assert recorded["statement"] == "不确定的外发结果不得盲目重发"
    assert "outbox_" not in str(recorded)
    service.shutdown()
