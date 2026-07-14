#!/usr/bin/env python3
"""Local state, test-process, and validation helpers for archive_and_push.sh.

This module deliberately has no Git mutation commands.  Bash owns the archive
transaction; this helper only makes its durable metadata and test execution
safe on macOS and Linux using the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(canonical_json(value) + b"\n")
    os.replace(temporary, path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def command_journal_init(args: argparse.Namespace) -> int:
    path = Path(args.path)
    started = now()
    atomic_json(
        path,
        {
            "schema_version": SCHEMA_VERSION,
            "transaction_id": args.transaction_id,
            "repository_realpath": os.path.realpath(args.repository),
            "source_branch": args.source_branch,
            "source_head": args.source_head,
            "head_sha": args.source_head,
            "target_branch": args.target_branch,
            "expected_origin_main": args.expected_origin_main,
            "local_main_before": args.local_main_before,
            "archive_record_path": args.archive_record_path,
            "phase": "preflight",
            "phase_status": "running",
            "started_at": started,
            "updated_at": started,
            "test_results": {},
            "validation_status": "pending",
            "validated_head": None,
            "validation_source": None,
            "validation_record_path": None,
            "validation_record_checksum": None,
            "validation_completed_at": None,
            "validation_skip_reason": None,
            "commit_result": {"status": "pending"},
            "merge_result": {"status": "pending"},
            "push_result": {"status": "pending"},
            "archive_result": {"status": "pending"},
            "failure_stage": None,
            "failure_code": None,
        },
    )
    return 0


def command_journal_update(args: argparse.Namespace) -> int:
    path = Path(args.path)
    value = read_json(path)
    for key in ("phase", "phase_status", "failure_stage", "failure_code"):
        update = getattr(args, key)
        if update is not None:
            value[key] = update
    for item in args.set_json:
        key, raw = item.split("=", 1)
        target = value
        parts = key.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = json.loads(raw)
    value["updated_at"] = now()
    atomic_json(path, value)
    return 0


def command_journal_get(args: argparse.Namespace) -> int:
    value: Any = read_json(Path(args.path))
    for part in args.field.split("."):
        value = value[part]
    if isinstance(value, (dict, list)):
        print(canonical_json(value).decode())
    elif value is None:
        print("")
    else:
        print(value)
    return 0


def terminate_group(process: subprocess.Popen[bytes], grace_seconds: float) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def command_run(args: argparse.Namespace) -> int:
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise SystemExit("run requires a command after --")
    started_at = now()
    began = time.monotonic()
    log_path = Path(args.log)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    interrupted = False

    def interrupted_signal(_signum: int, _frame: Any) -> None:
        nonlocal interrupted
        interrupted = True

    previous_int = signal.signal(signal.SIGINT, interrupted_signal)
    previous_term = signal.signal(signal.SIGTERM, interrupted_signal)
    try:
        with log_path.open("wb") as log_file:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            assert process.stdout is not None
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            last_heartbeat = began
            timed_out = False
            print(f"test started: pid={process.pid}; log={log_path}", flush=True)
            while process.poll() is None:
                for _key, _mask in selector.select(timeout=0.2):
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if chunk:
                        log_file.write(chunk)
                        log_file.flush()
                current = time.monotonic()
                if interrupted:
                    terminate_group(process, args.grace_seconds)
                    break
                if current - began >= args.timeout_seconds:
                    timed_out = True
                    terminate_group(process, args.grace_seconds)
                    break
                if current - last_heartbeat >= args.heartbeat_seconds:
                    print(
                        f"test still running: pid={process.pid}; elapsed_seconds={current - began:.0f}; log={log_path}",
                        flush=True,
                    )
                    last_heartbeat = current
            while True:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                log_file.write(chunk)
            selector.close()
            exit_code = process.wait()
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)
    duration = round(time.monotonic() - began, 3)
    status = "interrupted" if interrupted else "timed_out" if timed_out else "passed" if exit_code == 0 else "failed"
    result = {
        "command": command,
        "started_at": started_at,
        "finished_at": now(),
        "duration_seconds": duration,
        "exit_code": exit_code,
        "status": status,
        "log_path": str(log_path),
        "pid": process.pid,
    }
    atomic_json(Path(args.result_file), result)
    print(f"test finished: status={status}; exit_code={exit_code}; duration_seconds={duration}; log={log_path}", flush=True)
    return 0 if status == "passed" else 1


def record_digest(record: dict[str, Any]) -> str:
    copied = dict(record)
    copied.pop("checksum", None)
    return hashlib.sha256(canonical_json(copied)).hexdigest()


def markdown_value(value: Any) -> str:
    if value is None or value == "":
        return "none"
    return str(value)


def command_archive_render(args: argparse.Namespace) -> int:
    journal = read_json(Path(args.journal))
    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"archive record already exists: {output}")
    included = Path(args.included_commits_file).read_text(encoding="utf-8").strip() or "none"
    changed = Path(args.changed_files_file).read_text(encoding="utf-8").strip() or "none"
    tests = journal.get("test_results", {})
    test_lines: list[str] = []
    if tests.get("status") == "skipped":
        test_lines.extend([
            "- validation",
            "  - Command: none",
            "  - Status: skipped",
            "  - Exit code: none",
            "  - Duration: none",
            "  - Log path: none",
        ])
    else:
        for name, result in tests.items():
            if not isinstance(result, dict):
                continue
            test_lines.extend([
                f"- {name}",
                f"  - Command: {markdown_value(result.get('command'))}",
                f"  - Status: {markdown_value(result.get('status'))}",
                f"  - Exit code: {markdown_value(result.get('exit_code'))}",
                f"  - Duration: {markdown_value(result.get('duration_seconds'))}",
                f"  - Log path: {markdown_value(result.get('log_path'))}",
            ])
    text = "\n".join([
        "# Archive And Push Record",
        "",
        "Status: ARCHIVE",
        "",
        "## Transaction",
        f"- Transaction ID: {journal['transaction_id']}",
        f"- Source branch: {journal['source_branch']}",
        f"- Base: {journal['expected_origin_main']}",
        f"- Head: {journal['head_sha']}",
        "- Merge mode: fast-forward only",
        "",
        "## Included Commits",
        included,
        "",
        "## Validation",
        f"- Status: {markdown_value(journal.get('validation_status'))}",
        f"- Validated head: {markdown_value(journal.get('validated_head'))}",
        f"- Source: {markdown_value(journal.get('validation_source'))}",
        f"- Validation record: {markdown_value(journal.get('validation_record_path'))}",
        f"- Validation checksum: {markdown_value(journal.get('validation_record_checksum'))}",
        f"- Validation completed at: {markdown_value(journal.get('validation_completed_at'))}",
        f"- Skip reason: {markdown_value(journal.get('validation_skip_reason'))}",
        "",
        "## Test Results",
        *(test_lines or ["- none"]),
        "",
        "## Git Result",
        f"- Commit result: {canonical_json(journal['commit_result']).decode()}",
        f"- Merge result: {canonical_json(journal['merge_result']).decode()}",
        f"- Push result: {canonical_json(journal['push_result']).decode()}",
        f"- Remote: {args.remote}",
        f"- Main before: {journal['local_main_before']}",
        f"- Main after: {journal['push_result'].get('head', 'none')}",
        "",
        "## Changed Files",
        changed,
        "",
        "## Production Status",
        "- Repository main updated: yes",
        "- Production deployed: no",
        "- Server connected: no",
        "- Production state modified: no",
        "",
    ])
    atomic_text(output, text)
    return 0


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def command_archive_verify(args: argparse.Namespace) -> int:
    journal = read_json(Path(args.journal))
    content = Path(args.record).read_text(encoding="utf-8")
    expected = {
        "Transaction ID": journal["transaction_id"],
        "Source branch": journal["source_branch"],
        "Base": journal["expected_origin_main"],
        "Head": journal["head_sha"],
        "Status": markdown_value(journal.get("validation_status")),
        "Validated head": markdown_value(journal.get("validated_head")),
        "Source": markdown_value(journal.get("validation_source")),
        "Validation record": markdown_value(journal.get("validation_record_path")),
        "Validation checksum": markdown_value(journal.get("validation_record_checksum")),
        "Commit result": canonical_json(journal["commit_result"]).decode(),
        "Merge result": canonical_json(journal["merge_result"]).decode(),
        "Push result": canonical_json(journal["push_result"]).decode(),
    }
    for label, value in expected.items():
        if f"- {label}: {value}" not in content:
            raise SystemExit(f"archive record does not match journal field: {label}")
    return 0


def command_validation_create(args: argparse.Namespace) -> int:
    journal = read_json(Path(args.journal))
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "repository_realpath": os.path.realpath(args.repository),
        "branch": args.branch,
        "base_sha": args.base_sha,
        "head_sha": args.head,
        "worktree_clean": args.worktree_clean == "true",
        "node_version": args.node_version,
        "python_version": args.python_version,
        "commands": json.loads(args.commands_json),
        "per_command_status": journal["test_results"],
        "completed_at": now(),
    }
    record["checksum"] = record_digest(record)
    atomic_json(Path(args.output), record)
    return 0


def command_validation_verify(args: argparse.Namespace) -> int:
    record = read_json(Path(args.record))
    if record.get("schema_version") != SCHEMA_VERSION or record.get("checksum") != record_digest(record):
        raise SystemExit("validation record checksum or schema is invalid")
    if record.get("repository_realpath") != os.path.realpath(args.repository):
        raise SystemExit("validation record repository does not match")
    if record.get("head_sha") != args.head or args.worktree_clean not in {"true", "false"}:
        raise SystemExit("validation record HEAD or worktree does not match")
    statuses = record.get("per_command_status", {})
    if not all(statuses.get(name, {}).get("status") == "passed" for name in ("python", "node")):
        raise SystemExit("validation record does not contain two passed baselines")
    print(canonical_json(record).decode())
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="subcommand", required=True)
    init = sub.add_parser("journal-init")
    init.add_argument("--path", required=True)
    init.add_argument("--transaction-id", required=True)
    init.add_argument("--repository", required=True)
    init.add_argument("--source-branch", required=True)
    init.add_argument("--source-head", required=True)
    init.add_argument("--target-branch", required=True)
    init.add_argument("--expected-origin-main", required=True)
    init.add_argument("--local-main-before", required=True)
    init.add_argument("--archive-record-path", required=True)
    init.set_defaults(function=command_journal_init)
    update = sub.add_parser("journal-update")
    update.add_argument("--path", required=True)
    update.add_argument("--phase")
    update.add_argument("--phase-status")
    update.add_argument("--failure-stage")
    update.add_argument("--failure-code")
    update.add_argument("--set-json", action="append", default=[])
    update.set_defaults(function=command_journal_update)
    get = sub.add_parser("journal-get")
    get.add_argument("--path", required=True)
    get.add_argument("--field", required=True)
    get.set_defaults(function=command_journal_get)
    run = sub.add_parser("run")
    run.add_argument("--log", required=True)
    run.add_argument("--result-file", required=True)
    run.add_argument("--timeout-seconds", type=float, required=True)
    run.add_argument("--grace-seconds", type=float, default=10)
    run.add_argument("--heartbeat-seconds", type=float, default=25)
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(function=command_run)
    create = sub.add_parser("validation-create")
    create.add_argument("--journal", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--repository", required=True)
    create.add_argument("--branch", required=True)
    create.add_argument("--base-sha", required=True)
    create.add_argument("--head", required=True)
    create.add_argument("--worktree-clean", required=True)
    create.add_argument("--node-version", required=True)
    create.add_argument("--python-version", required=True)
    create.add_argument("--commands-json", required=True)
    create.set_defaults(function=command_validation_create)
    verify = sub.add_parser("validation-verify")
    verify.add_argument("--record", required=True)
    verify.add_argument("--repository", required=True)
    verify.add_argument("--head", required=True)
    verify.add_argument("--worktree-clean", required=True)
    verify.set_defaults(function=command_validation_verify)
    render = sub.add_parser("archive-render")
    render.add_argument("--journal", required=True)
    render.add_argument("--output", required=True)
    render.add_argument("--included-commits-file", required=True)
    render.add_argument("--changed-files-file", required=True)
    render.add_argument("--remote", required=True)
    render.set_defaults(function=command_archive_render)
    archive_verify = sub.add_parser("archive-verify")
    archive_verify.add_argument("--journal", required=True)
    archive_verify.add_argument("--record", required=True)
    archive_verify.set_defaults(function=command_archive_verify)
    return root


def main() -> int:
    args = parser().parse_args()
    return args.function(args)


if __name__ == "__main__":
    raise SystemExit(main())
