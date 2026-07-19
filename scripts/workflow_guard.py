#!/usr/bin/env python3
"""Fingerprint a Git worktree and record redacted command evidence."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        capture_output=True,
    )


def git_text(repo: Path, *args: str) -> str:
    return git(repo, *args).stdout.decode("utf-8", "surrogateescape").strip()


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def untracked_files(repo: Path) -> list[dict[str, Any]]:
    raw = git(repo, "ls-files", "--others", "--exclude-standard", "-z").stdout
    records: list[dict[str, Any]] = []
    for encoded in sorted(item for item in raw.split(b"\0") if item):
        relative = encoded.decode("utf-8", "surrogateescape")
        path = repo / relative
        if path.is_symlink():
            link = os.readlink(path)
            records.append(
                {"path": relative, "kind": "symlink", "size": len(link.encode()), "sha256": digest(link.encode())}
            )
        else:
            records.append(
                {"path": relative, "kind": "file", "size": path.stat().st_size, "sha256": file_sha256(path)}
            )
    return records


def optional_ref(repo: Path, ref: str) -> str | None:
    result = git(repo, "rev-parse", "--verify", ref, check=False)
    return result.stdout.decode().strip() if result.returncode == 0 else None


def runtime_fingerprint() -> dict[str, Any]:
    node = shutil.which("node")
    node_version = None
    if node:
        result = subprocess.run([node, "--version"], capture_output=True, text=True, check=False)
        node_version = result.stdout.strip() if result.returncode == 0 else None
    return {
        "python": {"executable": str(Path(sys.executable).resolve()), "version": sys.version.split()[0]},
        "node": {"executable": str(Path(node).resolve()) if node else None, "version": node_version},
    }


def repository_identity(repo: Path) -> dict[str, Any]:
    index_diff = git(
        repo, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"
    ).stdout
    worktree_diff = git(
        repo, "diff", "--no-ext-diff", "--no-textconv", "--binary", "--"
    ).stdout
    return {
        "git": {
            "branch": git_text(repo, "branch", "--show-current"),
            "head": git_text(repo, "rev-parse", "HEAD"),
            "origin_main": optional_ref(repo, "refs/remotes/origin/main"),
        },
        "worktree": {
            "index_diff_sha256": digest(index_diff),
            "worktree_diff_sha256": digest(worktree_diff),
            "untracked": untracked_files(repo),
        },
        "runtime": runtime_fingerprint(),
    }


def snapshot_document(repo: Path) -> dict[str, Any]:
    document = {
        "schema_version": SCHEMA_VERSION,
        "repository_realpath": str(repo.resolve()),
        "created_at": utc_now(),
        **repository_identity(repo),
    }
    document["checksum"] = digest(canonical_bytes(document))
    return document


def seal_document(document: dict[str, Any]) -> None:
    document.pop("checksum", None)
    document["checksum"] = digest(canonical_bytes(document))


def atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        json.dump(document, temp, indent=2, sort_keys=True, ensure_ascii=False)
        temp.write("\n")
        temp_path = Path(temp.name)
    os.replace(temp_path, path)


def load_snapshot(path: Path, repo: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    checksum = document.pop("checksum", None)
    if document.get("schema_version") != SCHEMA_VERSION or checksum != digest(canonical_bytes(document)):
        raise ValueError("snapshot checksum or schema is invalid")
    document["checksum"] = checksum
    if document.get("repository_realpath") != str(repo.resolve()):
        raise ValueError("snapshot repository does not match")
    return document


def compare(snapshot: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    changed: dict[str, dict[str, Any]] = {}
    for group in ("git", "worktree", "runtime"):
        for key, expected in snapshot[group].items():
            actual = current[group].get(key)
            if actual != expected:
                changed[key] = {"expected": expected, "actual": actual}
    return {"matches": not changed, "changed": changed}


def checked_state(repo: Path, snapshot_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot = load_snapshot(snapshot_path, repo)
    return snapshot, compare(snapshot, repository_identity(repo))


def snapshot_anchor(snapshot_path: Path, repo: Path, expected: dict[str, Any]) -> dict[str, Any]:
    try:
        if not stat.S_ISREG(snapshot_path.lstat().st_mode):
            return {"matches": False, "error": "snapshot is not a regular file"}
        current = load_snapshot(snapshot_path, repo)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"matches": False, "error": str(exc)}
    matches = current["checksum"] == expected["checksum"]
    return {"matches": matches, "error": None if matches else "snapshot checksum changed"}


def safe_output_path(repo: Path, value: str) -> Path:
    output = Path(value).resolve()
    if output.is_relative_to(repo):
        relative = output.relative_to(repo)
        ignored = git(repo, "check-ignore", "-q", "--", str(relative), check=False)
        if ignored.returncode != 0:
            raise ValueError("output inside repository must be ignored by Git")
    return output


def verify_output_directory(repo: Path) -> Path:
    directory = repo
    for part in ("local_archive", "runtime", "workflow-evidence"):
        directory /= part
        if directory.is_symlink():
            raise ValueError("verify evidence directory must not contain symlinks")
    resolved = directory.resolve()
    if not resolved.is_relative_to(repo.resolve()):
        raise ValueError("verify evidence directory must remain inside repository")
    return resolved


def verify_output_boundary(repo: Path, expected_directory: str | None) -> dict[str, Any]:
    if expected_directory is None:
        return {"matches": True, "error": None}
    try:
        current = verify_output_directory(repo)
    except ValueError as exc:
        return {"matches": False, "error": str(exc)}
    matches = current == Path(expected_directory)
    return {"matches": matches, "error": None if matches else "verify output directory changed"}


def command_snapshot(args: argparse.Namespace) -> int:
    output = safe_output_path(args.repository, args.output)
    if output.exists() and not args.force:
        raise ValueError("snapshot output already exists; use --force to replace it")
    atomic_json(output, snapshot_document(args.repository))
    return 0


def command_check(args: argparse.Namespace) -> int:
    _, result = checked_state(args.repository, Path(args.snapshot))
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0 if result["matches"] else 3


def load_evidence(path: Path, repo: Path, snapshot: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        document = {
            "schema_version": SCHEMA_VERSION,
            "repository_realpath": str(repo.resolve()),
            "snapshot_checksum": snapshot["checksum"],
            "results": [],
        }
        seal_document(document)
        return document
    document = json.loads(path.read_text(encoding="utf-8"))
    checksum = document.pop("checksum", None)
    valid_checksum = checksum == digest(canonical_bytes(document))
    document["checksum"] = checksum
    if (
        not valid_checksum
        or document.get("schema_version") != SCHEMA_VERSION
        or document.get("repository_realpath") != str(repo.resolve())
        or document.get("snapshot_checksum") != snapshot["checksum"]
        or not isinstance(document.get("results"), list)
    ):
        raise ValueError("evidence manifest checksum/schema does not match snapshot")
    return document


@contextmanager
def evidence_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def executable_fingerprint(command: list[str], cwd: Path) -> dict[str, str]:
    candidate = command[0]
    if os.sep in candidate:
        command_path = Path(candidate)
        resolved = command_path if command_path.is_absolute() else cwd / command_path
    else:
        resolved = shutil.which(candidate)
    if not resolved:
        raise ValueError(f"command executable not found: {candidate}")
    path = Path(resolved).resolve()
    if not path.is_file():
        raise ValueError(f"command executable is not a regular file: {path}")
    if not os.access(path, os.X_OK):
        raise ValueError(f"command executable is not executable: {path}")
    return {"realpath": str(path), "sha256": file_sha256(path)}


def validated_command(label: str, raw_command: list[str]) -> list[str]:
    command = list(raw_command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        raise ValueError("run requires a command after --")
    if not label.strip() or "\n" in label or len(label) > 100:
        raise ValueError("label must be 1-100 characters without newlines")
    return command


def command_run(args: argparse.Namespace) -> int:
    command = validated_command(args.label, args.command)

    evidence_path = safe_output_path(args.repository, args.evidence)
    with evidence_lock(evidence_path):
        snapshot, precheck = checked_state(args.repository, Path(args.snapshot))
        if not precheck["matches"]:
            args.result_status = "preexisting_drift"
            if not getattr(args, "quiet", False):
                print(json.dumps(precheck, indent=2, sort_keys=True, ensure_ascii=False))
            return 3
        evidence = load_evidence(evidence_path, args.repository, snapshot)
        if any(item.get("label") == args.label for item in evidence["results"]):
            raise ValueError(f"evidence label already exists: {args.label}")

        executable = executable_fingerprint(command, args.repository)
        started_at = utc_now()
        completed = subprocess.run(command, cwd=args.repository, check=False)
        completed_at = utc_now()
        output_boundary = verify_output_boundary(
            args.repository, getattr(args, "verify_directory", None)
        )
        anchor = snapshot_anchor(Path(args.snapshot), args.repository, snapshot)
        postcheck = compare(snapshot, repository_identity(args.repository))
        if not output_boundary["matches"]:
            status = "output_boundary_drift"
        elif not anchor["matches"]:
            status = "evidence_anchor_drift"
        elif not postcheck["matches"]:
            status = "worktree_drift"
        elif completed.returncode == 0:
            status = "passed"
        else:
            status = "failed"
        args.result_status = status

        evidence["results"].append(
            {
                "label": args.label,
                "command_sha256": digest(canonical_bytes(command)),
                "executable": executable,
                "started_at": started_at,
                "completed_at": completed_at,
                "exit_code": completed.returncode,
                "status": status,
                "precheck": precheck,
                "postcheck": postcheck,
                "snapshot_anchor": anchor,
                "output_boundary": output_boundary,
            }
        )
        if output_boundary["matches"]:
            seal_document(evidence)
            atomic_json(evidence_path, evidence)
        if not output_boundary["matches"] or not anchor["matches"] or not postcheck["matches"]:
            return 4
        return 0 if completed.returncode == 0 else 5


def command_verify(args: argparse.Namespace) -> int:
    command = validated_command(args.label, args.command)
    executable_fingerprint(command, args.repository)
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{uuid.uuid4().hex[:8]}"
    directory = verify_output_directory(args.repository)
    snapshot_path = safe_output_path(args.repository, str(directory / f"{run_id}-snapshot.json"))
    evidence_path = safe_output_path(args.repository, str(directory / f"{run_id}-evidence.json"))
    atomic_json(snapshot_path, snapshot_document(args.repository))

    run_args = argparse.Namespace(
        repository=args.repository,
        snapshot=str(snapshot_path),
        evidence=str(evidence_path),
        label=args.label,
        command=command,
        quiet=True,
        verify_directory=str(directory),
    )
    result = command_run(run_args)
    summary = {
        "label": args.label,
        "status": getattr(run_args, "result_status", "invalid"),
        "snapshot": str(snapshot_path),
        "evidence": str(evidence_path),
    }
    print(f"WORKFLOW_GUARD_SUMMARY={json.dumps(summary, sort_keys=True, ensure_ascii=False)}")
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--repository", type=Path, default=Path.cwd())
    commands = root.add_subparsers(dest="subcommand", required=True)

    snapshot = commands.add_parser("snapshot")
    snapshot.add_argument("--output", required=True)
    snapshot.add_argument("--force", action="store_true")
    snapshot.set_defaults(function=command_snapshot)

    check = commands.add_parser("check")
    check.add_argument("--snapshot", required=True)
    check.set_defaults(function=command_check)

    run = commands.add_parser("run")
    run.add_argument("--snapshot", required=True)
    run.add_argument("--evidence", required=True)
    run.add_argument("--label", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(function=command_run)

    verify = commands.add_parser("verify")
    verify.add_argument("--label", required=True)
    verify.add_argument("command", nargs=argparse.REMAINDER)
    verify.set_defaults(function=command_verify)
    return root


def main() -> int:
    args = parser().parse_args()
    args.repository = args.repository.resolve()
    try:
        args.repository = Path(git_text(args.repository, "rev-parse", "--show-toplevel")).resolve()
        return args.function(args)
    except (OSError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as exc:
        print(f"workflow_guard: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
