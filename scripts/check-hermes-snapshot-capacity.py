#!/usr/bin/env python3
"""Fail closed unless the artifact filesystem can hold a full release snapshot."""

from __future__ import annotations

import argparse
import fnmatch
import os
from pathlib import Path
import stat
import sys


FIXED_MARGIN_BYTES = 2 * 1024 * 1024 * 1024
MARGIN_PERCENT = 25
INSUFFICIENT = 3
MIGRATION_PATTERNS = ("*.sqlite", "*.sqlite-*", "*.db", "*.db-*")


def disk_usage(path: Path) -> tuple[int, int]:
    try:
        value = path.lstat()
    except FileNotFoundError:
        return (0, 0)
    total = max(value.st_size, value.st_blocks * 512)
    inodes = 1
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
        return (total, inodes)
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                child_bytes, child_inodes = disk_usage(Path(entry.path))
                total += child_bytes
                inodes += child_inodes
    except FileNotFoundError:
        return (total, inodes)
    return (total, inodes)


def existing_copy_roots(values: list[str]) -> list[Path]:
    candidates: list[Path] = []
    for value in values:
        candidate = Path(os.path.abspath(os.path.normpath(value)))
        if not os.path.lexists(candidate) or candidate in candidates:
            continue
        candidates.append(candidate)
    roots: list[Path] = []
    for candidate in sorted(candidates, key=lambda path: (len(path.parts), str(path))):
        nested = False
        for parent in roots:
            parent_value = parent.lstat()
            if (
                stat.S_ISDIR(parent_value.st_mode)
                and not stat.S_ISLNK(parent_value.st_mode)
                and parent in candidate.parents
            ):
                nested = True
                break
        if not nested:
            roots.append(candidate)
    return roots


def migration_duplicate_usage(root: Path | None) -> tuple[int, int]:
    if root is None or not root.exists() or root.is_symlink():
        return (0, 0)
    total = 0
    inodes = 0
    def raise_walk_error(error: OSError) -> None:
        raise error

    for directory, names, files in os.walk(root, followlinks=False, onerror=raise_walk_error):
        names[:] = [name for name in names if not Path(directory, name).is_symlink()]
        for name in files:
            path = Path(directory, name)
            try:
                value = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(value.st_mode) and any(
                fnmatch.fnmatch(name, pattern) for pattern in MIGRATION_PATTERNS
            ):
                total += max(value.st_size, value.st_blocks * 512)
                inodes += 1
    return (total, inodes)


def available_bytes(artifact_root: Path) -> int:
    override = os.environ.get("RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES")
    if override is not None:
        if os.environ.get("RAN_AGENT_TEST_MODE") != "1":
            raise ValueError("test_override_forbidden")
        return int(override)
    value = os.statvfs(artifact_root)
    return value.f_bavail * value.f_frsize


def available_inodes(artifact_root: Path) -> int:
    override = os.environ.get("RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_INODES")
    if override is not None:
        if os.environ.get("RAN_AGENT_TEST_MODE") != "1":
            raise ValueError("test_override_forbidden")
        return int(override)
    return os.statvfs(artifact_root).f_favail


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--migration-root")
    parser.add_argument("--fixed-bytes", type=int, default=0)
    parser.add_argument("--fixed-inodes", type=int, default=0)
    args = parser.parse_args()
    try:
        artifact_root = Path(args.artifact_root)
        if not artifact_root.is_absolute() or not artifact_root.is_dir() or artifact_root.is_symlink():
            raise ValueError("artifact_root_invalid")
        roots = existing_copy_roots(args.source)
        if args.fixed_bytes < 0 or args.fixed_inodes < 0:
            raise ValueError("fixed_reserve_invalid")
        usages = [disk_usage(path) for path in roots]
        apparent = args.fixed_bytes + sum(value[0] for value in usages)
        required_inodes = args.fixed_inodes + sum(value[1] for value in usages)
        migration_root = Path(args.migration_root) if args.migration_root else None
        migration_bytes, migration_inodes = migration_duplicate_usage(migration_root)
        apparent += migration_bytes
        required_inodes += migration_inodes
        margin = max(FIXED_MARGIN_BYTES, (apparent * MARGIN_PERCENT + 99) // 100)
        required = apparent + margin
        required_inodes += max(1024, (required_inodes * MARGIN_PERCENT + 99) // 100)
        free = available_bytes(artifact_root)
        free_inodes = available_inodes(artifact_root)
        if free < 0 or free_inodes < 0:
            raise ValueError("free_capacity_invalid")
    except (OSError, ValueError):
        print("snapshot-capacity: probe_failed", file=sys.stderr)
        return 2
    print(
        f"free_bytes={free} required_bytes={required} "
        f"free_inodes={free_inodes} required_inodes={required_inodes}"
    )
    return 0 if free >= required and free_inodes >= required_inodes else INSUFFICIENT


if __name__ == "__main__":
    raise SystemExit(main())
