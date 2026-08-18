# Documentation Status

Status: CURRENT (2026-08-18)

This file is the public documentation index and conflict rule. Current runtime
facts live in `docs/governance/current_runtime_status.md`; historical deployment
journals belong in ignored `local_archive/` or the focused phase record. Active
S-stage order and completion state live in
`docs/governance/active_sequence.md`; the detailed S12 R-node topology,
acceptance checklists and review handoff live in
`docs/governance/s12-readiness-topology.md`.

## Current State

The repaired post-S12 source is applied in production; Packages A-E are
complete and `core-cutover:v1`
remains at `e298bab161bf0f4882bcef6e9cd701d546b63ff2`. Runtime rollback is
closed, retired v0.13 payloads are deleted, `18002` and O2 are absent, and the
direct loopback Ombre service on `18001` remains active. The post-S12
capability-parity and product-effect repairs are live: verified Feishu Calendar
creation, replay-safe Todo registration and managed wake are restored, F6a/F6b
delivery guards are deployed, and the Minutes strict replan is production
verified. The owner superseded F6OBS by assigning daily reports to Codex and
explicitly reordered the Hermes transformation ahead of S13. H0-H5 are
`PROD_VERIFIED`: the digest is stopped, external MCP is default-available behind
its existing gates, Ombre projection and bounded companionship are composed,
and the retired Python chat graph is absent. The Package B
presentation-binding namespace repair is already contained in current `main`;
no separate Package B work remains. S13 is `NOT STARTED` and its
deletion scope is not authorized. A post-H5 source projection refresh repair
is `PROD_VERIFIED`: it removes the whole-SQLite-byte digest
dependency while preserving same-revision projected-data conflicts and the
existing root-controller/ubuntu-runtime identity boundary. The H0-H5 contract lives in
`docs/governance/hermes-playground-boundary.md`. S-stage exit conditions and
S12 R-node detail are canonical in `active_sequence.md` and
`s12-readiness-topology.md`; historical narratives live in `phase_status.md`.
The 2026-08-17 owner-authorized cleanup removed dead code, stale docs and
local artifacts; every deletion is recorded in `docs/governance/cleanup.md`.
The post-H5 Qwen-MM Token Plan stage is `LOCAL_VERIFIED` and `IN_PROGRESS`:
the source candidate keeps one `media_reader` facade, uses `qwen3.6-flash` for
optional OCR/VLM and knowledge maintenance, and leaves ASR on DashScope. It is
not yet archived, deployed or activated with the owner's key.

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
| `hermes/profile/AGENTS.md` | Initial sealed-runtime profile reference; current source-advance product boundary is `hermes-playground-boundary.md` |
| `hermes/profile/config.companion.yaml` | Deployed unified companion source profile |
| `docs/governance/doc_status.md` | Documentation index and conflict rule |
| `docs/governance/active_sequence.md` | Canonical S-stage order, current stage and exit conditions |
| `docs/governance/current_runtime_status.md` | Compact current runtime truth |
| `docs/governance/r1d_dependency_compatibility.v1.json` | R1D dependency surfaces, compatibility evidence, rollback and S12 dispositions |
| `docs/governance/r2_fresh_production_copy_rehearsal.v1.json` | Redacted R2-A fresh production aggregates, R2-B copy-only rehearsal evidence and separately attributed XHS public-only recovery |
| `docs/governance/core_schedule_migration.v1.json` | S10 legacy scheduling disposition and paused-import policy manifest |
| `docs/governance/core_managed_wake.v1.json` | Disabled-by-default Hermes `core-wake` projection contract |
| `docs/governance/core_system_schedules.v1.json` | S12 replacement system ScheduleSpec manifest |
| `docs/governance/hermes-core-foundation.md` | Package A boundary and frozen Schema v1 |
| `docs/governance/hermes-core-scheduling-and-unified-runtime.md` | Schema v2 scheduling and unified-runtime target |
| `docs/governance/s12-readiness-topology.md` | Canonical S12 R-node dependency topology, acceptance ledger and reviewer handoff |
| `docs/governance/post-s12-product-effect-repair.md` | Completed post-S12 recovery record and owner-approved F6 delivery-guard frontier |
| `docs/governance/hermes-playground-boundary.md` | Hermes playground demotion boundary contract and T0-T6 stage plan |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/hermes_release_deployment.md` | Immutable-SHA deployment and rollback contract |
| `docs/governance/phase_status.md` | Historical phase closure status |
| `docs/governance/constraints.md` | Runtime and implementation constraints |
| `docs/governance/co-reading.md` | Co-reading storage, MCP, privacy and API contract |
| `docs/governance/co-reading-web-reader.md` | Tailscale-only co-reading Web reader contract |
| `docs/governance/skills.md` | On-demand skill map |
| `docs/governance/delivery-evidence.md` | Delivery evidence and adversarial acceptance |
| `docs/governance/agent-capability-governance.md` | Skill, hook, plugin and MCP governance |
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
| `docs/governance/hermes_source_profile_migration.v1.json` | Candidate-bound post-S1 companion profile migration contract: prior source, exact profile digest, allowed delta, destinations and rollback authority |
| `docs/governance/hermes-context-optimization.md` | Context optimization, cache and soft-reset contract |
| `docs/governance/external-mcp-gateway.md` | External MCP admission and system queue |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat media buffering semantics |
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
