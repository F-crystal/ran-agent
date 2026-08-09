# Documentation Status

Status: CURRENT (2026-08-09)

This file is the public documentation index and conflict rule. Current runtime
facts live in `docs/governance/current_runtime_status.md`; historical deployment
journals belong in ignored `local_archive/` or the focused phase record. Active
S-stage order and completion state live in
`docs/governance/active_sequence.md`; the detailed S12 R-node topology,
acceptance checklists and review handoff live in
`docs/governance/s12-readiness-topology.md`.

## Current State

The clean production checkout and accepted source pointer are at S4 runtime
source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`; it remains an ancestor of
GitHub `main`. Hermes v0.20 is
`PROD_VERIFIED` for the bounded evidence in `current_runtime_status.md`.
Runtime rollback is closed, retired v0.13 payloads are deleted, `18002` and O2
are absent, and the direct loopback Ombre service on `18001` remains active.
The earlier companion overlay is rollback-only evidence.

S2 adds one production-verified typed action for an existing
Feishu Minutes transcript: `feishu.minutes_to_doc`. It uses the authenticated
user to resolve one transcript and one destination folder, creates one cloud
document, and requires readback before a success receipt. It does not add ASR,
PPT handling, polling or a general workflow framework. Its source controller
also extends the existing S1 transaction to exact archived `main` descendants
while retaining the prior source pointer as rollback authority. Production
accepted a normalized action canary without replaying the executor against the
already-created document.

S3 is production verified for its bounded value chain. Hermes proposes the
identifier and content, Node validates their class and format, and Python owns
persistence and recall. An existing active fact produced
`personal_learning=hit` through `personal_memory`, while the independent
read-only Ombre outcome remained observable. S4 is complete: production no
longer contains the inactive O2 implementation or its dedicated
Steward/token/model/gate seams, direct Ombre on `18001` remains active, and old
worktrees/branches were closed after recoverable snapshots. S5 is locally
verified: one B.2 typed transaction/outbox/effect/receipt loop replays after
reopen without a duplicate effect and remains disconnected from production.
S6 then converged the root worktree, triaged its 33 status entries, reimplemented
the three retained runtime semantics on current `main`, and synchronized the
S6-S13 topology. S7 Node-to-Core local wiring is locally verified through its
typed adapter receipt and does not change production. S8 is locally verified:
the owner-authorized internal projector binds content to confirmed Core payload
hashes, recovers lost Ombre responses without duplicate growth, and supports
scope erasure/rebuild while the public recall surface remains read-only. It is
not composed into production. S9 Package C scheduling is locally verified:
Schema v2, deterministic occurrences and the injected managed tick remain
disconnected from production. S10 is locally verified with the governed
19-component migration manifest, a zero-effect production-copy rehearsal and a
Core-fact-only external-poll seam. S11 synthetic acceptance is locally verified
after owner-audit remediation; S12 remains not started and production is unchanged.
Unarchived S12-R1 readiness code now covers the cutover transaction/command,
managed wake projection, WorkRun execution and terminal evidence, typed
scheduled delivery, retained Python maintenance, and replay-safe Core reminder
registration plus projection acknowledgement. It is not a deployable candidate:
the early local external-MCP WorkRun composition still awaits its serial R1E
authority/replay/no-direct-send acceptance, and a real presence source still
needs to own attention admission/flush. The ordered R1 frontier now first repairs the
observed web-tool route and adds the smallest effect-oriented Feishu document
write/replan seam, takes a bounded dependency compatibility decision, then
closes the external-MCP and real-presence runtime boundaries. This does not
start S12 or authorize production. R1B is locally verified: the companion
candidate has one generic Web surface (`mcp-search_hub`), the DLM-shaped handler
check returned typed research evidence, and the affected Node/Python sets pass
62/62 and 43/43. R1B.1 also locally closes the reproduced provider-origin
`schemaVersion: "v1"` raw-envelope leak; its affected set passes 259/259. The
project-local Python entrypoint is also fixed at ignored `.venv`, while
production still requires an explicit absolute runtime. The bounded candidate
archive is next, followed by an independent exact-SHA review; R1C starts only
after that review.

## Lifecycle Stages

Stages describe one exact artifact and scope, not permanent quality scores.

| Stage | Meaning |
|---|---|
| `DESIGNED` | An approved contract or design exists; no implementation claim. |
| `IMPLEMENTED` | Code exists for the named scope; no validation or deployment claim. |
| `LOCAL_VERIFIED` | Required isolated/local acceptance passed for that exact artifact. |
| `ARCHIVED` | The exact artifact was committed and pushed; this is not deployment approval. |
| `DEPLOYED` | The production mutation completed; no post-deploy acceptance claim. |
| `PROD_VERIFIED` | Bounded production acceptance passed for the named dimensions and time window. |

## Public Source Of Truth

| Document | Ownership |
|---|---|
| `README.md` / `README_en.md` | User-facing project overview |
| `hermes/README.md` / `hermes/README_en.md` | Hermes profile distribution overview |
| `AGENTS.md` | Repo-root operating rules |
| `CLAUDE.md` | Claude shim pointing to canonical `AGENTS.md` |
| `hermes/profile/AGENTS.md` | Hermes profile runtime constraints |
| `hermes/profile/config.companion.yaml` | Deployed unified companion source profile |
| `docs/governance/doc_status.md` | Documentation index and conflict rule |
| `docs/governance/active_sequence.md` | Canonical S-stage order, current stage and exit conditions |
| `docs/governance/current_runtime_status.md` | Compact current runtime truth |
| `docs/governance/core_schedule_migration.v1.json` | S10 legacy scheduling disposition and paused-import policy manifest |
| `docs/governance/core_managed_wake.v1.json` | Disabled-by-default Hermes `core-wake` projection contract |
| `docs/governance/core_system_schedules.v1.json` | S12 replacement system ScheduleSpec manifest |
| `docs/governance/hermes-core-foundation.md` | Package A boundary and frozen Schema v1 |
| `docs/governance/hermes-core-scheduling-and-unified-runtime.md` | Schema v2 scheduling and unified-runtime target |
| `docs/governance/s12-readiness-topology.md` | Canonical S12 R-node dependency topology, acceptance ledger and reviewer handoff |
| `docs/governance/s12-r1b-web-routing.md` | Current R1B Web capability assembly task and acceptance boundary |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/hermes_release_deployment.md` | Immutable-SHA deployment and rollback contract |
| `docs/governance/hermes_release_bootstrap.v1.sha256` | Bootstrap source-digest manifest |
| `docs/governance/phase_status.md` | Historical phase closure status |
| `docs/governance/constraints.md` | Runtime and implementation constraints |
| `docs/governance/co-reading.md` | Co-reading storage, MCP, privacy and API contract |
| `docs/governance/co-reading-web-reader.md` | Tailscale-only co-reading Web reader contract |
| `docs/governance/skills.md` | On-demand skill map |
| `docs/governance/delivery-evidence.md` | Delivery evidence and adversarial acceptance |
| `docs/governance/agent-capability-governance.md` | Skill, hook, plugin and MCP governance |
| `docs/governance/sub_agents.md` | Sub-agent candidate policy |
| `docs/governance/cleanup.md` | Retired/deleted component record |
| `docs/governance/media-pipeline.md` | Media pipeline and context policy |
| `docs/governance/sticker-catalog.md` | Sticker catalog and safe `RAN_MEDIA` contract |
| `docs/governance/hermes-action-contract-gate.md` | Action validation, repair and pending-action rules |
| `docs/governance/hermes_action_compatibility.v1.json` | Closed protected-signal registry |
| `docs/governance/hermes_protected_capabilities.v1.json` | Historical split-profile capability digest; not rollback authority |
| `docs/governance/hermes_runtime_artifact.v1.json` | Immutable LOCAL_BUILT v0.20 provenance |
| `docs/governance/hermes_runtime_linux_verification.v1.json` | LOCAL_VERIFIED Linux artifact/profile evidence |
| `docs/governance/hermes_runtime_mutation.v1.json` | Deployed v0.20 mutation evidence; bounded production verification is recorded in current runtime status; retained snapshot is evidence-only |
| `docs/governance/hermes_companion_overlay.v1.json` | Exact production baseline and companion source/profile/Python-memory overlay contract; current acceptance truth remains in the runtime status and private transaction record |
| `docs/governance/hermes-context-optimization.md` | Context optimization, cache and soft-reset contract |
| `docs/governance/external-mcp-gateway.md` | External MCP admission and system queue |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat media buffering semantics |
| `docs/governance/mimo-power-mcp.md` | Retired MiMo Power MCP record |
| `docs/governance/multi_frontend_identity_strategy.md` | Multi-frontend identity and timeline |
| `docs/governance/prompt-slimming-audit.md` | Prompt slimming ownership audit |

## Conflict Rule

1. Runtime behavior and fresh evidence are first truth.
2. Then the public source-of-truth documents above.
3. Local archives and Git history are context only.

The Core and External MCP design documents remain target architectures even
where individual components landed. Do not read unchecked plans as deployment
claims. Historical release lineage never overrides `current_runtime_status.md`.

## Governance Rules

- Keep `AGENTS.md` self-contained and `CLAUDE.md` as its shim.
- Keep `current_runtime_status.md` compact; commands belong in the runbook,
  contracts in focused documents, and historical detail in `phase_status.md`.
- Keep the runbook script-first; do not add one-off repair logs.
- Keep governance documents in English and update their `CURRENT` date when
  behavior or status changes.
- Keep secrets, runtime state, private data, logs, debug output and local
  archives out of Git.
- Reconcile documentation before archive, then use
  `skills/archive-and-push/SKILL.md` for GitHub synchronization.
