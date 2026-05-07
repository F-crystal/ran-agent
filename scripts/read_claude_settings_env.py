#!/usr/bin/env python3
"""Read one env-style key from Claude Code settings.json / JSONC."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def strip_line_comments(text: str) -> str:
    """Remove // comments while preserving string contents such as URLs."""

    result: list[str] = []
    in_string = False
    escape = False
    i = 0
    while i < len(text):
        char = text[i]
        next_char = text[i + 1] if i + 1 < len(text) else ""

        if in_string:
            result.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            i += 1
            continue

        if char == '"':
            in_string = True
            result.append(char)
            i += 1
            continue

        if char == "/" and next_char == "/":
            i += 2
            while i < len(text) and text[i] not in "\r\n":
                i += 1
            continue

        result.append(char)
        i += 1

    return "".join(result)


def read_setting(settings_path: Path, key: str) -> str:
    parsed = json.loads(strip_line_comments(settings_path.read_text(encoding="utf-8")))
    value = parsed.get("env", {}).get(key, "")
    return "" if value in (None, "") else str(value)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: read_claude_settings_env.py <settings-path> <key>", file=sys.stderr)
        return 2
    settings_path = Path(sys.argv[1])
    key = sys.argv[2]
    if not settings_path.is_file():
        return 1
    value = read_setting(settings_path, key)
    if value:
        print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
