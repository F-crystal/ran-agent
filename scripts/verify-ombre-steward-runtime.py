#!/usr/bin/env python3
"""Verify the local patched Steward endpoint without exposing its token."""

from __future__ import annotations

import argparse
import grp
import hashlib
import json
import os
import pwd
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--identity-file", required=True, type=Path)
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--venv", type=Path)
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:18001/internal/ran-agent/steward/v1",
    )
    parser.add_argument("--rejected-token-file", type=Path)
    parser.add_argument("--runtime-user", default="ubuntu")
    parser.add_argument("--runtime-group")
    args = parser.parse_args()
    args.runtime_group = args.runtime_group or args.runtime_user
    account = pwd.getpwnam(args.runtime_user)
    group = grp.getgrnam(args.runtime_group)
    runtime_env = {
        "HOME": str(args.state_dir.resolve() / "ombre-brain"),
        "PATH": "/usr/bin:/bin",
        "TMPDIR": "/tmp",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }

    def run_as_runtime(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if os.geteuid() == account.pw_uid:
            effective = command
        elif os.geteuid() == 0 and Path("/usr/sbin/runuser").is_file():
            effective = [
                "/usr/sbin/runuser",
                "--user",
                account.pw_name,
                "--group",
                group.gr_name,
                "--",
                *command,
            ]
        else:
            raise SystemExit("Steward runtime verification requires root or the runtime user")
        kwargs["env"] = {**runtime_env, **kwargs.get("env", {})}
        return subprocess.run(effective, **kwargs)

    token_path = args.state_dir.resolve() / "ombre-compat/secrets/steward-api-token"
    info = os.lstat(token_path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != account.pw_uid
        or info.st_gid != group.gr_gid
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise SystemExit("steward token identity invalid")
    token = token_path.read_text(encoding="ascii")
    if len(token) != 65 or not token.endswith("\n"):
        raise SystemExit("steward token format invalid")
    identity = json.loads(args.identity_file.read_text(encoding="utf-8"))
    if bool(args.source_dir) != bool(args.venv):
        raise SystemExit("source runtime arguments incomplete")
    if args.source_dir:
        home = args.state_dir.resolve() / "ombre-brain"
        source = args.source_dir.resolve(strict=True)
        venv = args.venv.resolve(strict=True)
        if source != home / "upstream" or venv != home / ".venv":
            raise SystemExit("source runtime path mismatch")
        if any(path.lstat().st_uid != account.pw_uid for path in (source, source / ".git", venv)):
            raise SystemExit("source runtime owner invalid")
        lock = source / "requirements.lock.txt"
        stamp = venv / ".requirements.lock.fingerprint"
        digest = hashlib.sha256(lock.read_bytes()).hexdigest()
        if stamp.read_text(encoding="ascii").strip() != digest:
            raise SystemExit("source runtime lock fingerprint mismatch")
        head = run_as_runtime(
            ["git", "-C", str(source), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if head != identity.get("base_upstream_commit"):
            raise SystemExit("source runtime upstream identity mismatch")
        python = venv / "bin/python"
        version = run_as_runtime(
            [str(python), "-I", "-c", 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if version != "3.12":
            raise SystemExit("source runtime requires Python 3.12")
        run_as_runtime([str(python), "-m", "pip", "check"], check=True, stdout=subprocess.DEVNULL)
        run_as_runtime(
            [str(python), "-I", "-c", "import frontmatter, httpx, jieba, mcp, numpy, openai, rapidfuzz, rank_bm25, sklearn, uvicorn, yaml, zstandard"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        run_as_runtime(
            [
                str(python),
                "-I",
                str(Path(__file__).with_name("apply_ombre_steward_patch.py")),
                "--checkout",
                str(source),
                "--identity-output",
                str(args.identity_file.resolve(strict=True)),
                "--verify",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    request = urllib.request.Request(
        args.endpoint.rstrip("/") + "/health",
        headers={"X-Ran-Agent-Steward-Token": token[:-1]},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        health = json.load(response)
    expected = {"schema_version": "ombre.steward-api/1", "status": "ok", **identity}
    if health != expected:
        raise SystemExit("steward endpoint identity mismatch")
    if args.rejected_token_file:
        rejected = args.rejected_token_file.read_text(encoding="ascii")
        if len(rejected) != 65 or not rejected.endswith("\n"):
            raise SystemExit("rejected token fixture invalid")
        old_request = urllib.request.Request(
            args.endpoint.rstrip("/") + "/health",
            headers={"X-Ran-Agent-Steward-Token": rejected[:-1]},
        )
        try:
            urllib.request.urlopen(old_request, timeout=5)
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise SystemExit("old steward token rejection invalid") from exc
        else:
            raise SystemExit("old steward token still accepted")
    print(json.dumps({"status": "ok", "identity": identity}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
