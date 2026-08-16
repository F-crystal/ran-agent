#!/usr/bin/env python3
"""Read-only audit for project agent instruction governance."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path


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


def path_present(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def is_project_candidate(path: Path) -> bool:
    if path_present(path / ".mcp.json"):
        return True
    skills = path / "skills"
    if skills.is_dir() and not skills.is_symlink() and any(skills.glob("*/SKILL.md")):
        return True
    return any(path_present(path / name) for name in DOC_NAMES)


def inspect_doc(path: Path) -> tuple[dict[str, str] | None, bool]:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return {"path": str(path), "issue": "missing_instruction_file"}, False
    if stat.S_ISLNK(mode):
        return {"path": str(path), "issue": "symlink_not_audited"}, False
    if not stat.S_ISREG(mode):
        return {"path": str(path), "issue": "non_regular_file"}, False
    text = path.read_text(encoding="utf-8", errors="replace")
    return None, any(marker in text for marker in MARKERS)


def audit_dir(path: Path) -> list[dict[str, str]]:
    if not is_project_candidate(path):
        return []
    existing_docs = [path / name for name in DOC_NAMES if path_present(path / name)]
    targets = existing_docs or [path / "AGENTS.md"]
    findings = []
    first_regular_doc = None
    marker_found = False
    for target in targets:
        finding, has_marker = inspect_doc(target)
        if finding:
            findings.append(finding)
        else:
            first_regular_doc = first_regular_doc or target
            marker_found = marker_found or has_marker
    if first_regular_doc and not marker_found:
        findings.append(
            {"path": str(first_regular_doc), "issue": "missing_capability_governance"}
        )
    return findings


def iter_project_dirs(root: Path, max_depth: int):
    root = root.resolve(strict=True)
    for current, dirs, _files in os.walk(root, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        dirs[:] = [
            name
            for name in dirs
            if name not in EXCLUDED_NAMES
            and not name.startswith(".")
            and not (current_path / name).is_symlink()
        ]
        if depth >= max_depth:
            dirs[:] = []
        yield current_path


def self_test() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir).resolve()
        project = root / "project"
        project.mkdir()
        doc = project / "AGENTS.md"
        doc.write_text("# Project\n", encoding="utf-8")
        findings = [item for path in iter_project_dirs(root, 2) for item in audit_dir(path)]
        assert findings == [
            {"path": str(doc), "issue": "missing_capability_governance"}
        ], findings
        doc.write_text(f"# Project\n\n## {MARKER}\n", encoding="utf-8")
        (project / "GEMINI.md").write_text("@./AGENTS.md\n", encoding="utf-8")
        findings = [item for path in iter_project_dirs(root, 2) for item in audit_dir(path)]
        assert not findings, findings
        link = project / "CLAUDE.md"
        link.symlink_to(doc)
        findings = [item for path in iter_project_dirs(root, 2) for item in audit_dir(path)]
        assert findings == [
            {"path": str(link), "issue": "symlink_not_audited"}
        ], findings
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="*", type=Path, help="Explicit project roots to audit")
    parser.add_argument("--max-depth", type=int, default=5)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if not args.roots:
        parser.error("provide at least one explicit root")

    findings = []
    for root in args.roots:
        for project_dir in iter_project_dirs(root, args.max_depth):
            findings.extend(audit_dir(project_dir))
    print(json.dumps({"finding_count": len(findings), "findings": findings}, ensure_ascii=False))
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
