# Delivery Evidence

Status: CURRENT (2026-07-19)

## Purpose

High-risk work should maximize validated outcome throughput without weakening trust boundaries. Repeated full-suite runs and long prompts are not substitutes for feasibility, negative probes, or fresh Git evidence.

## Feasibility Gate

Before a large implementation contract, perform a short read-only gate and classify every required capability as `EXISTS`, `COMPOSABLE`, `MISSING`, or `UNKNOWN`.

At minimum check:

- authoritative state and public/typed write boundary;
- cold-start discovery and restart recovery;
- identity and idempotency scope;
- schema sufficiency and migration need;
- observable runtime/provider boundary;
- the three highest-impact failure paths.

`MISSING` stops implementation. `UNKNOWN` requires more evidence; it is not silently treated as failure or success.

## Automatic Project Trigger

Before a completion claim for high-risk work, run the applicable final
validation through the one-command project entry point:

```bash
python3 scripts/workflow_guard.py verify \
  --label focused-risk-tests -- python3 -m pytest tests/example.py -q
```

`verify` creates a unique snapshot/evidence pair under ignored
`local_archive/runtime/workflow-evidence/`, executes the command through the
same pre/post drift checks as `run`, revalidates the snapshot anchor afterward,
and prints a `WORKFLOW_GUARD_SUMMARY=` line containing the evidence paths.
The fixed automatic output path rejects symlinked directory components before
execution and rechecks them before writing evidence. If the command replaces
the snapshot or output directory, verification fails and an unsafe destination
receives no evidence write.
High-risk work includes deployment, migration, archive/commit/push
preparation, security, identity, idempotency, and irreversible state changes.

The printed status binds the result to the captured repository and executable,
not to a complete environment or dependency graph. Record required settings
such as `PYTHONPATH` separately without exposing secrets; identical argv can
produce different results in different environments.

This is project-instruction automation, not a host or Git hook. It activates
for new tasks and for current agents after they reread `AGENTS.md`; it is not a
mechanically enforced trigger and does not hot-load into unrelated running
tasks. It does not run on every edit or ordinary test command and does not
require a Codex restart.

The wrapped command must already be authorized and read-only. `verify` is not a
sandbox: it can detect repository or snapshot drift after execution, but it
cannot prevent a command from committing, deploying, deleting data, or causing
other side effects. It does not grant authority to commit, push, deploy,
migrate, accept risk, or perform destructive actions. Labels are stored and
printed verbatim, so use short non-sensitive public identifiers only.

Use `verify` for a final read-only validation whose baseline can be taken
immediately before the command. Use the explicit `snapshot` plus `run` flow
below when an expensive or long-running validation must remain bound to an
earlier baseline.

## Optimistic Baseline Checks

Use `scripts/workflow_guard.py` at three checkpoints:

1. before expensive validation;
2. before creating the delivery commit;
3. before advancing or pushing the integration branch.

Example:

```bash
python3 scripts/workflow_guard.py snapshot \
  --output local_archive/runtime/workflow-evidence/task-snapshot.json

python3 scripts/workflow_guard.py check \
  --snapshot local_archive/runtime/workflow-evidence/task-snapshot.json
```

This is optimistic compare-and-swap evidence, not a long-lived lock. Drift stops the current step and prints facts; it never merges, rebases, resets, stashes, or repairs automatically. `origin/main` is only the local remote-tracking ref unless a separately authorized fetch refreshed it.

Repository-local snapshot and evidence paths must already be ignored by Git.
Snapshots refuse accidental overwrite; `--force` is reserved for an explicit
new baseline, not for hiding drift.

## Evidence Manifest

Run a validation command against an exact snapshot:

```bash
python3 scripts/workflow_guard.py run \
  --snapshot local_archive/runtime/workflow-evidence/task-snapshot.json \
  --evidence local_archive/runtime/workflow-evidence/task-evidence.json \
  --label targeted-risk-tests -- python3 -m pytest tests/example.py -q
```

The evidence stores a command hash, resolved executable path/hash, unique label,
exit code, timestamps, and pre/post drift results. Writes to one manifest are
serialized. It intentionally omits command arguments, environment values,
stdout, stderr, and source contents.

This is a local consistency record, not tamper-evident proof. Its checksum can
detect accidental modification but can be recomputed by an actor who can
rewrite the file. Do not put secrets in command arguments: a deterministic
hash can confirm guesses for low-entropy values, and command stdout/stderr is
still visible in the calling terminal. Network results, dependencies, and
environment-sensitive commands are not reusable unless separately bound and
reviewed. Evidence reuse also requires human confirmation that the recorded
runtime and locally available refs are fresh enough for the risk.

Use a direct executable path for reusable evidence. A wrapper such as `env`,
`sh`, or `bash -c` binds the wrapper file and argv, not every executable or
dependency it may launch.

## Adversarial Acceptance

Full-suite green proves regression coverage, not contract closure. For each applicable category, the independent reviewer constructs at least one negative probe:

- identity/scope;
- exact replay/idempotency;
- terminal/completed state;
- partial failure continuation;
- evidence/provenance binding;
- cold-start/restart recovery.

Every blocker needs a stable ID, violated invariant, minimal reproduction, and closure evidence. Two repeated failures in the same invariant family trigger contract/state-machine reconsideration instead of another local patch.

## Evidence Classes

Record conclusions as `STATIC`, `TESTED`, `USER_SUPPLIED_RUNTIME`, or `SERVER_UNKNOWN`, followed by `observation → inference → decision`.

## Human-Only Decisions

Do not automate owner acceptance, risk waivers, migration choice, divergent-history integration strategy, push/deploy authorization, production cutover, or deletion of superseded evidence.

## Capability Boundary

This workflow is currently a project script, project instruction, and
governance contract. Do not add a plugin, MCP server, global hook, or new skill
until repeated real-task failures demonstrate that the existing project entry
scan and independent review behavior are insufficient.
