#!/usr/bin/env python3
"""Install shared skill, inventories, and Codex hook for agent capability governance."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


HOME = Path("/Users/fengran")
REPO = Path("/Users/fengran/ran_agent")
CANONICAL = HOME / ".agents" / "skills" / "agent-capability-governance"
SKILL_ROOTS = [
    HOME / ".codex" / "skills",
    HOME / ".claude" / "skills",
    HOME / ".qwen" / "skills",
    HOME / ".trae" / "skills",
    HOME / ".trae-cn" / "skills",
    HOME / ".cursor" / "skills",
    HOME / ".copilot" / "skills",
    HOME / ".gemini" / "skills",
    HOME / ".openclaw" / "skills",
    HOME / ".cc-switch" / "skills",
]

SKILL_MD = """---
name: agent-capability-governance
description: Use when creating, installing, editing, or reviewing agent skills, hooks, plugins, MCP servers, AGENTS.md, CLAUDE.md, GEMINI.md, .mcp.json, settings.json, or bootstrapping a new project so shared capability config stays canonical.
---

# Agent Capability Governance

Keep three layers separate:

1. Skills are shared knowledge. Cross-tool skills live in `/Users/fengran/.agents/skills/<skill>`.
2. Hooks are executable lifecycle code. Keep them host-specific and record changes in `/Users/fengran/.agents/hook-policy/`.
3. Plugins and MCP servers are executable capability entry points. Do not edit caches by hand; record enabled entries in `/Users/fengran/.agents/plugin-inventory/`.

When adding a new project, add an Agent Capability Governance section to `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` if the project has any agent config.

Rules:

- New cross-tool skill: edit `/Users/fengran/.agents/skills/<skill>/SKILL.md`, then symlink that one skill into tool roots.
- Project-only skill: keep it in the project `skills/<skill>/SKILL.md`.
- Never edit `/Users/fengran/.codex/skills`, `/Users/fengran/.claude/skills`, or other tool skill roots directly except to add/remove per-skill symlinks.
- Never symlink whole skill roots.
- Before changing hooks, plugins, MCP, or global agent settings, update the relevant inventory and check for secrets.
- Do not place credentials, cookies, API keys, sessions, logs, SQLite state, or local caches in skills or inventories.
- Codex, Claude, and Cursor hard-block direct tool-skill-root writes at their pre-tool hook; other agents rely on this skill plus their global project instructions unless a host-specific hook is added.
"""

GLOBAL_RULE = """# Agent Capability Governance

Status: CURRENT (2026-06-29)

For any new or existing project under `/Users/fengran`:

- Use the `agent-capability-governance` skill when creating or changing skills, hooks, plugins, MCP servers, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json`, or agent settings.
- Cross-tool skills live in `/Users/fengran/.agents/skills`; project-only skills stay in that repo's `skills/`.
- Hooks, plugins, and MCP entries are executable capability surfaces; record new or changed entries in `/Users/fengran/.agents/hook-policy/` or `/Users/fengran/.agents/plugin-inventory/`.
- Do not edit tool-specific skill copies directly; use per-skill symlinks from `/Users/fengran/.agents/skills`.
- Do not put credentials, cookies, API keys, session files, logs, or local caches in skills or inventories.
"""

PROJECT_SECTION = """## Agent Capability Governance

- Cross-tool skills live in `/Users/fengran/.agents/skills`; project-only skills stay in this repo's `skills/`.
- Hooks, plugins, and MCP entries are executable capability surfaces; record new or changed entries in `/Users/fengran/.agents/hook-policy/` or `/Users/fengran/.agents/plugin-inventory/`.
- Do not edit tool-specific skill copies directly; use per-skill symlinks from the shared source.
"""

HOOK_INVENTORY = """# Hook Inventory

Status: CURRENT (2026-06-29)

## Active Global Hooks

- Codex `/Users/fengran/.codex/hooks.json`
  - Clawd on Desk hook on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`.
  - `/Users/fengran/.codex/hooks/git_guard.py` on `PreToolUse` and `PostToolUse`; blocks unsafe staged git files.
  - `/Users/fengran/.codex/hooks/agent_governance_guard.py` on `UserPromptSubmit` and `PreToolUse`; prompt events only remind, `PreToolUse` blocks direct writes to tool-specific shared skill roots.
- Claude `/Users/fengran/.claude/settings.json`
  - Clawd on Desk hook on major lifecycle events.
  - `/Users/fengran/.claude/hooks/agent_governance_guard.py` on `UserPromptSubmit` and `PreToolUse`; same governance behavior as Codex.
- Cursor `/Users/fengran/.cursor/hooks.json`
  - Clawd on Desk hook on major lifecycle events.
  - `/Users/fengran/.cursor/hooks/agent_governance_guard.py` on `beforeSubmitPrompt` and `preToolUse`; prompt events only remind, `preToolUse` blocks direct writes to tool-specific shared skill roots.
- Gemini `/Users/fengran/.gemini/settings.json`
  - Clawd on Desk hook on major lifecycle events. Review `BeforeTool` allow semantics before relying on it as a permission boundary.
- Codex Ponytail plugin
  - Plugin-managed hooks for activation/mode tracking.
- macOS LaunchAgent `/Users/fengran/Library/LaunchAgents/com.fengran.agent-governance-watch.plist`
  - Runs `/Users/fengran/.agents/bin/agent_project_governance_watch.py --once` periodically.
  - Host-independent fallback for future project `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` governance sections.

## Rules

- Hook code is executable. Record event, command path, input visibility, side effects, and allow/block behavior before adding or changing one.
- Keep host-managed hooks in their host config; do not move them into the shared skills directory.
- Do not store secrets or raw hook payloads here.
"""

PLUGIN_INVENTORY = """# Plugin And MCP Inventory

Status: CURRENT (2026-06-29)

## Active Codex Plugins

Source: `/Users/fengran/.codex/config.toml` enabled plugin entries.

- `github@openai-curated`
- `documents@openai-primary-runtime`
- `spreadsheets@openai-primary-runtime`
- `presentations@openai-primary-runtime`
- `chrome@openai-bundled`
- `pdf@openai-primary-runtime`
- `browser@openai-bundled`
- `template-creator@openai-primary-runtime`
- `ponytail@ponytail`

## Active Claude Plugins

- `claude-code-setup@claude-plugins-official`

## Project MCP: `/Users/fengran/ran_agent/.mcp.json`

- `playwright`
- `time`
- `media_generation`
- `sticker_catalog`
- `media_reader`
- `social_reader`
- `personal_memory`
- `ombre_memory`
- `search_hub`
- `tavily`

## Notes

- Claude plugin marketplace/cache entries are not enabled plugins.
- Codex plugin caches are host-managed artifacts; do not edit or symlink them by hand.
- GitHub skills may be served from the `openai-curated-remote` cache even when the enabled config entry is `github@openai-curated`.
- Claude `ANTHROPIC_AUTH_TOKEN` and Tavily MCP had secret-like values in local settings during audit. Files are hardened to owner-only permissions; rotate them and move future secrets to Keychain/env/secret store when the host supports it. Project `.mcp.json` must keep Tavily as `${TAVILY_API_KEY}`, not a literal key. Do not record secret values here.
"""


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path}")


def write_with_backup(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8", errors="replace") != text:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = path.with_name(f"{path.name}.backup-{stamp}")
        shutil.copy2(path, backup)
        print(f"backed up {path} -> {backup}")
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path}")


def generated_block(text: str) -> str:
    return (
        "<!-- BEGIN GENERATED: agent-capability-governance -->\n"
        + text.strip()
        + "\n<!-- END GENERATED: agent-capability-governance -->\n"
    )


def write_generated(path: Path, text: str) -> None:
    begin = "<!-- BEGIN GENERATED: agent-capability-governance -->"
    end = "<!-- END GENERATED: agent-capability-governance -->"
    block = generated_block(text)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(block, encoding="utf-8")
        print(f"wrote {path}")
        return

    existing = path.read_text(encoding="utf-8", errors="replace")
    if begin in existing and end in existing:
        start = existing.index(begin)
        finish = existing.index(end, start) + len(end)
        next_text = existing[:start] + block.rstrip() + existing[finish:]
    elif existing.strip() and existing.strip() != text.strip():
        next_text = block + "\n## Preserved Previous Content\n\n" + existing.rstrip() + "\n"
    else:
        next_text = block
    path.write_text(drop_legacy_preserved_generated(next_text, text), encoding="utf-8")
    print(f"updated {path}")


def drop_legacy_preserved_generated(existing: str, generated: str) -> str:
    marker = "\n## Preserved Previous Content\n\n"
    if marker not in existing:
        return existing
    head, preserved = existing.split(marker, 1)
    title = generated.strip().splitlines()[0]
    if preserved.lstrip().startswith(title):
        return head.rstrip() + "\n"
    return existing


def append_section(path: Path, section: str) -> None:
    if not path.exists():
        write(path, section)
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    if "Agent Capability Governance" in text:
        print(f"kept {path}")
        return
    path.write_text(text.rstrip() + "\n\n" + section, encoding="utf-8")
    print(f"updated {path}")


def backup_if_changed(path: Path, before: str, after: str) -> None:
    if before == after or not path.exists():
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup = path.with_name(f"{path.name}.backup-{stamp}")
    path.write_text(before, encoding="utf-8")
    shutil.copy2(path, backup)
    print(f"backed up {path} -> {backup}")


def install_hook_script(hook_dst: Path) -> None:
    hook_src = REPO / "scripts" / "agent_governance_guard.py"
    hook_dst.parent.mkdir(parents=True, exist_ok=True)
    if hook_dst.exists() and hook_dst.read_text(encoding="utf-8", errors="replace") != hook_src.read_text(encoding="utf-8"):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = hook_dst.with_name(f"{hook_dst.name}.backup-{stamp}")
        shutil.copy2(hook_dst, backup)
        print(f"backed up {hook_dst} -> {backup}")
    shutil.copy2(hook_src, hook_dst)
    os.chmod(hook_dst, 0o755)
    print(f"installed {hook_dst}")


def install_project_watcher() -> None:
    script_src = REPO / "scripts" / "agent_project_governance_watch.py"
    script_dst = HOME / ".agents" / "bin" / "agent_project_governance_watch.py"
    script_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(script_src, script_dst)
    os.chmod(script_dst, 0o755)
    print(f"installed {script_dst}")

    log_dir = HOME / ".agents" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    plist = HOME / "Library" / "LaunchAgents" / "com.fengran.agent-governance-watch.plist"
    plist_text = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fengran.agent-governance-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>{script_dst}</string>
    <string>--once</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>{log_dir / "project-governance-watch.out"}</string>
  <key>StandardErrorPath</key>
  <string>{log_dir / "project-governance-watch.err"}</string>
</dict>
</plist>
"""
    before = plist.read_text(encoding="utf-8") if plist.exists() else ""
    plist.parent.mkdir(parents=True, exist_ok=True)
    backup_if_changed(plist, before, plist_text)
    plist.write_text(plist_text, encoding="utf-8")
    print(f"updated {plist}")
    subprocess.run(["/usr/bin/python3", str(script_dst), "--once"], stdout=subprocess.DEVNULL, check=False)


def harden_sensitive_config_permissions() -> None:
    paths = [
        HOME / ".claude" / "settings.json",
        HOME / ".reasonix" / "config.json",
    ]
    paths.extend((HOME / ".claude").glob("settings.json.backup-*"))
    for path in paths:
        if path.exists():
            os.chmod(path, 0o600)
            print(f"hardened permissions {path}")


def sanitize_project_mcp() -> None:
    path = REPO / ".mcp.json"
    if not path.exists():
        return
    before = path.read_text(encoding="utf-8", errors="replace")
    after = re.sub(r"(tavilyApiKey=)(?!\$\{TAVILY_API_KEY\})([^\"&]+)", r"\1${TAVILY_API_KEY}", before)
    if before != after:
        path.write_text(after, encoding="utf-8")
        print(f"sanitized {path}")


def install_skill() -> None:
    write_with_backup(CANONICAL / "SKILL.md", SKILL_MD)
    write_with_backup(HOME / ".agents" / "skills" / "AGENTS.md", GLOBAL_RULE)
    for root in SKILL_ROOTS:
        root.mkdir(parents=True, exist_ok=True)
        target = root / "agent-capability-governance"
        if target.is_symlink() or not target.exists():
            if target.exists() or target.is_symlink():
                target.unlink()
            target.symlink_to(CANONICAL, target_is_directory=True)
            print(f"linked {target} -> {CANONICAL}")
        else:
            print(f"skipped existing non-symlink {target}")


def install_inventories() -> None:
    write_generated(HOME / ".agents" / "hook-policy" / "inventory.md", HOOK_INVENTORY)
    write_generated(HOME / ".agents" / "plugin-inventory" / "inventory.md", PLUGIN_INVENTORY)


def install_global_rules() -> None:
    for path in [
        HOME / "AGENTS.md",
        HOME / "CLAUDE.md",
        HOME / "GEMINI.md",
        HOME / ".codex" / "AGENTS.md",
        HOME / ".claude" / "CLAUDE.md",
        HOME / ".gemini" / "GEMINI.md",
        HOME / ".qwen" / "AGENTS.md",
        HOME / ".reasonix" / "AGENTS.md",
        HOME / ".cursor" / "AGENTS.md",
        HOME / ".trae" / "AGENTS.md",
        HOME / ".trae-cn" / "AGENTS.md",
        HOME / ".copilot" / "AGENTS.md",
    ]:
        append_section(path, GLOBAL_RULE)


def install_project_sections() -> None:
    for path in [
        Path("/Users/fengran/Desktop/3 中海油/2026.06 - 科技信息系统/AGENTS.md"),
        Path("/Users/fengran/Desktop/3 中海油/2026.03 - 未来产业课题/GEMINI.md"),
        HOME / ".hermes" / "hermes-agent" / "AGENTS.md",
    ]:
        if path.exists():
            append_section(path, PROJECT_SECTION)


def install_codex_hook() -> None:
    hook_dst = HOME / ".codex" / "hooks" / "agent_governance_guard.py"
    install_hook_script(hook_dst)

    hooks_json = HOME / ".codex" / "hooks.json"
    hooks_before = hooks_json.read_text(encoding="utf-8")
    data = json.loads(hooks_json.read_text(encoding="utf-8"))
    base_command = f'python3 "{hook_dst}"'
    for event in ("UserPromptSubmit", "PreToolUse", "PostToolUse"):
        entries = data.setdefault("hooks", {}).setdefault(event, [])
        kept = []
        for entry in entries:
            hooks = [
                hook
                for hook in entry.get("hooks", [])
                if not str(hook.get("command", "")).startswith(base_command)
            ]
            if hooks:
                kept.append({**entry, "hooks": hooks})
        data["hooks"][event] = kept

    for event in ("UserPromptSubmit", "PreToolUse"):
        entries = data.setdefault("hooks", {}).setdefault(event, [])
        command = f'{base_command} {event}'
        found = any(hook.get("command") == command for entry in entries for hook in entry.get("hooks", []))
        if not found:
            entries.append({"hooks": [{"type": "command", "command": command, "timeout": 10}]})
            print(f"registered {event}")
    hooks_after = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    backup_if_changed(hooks_json, hooks_before, hooks_after)
    hooks_json.write_text(hooks_after, encoding="utf-8")
    print(f"updated {hooks_json}")


def install_claude_hook() -> None:
    hook_dst = HOME / ".claude" / "hooks" / "agent_governance_guard.py"
    install_hook_script(hook_dst)
    settings = HOME / ".claude" / "settings.json"
    before = settings.read_text(encoding="utf-8")
    data = json.loads(before)
    base_command = f'python3 "{hook_dst}"'
    hooks_root = data.setdefault("hooks", {})
    for event in ("UserPromptSubmit", "PreToolUse"):
        entries = hooks_root.setdefault(event, [])
        kept_entries = []
        for entry in entries:
            hooks = [
                hook
                for hook in entry.get("hooks", [])
                if not str(hook.get("command", "")).startswith(base_command)
            ]
            if hooks:
                kept_entries.append({**entry, "hooks": hooks})
        command = f"{base_command} {event}"
        found = any(hook.get("command") == command for entry in kept_entries for hook in entry.get("hooks", []))
        if not found:
            kept_entries.append({"matcher": "", "hooks": [{"type": "command", "command": command}]})
            print(f"registered Claude {event}")
        hooks_root[event] = kept_entries
    after = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    backup_if_changed(settings, before, after)
    settings.write_text(after, encoding="utf-8")
    print(f"updated {settings}")


def install_cursor_hook() -> None:
    hook_dst = HOME / ".cursor" / "hooks" / "agent_governance_guard.py"
    install_hook_script(hook_dst)
    hooks_json = HOME / ".cursor" / "hooks.json"
    before = hooks_json.read_text(encoding="utf-8")
    data = json.loads(before)
    base_command = f'python3 "{hook_dst}"'
    hooks_root = data.setdefault("hooks", {})
    for event in ("beforeSubmitPrompt", "preToolUse"):
        entries = [
            entry
            for entry in hooks_root.setdefault(event, [])
            if not str(entry.get("command", "")).startswith(base_command)
        ]
        command = f"{base_command} {event}"
        if not any(entry.get("command") == command for entry in entries):
            entries.append({"command": command})
            print(f"registered Cursor {event}")
        hooks_root[event] = entries
    after = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    backup_if_changed(hooks_json, before, after)
    hooks_json.write_text(after, encoding="utf-8")
    print(f"updated {hooks_json}")


def main() -> None:
    sanitize_project_mcp()
    install_skill()
    install_inventories()
    install_global_rules()
    install_project_sections()
    install_codex_hook()
    install_claude_hook()
    install_cursor_hook()
    install_project_watcher()
    harden_sensitive_config_permissions()


if __name__ == "__main__":
    main()
