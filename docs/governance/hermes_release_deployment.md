# Hermes Immutable Source Release

Status: CURRENT (2026-08-18)

This document defines the current source-release transaction. Operator commands
live in `server_runtime_commands.md`. Runtime-only v0.20 cutover, v0.13 split
rollback, S12 cutover, and earlier overlay attempts are completed historical
transactions and are not reusable mutation paths.

## Invariants

1. One reviewed immutable Git commit is the complete source authority.
2. Archive/push and adversarial review complete before production apply.
3. Production starts clean and advances only through the repo-managed
   transaction; no `git pull`, checkout switching, or manual file copy.
4. Source, profile, dependencies, env ownership, snapshot, service state, and
   acceptance are one rollback-capable transaction.
5. Personal data, databases, vault content, credentials, logs, caches, and
   runtime state are never candidate payloads.
6. Existing `ubuntu` service identity, ownership, permission, and storage
   boundaries remain unchanged unless separately authorized.
7. A dry-run or VERIFY result is evidence only; it never authorizes APPLY.

## Entry Points

After activating `/opt/ran_agent/.venv`, use one of:

```bash
# Exact reviewed commit (preferred explicit form)
bash scripts/deploy-hermes-candidate.sh \
  --commit <reviewed-40-char-main-sha> --dry-run

# Reviewed current origin/main; the script resolves and pins its exact SHA
bash scripts/deploy-hermes-main.sh --dry-run
```

A separately authorized apply repeats the same entrypoint with `--apply`.
Candidate branch mode exists for reviewed branch delivery but is not the
default production instruction. The resolved commit must satisfy the accepted
source-pointer and main-line ancestry rules enforced by the controller.

The wrapper extracts `scripts/bootstrap-hermes-release.sh` from the candidate
itself and enters the common transaction. The ambient worktree copy is never
the controller for a different candidate.

## Preflight And Gate

Before mutation the transaction proves:

- caller input resolves to one commit and source provenance is allowed;
- local and production worktrees have no unauthorized drift;
- candidate source contains the governed manifests, profile, controller, and
  verification surfaces;
- release capacity covers snapshot, stage, dependency, and safety headroom;
- service identities and protected paths match the approved architecture;
- the immutable candidate passes its required Node/Python/shell checks;
- the release controller and subordinate commands are candidate-bound.

The immutable release gate runs from a Git-less, read-only candidate copy with
an empty inherited environment. It verifies both root control-plane behavior
and the validated non-root runtime identity. Scratch writes stay below explicit
temporary/runtime roots. The gate must not depend on `.git`, developer paths,
interactive `PATH`, ambient env, or same-user permission fixtures.

Fault injection and shell harnesses must prove the intended command actually
ran and preserve its failure status. Identity-sensitive fixtures establish
owner/group/mode explicitly. Local desktop success alone is insufficient for a
release-gate change; the staged Linux/root/non-root regression remains required.

## Snapshot And Capacity

The transaction snapshots only the state required to restore its own source
mutation: accepted source pointer, governed checkout paths, active profile/env
surfaces, dependency swap metadata, and service configuration owned by the
release. It does not copy personal databases or durable delivery state merely
to create another backup.

Capacity checks use allocated blocks and inode headroom over the complete
snapshot source set plus candidate stage/dependency reserve. The repo-managed
pruner may remove only artifacts covered by its retention policy while holding
the global release lock. Operators must not delete release/snapshot directories
manually to satisfy a preflight.

## Apply Sequence

The current source transaction performs, in order:

1. acquire the cross-identity release lock;
2. revalidate candidate, accepted source pointer, and clean state;
3. build and verify the immutable stage;
4. create and seal the rollback snapshot;
5. quiesce affected services;
6. project candidate source with tracked Git modes and checkout ownership;
7. reuse `node_modules` when package blobs are unchanged, otherwise perform the
   governed staged dependency swap;
8. activate `hermes/profile/config.companion.yaml` and required source/profile
   migrations;
9. refresh current identity/activity projection;
10. restart the existing services;
11. run post-start acceptance;
12. publish the accepted source pointer and transaction record.

The active companion profile remains least-privilege. A profile change must
carry its separately reviewed migration manifest and exact allowed delta. The
legacy `config.yaml` and inert Pro template are not alternate active profiles.

## Configuration Preservation

Candidate code must preserve local credentials and operator configuration.
Optional managed values use the release's existing env-preservation rules;
canonical safety/routing keys may be deliberately replaced. Every new managed
key belongs in `is_managed_env_key`, all required EnvironmentFiles, focused
diagnostics, and public runbook documentation.

The transaction must never print secret values. Logs and evidence use only
variable names, sanitized flags, digests, counts, semantic identities, and
privacy-safe route fingerprints.

## Rollback And Recovery

Before source acceptance, a failed apply automatically restores the exact
snapshot and restarts the prior service topology. A manual rollback, when the
transaction still authorizes one, must use the same candidate-extracted
controller and exact snapshot printed by apply. Do not improvise with Git or
copy files from another worktree.

Once a source transaction closes an older rollback window, its controller,
artifact, ref, and snapshot are evidence-only. Runtime-only rollback is already
closed. Forward recovery after a committed cutover marker must follow the
controller's durable journal; an older root-side journal cannot override a
newer committed Core/source marker.

## Acceptance And Evidence

Post-start acceptance is bounded to the candidate's changed invariants and the
shared seams they can weaken. It normally proves:

- Python, Node, unified Hermes, and required internal services are active;
- retired Full, O2/`18002`, account-backed XHS, and second-runtime paths remain
  inactive or absent;
- the live process executable, cwd, identity, profile, and environment names
  match the accepted contract;
- provider and MCP boundaries respond without exposing secrets;
- source pointer and rollback metadata agree with the completed transaction.

High-risk final claims use `scripts/workflow_guard.py` around a separately
authorized read-only acceptance command. Evidence records do not expand the
authorization of the wrapped command.

## Prohibited Shortcuts

- floating branch apply without exact resolution;
- deploy from a dirty worktree;
- manual `git pull`, checkout, rsync, systemd, env, ownership, or permission
  repair;
- standalone `apply-hermes-runtime-split.sh`;
- invoking the closed Runtime rollback or S12 canary again;
- restoring retired OpenClaw/Kimi/GLM/MiMo, O2/`18002`, Python `/chat`,
  account-backed XHS, or Hermes work-action executors;
- staging secrets, local archives, private vault content, runtime state, or
  logs.

Completed release lineage remains available in Git history, the historical
S12 ledger, `cleanup.md`, and ignored transaction records. It must not be copied
back into this current operator contract.
