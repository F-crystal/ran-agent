"""Natural language time parsing for reminder scheduling.

Converts Chinese natural language time expressions into ISO 8601 timestamps.
Examples:
- "晚上8点" -> "2024-01-15 20:00:00"
- "明天下午3点" -> "2024-01-16 15:00:00"
- "半小时后" -> "2024-01-15 14:30:00" (if now is 14:00)
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from personal_agent.config import AppConfig
from personal_agent.interfaces.model import ModelClient, ModelRequest

try:
    from recognizers_date_time import recognize_datetime
    from recognizers_text import Culture
except ImportError:  # pragma: no cover - exercised by environments without the dependency
    recognize_datetime = None
    Culture = None


@dataclass(frozen=True)
class TimeParseResult:
    """Result of parsing a natural language time expression."""

    success: bool
    iso_timestamp: str | None
    explanation: str
    confidence: float  # 0.0 to 1.0
    resolution_kind: str = "point"
    range_start: str | None = None
    range_end: str | None = None


class TemporalParser:
    """Parses natural language time expressions using rule-based and LLM fallback."""

    # Common Chinese time patterns
    TIME_PATTERNS = {
        "hour_only": re.compile(r"(\d{1,2})\s*点(?:钟)?"),
        "hour_minute": re.compile(r"(\d{1,2})\s*点\s*(\d{1,2})\s*分?"),
        "half_hour": re.compile(r"(\d{1,2})\s*点半"),
        "relative_minutes": re.compile(r"(\d+)\s*分钟?后"),
        "relative_hours": re.compile(r"(\d+)\s*个?小时?后"),
        "relative_days": re.compile(r"(\d+)\s*天后"),
        "half_hour_relative": re.compile(r"半\s*个?小时?后"),
        "tomorrow": re.compile(r"明天"),
        "tonight": re.compile(r"今晚|今天晚上"),
        "this_afternoon": re.compile(r"今天下午|下午"),
        "this_morning": re.compile(r"今天早上|今天上午|早上|上午"),
        "noon": re.compile(r"中午|午饭"),
        "evening": re.compile(r"晚上|傍晚|晚饭"),
        "midnight": re.compile(r"午夜|凌晨|半夜"),
    }

    TIME_OF_DAY_OFFSETS = {
        "morning": 8,  # 早上/上午默认 8点
        "noon": 12,  # 中午默认 12点
        "afternoon": 15,  # 下午默认 15点
        "evening": 20,  # 晚上默认 20点
        "night": 21,  # 今晚默认 21点
        "midnight": 0,  # 午夜默认 0点
    }

    def __init__(
        self,
        model_client: ModelClient | None = None,
        logger: logging.Logger | None = None,
        config: AppConfig | None = None,
    ) -> None:
        self._model_client = model_client
        self._logger = logger or logging.getLogger(__name__)
        self._config = config
        self._timezone = "Asia/Shanghai"

    def parse(
        self,
        text: str,
        reference_time: datetime | None = None,
        use_llm_fallback: bool = True,
    ) -> TimeParseResult:
        """Parse a natural language time expression.

        Args:
            text: Natural language time expression (e.g., "晚上8点")
            reference_time: Base time for relative expressions (defaults to now)
            use_llm_fallback: Whether to use LLM if rule-based parsing fails

        Returns:
            TimeParseResult with parsed timestamp or failure explanation
        """
        now = reference_time or datetime.now()

        recognizer_result = self._parse_with_microsoft_recognizer(text, now)
        if recognizer_result.success:
            self._logger.info(
                "time parsed microsoft text=%s kind=%s result=%s range=%s~%s",
                text[:50],
                recognizer_result.resolution_kind,
                recognizer_result.iso_timestamp,
                recognizer_result.range_start,
                recognizer_result.range_end,
            )
            return recognizer_result

        # Try rule-based parsing first
        result = self._parse_rule_based(text, now)
        if result.success:
            self._logger.info(
                "time parsed rule_based text=%s result=%s",
                text[:50],
                result.iso_timestamp,
            )
            return result

        # Fall back to LLM if enabled
        if use_llm_fallback and self._model_client is not None:
            result = self._parse_with_llm(text, now)
            self._logger.info(
                "time parsed llm text=%s success=%s",
                text[:50],
                result.success,
            )
            return result

        return TimeParseResult(
            success=False,
            iso_timestamp=None,
            explanation=f"Could not parse time expression: {text}",
            confidence=0.0,
        )

    def _parse_rule_based(self, text: str, now: datetime) -> TimeParseResult:
        """Attempt to parse using regex patterns."""
        text = text.strip().lower()

        # First, check for relative time expressions (highest priority)
        # Check for relative minutes
        match = self.TIME_PATTERNS["relative_minutes"].search(text)
        if match:
            minutes = int(match.group(1))
            target = now + timedelta(minutes=minutes)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {minutes} minutes from now",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for relative hours
        match = self.TIME_PATTERNS["relative_hours"].search(text)
        if match:
            hours = int(match.group(1))
            target = now + timedelta(hours=hours)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {hours} hours from now",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for "半小时后"
        match = self.TIME_PATTERNS["half_hour_relative"].search(text)
        if match:
            target = now + timedelta(minutes=30)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation="Parsed as 30 minutes from now",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for relative days
        match = self.TIME_PATTERNS["relative_days"].search(text)
        if match:
            days = int(match.group(1))
            target = now + timedelta(days=days)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {days} days from now",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for time-of-day keywords with explicit hour
        # Pattern: [time-of-day] + [hour] like "晚上8点"
        time_of_day, base_hour = self._detect_time_of_day(text)

        # Check for explicit hour:minute patterns
        match = self.TIME_PATTERNS["hour_minute"].search(text)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2))
            # Adjust hour based on time-of-day context
            if time_of_day == "evening" and hour < 12:
                hour += 12  # 晚上8点 -> 20:00
            elif time_of_day == "afternoon" and hour < 12:
                hour += 12  # 下午3点 -> 15:00
            target = self._resolve_datetime(now, hour, minute, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {hour}:{minute:02d}",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for X点半 pattern
        match = self.TIME_PATTERNS["half_hour"].search(text)
        if match:
            hour = int(match.group(1))
            # Adjust hour based on time-of-day context
            if time_of_day == "evening" and hour < 12:
                hour += 12
            elif time_of_day == "afternoon" and hour < 12:
                hour += 12
            target = self._resolve_datetime(now, hour, 30, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {hour}:30",
                confidence=0.95,
                resolution_kind="datetime",
            )

        # Check for hour only pattern
        match = self.TIME_PATTERNS["hour_only"].search(text)
        if match:
            hour = int(match.group(1))
            # Adjust hour based on time-of-day context
            if time_of_day == "evening" and hour < 12:
                hour += 12
            elif time_of_day == "afternoon" and hour < 12:
                hour += 12
            target = self._resolve_datetime(now, hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {hour}:00",
                confidence=0.90,
                resolution_kind="datetime",
            )

        # Check for time-of-day keywords with modifiers (tomorrow)
        if self.TIME_PATTERNS["tomorrow"].search(text):
            target_date = now + timedelta(days=1)
            hour = self._extract_hour_from_text(text) or base_hour or self.TIME_OF_DAY_OFFSETS["morning"]
            # Adjust hour for afternoon/evening
            if time_of_day == "afternoon" and hour < 12:
                hour += 12
            elif time_of_day == "evening" and hour < 12:
                hour += 12
            target = target_date.replace(hour=hour, minute=0, second=0, microsecond=0)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as tomorrow at {hour}:00",
                confidence=0.85,
                resolution_kind="datetime",
            )

        # Check for standalone time-of-day keywords
        if time_of_day and base_hour:
            target = self._resolve_datetime(now, base_hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as {time_of_day} at {base_hour}:00",
                confidence=0.80,
                resolution_kind="datetime",
            )

        if self.TIME_PATTERNS["this_afternoon"].search(text):
            hour = self._extract_hour_from_text(text) or self.TIME_OF_DAY_OFFSETS["afternoon"]
            target = self._resolve_datetime(now, hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as this afternoon at {hour}:00",
                confidence=0.85,
                resolution_kind="datetime",
            )

        if self.TIME_PATTERNS["this_morning"].search(text):
            hour = self._extract_hour_from_text(text) or self.TIME_OF_DAY_OFFSETS["morning"]
            target = self._resolve_datetime(now, hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as this morning at {hour}:00",
                confidence=0.85,
                resolution_kind="datetime",
            )

        if self.TIME_PATTERNS["noon"].search(text):
            hour = self._extract_hour_from_text(text) or self.TIME_OF_DAY_OFFSETS["noon"]
            target = self._resolve_datetime(now, hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as noon at {hour}:00",
                confidence=0.80,
                resolution_kind="datetime",
            )

        if self.TIME_PATTERNS["evening"].search(text):
            hour = self._extract_hour_from_text(text) or self.TIME_OF_DAY_OFFSETS["evening"]
            target = self._resolve_datetime(now, hour, 0, text)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed as evening at {hour}:00",
                confidence=0.80,
                resolution_kind="datetime",
            )

        return TimeParseResult(
            success=False,
            iso_timestamp=None,
            explanation="No rule-based pattern matched",
            confidence=0.0,
        )

    def _detect_time_of_day(self, text: str) -> tuple[str | None, int | None]:
        """Detect time-of-day keyword and return its type and base hour.

        Returns:
            Tuple of (time_of_day_type, base_hour)
            time_of_day_type: "morning", "afternoon", "evening", "night", "noon", "midnight"
            base_hour: The default hour for this time of day
        """
        if self.TIME_PATTERNS["this_morning"].search(text):
            return ("morning", self.TIME_OF_DAY_OFFSETS["morning"])
        if self.TIME_PATTERNS["noon"].search(text):
            return ("noon", self.TIME_OF_DAY_OFFSETS["noon"])
        if self.TIME_PATTERNS["this_afternoon"].search(text):
            return ("afternoon", self.TIME_OF_DAY_OFFSETS["afternoon"])
        if self.TIME_PATTERNS["evening"].search(text):
            return ("evening", self.TIME_OF_DAY_OFFSETS["evening"])
        if self.TIME_PATTERNS["tonight"].search(text):
            return ("night", self.TIME_OF_DAY_OFFSETS["night"])
        if self.TIME_PATTERNS["midnight"].search(text):
            return ("midnight", self.TIME_OF_DAY_OFFSETS["midnight"])
        return (None, None)

    def _parse_with_microsoft_recognizer(self, text: str, now: datetime) -> TimeParseResult:
        if recognize_datetime is None or Culture is None:
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation="Microsoft Recognizers-Text unavailable",
                confidence=0.0,
            )

        try:
            results = recognize_datetime(text, Culture.Chinese, reference=now)
        except Exception as exc:
            self._logger.warning("microsoft recognizer parse failed text=%s error=%s", text[:50], exc)
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation=f"Microsoft recognizer error: {exc}",
                confidence=0.0,
            )

        if not results:
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation="Microsoft recognizer found no temporal expressions",
                confidence=0.0,
            )

        primary = results[0]
        resolution = getattr(primary, "resolution", None) or {}
        values = resolution.get("values") or []
        if not values:
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation="Microsoft recognizer returned no values",
                confidence=0.0,
            )

        primary_type = str(getattr(primary, "type_name", "")).replace("datetimeV2.", "")
        if primary_type == "datetimerange":
            candidate = self._select_future_range_candidate(values, now)
            if candidate is None:
                return TimeParseResult(
                    success=False,
                    iso_timestamp=None,
                    explanation="Recognizer returned only past datetime ranges",
                    confidence=0.0,
                )
            return TimeParseResult(
                success=True,
                iso_timestamp=None,
                explanation=f"Parsed as range {candidate['start']} to {candidate['end']}",
                confidence=0.96,
                resolution_kind="datetimerange",
                range_start=candidate["start"],
                range_end=candidate["end"],
            )

        if primary_type == "date":
            candidate = self._select_future_value_candidate(values, now, key="value")
            if candidate is None:
                return TimeParseResult(
                    success=False,
                    iso_timestamp=None,
                    explanation="Recognizer returned only past dates",
                    confidence=0.0,
                )
            return TimeParseResult(
                success=True,
                iso_timestamp=None,
                explanation=f"Parsed as date {candidate}",
                confidence=0.9,
                resolution_kind="date",
                range_start=f"{candidate} 00:00:00",
                range_end=f"{candidate} 23:59:59",
            )

        if primary_type == "time":
            value = self._select_first_value(values, key="value")
            if value is None:
                return TimeParseResult(
                    success=False,
                    iso_timestamp=None,
                    explanation="Recognizer returned no time value",
                    confidence=0.0,
                )
            hour, minute, second = (int(part) for part in value.split(":"))
            target = self._resolve_datetime(now, hour, minute, text)
            if len(value.split(":")) == 3:
                target = target.replace(second=second)
            return TimeParseResult(
                success=True,
                iso_timestamp=target.strftime("%Y-%m-%d %H:%M:%S"),
                explanation=f"Parsed time {value}",
                confidence=0.95,
                resolution_kind="time",
            )

        candidate = self._select_future_value_candidate(values, now, key="value")
        if candidate is None:
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation="Recognizer returned only past datetimes",
                confidence=0.0,
            )
        return TimeParseResult(
            success=True,
            iso_timestamp=candidate,
            explanation=f"Parsed as {candidate}",
            confidence=0.97,
            resolution_kind=primary_type or "datetime",
        )

    def _select_future_value_candidate(
        self,
        values: list[dict[str, Any]],
        now: datetime,
        *,
        key: str,
    ) -> str | None:
        normalized: list[tuple[datetime, str]] = []
        for value in values:
            raw = value.get(key)
            if not isinstance(raw, str):
                continue
            parsed = self._parse_resolution_datetime(raw)
            if parsed is None:
                continue
            normalized.append((parsed, raw))
        for parsed, raw in sorted(normalized, key=lambda item: item[0]):
            if parsed >= now:
                return raw
        return normalized[-1][1] if normalized else None

    def _select_future_range_candidate(
        self,
        values: list[dict[str, Any]],
        now: datetime,
    ) -> dict[str, str] | None:
        normalized: list[tuple[datetime, datetime, dict[str, str]]] = []
        for value in values:
            start = value.get("start")
            end = value.get("end")
            if not isinstance(start, str) or not isinstance(end, str):
                continue
            parsed_start = self._parse_resolution_datetime(start)
            parsed_end = self._parse_resolution_datetime(end)
            if parsed_start is None or parsed_end is None:
                continue
            normalized.append((parsed_start, parsed_end, {"start": start, "end": end}))
        for parsed_start, parsed_end, raw in sorted(normalized, key=lambda item: item[0]):
            if parsed_end >= now:
                return raw
        return normalized[-1][2] if normalized else None

    def _select_first_value(self, values: list[dict[str, Any]], *, key: str) -> str | None:
        for value in values:
            raw = value.get(key)
            if isinstance(raw, str):
                return raw
        return None

    def _parse_resolution_datetime(self, value: str) -> datetime | None:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(value, fmt)
                if fmt == "%Y-%m-%d":
                    return parsed.replace(hour=0, minute=0, second=0, microsecond=0)
                return parsed
            except ValueError:
                continue
        return None

    def _extract_hour_from_text(self, text: str) -> int | None:
        """Extract hour number from text if present."""
        match = self.TIME_PATTERNS["hour_only"].search(text)
        if match:
            return int(match.group(1))
        return None

    def _resolve_datetime(self, now: datetime, hour: int, minute: int, text: str) -> datetime:
        """Resolve a time to a datetime, handling day rollover if needed."""
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

        # If the time has already passed today and no explicit date is mentioned,
        # assume tomorrow
        if target <= now and not self.TIME_PATTERNS["tomorrow"].search(text):
            # Check if any date modifier is present
            has_date_modifier = any(
                pattern.search(text)
                for name, pattern in self.TIME_PATTERNS.items()
                if name in ["tomorrow", "relative_days"]
            )
            if not has_date_modifier:
                target += timedelta(days=1)

        return target

    def _parse_with_llm(self, text: str, now: datetime) -> TimeParseResult:
        """Use LLM to parse complex time expressions."""
        if self._model_client is None:
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation="LLM client not available",
                confidence=0.0,
            )

        system_prompt = """You are a temporal parsing assistant. Parse the user's time expression into a structured format.

Current time: {current_time}
Timezone: Asia/Shanghai

Respond with a JSON object:
{{
    "success": true/false,
    "iso_timestamp": "YYYY-MM-DD HH:MM:SS" or null,
    "explanation": "brief explanation of how you interpreted the time",
    "confidence": 0.0 to 1.0
}}

Rules:
- If the time has already passed today and no date is specified, assume tomorrow
- Handle relative times (e.g., "半小时后" = 30 minutes from now)
- Handle time-of-day keywords (早上=8, 中午=12, 下午=15, 晚上=20, 今晚=21)
- Return success=false if you cannot parse the expression"""

        request = ModelRequest(
            system_prompt=system_prompt.format(
                current_time=now.strftime("%Y-%m-%d %H:%M:%S")
            ),
            user_message=f'Parse this time expression: "{text}"',
        )

        try:
            response = self._model_client.generate_reply(request)
            if response.is_error:
                return TimeParseResult(
                    success=False,
                    iso_timestamp=None,
                    explanation=f"LLM error: {response.error_message}",
                    confidence=0.0,
                )

            # Extract JSON from response
            result = self._extract_json_from_text(response.text)
            if result is None:
                return TimeParseResult(
                    success=False,
                    iso_timestamp=None,
                    explanation="Could not extract valid JSON from LLM response",
                    confidence=0.0,
                )

            return TimeParseResult(
                success=result.get("success", False),
                iso_timestamp=result.get("iso_timestamp"),
                explanation=result.get("explanation", "LLM parsed"),
                confidence=result.get("confidence", 0.5),
            )

        except Exception as e:
            self._logger.exception("LLM time parsing failed")
            return TimeParseResult(
                success=False,
                iso_timestamp=None,
                explanation=f"LLM parsing error: {str(e)}",
                confidence=0.0,
            )

    def _extract_json_from_text(self, text: str) -> dict[str, Any] | None:
        """Extract JSON object from text, handling code blocks."""
        # Try to find JSON in code blocks
        code_block_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if code_block_match:
            text = code_block_match.group(1)

        # Try to find JSON object directly
        json_match = re.search(r"\{.*\}", text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass

        return None


def parse_reminder_time(
    text: str,
    model_client: ModelClient | None = None,
    logger: logging.Logger | None = None,
) -> TimeParseResult:
    """Convenience function to parse a reminder time expression."""
    parser = TemporalParser(model_client=model_client, logger=logger)
    return parser.parse(text, use_llm_fallback=(model_client is not None))
