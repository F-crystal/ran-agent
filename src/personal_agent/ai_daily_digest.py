"""Scheduled AI daily digest support."""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Callable, Protocol

from personal_agent.config import AppConfig
from personal_agent.db import Database

AI_DAILY_DIGEST_SENT_PREFIX = "ai_daily_digest:sent:"
AI_DAILY_DIGEST_TEMPLATE_PATH = Path(__file__).with_name("prompts") / "ai_daily_digest_report.md"
AIHOT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
AIHOT_FETCH_RETRY_COUNT = 2
AIHOT_FETCH_ERRORS = (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError, RuntimeError)


class DigestOutboundClient(Protocol):
    def send_ai_daily_digest(self, facts: str) -> dict[str, object]:
        """Send one scheduled digest trigger."""
        ...


def build_digest_prompt(facts: str) -> str:
    """Build the facts package that Hermes will turn into a digest."""

    template = _load_digest_template()
    facts_text = facts.strip()
    if "{facts}" in template:
        return template.replace("{facts}", facts_text).strip()
    return "\n".join([template.strip(), "", "[AIHOT/Search Hub 事实材料]", facts_text]).strip()


def _load_digest_template() -> str:
    return AI_DAILY_DIGEST_TEMPLATE_PATH.read_text(encoding="utf-8")


def load_aihot_facts(urlopen: Callable[..., object] | None = None) -> str:
    """Fetch a compact facts package from AIHOT public endpoints."""

    opener = urlopen or urllib.request.urlopen
    last_error: Exception | None = None
    try:
        daily = _fetch_json("https://aihot.virxact.com/api/public/daily", opener)
        rendered = _render_daily(daily)
        if rendered:
            return rendered
    except AIHOT_FETCH_ERRORS as error:
        last_error = error

    try:
        items = _fetch_json("https://aihot.virxact.com/api/public/items?mode=selected&take=30", opener)
        rendered = _render_items(items)
        if rendered:
            return rendered
        raise RuntimeError("AIHOT response did not contain digest facts")
    except AIHOT_FETCH_ERRORS as error:
        last_error = error

    raise RuntimeError("AIHOT facts unavailable") from last_error


def run_ai_daily_digest(
    *,
    config: AppConfig,
    database: Database,
    outbound_client: DigestOutboundClient,
    logger: logging.Logger,
    now_local: datetime | None = None,
    facts_loader: Callable[[], str] = load_aihot_facts,
) -> dict[str, object]:
    """Run one scheduled AI daily digest pass."""

    if not config.ai_daily_digest_enabled:
        logger.info("AI daily digest skipped because disabled")
        return {"sent": False, "reason": "disabled"}

    now = now_local or datetime.now()
    local_date = now.strftime("%Y-%m-%d")
    sent_key = f"{AI_DAILY_DIGEST_SENT_PREFIX}{local_date}"
    if database.get_handoff_value(sent_key):
        logger.info("AI daily digest skipped because already sent date=%s", local_date)
        return {"sent": False, "reason": "already_sent", "date": local_date}

    try:
        facts = facts_loader().strip()
    except Exception as error:
        logger.warning("AI daily digest facts unavailable error=%s", error)
        return {"sent": False, "reason": "facts_unavailable", "date": local_date}
    if not facts:
        logger.warning("AI daily digest facts unavailable error=empty_facts")
        return {"sent": False, "reason": "facts_unavailable", "date": local_date}
    prompt = build_digest_prompt(facts)
    bridge_result = outbound_client.send_ai_daily_digest(prompt)
    if bridge_result.get("skipped") is True:
        logger.warning("AI daily digest skipped by Node bridge reason=%s", bridge_result.get("reason"))
        return {"sent": False, "reason": str(bridge_result.get("reason") or "bridge_skipped"), "date": local_date}

    database.set_handoff_value(
        sent_key,
        json.dumps(
            {
                "status": "sent",
                "sent_at": now.isoformat(),
                "bridge_result": bridge_result,
            },
            ensure_ascii=False,
        ),
    )
    database.record_timeline_event(
        source="scheduler",
        event_type="ai_daily_digest_sent",
        content=json.dumps({"date": local_date}, ensure_ascii=False),
        tags="system,ai-daily-digest,feishu",
        importance=1,
    )
    logger.info("AI daily digest sent date=%s", local_date)
    return {"sent": True, "date": local_date, "bridge_result": bridge_result}


def _fetch_json(url: str, opener: Callable[..., object]) -> dict[str, object]:
    last_error: Exception | None = None
    for _attempt in range(AIHOT_FETCH_RETRY_COUNT):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": AIHOT_USER_AGENT})
            with opener(request, timeout=20) as response:
                raw = response.read().decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("AIHOT response must be an object")
            return payload
        except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as error:
            last_error = error
    raise RuntimeError("AIHOT fetch failed") from last_error


def _render_daily(payload: dict[str, object]) -> str:
    lines: list[str] = []
    date = str(payload.get("date") or "").strip()
    if date:
        lines.append(f"date: {date}")
    lead = payload.get("lead")
    if isinstance(lead, dict):
        title = str(lead.get("title") or "").strip()
        paragraph = str(lead.get("leadParagraph") or "").strip()
        if title:
            lines.append(f"lead: {title}")
        if paragraph:
            lines.append(f"lead_summary: {paragraph}")
    sections = payload.get("sections")
    if isinstance(sections, list):
        for section in sections:
            if not isinstance(section, dict):
                continue
            label = str(section.get("label") or "").strip() or "未分组"
            items = section.get("items")
            if not isinstance(items, list):
                continue
            lines.append(f"\n## {label}")
            for item in items[:6]:
                if isinstance(item, dict):
                    lines.append(_render_item_line(item))
    return "\n".join(line for line in lines if line.strip()).strip()


def _render_items(payload: dict[str, object]) -> str:
    items = payload.get("items")
    if not isinstance(items, list):
        return ""
    lines = ["source: AIHOT selected items"]
    for item in items[:20]:
        if isinstance(item, dict):
            lines.append(_render_item_line(item))
    return "\n".join(line for line in lines if line.strip()).strip()


def _render_item_line(item: dict[str, object]) -> str:
    title = str(item.get("titleZh") or item.get("title") or "").strip()
    summary = str(item.get("summaryZh") or item.get("summary") or "").strip()
    source = str(item.get("sourceName") or item.get("source") or "").strip()
    url = str(item.get("sourceUrl") or item.get("url") or item.get("originalUrl") or "").strip()
    parts = [f"- {title}" if title else "- untitled"]
    if summary:
        parts.append(summary)
    if source:
        parts.append(f"source={source}")
    if url:
        parts.append(f"url={url}")
    return " | ".join(parts)
