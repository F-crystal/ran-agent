# Documentation Status

Status: CURRENT (2026-08-18)

This is the documentation index and conflict rule. It classifies every tracked
Markdown document without turning a second document into runtime authority.

## Conflict Rule

1. Fresh code, configuration, tests, and bounded production evidence are first
   truth for their own scope.
2. `current_runtime_status.md` owns current production facts;
   `active_sequence.md` owns unfinished stage order.
3. The focused current contract for a subsystem owns its public behavior.
4. Executable prompts and skills govern only the runtime or agent that loads
   them; they do not override system permissions or production evidence.
5. Implemented references, historical plans, acceptance ledgers, Git history,
   and ignored archives explain lineage only.

Unchecked historical tasks are not authorization. A historical design never
becomes current merely because some of its code landed.

## Tracked Markdown Inventory

The 2026-08-18 audit covered all 103 tracked Markdown files:

| Scope | Count | Classification |
|---|---:|---|
| repository root | 8 | policy, shims, persona, license, and bilingual overview |
| `docs/` | 42 | 26 governance documents plus 16 historical plans/specs |
| `hermes/` | 19 | bilingual overview, active profile prompts/shims, and 9 profile skills |
| `skills/` | 22 | executable project skills, their security policy, and imported references/templates |
| `src/` | 1 | dormant daily-digest prompt retained with disabled compatibility code |
| `vault/` | 11 | vault policy/shims, 3 Qwen task prompts, and 5 note templates |

The inventory boundary is `git ls-files '*.md'`. Ignored `local_archive/`,
runtime state, dependencies, caches, logs, and personal vault content are not
public documentation and were not rewritten.

## Current Public Authorities

| Document | Owns |
|---|---|
| `README.md`, `README_en.md` | user-facing project overview |
| `AGENTS.md` | repository operating policy |
| `docs/governance/doc_status.md` | this index and conflict rule |
| `docs/governance/current_runtime_status.md` | compact production truth |
| `docs/governance/active_sequence.md` | canonical unfinished-work frontier |
| `docs/governance/constraints.md` | stable runtime and implementation limits |
| `docs/governance/server_runtime_commands.md` | current server operator commands |
| `docs/governance/hermes_release_deployment.md` | immutable source-release transaction |
| `docs/governance/delivery-evidence.md` | workflow evidence and adversarial acceptance |
| `docs/governance/agent-capability-governance.md` | skills, hooks, plugins, MCP, and instruction governance |
| `docs/governance/skills.md` | on-demand project skill map |
| `docs/governance/cleanup.md` | deletion, retirement, retention, and env-hygiene record |
| `docs/governance/hermes-playground-boundary.md` | conversation/companionship/play product boundary |
| `docs/governance/hermes-action-contract-gate.md` | memory action validation and work-action exclusion |
| `docs/governance/hermes-context-optimization.md` | continuity, cache, and soft-reset contract |
| `docs/governance/external-mcp-gateway.md` | external MCP admission, activity, evidence, and system queue |
| `docs/governance/co-reading.md` | co-reading import, storage, privacy, and MCP contract |
| `docs/governance/co-reading-web-reader.md` | private Tailscale Web reader contract |
| `docs/governance/media-pipeline.md` | media analysis/generation and Qwen-MM routing |
| `docs/governance/sticker-catalog.md` | sticker catalog and safe media-marker contract |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat inbound media buffering |
| `docs/governance/multi_frontend_identity_strategy.md` | frontend identity, session, and timeline semantics |
| `docs/governance/prompt-slimming-audit.md` | prompt ownership and duplication limits |
| `hermes/README.md`, `hermes/README_en.md` | distributed Hermes profile overview |
| `hermes/profile/HERMES_RUNTIME.md` | concise profile-facing runtime facts |
| `vault/AGENTS.md` | current knowledge-management contract |

Machine-readable governance manifests under `docs/governance/*.json` remain
evidence/data contracts. Their existence does not make them Markdown authority.

## Implemented And Historical Records

These documents are retained, but do not control current execution:

- `docs/governance/hermes-core-foundation.md` — implemented Schema v1/v2 and
  Packages A-E foundation reference;
- `docs/governance/hermes-core-scheduling-and-unified-runtime.md` — implemented
  architecture and historical cutover detail;
- `docs/governance/s12-readiness-topology.md` — completed acceptance ledger;
- `docs/governance/post-s12-product-effect-repair.md` — completed repair record;
- `docs/governance/phase_status.md` — historical phase index;
- every `docs/superpowers/plans/*.md` and `docs/superpowers/specs/*.md` —
  historical, implemented, partially implemented, or superseded as labeled in
  each file.

## Executable Prompts, Skills, Personas, And Shims

These are audited as runtime inputs and intentionally do not all carry a
`Status:` header:

- root `IDENTITY.md` and `SOUL.md`, plus `hermes/profile/IDENTITY.md`,
  `SOUL.md`, `HERMES_MEMORY.md`, and `HERMES_USER.md` — persona/user contracts;
- `hermes/profile/AGENTS.md` — active Hermes tool and behavior boundary;
- `hermes/profile/skills/*/SKILL.md` — on-demand Hermes skills;
- `skills/*/SKILL.md` and `skills/SECURITY.md` — project agent procedures;
- `vault/.qwen/tasks/*.md` and `vault/templates/*.md` — Qwen task prompts and
  note templates governed by `vault/AGENTS.md`;
- `src/personal_agent/prompts/ai_daily_digest_report.md` — retained dormant
  compatibility prompt; production digest is disabled;
- root, Hermes-profile, and Vault `CLAUDE.md`/`GEMINI.md` files — minimal imports
  of the nearest canonical `AGENTS.md`;
- `LICENSE.md`, `skills/aihot/**`, and
  `skills/code-simplifier/references/**` — license, imported workflow material,
  examples, and templates rather than current runtime status.

## Maintenance Rules

- Keep `current_runtime_status.md` factual and compact; commands belong in the
  runbook, contracts in focused documents, and lineage in historical ledgers.
- Date a current governance document when its behavior or classification
  changes. Label completed plans historical or superseded.
- Keep bilingual README claims aligned.
- Never put credentials, cookies, raw identities, private memory, runtime state,
  logs, caches, or ignored archive content in public docs.
- Re-run the tracked inventory, local-link check, stale-authority search, and
  relevant source tests before archive.
