"""Nightly rollover that clears short context, writes daily carry-over, and queues next-day continuity."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from personal_agent.agent_internal_state import (
    load_agent_internal_state,
    record_night_cycle,
    save_agent_internal_state,
)
from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.knowledge_agent import KnowledgeAgent
from personal_agent.memory_specialist import MemorySpecialist
from personal_agent.persona_evolution import evolve_persona_bootstrap
from personal_agent.reflection_specialist import ReflectionSpecialist


DAILY_CONTEXT_KEY = "daily_context:latest"
LATEST_REFLECTION_DIGEST_KEY = "night_cycle:latest_reflection_digest"


@dataclass(frozen=True)
class NightCycleResult:
    """Structured output of one nightly rollover pass."""

    summary_date: str
    cleared_session_count: int
    daily_summary: str
    reflection_digest: str
    promoted_count: int
    knowledge_inbox_path: str
    summary_output_path: str
    knowledge_action: str
    knowledge_status: str
    persona_proposal_path: str = ""


class NightCycle:
    """Runs one nightly rollover without replacing long-term memory or the daytime chat path."""

    def __init__(
        self,
        *,
        config: AppConfig,
        database: Database,
        memory_specialist: MemorySpecialist,
        logger: logging.Logger,
        knowledge_agent: KnowledgeAgent | None = None,
    ) -> None:
        self._config = config
        self._database = database
        self._memory_specialist = memory_specialist
        self._logger = logger
        self._knowledge_agent = knowledge_agent or KnowledgeAgent(config=config, logger=logger)

    def run(self, *, now_local: datetime | None = None) -> NightCycleResult:
        """Run the nightly cleanup and carry-over generation for the previous local day."""

        current_local = now_local or datetime.now()
        summary_date = (current_local - timedelta(days=1)).strftime("%Y-%m-%d")
        rows = self._database.get_timeline_events_for_local_date(summary_date, limit=300)
        daily_summary = _build_daily_summary(summary_date, rows)
        reflection_report = ReflectionSpecialist(
            database=self._database,
            config=self._config,
            logger=self._logger,
        ).generate_report(limit=self._config.self_reflection_sample_limit)
        reflection_digest = _build_reflection_digest(reflection_report)
        persona_result = evolve_persona_bootstrap(
            config=self._config,
            reflection_report=reflection_report,
            summary_date=summary_date,
            logger=self._logger,
        )
        promotion_decisions = self._memory_specialist.run_night_promotion(limit=3)
        promoted_count = sum(1 for decision in promotion_decisions if decision.action != "skip")
        knowledge_inbox_path = _write_knowledge_inbox_note(
            vault_dir=self._config.vault_dir,
            summary_date=summary_date,
            daily_summary=daily_summary,
            rows=rows,
        )
        knowledge_result = self._knowledge_agent.auto_run(
            trigger="night_cycle",
            now_local=current_local,
        )
        summary_output_path = _write_night_cycle_artifact(
            output_dir=self._config.night_cycles_dir,
            summary_date=summary_date,
            daily_summary=daily_summary,
            reflection_digest=reflection_digest,
            promoted_count=promoted_count,
            knowledge_inbox_path=knowledge_inbox_path,
            knowledge_action=knowledge_result.action,
            knowledge_status=knowledge_result.status,
        )
        self._database.set_handoff_value(DAILY_CONTEXT_KEY, daily_summary)
        self._database.set_handoff_value(LATEST_REFLECTION_DIGEST_KEY, reflection_digest)
        cleared_session_count = self._database.delete_handoff_by_prefix("conversation_session_state:")

        state = load_agent_internal_state(self._database)
        state = record_night_cycle(
            state,
            summary_date=summary_date,
            summary=daily_summary,
            reflection_digest=reflection_digest,
            knowledge_note_path=knowledge_inbox_path,
            now_local=current_local,
        )
        save_agent_internal_state(self._database, state)

        return NightCycleResult(
            summary_date=summary_date,
            cleared_session_count=cleared_session_count,
            daily_summary=daily_summary,
            reflection_digest=reflection_digest,
            promoted_count=promoted_count,
            knowledge_inbox_path=knowledge_inbox_path,
            summary_output_path=summary_output_path,
            knowledge_action=knowledge_result.action,
            knowledge_status=knowledge_result.status,
            persona_proposal_path=str(persona_result.proposal_json_path) if persona_result else "",
        )


def _build_daily_summary(summary_date: str, rows: list[object]) -> str:
    user_texts = [
        str(row["content"]).strip()
        for row in rows
        if str(row["event_type"]) == "user_message" and str(row["content"]).strip()
    ]
    proactive_count = sum(1 for row in rows if str(row["event_type"]) == "agent_proactive")
    topics = []
    if any("论文" in text or "答辩" in text for text in user_texts):
        topics.append("论文/答辩")
    if any("项目" in text or "工作" in text for text in user_texts):
        topics.append("项目/工作")
    if any(any(marker in text for marker in ("困", "累", "烦", "难受")) for text in user_texts):
        topics.append("情绪/状态波动")
    if not topics and user_texts:
        topics.append("零散日常聊天")

    last_user_text = user_texts[-1][:32] if user_texts else ""
    lines = [f"{summary_date} 的连续感摘要："]
    if topics:
        lines.append(f"- 昨天主要围绕：{'、'.join(topics)}")
    if last_user_text:
        lines.append(f"- 最后较明确的用户线索：{last_user_text}")
    lines.append(f"- 主动开口次数：{proactive_count}")
    if not user_texts:
        lines.append("- 昨天有效对话较少，今天优先轻量接续。")
    return "\n".join(lines)


def _build_reflection_digest(report) -> str:
    top_lines = []
    if report.common_failure_patterns:
        top_lines.extend(report.common_failure_patterns[:2])
    if report.possible_false_positive_rules:
        top_lines.extend(report.possible_false_positive_rules[:1])
    if not top_lines:
        top_lines.append("昨晚没有明显的新失败模式，今天继续自然观察。")
    return "\n".join(f"- {line}" for line in top_lines[:3])


def _write_knowledge_inbox_note(
    *,
    vault_dir: Path,
    summary_date: str,
    daily_summary: str,
    rows: list[object],
) -> str:
    inbox_dir = vault_dir / "inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    note_path = inbox_dir / f"night_cycle_{summary_date}.md"
    user_lines = [
        str(row["content"]).strip()
        for row in rows
        if str(row["event_type"]) == "user_message" and str(row["content"]).strip()
    ][:5]
    body_lines = [
        "---",
        "type: inbox_note",
        f"title: Night Cycle {summary_date}",
        f"created: {summary_date}",
        "source: night_cycle",
        "---",
        "",
        "## Daily Carry-over",
        daily_summary,
        "",
        "## Candidate Materials",
    ]
    if user_lines:
        body_lines.extend(f"- {line}" for line in user_lines)
    else:
        body_lines.append("- 昨天没有足够明确的新材料。")
    note_path.write_text("\n".join(body_lines) + "\n", encoding="utf-8")
    return str(note_path)


def _write_night_cycle_artifact(
    *,
    output_dir: Path,
    summary_date: str,
    daily_summary: str,
    reflection_digest: str,
    promoted_count: int,
    knowledge_inbox_path: str,
    knowledge_action: str,
    knowledge_status: str,
) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "summary_date": summary_date,
        "daily_summary": daily_summary,
        "reflection_digest": reflection_digest,
        "promoted_count": promoted_count,
        "knowledge_inbox_path": knowledge_inbox_path,
        "knowledge_action": knowledge_action,
        "knowledge_status": knowledge_status,
    }
    output_path = output_dir / f"{summary_date}.json"
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return str(output_path)
