#!/usr/bin/env python3
"""Codex hook guard for shared agent capability governance."""

from __future__ import annotations

import json
import os
import shlex
import re
import sys
from pathlib import Path
from typing import Any


HOME = Path("/Users/fengran")
CANONICAL_SKILLS = HOME / ".agents" / "skills"
TOOL_SKILL_ROOTS = [
    HOME / ".codex" / "skills",
    HOME / ".claude" / "skills",
    HOME / ".cursor" / "skills",
    HOME / ".gemini" / "skills",
    HOME / ".qwen" / "skills",
    HOME / ".trae" / "skills",
    HOME / ".trae-cn" / "skills",
    HOME / ".copilot" / "skills",
    HOME / ".openclaw" / "skills",
    HOME / ".cc-switch" / "skills",
]

READ_ONLY_COMMANDS = {"sed", "cat", "rg", "grep", "ls", "find", "stat", "file", "wc", "nl", "test", "[", "readlink"}
INTERPRETER_COMMANDS = {"python", "python3", "node", "ruby"}
CODE_WRITE_RE = re.compile(
    r"\b(write_text|write_bytes|writeFile|writeFileSync|appendFile|appendFileSync|"
    r"copyFile|copyFileSync|createWriteStream|File\.write|File\.open|"
    r"unlink|unlinkSync|remove|removeSync|rename|renameSync|replace|mkdir|makedirs)\b"
    r"|\.write\s*\("
    r"|\bopen\s*\([^)\n]*(?:['\"][wa+x][^'\"]*['\"])",
    re.I,
)

GOVERNANCE_PATTERNS = (
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".mcp.json",
    "hooks.json",
    "plugin.json",
    "/hooks/",
    "/plugins/",
)

PROMPT_WORDS = re.compile(
    r"\b(skill|skills|hook|hooks|plugin|plugins|mcp|agent config|new project|bootstrap)\b"
    r"|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.mcp\.json",
    re.I,
)


def walk(value: Any):
    if isinstance(value, dict):
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)
    elif isinstance(value, (str, int, float, bool)):
        yield str(value)


def payload_text(raw: str) -> str:
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return raw
    return "\n".join(walk(data))


def load_payload(raw: str) -> tuple[dict[str, Any], str]:
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}, raw
    return data if isinstance(data, dict) else {}, "\n".join(walk(data))


def event_name(data: dict[str, Any], override: str = "") -> str:
    if override:
        return re.sub(r"[^a-z]", "", override.lower())
    for key in ("event", "hook_event_name", "hook_event", "eventName", "hookEventName"):
        value = data.get(key)
        if isinstance(value, str):
            return re.sub(r"[^a-z]", "", value.lower())
    return ""


def is_blocking_event(data: dict[str, Any], override: str = "") -> bool:
    event = event_name(data, override)
    return event == "pretooluse"


def action_texts(value: Any, parent_key: str = ""):
    if isinstance(value, dict):
        for key, item in value.items():
            lower = str(key).lower()
            if lower in {"cmd", "command", "args", "arguments", "patch"}:
                yield from strings(item)
            elif lower in {"tool_input", "input"} and isinstance(item, str):
                yield item
            else:
                yield from action_texts(item, lower)
    elif isinstance(value, list) and parent_key in {"args", "arguments", "tool_input", "input"}:
        yield " ".join(map(str, value))


def action_cwd(data: dict[str, Any]) -> str:
    for key in ("cwd", "workdir"):
        value = data.get(key)
        if isinstance(value, str):
            return value
    for key in ("tool_input", "input"):
        value = data.get(key)
        if isinstance(value, dict):
            nested = action_cwd(value)
            if nested:
                return nested
    return ""


def strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        yield " ".join(map(str, value))
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)


def normalize_path_text(blob: str) -> str:
    blob = blob.replace("${HOME}", str(HOME)).replace("$HOME", str(HOME))
    blob = blob.replace('"$HOME"', str(HOME)).replace("'$HOME'", str(HOME))
    blob = re.sub(r"(?:(?<=\s)|^)~fengran(?=/)", str(HOME), blob)
    return re.sub(r"(?:(?<=\s)|^)~(?=/)", str(HOME), blob)


def expand_simple_shell_vars(blob: str) -> str:
    text = normalize_path_text(blob)
    variables = {}
    pattern = r"(?:^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=(\"[^\"]*\"|'[^']*'|[^\s;&|]+)"
    for match in re.finditer(pattern, text):
        value = match.group(2)
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            value = value[1:-1]
        if any(marker in value for marker in ("$", "`", "\n")):
            continue
        variables[match.group(1)] = value
    for name, value in variables.items():
        text = text.replace(f"${{{name}}}", value).replace(f"${name}", value)
    return text


def normalize_path_token(token: str, cwd: str = "") -> Path | None:
    token = normalize_path_text(token).rstrip("/")
    if not token.startswith("/"):
        if not cwd:
            return None
        cwd_path = normalize_path_token(cwd)
        if not cwd_path:
            return None
        token = str(cwd_path / token)
    return Path(os.path.normpath(token))


def root_for_path(path: Path) -> Path | None:
    for root in TOOL_SKILL_ROOTS:
        if path == root or root in path.parents:
            return root
    return None


def referenced_root(blob: str, cwd: str = "") -> Path | None:
    text = normalize_path_text(blob)
    if cwd:
        cwd_path = Path(cwd)
        if cwd_path == HOME or HOME in cwd_path.parents:
            text = text.replace(".codex/skills", str(HOME / ".codex" / "skills"))
            text = text.replace(".claude/skills", str(HOME / ".claude" / "skills"))
            text = text.replace(".agents/skills", str(HOME / ".agents" / "skills"))
    for root in TOOL_SKILL_ROOTS:
        root_text = str(root)
        if root_text in text:
            return root
        if root.parent.name in text and re.search(r"['\"]?skills['\"]?", text):
            return root
    return None


def single_skill_path(path: Path, root: Path) -> bool:
    return path.parent == root and path.name not in {"", ".", ".."}


def patch_target_root(blob: str, cwd: str = "") -> Path | None:
    for line in blob.splitlines():
        match = re.match(r"\*\*\* (?:Add|Update|Delete) File: (.+)$", line)
        if not match:
            continue
        path = normalize_path_token(match.group(1).strip(), cwd)
        if not path:
            continue
        root = root_for_path(path)
        if root:
            return root
    return None


def shlex_parts(blob: str) -> list[str]:
    try:
        return shlex.split(expand_simple_shell_vars(blob))
    except ValueError:
        return []


def shell_segments(blob: str) -> list[str]:
    try:
        lexer = shlex.shlex(expand_simple_shell_vars(blob), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []
    segments = []
    current = []
    for token in tokens:
        if token in {"&&", ";", "||", "|"}:
            if current:
                segments.append(shlex.join(current))
                current = []
            continue
        current.append(token)
    if current:
        segments.append(shlex.join(current))
    return segments if len(segments) > 1 else []


def allowed_per_skill_symlink(parts: list[str], root: Path, cwd: str = "") -> bool:
    if not parts or Path(parts[0]).name != "ln":
        return False

    paths = []
    saw_symlink_flag = False
    for part in parts[1:]:
        if part.startswith("-"):
            flags = part[1:]
            if not flags or any(flag not in "sfn" for flag in flags):
                return False
            saw_symlink_flag = saw_symlink_flag or "s" in flags
            continue
        paths.append(part)
    if not saw_symlink_flag or len(paths) != 2:
        return False

    source = normalize_path_token(paths[0], cwd)
    target = normalize_path_token(paths[1], cwd)
    if not source or not target:
        return False
    if source.parent != CANONICAL_SKILLS or target.parent != root:
        return False
    return source.name == target.name and source.name not in {"", ".", ".."}


def redirection_targets(parts: list[str], cwd: str = "") -> list[Path]:
    targets = []
    operators = {">", ">>", "1>", "1>>", "2>", "2>>"}
    for index, part in enumerate(parts):
        if part in operators and index + 1 < len(parts):
            path = normalize_path_token(parts[index + 1], cwd)
            if path:
                targets.append(path)
            continue
        match = re.match(r"^\d?>{1,2}(.+)$", part)
        if match:
            path = normalize_path_token(match.group(1), cwd)
            if path:
                targets.append(path)
    return targets


def non_flag_args(parts: list[str]) -> list[str]:
    return [part for part in parts[1:] if not part.startswith("-")]


def cd_prefixed_command(blob: str, cwd: str) -> tuple[str, str] | None:
    match = re.match(r"\s*cd\s+(.+?)\s*(?:&&|;)\s*(.+)$", blob, re.S)
    if not match:
        return None
    try:
        cd_parts = shlex.split(normalize_path_text(match.group(1)))
    except ValueError:
        return None
    if len(cd_parts) != 1:
        return None
    next_cwd = normalize_path_token(cd_parts[0], cwd)
    return (match.group(2), str(next_cwd)) if next_cwd else None


def shell_script_arg(parts: list[str]) -> str:
    for index, part in enumerate(parts[1:], start=1):
        if part == "-c" and index + 1 < len(parts):
            return parts[index + 1]
        if part.startswith("-") and "c" in part and index + 1 < len(parts):
            return parts[index + 1]
    return ""


def shell_target_root(blob: str, cwd: str = "", depth: int = 0) -> Path | None:
    parts = shlex_parts(blob)
    if not parts:
        return None
    command = Path(parts[0]).name

    if depth < 4:
        cd_command = cd_prefixed_command(blob, cwd)
        if cd_command:
            nested_blob, nested_cwd = cd_command
            return shell_target_root(nested_blob, nested_cwd, depth + 1)
        if command in {"bash", "sh", "zsh"}:
            script = shell_script_arg(parts)
            if script:
                return shell_target_root(script, cwd, depth + 1)

    for target in redirection_targets(parts, cwd):
        root = root_for_path(target)
        if root:
            return root

    if command == "ln":
        for root in TOOL_SKILL_ROOTS:
            if allowed_per_skill_symlink(parts, root, cwd):
                return None
        targets = [normalize_path_token(arg, cwd) for arg in non_flag_args(parts)]
        for path in targets[-1:]:
            if path:
                root = root_for_path(path)
                if root:
                    return root
        return None

    if command in {"rm", "unlink"}:
        recursive = any(part.startswith("-") and ("r" in part or "R" in part) for part in parts[1:])
        for arg in non_flag_args(parts):
            path = normalize_path_token(arg, cwd)
            if not path:
                continue
            root = root_for_path(path)
            if root and (recursive or not single_skill_path(path, root)):
                return root
        return None

    if command in {"cp", "mv", "install", "rsync"}:
        args = [normalize_path_token(arg, cwd) for arg in non_flag_args(parts)]
        path = next((item for item in reversed(args) if item), None)
        return root_for_path(path) if path else None

    if command in {"tee", "touch", "mkdir"}:
        for arg in non_flag_args(parts):
            path = normalize_path_token(arg, cwd)
            if path:
                root = root_for_path(path)
                if root:
                    return root
        return None

    if command == "unzip":
        for index, part in enumerate(parts):
            if part == "-d" and index + 1 < len(parts):
                path = normalize_path_token(parts[index + 1], cwd)
                if path:
                    return root_for_path(path)
        return None

    if command == "dd":
        for part in parts[1:]:
            if part.startswith("of="):
                path = normalize_path_token(part[3:], cwd)
                if path:
                    return root_for_path(path)
        return None

    if command in {"sed", "perl"} and any(part.startswith("-") and "i" in part for part in parts[1:]):
        for arg in non_flag_args(parts):
            path = normalize_path_token(arg, cwd)
            if path:
                root = root_for_path(path)
                if root:
                    return root
    return None


def allowed_shell_action(blob: str, cwd: str = "") -> bool:
    parts = shlex_parts(blob)
    if not parts:
        return False
    command = Path(parts[0]).name
    if command == "ln":
        return any(allowed_per_skill_symlink(parts, root, cwd) for root in TOOL_SKILL_ROOTS)
    if command in {"rm", "unlink"}:
        for arg in non_flag_args(parts):
            path = normalize_path_token(arg, cwd)
            if not path:
                continue
            root = root_for_path(path)
            if root and single_skill_path(path, root):
                return True
    if command in {"printf", "echo"}:
        return not any(root_for_path(target) for target in redirection_targets(parts, cwd))
    return False


def direct_tool_skill_write(blob: str, cwd: str = "", depth: int = 0) -> Path | None:
    expanded_blob = expand_simple_shell_vars(blob)
    root = patch_target_root(blob, cwd) or shell_target_root(blob, cwd)
    if root:
        return root
    if re.search(r"^\*\*\* (?:Add|Update|Delete) File: ", blob, re.M):
        return None
    parts = shlex_parts(expanded_blob)
    if depth < 4:
        cd_command = cd_prefixed_command(expanded_blob, cwd)
        if cd_command:
            nested_blob, nested_cwd = cd_command
            return direct_tool_skill_write(nested_blob, nested_cwd, depth + 1)
        if parts and Path(parts[0]).name in {"bash", "sh", "zsh"}:
            script = shell_script_arg(parts)
            if script:
                return direct_tool_skill_write(script, cwd, depth + 1)
        for segment in shell_segments(expanded_blob):
            root = direct_tool_skill_write(segment, cwd, depth + 1)
            if root:
                return root
    if allowed_shell_action(blob, cwd):
        return None
    referenced = referenced_root(expanded_blob, cwd)
    if not referenced:
        return None
    if parts and Path(parts[0]).name in READ_ONLY_COMMANDS:
        return None
    if parts and Path(parts[0]).name in INTERPRETER_COMMANDS:
        return referenced if CODE_WRITE_RE.search(expanded_blob) else None
    return referenced


def governance_related(blob: str) -> bool:
    return PROMPT_WORDS.search(blob) is not None or any(pattern in blob for pattern in GOVERNANCE_PATTERNS)


def check(raw: str, event_override: str = "") -> tuple[int, str]:
    data, blob = load_payload(raw)
    action_blob = "\n".join(action_texts(data)) if data else raw
    bad_root = direct_tool_skill_write(action_blob, action_cwd(data)) if is_blocking_event(data, event_override) else None
    if bad_root:
        return (
            2,
            "[agent-governance] blocked: write shared skills under "
            f"{CANONICAL_SKILLS}/<skill>, then symlink individual tool roots. "
            f"Do not edit {bad_root} directly.",
        )
    if governance_related(blob):
        return (
            0,
            "[agent-governance] reminder: use agent-capability-governance. "
            "Skills live in /Users/fengran/.agents/skills; hooks/plugins/MCP need inventory review.",
        )
    return 0, ""


def self_test() -> int:
    codex_dir = ".co" + "dex"
    skill_dir = "sk" + "ills"
    codex_home = str(HOME / codex_dir)
    codex_skill_root = str(HOME / codex_dir / skill_dir)
    cases = [
        ({"command": "sed -n '1,80p' /Users/fengran/.codex/skills/foo/SKILL.md"}, 0, ""),
        ({"patch": "*** Update File: /Users/fengran/.codex/skills/foo/SKILL.md\n+bad\n"}, 0, ""),
        ({"patch": "*** Update File: /Users/fengran/.codex/skills/foo/SKILL.md\n+bad\n"}, 2, "PreToolUse"),
        ({"command": "cp /Users/fengran/.agents/skills/foo/SKILL.md /Users/fengran/.codex/skills/foo/SKILL.md"}, 2, "PreToolUse"),
        (
            {
                "event": "UserPromptSubmit",
                "prompt": "Please analyze why cp /tmp/x /Users/fengran/.codex/skills/foo/SKILL.md is unsafe.",
            },
            0,
            "",
        ),
        ({"prompt": "Please analyze cp /tmp/x /Users/fengran/.codex/skills/foo/SKILL.md"}, 0, "UserPromptSubmit"),
        ({"command": "cp /tmp/x /Users/fengran/.codex/skills/foo/SKILL.md"}, 2, "PreToolUse"),
        (
            {
                "event": "PostToolUse",
                "output": "Example only: cp /tmp/x /Users/fengran/.codex/skills/foo/SKILL.md",
            },
            0,
            "",
        ),
        ({"command": "ln -s /Users/fengran/.agents/skills/foo /Users/fengran/.codex/skills/foo"}, 0, "PreToolUse"),
        ({"command": "ln -s /Users/fengran/.agents/skills/foo /Users/fengran/.codex/skills/bar"}, 2, "PreToolUse"),
        ({"command": "ln -s /Users/fengran/.agents/skills /Users/fengran/.codex/skills"}, 2, "PreToolUse"),
        ({"command": "printf bad > $HOME/.codex/skills/foo/SKILL.md"}, 2, "PreToolUse"),
        ({"command": "printf bad > \"$HOME\"/.codex/skills/foo/SKILL.md"}, 2, "PreToolUse"),
        ({"command": "printf '%s' '/Users/fengran/.codex/skills/foo/SKILL.md' > /tmp/note.txt"}, 0, "PreToolUse"),
        ({"command": "ln -s $HOME/.agents/skills/foo $HOME/.codex/skills/foo"}, 0, "PreToolUse"),
        ({"command": "ln -fs /Users/fengran/.agents/skills /Users/fengran/.codex/skills"}, 2, "PreToolUse"),
        ({"command": "rm -f /Users/fengran/.codex/skills/foo"}, 0, "PreToolUse"),
        ({"command": "rm -rf /Users/fengran/.codex/skills"}, 2, "PreToolUse"),
        ({"command": "bash -lc 'cp /tmp/x /Users/fengran/.codex/skills/foo/SKILL.md'"}, 2, "PreToolUse"),
        ({"command": "python3 -c 'from pathlib import Path; Path(\"/Users/fengran/.codex/skills/foo/SKILL.md\").write_text(\"bad\")'"}, 2, "PreToolUse"),
        ({"command": "cp /tmp/x ~fengran/.codex/skills/foo/SKILL.md"}, 2, "PreToolUse"),
        ({"command": "cp /tmp/x .codex/skills/foo/SKILL.md", "cwd": "/Users/fengran"}, 2, "PreToolUse"),
        ({"tool_input": {"message": "review relative .codex/skills with cwd /Users/fengran"}, "cwd": "/Users/fengran/ran_agent"}, 0, "PreToolUse"),
        ({"patch": "*** Update File: /Users/fengran/.agents/skills/foo/SKILL.md\n+ok\n"}, 0, ""),
        ({"command": f"cp /tmp/x {skill_dir}/foo/SKILL.md", "cwd": codex_home}, 2, "PreToolUse"),
        ({"command": "cp /tmp/x foo/SKILL.md", "cwd": codex_skill_root}, 2, "PreToolUse"),
        ({"command": f"bash -lc 'cd {codex_home} && cp /tmp/x {skill_dir}/foo/SKILL.md'"}, 2, "PreToolUse"),
        ({"command": f"bash -lc 'cd {codex_home} && D={skill_dir} && cp /tmp/x \"$D/foo/SKILL.md\"'"}, 2, "PreToolUse"),
        ({"command": f"D={skill_dir}; cp /tmp/x \"$D/foo/SKILL.md\"", "cwd": codex_home}, 2, "PreToolUse"),
        ({"command": f"D={skill_dir}; rg \"$D\" /Users/fengran/ran_agent/AGENTS.md", "cwd": codex_home}, 0, "PreToolUse"),
        ({"command": f"printf bad | tee {codex_skill_root}/foo/SKILL.md"}, 2, "PreToolUse"),
        ({"command": f"D={skill_dir}; cat /tmp/x | tee \"$D/foo/SKILL.md\"", "cwd": codex_home}, 2, "PreToolUse"),
        ({"command": f"python3 -c 'from pathlib import Path; (Path.home() / \"{codex_dir}\" / \"{skill_dir}\" / \"foo\" / \"SKILL.md\").write_text(\"bad\")'"}, 2, "PreToolUse"),
        ({"command": f"python3 -c 'from pathlib import Path; print(Path(\"{codex_skill_root}/foo/SKILL.md\").read_text())'"}, 0, "PreToolUse"),
        ({"command": f"node -e 'console.log(require(\"fs\").readFileSync(\"{codex_skill_root}/foo/SKILL.md\", \"utf8\"))'"}, 0, "PreToolUse"),
        ({"command": f"node -e 'require(\"fs\").writeFileSync(\"{codex_skill_root}/foo/SKILL.md\", \"bad\")'"}, 2, "PreToolUse"),
        ({"command": f"bash -lc 'rg {codex_dir} {skill_dir} /Users/fengran/ran_agent/AGENTS.md'"}, 0, "PreToolUse"),
        ({"command": f"test -L {codex_skill_root}/agent-capability-governance"}, 0, "PreToolUse"),
        ({"command": f"readlink {codex_skill_root}/agent-capability-governance"}, 0, "PreToolUse"),
        ({"patch": f"*** Update File: scripts/x.py\n+ROOT = {codex_skill_root!r}\n"}, 0, "PreToolUse"),
        ({"command": "cat > /tmp/project/.mcp.json"}, 0, ""),
    ]
    for payload, expected, event_override in cases:
        actual, _message = check(json.dumps(payload), event_override)
        assert actual == expected, (payload, actual, expected)
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    code, message = check(sys.stdin.read(), sys.argv[1] if len(sys.argv) > 1 else "")
    if message:
        print(message, file=sys.stderr)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
