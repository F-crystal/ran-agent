"""Todo and reminder management for the personal agent.

Provides high-level operations for creating, retrieving, and managing todos
and reminders, including natural language time parsing.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.interfaces.model import ModelClient
from personal_agent.temporal_parser import TemporalParser, TimeParseResult


@dataclass(frozen=True)
class TodoItem:
    """Represents a single todo item."""

    id: int
    content: str
    reminder_at: str | None
    status: str
    source: str
    created_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> TodoItem:
        """Create a TodoItem from a database row."""
        return cls(
            id=int(row["id"]),
            content=str(row["content"]),
            reminder_at=str(row["reminder_at"]) if row["reminder_at"] else None,
            status=str(row["status"]),
            source=str(row["source"]),
            created_at=str(row["created_at"]),
        )


@dataclass(frozen=True)
class ReminderCheckResult:
    """Result of checking for due reminders."""

    due_reminders: tuple[TodoItem, ...]
    next_check_time: str | None


@dataclass(frozen=True)
class TodoCreationResult:
    """Result of creating a new todo."""

    success: bool
    todo_id: int | None
    parsed_time: str | None
    explanation: str
    needs_confirmation: bool


class TodoManager:
    """Manages todos and reminders with natural language time parsing."""

    def __init__(
        self,
        database: Database,
        logger: logging.Logger,
        config: AppConfig,
        model_client: ModelClient | None = None,
    ) -> None:
        self._database = database
        self._logger = logger
        self._config = config
        self._temporal_parser = TemporalParser(
            model_client=model_client,
            logger=logger,
            config=config,
        )

    def create_todo_from_text(
        self,
        text: str,
        source: str = "user",
        extract_time: bool = True,
    ) -> TodoCreationResult:
        """Create a todo from natural language text, optionally extracting reminder time.

        Args:
            text: Natural language description (e.g., "晚上8点提醒我吃饭")
            source: Source of the todo (user, agent, etc.)
            extract_time: Whether to extract time from the text

        Returns:
            TodoCreationResult with the created todo details
        """
        if not extract_time:
            todo_id = self._database.create_todo(content=text, reminder_at=None, source=source)
            return TodoCreationResult(
                success=True,
                todo_id=todo_id,
                parsed_time=None,
                explanation="Todo created without reminder time",
                needs_confirmation=False,
            )

        # Try to extract time from text
        time_result = self._extract_time_from_text(text)

        if time_result.success and time_result.iso_timestamp:
            # Remove time expression from content for cleaner storage
            clean_content = self._remove_time_expression(text)
            todo_id = self._database.create_todo(
                content=clean_content,
                reminder_at=time_result.iso_timestamp,
                source=source,
            )
            return TodoCreationResult(
                success=True,
                todo_id=todo_id,
                parsed_time=time_result.iso_timestamp,
                explanation=time_result.explanation,
                needs_confirmation=time_result.confidence < 0.8,
            )
        if time_result.success and time_result.resolution_kind in {"date", "datetimerange", "daterange", "timerange"}:
            todo_id = self._database.create_todo(content=text, reminder_at=None, source=source)
            return TodoCreationResult(
                success=True,
                todo_id=todo_id,
                parsed_time=None,
                explanation=(
                    f"Parsed {time_result.resolution_kind} without exact clock time"
                    if time_result.explanation == ""
                    else time_result.explanation
                ),
                needs_confirmation=True,
            )
        else:
            # Create todo without reminder time
            todo_id = self._database.create_todo(content=text, reminder_at=None, source=source)
            return TodoCreationResult(
                success=True,
                todo_id=todo_id,
                parsed_time=None,
                explanation=f"Could not parse time: {time_result.explanation}",
                needs_confirmation=False,
            )

    def create_todo_with_time(
        self,
        content: str,
        time_expression: str,
        source: str = "user",
    ) -> TodoCreationResult:
        """Create a todo with an explicit time expression.

        Args:
            content: Todo content/description
            time_expression: Natural language time (e.g., "晚上8点")
            source: Source of the todo

        Returns:
            TodoCreationResult with the created todo details
        """
        time_result = self._temporal_parser.parse(time_expression)

        if time_result.success and time_result.iso_timestamp:
            todo_id = self._database.create_todo(
                content=content,
                reminder_at=time_result.iso_timestamp,
                source=source,
            )
            return TodoCreationResult(
                success=True,
                todo_id=todo_id,
                parsed_time=time_result.iso_timestamp,
                explanation=time_result.explanation,
                needs_confirmation=time_result.confidence < 0.8,
            )
        else:
            return TodoCreationResult(
                success=False,
                todo_id=None,
                parsed_time=None,
                explanation=f"Failed to parse time: {time_result.explanation}",
                needs_confirmation=False,
            )

    def get_pending_todos(self, limit: int = 20) -> list[TodoItem]:
        """Get all pending todos ordered by reminder time."""
        rows = self._database.get_pending_todos(limit=limit)
        return [TodoItem.from_row(row) for row in rows]

    def get_due_reminders(self, before_time: datetime | None = None) -> list[TodoItem]:
        """Get reminders that are due before the specified time.

        Args:
            before_time: Check for reminders due before this time (defaults to now)

        Returns:
            List of due TodoItems
        """
        check_time = before_time or datetime.now()
        time_str = check_time.strftime("%Y-%m-%d %H:%M:%S")
        rows = self._database.get_due_reminders(time_str)
        return [TodoItem.from_row(row) for row in rows]

    def check_reminders(self) -> ReminderCheckResult:
        """Check for due reminders and determine next check time.

        Returns:
            ReminderCheckResult with due reminders and next check time
        """
        now = datetime.now()
        due_reminders = self.get_due_reminders(before_time=now)

        # Find next pending reminder for scheduling next check
        next_check = self._get_next_reminder_time()

        return ReminderCheckResult(
            due_reminders=tuple(due_reminders),
            next_check_time=next_check,
        )

    def mark_done(self, todo_id: int) -> bool:
        """Mark a todo as completed."""
        return self._database.mark_todo_done(todo_id)

    def mark_cancelled(self, todo_id: int) -> bool:
        """Mark a todo as cancelled."""
        return self._database.mark_todo_cancelled(todo_id)

    def complete_best_pending_todo(self) -> TodoItem | None:
        """Mark the most relevant pending todo as completed and return it."""
        row = self._database.get_best_pending_todo_for_completion()
        if row is None:
            return None
        todo = TodoItem.from_row(row)
        if not self._database.mark_todo_done(todo.id):
            return None
        return todo

    def cancel_best_pending_todo(self) -> TodoItem | None:
        """Mark the most relevant pending todo as cancelled and return it."""
        row = self._database.get_best_pending_todo_for_completion()
        if row is None:
            return None
        todo = TodoItem.from_row(row)
        if not self._database.mark_todo_cancelled(todo.id):
            return None
        return todo

    def get_todo_by_id(self, todo_id: int) -> TodoItem | None:
        """Get a specific todo by ID."""
        # This would need to be added to db.py
        with self._database.connection() as conn:
            row = conn.execute(
                """
                SELECT id, content, reminder_at, status, source, created_at
                FROM todos
                WHERE id = ?
                """,
                (todo_id,),
            ).fetchone()
        if row:
            return TodoItem.from_row(row)
        return None

    def format_reminder_message(self, todo: TodoItem) -> str:
        """Format a friendly reminder message for a todo."""
        content = todo.content

        # Add contextual greeting based on time
        hour = datetime.now().hour
        if 6 <= hour < 12:
            greeting = "早上好"
        elif 12 <= hour < 18:
            greeting = "下午好"
        elif 18 <= hour < 22:
            greeting = "晚上好"
        else:
            greeting = "夜深了"

        return f"{greeting}，提醒一下：{content}"

    def _extract_time_from_text(self, text: str) -> TimeParseResult:
        """Extract time expression from natural language text."""
        # Common patterns that indicate a reminder request
        reminder_patterns = [
            r"(?:提醒|叫我|让我).{0,10}?(.{0,20}?)[做|去|记得]",
            r"(.{0,20}?)的时候?提醒",
            r"(.{0,20}?)[提醒我|叫我]",
        ]

        # Try to find time expression in the text
        time_result = self._temporal_parser.parse(text)

        if time_result.success:
            return time_result

        # Try extracting just the time portion
        # Look for patterns like "晚上8点" or "明天下午"
        time_patterns = [
            r"(今天|明天|后天)?\s*(早上|上午|中午|下午|晚上|今晚|凌晨)?\s*(\d{1,2})?\s*[点:：]\s*(\d{1,2})?",
            r"(\d{1,2})\s*个?小时?后",
            r"(\d{1,2})\s*分钟?后",
        ]

        for pattern in time_patterns:
            import re
            match = re.search(pattern, text)
            if match:
                time_expr = match.group(0)
                return self._temporal_parser.parse(time_expr)

        return time_result

    def _remove_time_expression(self, text: str) -> str:
        """Remove time expression from text to get clean content."""
        # Patterns to remove
        remove_patterns = [
            r"(?:提醒|叫我|让我)\s*",
            r"(?:今天|明天|后天)\s*",
            r"(?:早上|上午|中午|下午|晚上|今晚|凌晨)\s*",
            r"\d{1,2}\s*点\s*\d{1,2}\s*分?",
            r"\d{1,2}\s*点(?:半|钟)?",
            r"\d{1,2}\s*个?小时?后",
            r"\d{1,2}\s*分钟?后",
        ]

        import re
        clean_text = text
        for pattern in remove_patterns:
            clean_text = re.sub(pattern, "", clean_text)

        # Clean up extra whitespace
        clean_text = re.sub(r"\s+", " ", clean_text).strip()

        return clean_text if clean_text else text

    def _get_next_reminder_time(self) -> str | None:
        """Get the timestamp of the next pending reminder."""
        with self._database.connection() as conn:
            row = conn.execute(
                """
                SELECT reminder_at
                FROM todos
                WHERE status = 'pending'
                  AND reminder_at IS NOT NULL
                  AND reminder_at > datetime('now', 'localtime')
                ORDER BY reminder_at ASC
                LIMIT 1
                """,
            ).fetchone()
        if row and row["reminder_at"]:
            return str(row["reminder_at"])
        return None


def extract_todo_from_message(
    message: str,
    database: Database,
    logger: logging.Logger,
    config: AppConfig,
    model_client: ModelClient | None = None,
) -> TodoCreationResult:
    """Convenience function to extract and create a todo from a user message."""
    manager = TodoManager(database, logger, config, model_client)
    return manager.create_todo_from_text(message, source="user")
