# Workflow Evidence Gate Design

Status: IMPLEMENTED / HISTORICAL DESIGN (2026-08-18)

Use `docs/governance/delivery-evidence.md` for the current operational contract.

## Goal

Reduce repeated prompt boilerplate and stale validation without weakening high-risk review. The first implementation is a repository-local, standard-library tool that fingerprints the exact Git worktree, detects baseline drift, and records redacted command evidence.

## Scope

Create `scripts/workflow_guard.py` with four commands:

- `snapshot`: record repository identity, branch, HEAD, `origin/main`, separate index/worktree diff hashes, untracked file hashes, and runtime fingerprints.
- `check`: compare the current repository with a prior snapshot and fail closed on drift.
- `run`: require a clean comparison, execute one argv command, compare again, and append a redacted result to an evidence manifest.
- `verify`: create a unique ignored snapshot/evidence pair and run one argv
  validation command, so agents have a single high-risk completion entry point.

The manifest stores a command hash, executable fingerprint, unique label,
timestamps, exit status, and drift summaries. It never stores command
arguments, environment values, stdout, stderr, credentials, or source
contents.

## Boundaries

- Standard library only; no plugin, MCP, daemon, global hook, or global skill.
- No Git mutation, stash, reset, merge, rebase, commit, push, deployment, or remote fetch.
- `origin/main` means the locally available remote-tracking ref; the tool does not claim it is network-fresh.
- Drift is reported, never repaired automatically.
- Output inside the repository must be ignored by Git; existing snapshots are
  not overwritten unless `--force` is explicit.
- The automatic output directory must remain inside the repository and contain
  no symlink components before or after command execution. A wrapped command
  that deletes, rewrites, or symlink-replaces its snapshot anchor fails with
  evidence-anchor drift; output-boundary drift suppresses the evidence write.
- Evidence does not replace owner acceptance or adversarial review.
- Existing `archive_and_push.sh` and `archive-and-push/SKILL.md` remain untouched because another worktree owns their active remediation.
- Automation is project-instruction driven. It does not install an operating
  system, Git, Codex, or other host-level hook, and it does not broaden
  authority to commit, push, deploy, migrate, or accept risk.

## Data Model

Snapshot schema v1 contains:

- repository realpath and UTC creation time;
- branch, HEAD, local `refs/remotes/origin/main` when present;
- separate SHA-256 values for the index diff and worktree diff, so staged and
  unstaged changes cannot cancel each other;
- sorted untracked path, byte size, and SHA-256 records;
- Python and Node executable/version fingerprints;
- checksum over the canonical snapshot payload.

Evidence schema v1 is a locked local consistency record containing the snapshot checksum and uniquely labelled command results: argv hash, resolved executable hash, timestamps, exit code, status, and pre/post drift summaries. Its checksum detects accidental or unsophisticated modification; it is not a signature and cannot prove authenticity against an actor able to rewrite the file and recompute the checksum.

## Exit Codes

- `0`: snapshot/check succeeded, or command passed without drift.
- `2`: invalid input or malformed evidence.
- `3`: repository differs before command execution; command is not run.
- `4`: command completed but changed the repository fingerprint, regardless of
  the command's own exit code.
- `5`: command failed without repository drift; the original code is stored in
  the manifest.

## Verification

Tests must prove exact snapshot verification, tracked/untracked/origin drift detection, pre-drift refusal, redacted evidence, command-failure recording, and post-command drift detection. Documentation tests must ensure the governance map points to the executable contract.

## Deferred

Do not add feasibility or acceptance skills yet. Two no-skill pressure baselines already produced the desired behavior, so creating new skills would currently duplicate existing reasoning. Reconsider only after observed failures in real tasks.

## Project Trigger Automation

`AGENTS.md` requires `verify` before a completion claim for deployment,
migration, archive/commit/push preparation, security/identity/idempotency
changes, or irreversible state changes. The command creates uniquely named
files under ignored `local_archive/runtime/workflow-evidence/`, then delegates
to the same pre/post comparison and evidence logic as `run`.

Ordinary edit-test loops remain unchanged. Long-running validations that need
an earlier optimistic baseline continue to use explicit `snapshot` plus `run`.

## Adversarial Review

The first independent review rejected the implementation for index/worktree
cancellation, subdirectory leakage, concurrent manifest loss, weak local
integrity checks, exit-code ambiguity, and incorrect executable binding. Tests
were added before each correction. A closure review then found one remaining
relative-path executable bug; its regression test failed before the fix and
passed afterward.

The automatic-entry extension was independently rejected twice: first because
a command could delete its snapshot or escape through an ignored directory
symlink, then because a same-content snapshot symlink and an in-flight parent
directory swap still bypassed the initial checks. Failing probes drove regular
file checks, post-command anchor validation, repeated output-boundary checks,
and suppression of unsafe evidence writes. The final independent verdict was
`APPROVE`.

Residual boundaries are explicit: checksums are not signatures, refs are not
network-fresh, arbitrary dependency state is not fully captured, and one
manifest serializes its command runs. These limits prevent evidence reuse when
the task requires stronger provenance.
