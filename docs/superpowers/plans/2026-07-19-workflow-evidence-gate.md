# Workflow Evidence Gate Implementation Plan

Status: HISTORICAL IMPLEMENTATION PLAN (2026-08-18)

The gate has landed. Use `docs/governance/delivery-evidence.md` for the current
contract; this task list is retained as implementation history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Execute inline because the implementation owns one small file set.

**Goal:** Add a deterministic repository snapshot, drift check, and redacted evidence runner without modifying Git state.

**Architecture:** One Python standard-library CLI owns canonical hashing and atomic JSON writes. A focused unittest/pytest-compatible file exercises temporary Git repositories. Governance documentation defines when the tool is evidence and when human review is still required.

**Tech Stack:** Python 3, Git CLI, unittest-compatible pytest tests, Markdown.

---

### Task 1: Define behavior with failing tests

**Files:**
- Create: `tests/test_workflow_guard.py`

- [x] Add temporary-repository helpers and tests for snapshot/check/run behavior.
- [x] Run `env PYTHONPATH=src /Users/fengran/anaconda3/bin/python3 -m pytest tests/test_workflow_guard.py -q` and confirm failure because `scripts/workflow_guard.py` does not exist.

### Task 2: Implement the minimum CLI

**Files:**
- Create: `scripts/workflow_guard.py`

- [x] Implement canonical JSON hashing, Git/runtime fingerprinting, atomic JSON writes, snapshot validation, drift comparison, and redacted command evidence.
- [x] Run the focused tests and make them pass without adding dependencies.

### Task 3: Publish the project contract

**Files:**
- Create: `docs/governance/delivery-evidence.md`
- Modify: `docs/governance/skills.md`
- Modify: `tests/test_workflow_guard.py`

- [x] Document feasibility gate inputs, evidence classes, CAS checkpoints, review risk matrix, and non-automatable decisions.
- [x] Add a documentation test that verifies the governance index references the contract and executable command.

### Task 4: Verify and attack

- [x] Run focused tests, Python syntax check, `git diff --check`, and a repository smoke snapshot/check.
- [x] Ask an independent read-only reviewer to attack secret handling, fingerprint completeness, dirty-worktree behavior, exit-code semantics, and over-automation.
- [x] Fix confirmed blockers and repeat fresh verification.

### Task 5: Add the project-level automatic entry point

**Files:**
- Modify: `tests/test_workflow_guard.py`
- Modify: `scripts/workflow_guard.py`

- [x] Add a failing test proving `verify` creates a unique ignored snapshot and
  evidence manifest, runs the requested command, and reports their paths.
- [x] Add the minimal `verify` subcommand by composing the existing snapshot and
  run behavior; do not add dependencies or a second wrapper script.
- [x] Run the focused test and then the complete workflow-guard test file.

### Task 6: Bind high-risk completion to the entry point

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/governance/delivery-evidence.md`
- Modify: `docs/governance/skills.md`
- Modify: `docs/governance/doc_status.md`
- Modify: `tests/test_workflow_guard.py`

- [x] Add a failing documentation test for the high-risk trigger rule.
- [x] Add a compact root rule and detailed governance guidance without creating
  a global hook, plugin, MCP server, or skill.
- [x] Verify focused tests, Python syntax, documentation consistency, and Git
  whitespace.
