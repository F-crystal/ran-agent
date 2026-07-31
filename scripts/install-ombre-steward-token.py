#!/usr/bin/env python3
"""Atomically install or rotate the owner-only Ombre Steward API token."""

from __future__ import annotations

import argparse
import grp
import os
import pwd
import secrets
import stat
import tempfile
from pathlib import Path


TOKEN_RELATIVE_PATH = Path("ombre-compat/secrets/steward-api-token")
ROLLBACK_FILE = "steward-api-token.rollback"


def token_path(state_dir: Path) -> Path:
    return state_dir.resolve() / TOKEN_RELATIVE_PATH


def ensure_token_directory(path: Path, gid: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise RuntimeError("steward token directory invalid")
    os.chown(path, 0, gid)
    os.chmod(path, 0o750)
    value = os.lstat(path)
    if value.st_uid != 0 or value.st_gid != gid or stat.S_IMODE(value.st_mode) != 0o750:
        raise RuntimeError("steward token directory identity invalid")


def assert_token_file(path: Path, uid: int, gid: int) -> None:
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        raise RuntimeError("steward token must be a non-symlink regular file")
    if value.st_uid != uid or value.st_gid != gid or stat.S_IMODE(value.st_mode) != 0o600:
        raise RuntimeError("steward token owner/group/mode mismatch")
    value = path.read_bytes()
    if len(value) != 65 or value[-1:] != b"\n":
        raise RuntimeError("steward token format invalid")
    try:
        int(value[:-1], 16)
    except ValueError as exc:
        raise RuntimeError("steward token format invalid") from exc


def install_token(path: Path, uid: int, gid: int, token: bytes | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    token = token or (secrets.token_hex(32) + "\n").encode("ascii")
    if len(token) != 65 or token[-1:] != b"\n":
        raise RuntimeError("steward token format invalid")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".steward-api-token.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        value = os.lstat(temporary)
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
            raise RuntimeError("temporary token is not a regular file")
        os.write(descriptor, token)
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, uid, gid)
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_uid != uid or value.st_gid != gid:
            raise RuntimeError("temporary token identity mismatch")
        if stat.S_IMODE(value.st_mode) != 0o600:
            raise RuntimeError("temporary token mode mismatch")
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        assert_token_file(path, uid, gid)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()


def assert_rollback_dir(path: Path, owner_uid: int = 0) -> None:
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise RuntimeError("secret rollback directory invalid")
    if value.st_uid != owner_uid or stat.S_IMODE(value.st_mode) != 0o700:
        raise RuntimeError("secret rollback directory identity invalid")


def backup_token(path: Path, rollback_dir: Path, uid: int, gid: int, rollback_uid: int = 0) -> bool:
    assert_rollback_dir(rollback_dir, rollback_uid)
    backup = rollback_dir / ROLLBACK_FILE
    if backup.exists():
        raise RuntimeError("secret rollback file already exists")
    if not path.exists():
        return False
    assert_token_file(path, uid, gid)
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, path.read_bytes())
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_uid != rollback_uid or stat.S_IMODE(value.st_mode) != 0o600:
            raise RuntimeError("secret rollback file identity invalid")
    finally:
        os.close(descriptor)
    directory = os.open(rollback_dir, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return True


def restore_token(path: Path, rollback_dir: Path, uid: int, gid: int, rollback_uid: int = 0) -> None:
    assert_rollback_dir(rollback_dir, rollback_uid)
    backup = rollback_dir / ROLLBACK_FILE
    value = os.lstat(backup)
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        raise RuntimeError("secret rollback file invalid")
    if value.st_uid != rollback_uid or stat.S_IMODE(value.st_mode) != 0o600:
        raise RuntimeError("secret rollback file identity invalid")
    install_token(path, uid, gid, backup.read_bytes())


def destroy_rollback(rollback_dir: Path, rollback_uid: int = 0) -> None:
    assert_rollback_dir(rollback_dir, rollback_uid)
    backup = rollback_dir / ROLLBACK_FILE
    if backup.exists():
        value = os.lstat(backup)
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode) or value.st_uid != rollback_uid:
            raise RuntimeError("secret rollback file invalid")
        descriptor = os.open(backup, os.O_WRONLY | os.O_NOFOLLOW)
        try:
            os.write(descriptor, b"\0" * value.st_size)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        backup.unlink()
    directory = os.open(rollback_dir, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    rollback_dir.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--rotate", action="store_true")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--backup-to", type=Path)
    actions.add_argument("--restore-from", type=Path)
    actions.add_argument("--destroy-rollback", type=Path)
    actions.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    account = pwd.getpwnam("ran-agent")
    group = grp.getgrnam("ran-agent")
    if account.pw_gid != group.gr_gid:
        raise SystemExit("ran-agent primary group mismatch")
    path = token_path(args.state_dir)
    ensure_token_directory(path.parent, group.gr_gid)
    if args.backup_to:
        return 0 if backup_token(path, args.backup_to.resolve(), account.pw_uid, group.gr_gid) else 2
    if args.restore_from:
        restore_token(path, args.restore_from.resolve(), account.pw_uid, group.gr_gid)
        return 0
    if args.destroy_rollback:
        destroy_rollback(args.destroy_rollback.resolve())
        return 0
    if args.verify:
        assert_token_file(path, account.pw_uid, group.gr_gid)
        return 0
    if path.exists() and not args.rotate:
        assert_token_file(path, account.pw_uid, group.gr_gid)
        return 0
    install_token(path, account.pw_uid, group.gr_gid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
