# Main Source Authority Convergence

Status: HISTORICAL COMPLETED IMPLEMENTATION PLAN (2026-08-18)

The source-authority transaction is complete. This file no longer authorizes
execution; use `docs/governance/current_runtime_status.md` and
`docs/governance/hermes_release_deployment.md` for current facts and procedure.

## Objective

Replace the split production authority
`2c8e97c + accepted dc5fcf1 companion overlay` with one reviewed `main`
source SHA while preserving Hermes v0.20, the unified capability set, personal
data, and a proven source rollback path.

This is the shared prerequisite for later production source features. It is
not a memory-only patch, Runtime replacement, Core activation, or permission
to start Gate 5.

## Current Facts

- Production checkout: `2c8e97cacd1d2eaed30738abe621f3393cffb885`.
- Main: `dc5fcf13f86483073c54ac046e1b238a90c91921` at the audit point.
- The histories diverge; production is not an ancestor of main.
- Tree delta: 244 paths, `+59623/-15594`.
- The accepted companion overlay supplies the active profile, eight MCP source
  files, and Python memory assembly without changing the checkout.
- The active mount namespace has no standalone Obsidian MCP. Host profile files
  still contain the old registration.
- The direct Ombre service on `18001` is active. `18002`, O1 recall adapter, O2
  writes, and the retired `8643` gateway are inactive.

The rollback baseline is the complete current topology, including the accepted
overlay. Bare `2c8e97c` is not a valid recovery target.

## Non-goals

- Do not add Feishu document automation or Ombre ingestion features.
- Do not activate Core A/B, create a Core production database, or dual-write.
- Do not re-enable O1/O2, `18002`, `8643`, or standalone `obsidian_memory`.
- Do not create another general release controller or another overlay.
- Do not delete the production-line ref, accepted overlay payload, or current
  recovery records before the new source rollback authority is proven.

## Candidate Rule

The candidate must be one reviewed 40-character SHA on `main` after bounded
candidate shaping. It must not be a new production-only backport line. It may
remove source surfaces directly superseded by the unified profile and fix
release/profile truth, but it must not add unrelated product scope.

Do not apply the audited `dc5fcf1` tree blindly. Candidate shaping must first
close the profile, unit, env, and overlay-absorption gaps below, then rerun the
classification against the final SHA.

## Diff Triage

The initial mechanical classification is:

| Class | Paths | Review posture |
|---|---:|---|
| Public docs and policy | 32 | Consistency review; not runtime evidence |
| Tests | 69 | Gate portability and claimed invariant coverage |
| Deletions | 12 | Confirm every deleted path is retired or replaced |
| Runtime and release | 131 | Full behavioral review |

Runtime review focuses on these loaded seams:

1. Node normal-turn path: `index`, `channelHub`, `durableOutbox`,
   `globalTimeline`, `hermesGatewayClient`, and identity projection.
2. Existing durable Node state: outbox format upgrade, event-key collision,
   delivery receipts, and rollback compatibility.
3. Hermes provider/profile: DeepSeek request shape, API-only gateway, unified
   `8642` routing, and the exact live profile digest.
4. Personal memory: strict `query`, observable source status, Vault merge, and
   direct Ombre `18001` behavior.
5. Candidate-extracted bootstrap/release/rollback authority.

Core Package A/B.1 source is not imported by the production Node entry point
and must remain inactive. O2 modules are parsed at Node startup but must remain
inert. Exact O2 source deletion is a separate bounded post-convergence task;
S1 removes live O2 env values but does not expand into that refactor.

## Profile And Unit Convergence

- The production profile must be derived from the companion capability union.
  It must not register `obsidian_memory` or direct `ombre_memory`/`18002`.
- Generic legacy Lite/Full profiles must not remain an alternate deployable
  authority. Delete or collapse them into the one companion source instead of
  preserving compatibility selection.
- The source-owned unified unit must not contain candidate-specific
  `companion-overlay` bind mounts after convergence.
- Apply acceptance must inspect both host-visible profile files and the active
  Hermes mount namespace. Checking the Git tree alone is insufficient.

## Env Consumption Audit

Keep only keys with a live consumer and one clear owner.

Keep and verify:

- `OMBRE_BRAIN_*` for the direct loopback `18001` service.
- `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS=10` for bounded `breath_search`.
- `PYTHON_BACKEND_BASE_URL` for the Python service on `8787`.
- unified Hermes URLs/profile resolving to the single `8642` gateway.
- `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=15000` at the actual MCP consumer.

Remove stale configuration that main does not consume:

- `PERSONAL_AGENT_OMBRE_BACKEND`.
- `PERSONAL_AGENT_OMBRE_MCP_URL`.
- unused `PERSONAL_AGENT_OMBRE_READ_ENABLED`, `WRITE_ENABLED`, `TIMEOUT_MS`,
  `MAX_RESULTS`, and `MAX_CHARS` knobs.
- `OBSIDIAN_MEMORY_MCP_ENABLED` after the registration is removed.
- confirm `OMBRE_RECALL_*` and `OMBRE_COMPAT_*` remain absent; remove them if
  candidate preflight finds stale live values.

The 15000 ms value belongs at the `personal_memory` MCP boundary. Prefer one
explicit per-MCP env value over parent-only systemd and multiple Home/Profile
copies. Acceptance must verify the child process or an equivalent runtime
readback; a unit-file string is not evidence.

## Transaction Design

Extend the existing candidate-extracted source release transaction with one
bounded overlay-absorption seam. Do not create a second general controller.
The current `--preserve-runtime-shape` branch is forbidden for this cutover: it
starts the retired Full and `18002` services and does not install the unified
companion profile. Candidate shaping must add one narrow unified-source branch
inside the existing transaction and leave the legacy split branch unused.

Preflight must:

1. bind the exact candidate SHA and current production SHA;
2. verify Node `>=22.19` (the server currently reports `v22.22.2`);
3. bind the exact private accepted-transaction path, candidate-extracted
   overlay controller digest, immutable overlay root, profile/MCP/Python
   digests, applied drop-ins, and active service PIDs;
4. classify the final diff and confirm no unexpected runtime path;
5. verify capacity without retaining redundant snapshots;
6. snapshot the checkout, live profiles/env files, overlay drop-ins and payload
   references, service state, exact
   `ran-agent-hermes-lite-soft-reset.timer` active/enabled state, and existing
   release authority. Retain the immutable overlay payload in place instead of
   copying it.

Apply must:

1. stop only units mechanically derived from changed loaded paths; do not
   quiesce Ombre/XHS merely because the legacy controller listed them;
2. remove the active companion bind before candidate acceptance;
3. activate the exact staged source tree;
4. install the single companion profile and converged non-secret env;
5. start dependencies and Hermes before Node, restoring the exact soft-reset
   timer state last;
6. run acceptance in the unmounted candidate namespace;
7. publish the new source recovery authority only after all checks pass.

Rollback must restore checkout, profiles, env, drop-ins, the exact accepted
overlay payload/digests, services, and timer to the complete pre-transaction
topology. It must prove that the restored namespace's eight MCP paths, profile,
and Python seam match the accepted transaction. It must preserve the original
failure as well as any rollback failure and never fall back to a bare old
profile.

## Acceptance

The exact candidate is accepted only when all of the following hold:

- checkout HEAD equals the reviewed SHA and the worktree is clean;
- Python, Hermes, Node, and direct Ombre are active under the intended identity;
- affected ports `8787`, `8791`, `8642`, and `18001` have the expected owner;
- retired `8643` and `18002` are absent; optional XHS `18061` preserves its
  exact pre-transaction state rather than becoming a cutover requirement;
- live and host profiles contain no standalone Obsidian or `18002` tool;
- no overlay bind or candidate-specific overlay unit path remains active;
- the personal-memory child resolves a 15000 ms backend deadline;
- a real `query` request returns explicit `hit|empty|transport` source status;
- the provider completes one real API request through the unified gateway;
- one ordinary channel turn preserves identity projection and delivery truth;
- existing durable outbox/timeline state opens without destructive rewrite or
  conflicting duplicate delivery;
- source apply and explicit source rollback/reapply use the same exact SHA and
  leave a current recovery authority.

Any failed invariant rolls back. A successful rollback is not acceptance. The
owner authorized the exact dry-run, source apply, source rollback and reapply
drill on 2026-08-08. That authorization does not extend to later features,
Core activation, identity changes or storage-layout changes.

## Cleanup Unlock

After source convergence, recovery proof, and documented closure of the new
source rollback window, independently audit before deleting:

- the remote P2 production-line ref and corresponding worktrees;
- exact closed companion-overlay/failed-transaction artifacts;
- the retired Obsidian tool and derived index;
- the stale root `.mcp.json` registration that points to the retired Obsidian
  launcher;
- merged local worktrees, including `ran_agent-package-b` under the owner's
  existing deletion authorization.

Remove the retired O2 source and its now-unneeded release/test consumers in a
separate exact-delete change. Do not retain a compatibility layer, but do not
mix that deletion into the source-authority transaction.

Retain the current source recovery controller, ref, receipt, and snapshot.
Retain Vault data, FastEmbed/HNSW assets, shared UV cache, and personal data.

## Core Authorization Boundary

Core Package A and B.1 remain accepted local source foundations. After B.2
local acceptance, the approved route requires semantic review and a separately
approved Schema v2 design before any B.3 source implementation. B.3b-f, B.4,
B.5, and B.6 are designed future stages, not current implementation or
production authorization. Gate 5 always requires separate owner approval.
