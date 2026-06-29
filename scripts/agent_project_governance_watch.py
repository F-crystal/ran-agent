#!/usr/bin/env python3
"""Keep future project agent config aligned with shared governance rules."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


HOME = Path("/Users/fengran")
DEFAULT_ROOTS = [
    HOME,
]
EXCLUDED_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".tmp",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    "Library",
    "Applications",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "logs",
    "state",
    "data",
    "debug",
    "local_archive",
    "skills",
}
DOC_NAMES = ("AGENTS.md", "CLAUDE.md", "GEMINI.md")
MARKER = "Agent Capability Governance"
MARKERS = (
    MARKER,
    "Agent 能力治理",
    "must use `AGENTS.md` as the canonical repo-root rules",
    "Hermes 是 ran-agent 的前台对话 shell",
)
SECTION = """## Agent Capability Governance

- Cross-tool skills live in `/Users/fengran/.agents/skills`; project-only skills stay in this repo's `skills/`.
- Hooks, plugins, and MCP entries are executable capability surfaces; record new or changed entries in `/Users/fengran/.agents/hook-policy/` or `/Users/fengran/.agents/plugin-inventory/`.
- Do not edit tool-specific skill copies directly; use per-skill symlinks from the shared source.
"""


def load_roots() -> list[Path]:
    config = HOME / ".agents" / "project-governance" / "roots.json"
    if not config.exists():
        return [root for root in DEFAULT_ROOTS if root.exists()]
    try:
        items = json.loads(config.read_text(encoding="utf-8"))
    except Exception:
        return [root for root in DEFAULT_ROOTS if root.exists()]
    roots = [Path(item) for item in items if isinstance(item, str)]
    return [root for root in roots if root.exists()]


def is_project_candidate(path: Path) -> bool:
    if (path / ".mcp.json").exists():
        return True
    skills = path / "skills"
    if skills.is_dir() and any(skills.glob("*/SKILL.md")):
        return True
    return any((path / name).exists() for name in DOC_NAMES)


def update_doc(path: Path, dry_run: bool) -> bool:
    if path.exists():
        text = path.read_text(encoding="utf-8", errors="replace")
        if any(marker in text for marker in MARKERS):
            return False
        next_text = text.rstrip() + "\n\n" + SECTION
    else:
        next_text = "# AGENTS.md\n\n" + SECTION
    if not dry_run:
        path.write_text(next_text, encoding="utf-8")
    return True


def reconcile_dir(path: Path, dry_run: bool) -> list[str]:
    if not is_project_candidate(path):
        return []
    existing_docs = [path / name for name in DOC_NAMES if (path / name).exists()]
    targets = existing_docs or [path / "AGENTS.md"]
    changed = []
    for target in targets:
        if update_doc(target, dry_run):
            changed.append(str(target))
    return changed


def iter_project_dirs(root: Path, max_depth: int):
    root = root.resolve()
    for current, dirs, _files in os.walk(root):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        dirs[:] = [
            name
            for name in dirs
            if name not in EXCLUDED_NAMES and not name.startswith(".")
        ]
        if depth >= max_depth:
            dirs[:] = []
        yield current_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true", help="Run one scan. Present for launchd readability.")
    parser.add_argument("--max-depth", type=int, default=5)
    args = parser.parse_args()

    changed = []
    for root in load_roots():
        for project_dir in iter_project_dirs(root, args.max_depth):
            changed.extend(reconcile_dir(project_dir, args.dry_run))
    state_dir = HOME / ".agents" / "project-governance"
    if not args.dry_run:
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "last-run.json").write_text(json.dumps({"changed": changed}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"changed_count": len(changed), "changed": changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
