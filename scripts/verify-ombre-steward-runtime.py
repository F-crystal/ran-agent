#!/usr/bin/env python3
"""Verify the local patched Steward endpoint without exposing its token."""

from __future__ import annotations

import argparse
import grp
import json
import os
import pwd
import stat
import urllib.error
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--identity-file", required=True, type=Path)
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:18001/internal/ran-agent/steward/v1",
    )
    parser.add_argument("--rejected-token-file", type=Path)
    args = parser.parse_args()
    account = pwd.getpwnam("ran-agent")
    group = grp.getgrnam("ran-agent")
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
