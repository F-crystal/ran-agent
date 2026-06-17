"""Background knowledge-agent wrapper around a configurable local vault manager."""

from __future__ import annotations

import json
import logging
import os
import signal
import shlex
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from personal_agent.config import AppConfig


STATE_FILENAME = "knowledge_state.json"


@dataclass(frozen=True)
class KnowledgeRunResult:
    """Structured result for one background knowledge-agent run."""

    action: str
    trigger: str
    status: str
    started_at: str
    finished_at: str
    inbox_count_before: int
    inbox_count_after: int
    processed_inbox_count: int
    pending_knowledge_maintenance: bool
    recent_curated_topics: tuple[str, ...]
    recent_source_additions: tuple[str, ...]
    output_excerpt: str = ""
    error: str = ""
    returncode: int = 0
    timed_out: bool = False
    duration_seconds: float = 0.0


@dataclass(frozen=True)
class KnowledgeState:
    """Machine-readable background knowledge-maintenance state."""

    updated_at: str = ""
    last_checked_at: str = ""
    last_run_at: str = ""
    last_action: str = ""
    last_trigger: str = ""
    last_status: str = ""
    inbox_count: int = 0
    processed_inbox_count: int = 0
    pending_knowledge_maintenance: bool = False
    last_error: str = ""
    last_output_excerpt: str = ""
    last_returncode: int = 0
    last_timed_out: bool = False
    last_duration_seconds: float = 0.0
    recent_curated_topics: tuple[str, ...] = ()
    recent_source_additions: tuple[str, ...] = ()


CommandRunner = Callable[[str], subprocess.CompletedProcess]


class KnowledgeAgent:
    """Owns background knowledge maintenance without entering the chat path."""

    def __init__(
        self,
        *,
        config: AppConfig,
        logger: logging.Logger,
        command_runner: CommandRunner | None = None,
    ) -> None:
        self._config = config
        self._logger = logger
        self._command_runner = command_runner or self._default_command_runner

    def execute_background_maintenance(self, *, now_local: datetime | None = None) -> KnowledgeRunResult:
        """Execute background knowledge maintenance when opportunity is judged as silent.
        
        This method performs knowledge maintenance without user interaction.
        It processes inbox items and organizes them into the vault.
        """
        local_now = now_local or datetime.now()
        
        # Use auto_run with life_loop trigger for silent background work
        result = self.auto_run(trigger="life_loop_silent", now_local=local_now)
        
        self._logger.info(
            "knowledge background maintenance completed action=%s status=%s inbox_before=%d inbox_after=%d processed=%d",
            result.action,
            result.status,
            result.inbox_count_before,
            result.inbox_count_after,
            result.processed_inbox_count,
        )
        
        return result

    def count_inbox_items(self) -> int:
        """Return the number of current inbox items awaiting knowledge maintenance."""

        return sum(1 for _path in self._iter_inbox_items())

    def should_surface_maintenance(self, *, now_local: datetime) -> bool:
        """Return whether the life loop should surface a knowledge-maintenance opportunity."""

        state = load_knowledge_state(self._config)
        inbox_count = self.count_inbox_items()
        if inbox_count <= 0:
            return False
        if (
            self._config.knowledge_backlog_trigger_count > 0
            and inbox_count > self._config.knowledge_backlog_trigger_count
        ):
            return True
        oldest_age_minutes = self._oldest_inbox_item_age_minutes(now_local=now_local)
        if (
            self._config.knowledge_backlog_trigger_age_minutes > 0
            and oldest_age_minutes is not None
            and oldest_age_minutes >= self._config.knowledge_backlog_trigger_age_minutes
        ):
            return True
        if not state.last_checked_at:
            return True
        try:
            last_checked = datetime.strptime(state.last_checked_at, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return True
        return (now_local - last_checked) >= timedelta(minutes=self._config.knowledge_check_interval_minutes)

    def _iter_inbox_items(self):
        inbox_dir = self._config.vault_dir / "inbox"
        if not inbox_dir.exists():
            return []
        return (
            path
            for path in inbox_dir.rglob("*")
            if path.is_file()
            and not path.name.startswith(".")
            and all(not part.startswith(".") for part in path.parts)
        )

    def _oldest_inbox_item_age_minutes(self, *, now_local: datetime) -> float | None:
        oldest_modified_at: datetime | None = None
        for path in self._iter_inbox_items():
            try:
                modified_at = datetime.fromtimestamp(path.stat().st_mtime)
            except OSError:
                continue
            if oldest_modified_at is None or modified_at < oldest_modified_at:
                oldest_modified_at = modified_at
        if oldest_modified_at is None:
            return None
        return max(0.0, (now_local - oldest_modified_at).total_seconds() / 60)

    def auto_run(self, *, trigger: str, now_local: datetime | None = None) -> KnowledgeRunResult:
        """Run plan → apply → cleanup chain for knowledge management."""

        local_now = now_local or datetime.now()
        inbox_count = self.count_inbox_items()
        state = load_knowledge_state(self._config)
        if inbox_count <= 0:
            result = self._build_noop_result(
                trigger=trigger,
                now_local=local_now,
                inbox_count=inbox_count,
                status="skipped",
                error="",
            )
            save_knowledge_state(self._config, self._result_to_state(result))
            return result

        chain = ["plan", "apply", "cleanup"]
        self._logger.info("knowledge agent auto_run starting chain=%s trigger=%s inbox_count=%s", chain, trigger, inbox_count)

        last_result: KnowledgeRunResult | None = None
        stopped_result: KnowledgeRunResult | None = None
        for action in chain:
            result = self.run(action=action, trigger=trigger, now_local=local_now)
            last_result = result
            local_now = datetime.now()
            self._logger.info(
                "knowledge agent chain step completed action=%s status=%s inbox_before=%s inbox_after=%s",
                action,
                result.status,
                result.inbox_count_before,
                result.inbox_count_after,
            )
            if result.status != "ok":
                self._logger.warning(
                    "knowledge agent chain step did not complete action=%s status=%s, stopping chain",
                    action,
                    result.status,
                )
                stopped_result = result
                break
            if result.inbox_count_after <= 0:
                self._logger.info("knowledge agent chain: inbox empty after action=%s, stopping chain", action)
                break

        return stopped_result or last_result or self._build_noop_result(
            trigger=trigger,
            now_local=datetime.now(),
            inbox_count=inbox_count,
            status="skipped",
            error="no actions executed",
        )

    def run(
        self,
        *,
        action: str,
        trigger: str,
        now_local: datetime | None = None,
    ) -> KnowledgeRunResult:
        """Execute one concrete knowledge-manager action through the local shell wrapper."""

        local_now = now_local or datetime.now()
        inbox_before = self.count_inbox_items()
        daily_carryover_target = self._daily_carryover_note_path(local_now) if action == "daily_carryover" else None
        if daily_carryover_target is not None and not daily_carryover_target.exists():
            result = self._build_noop_result(
                trigger=trigger,
                now_local=local_now,
                inbox_count=inbox_before,
                status="skipped",
                error="daily carry-over note already absent from inbox",
                action=action,
            )
            save_knowledge_state(self._config, self._result_to_state(result))
            return result
        started_at = local_now.strftime("%Y-%m-%d %H:%M:%S")
        started_monotonic = time.monotonic()
        try:
            completed = self._command_runner(action)
            duration_seconds = time.monotonic() - started_monotonic
            status = "ok" if completed.returncode == 0 else "failed"
            output_excerpt = _tail_excerpt((completed.stdout or "") + "\n" + (completed.stderr or ""))
            error = "" if completed.returncode == 0 else output_excerpt
        except subprocess.TimeoutExpired as exc:
            duration_seconds = time.monotonic() - started_monotonic
            self._logger.error(
                "knowledge agent action timed out action=%s trigger=%s timeout_seconds=%s",
                action,
                trigger,
                exc.timeout,
            )
            stdout = _coerce_output(exc.output)
            stderr = _coerce_output(exc.stderr)
            output_excerpt = _tail_excerpt(stdout + "\n" + stderr)
            timeout_seconds = _format_seconds(exc.timeout)
            error = f"knowledge action {action} timed out after {timeout_seconds}s"
            if output_excerpt:
                error = f"{error}: {output_excerpt}"
            inbox_after = self.count_inbox_items()
            processed_count = max(0, inbox_before - inbox_after)
            result = KnowledgeRunResult(
                action=action,
                trigger=trigger,
                status="timeout",
                started_at=started_at,
                finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                inbox_count_before=inbox_before,
                inbox_count_after=inbox_after,
                processed_inbox_count=processed_count,
                pending_knowledge_maintenance=inbox_after > 0,
                recent_curated_topics=(),
                recent_source_additions=(),
                output_excerpt=output_excerpt,
                error=error,
                returncode=-9,
                timed_out=True,
                duration_seconds=duration_seconds,
            )
            save_knowledge_state(self._config, self._result_to_state(result))
            return result
        except Exception as exc:
            duration_seconds = time.monotonic() - started_monotonic
            self._logger.exception("knowledge agent action failed action=%s trigger=%s", action, trigger)
            result = KnowledgeRunResult(
                action=action,
                trigger=trigger,
                status="failed",
                started_at=started_at,
                finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                inbox_count_before=inbox_before,
                inbox_count_after=self.count_inbox_items(),
                processed_inbox_count=0,
                pending_knowledge_maintenance=True,
                recent_curated_topics=(),
                recent_source_additions=(),
                output_excerpt="",
                error=str(exc),
                returncode=-1,
                timed_out=False,
                duration_seconds=duration_seconds,
            )
            save_knowledge_state(self._config, self._result_to_state(result))
            return result

        inbox_after = self.count_inbox_items()
        processed_count = max(0, inbox_before - inbox_after)
        if completed.returncode == 0 and action == "apply" and inbox_before > 0 and processed_count <= 0:
            status = "no_progress"
            error = "knowledge action apply returned ok but did not reduce inbox"
        if (
            completed.returncode == 0
            and daily_carryover_target is not None
            and daily_carryover_target.exists()
        ):
            status = "no_progress"
            error = f"daily carry-over note remained in inbox: {daily_carryover_target.name}"
        recent_curated_topics = tuple(self._recent_modified_stems(self._config.vault_dir / "wiki", minutes=20))
        recent_source_additions = tuple(
            self._recent_modified_stems(self._config.vault_dir / "wiki" / "sources", minutes=20)
        )
        pending = inbox_after > 0
        result = KnowledgeRunResult(
            action=action,
            trigger=trigger,
            status=status,
            started_at=started_at,
            finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            inbox_count_before=inbox_before,
            inbox_count_after=inbox_after,
            processed_inbox_count=processed_count,
            pending_knowledge_maintenance=pending,
            recent_curated_topics=recent_curated_topics,
            recent_source_additions=recent_source_additions,
            output_excerpt=output_excerpt,
            error=error,
            returncode=completed.returncode,
            timed_out=False,
            duration_seconds=duration_seconds,
        )
        save_knowledge_state(self._config, self._result_to_state(result))
        return result

    def _build_noop_result(
        self,
        *,
        trigger: str,
        now_local: datetime,
        inbox_count: int,
        status: str,
        error: str,
        action: str = "noop",
    ) -> KnowledgeRunResult:
        timestamp = now_local.strftime("%Y-%m-%d %H:%M:%S")
        return KnowledgeRunResult(
            action=action,
            trigger=trigger,
            status=status,
            started_at=timestamp,
            finished_at=timestamp,
            inbox_count_before=inbox_count,
            inbox_count_after=inbox_count,
            processed_inbox_count=0,
            pending_knowledge_maintenance=inbox_count > 0,
            recent_curated_topics=(),
            recent_source_additions=(),
            output_excerpt="",
            error=error,
            returncode=0,
            timed_out=False,
            duration_seconds=0.0,
        )

    def _daily_carryover_note_path(self, now_local: datetime) -> Path:
        summary_date = (now_local - timedelta(days=1)).strftime("%Y-%m-%d")
        return self._config.vault_dir / "inbox" / f"night_cycle_{summary_date}.md"

    def _result_to_state(self, result: KnowledgeRunResult) -> KnowledgeState:
        return KnowledgeState(
            updated_at=result.finished_at,
            last_checked_at=result.finished_at,
            last_run_at=result.finished_at if result.action != "noop" else "",
            last_action=result.action,
            last_trigger=result.trigger,
            last_status=result.status,
            inbox_count=result.inbox_count_after,
            processed_inbox_count=result.processed_inbox_count,
            pending_knowledge_maintenance=result.pending_knowledge_maintenance,
            last_error=result.error,
            last_output_excerpt=result.output_excerpt,
            last_returncode=result.returncode,
            last_timed_out=result.timed_out,
            last_duration_seconds=result.duration_seconds,
            recent_curated_topics=result.recent_curated_topics,
            recent_source_additions=result.recent_source_additions,
        )

    def _default_command_runner(self, action: str) -> subprocess.CompletedProcess[str]:
        command = self._build_command(action)
        self._logger.info(
            "knowledge agent running runner=%s action=%s command=%s",
            self._config.knowledge_agent_runner_name,
            action,
            command,
        )
        env = os.environ.copy()
        api_key_env_var = self._config.knowledge_agent_api_key_env_var.strip()
        if api_key_env_var:
            env[api_key_env_var] = os.getenv(api_key_env_var, "")
        process = subprocess.Popen(
            command,
            cwd=self._config.base_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=self._config.knowledge_agent_timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate()
            exc.output = stdout
            exc.stderr = stderr
            raise exc
        return subprocess.CompletedProcess(
            args=command,
            returncode=process.returncode,
            stdout=stdout,
            stderr=stderr,
        )

    def _build_command(self, action: str) -> list[str]:
        template = self._config.knowledge_agent_command.strip()
        if not template:
            template = f"/bin/bash {self._config.base_dir / 'vault_runner.sh'}"
        if "{action}" in template:
            rendered = template.replace("{action}", action)
            return shlex.split(rendered)
        return [*shlex.split(template), action]

    def _recent_modified_stems(self, directory: Path, *, minutes: int) -> list[str]:
        if not directory.exists():
            return []
        threshold = datetime.now() - timedelta(minutes=minutes)
        recent: list[str] = []
        for path in directory.rglob("*.md"):
            try:
                modified_at = datetime.fromtimestamp(path.stat().st_mtime)
            except OSError:
                continue
            if modified_at >= threshold:
                recent.append(path.stem)
        return sorted(set(recent))[:10]


def load_knowledge_state(config: AppConfig) -> KnowledgeState:
    """Load the latest knowledge-maintenance state from disk."""

    state_path = config.data_dir / STATE_FILENAME
    if not state_path.exists():
        return KnowledgeState()
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return KnowledgeState()
    return KnowledgeState(
        updated_at=str(payload.get("updated_at", "")).strip(),
        last_checked_at=str(payload.get("last_checked_at", "")).strip(),
        last_run_at=str(payload.get("last_run_at", "")).strip(),
        last_action=str(payload.get("last_action", "")).strip(),
        last_trigger=str(payload.get("last_trigger", "")).strip(),
        last_status=str(payload.get("last_status", "")).strip(),
        inbox_count=int(payload.get("inbox_count", 0) or 0),
        processed_inbox_count=int(payload.get("processed_inbox_count", 0) or 0),
        pending_knowledge_maintenance=bool(payload.get("pending_knowledge_maintenance", False)),
        last_error=str(payload.get("last_error", "")).strip(),
        last_output_excerpt=str(payload.get("last_output_excerpt", "")).strip(),
        last_returncode=int(payload.get("last_returncode", 0) or 0),
        last_timed_out=bool(payload.get("last_timed_out", False)),
        last_duration_seconds=float(payload.get("last_duration_seconds", 0.0) or 0.0),
        recent_curated_topics=tuple(str(item).strip() for item in payload.get("recent_curated_topics", []) if str(item).strip()),
        recent_source_additions=tuple(str(item).strip() for item in payload.get("recent_source_additions", []) if str(item).strip()),
    )


def save_knowledge_state(config: AppConfig, state: KnowledgeState) -> None:
    """Persist the latest knowledge-maintenance state to disk."""

    config.data_dir.mkdir(parents=True, exist_ok=True)
    state_path = config.data_dir / STATE_FILENAME
    state_path.write_text(
        json.dumps(asdict(state), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _tail_excerpt(output: str, *, max_chars: int = 600) -> str:
    cleaned = output.strip()
    if len(cleaned) <= max_chars:
        return cleaned
    return cleaned[-max_chars:]


def _coerce_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _format_seconds(value: object) -> str:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return str(value)
    if seconds.is_integer():
        return str(int(seconds))
    return f"{seconds:.3f}".rstrip("0").rstrip(".")
