# Documentation Status

Status: CURRENT (2026-07-01)

This file is the public documentation index and conflict rule. Historical
deployment notes belong under ignored `local_archive/`, not under
`docs/governance/`.

## Public Source Of Truth

| Document | Ownership |
|----------|-----------|
| `README.md` / `README_en.md` | User-facing project overview |
| `hermes/README.md` / `hermes/README_en.md` | Hermes profile distribution overview |
| `AGENTS.md` | Repo-root operating rules |
| `CLAUDE.md` | Claude shim that points to canonical `AGENTS.md` |
| `hermes/profile/AGENTS.md` | Hermes profile runtime constraints |
| `docs/governance/doc_status.md` | Documentation index and conflict rule |
| `docs/governance/current_runtime_status.md` | Compact current runtime truth |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/phase_status.md` | Historical phase closure status |
| `docs/governance/constraints.md` | Runtime and implementation constraints |
| `docs/governance/co-reading.md` | Co Reading storage, import, MCP, privacy, and API contract |
| `docs/governance/co-reading-web-reader.md` | Tailscale-only Co Reading Web reader deployment and acceptance |
| `docs/governance/skills.md` | On-demand skill map |
| `docs/governance/agent-capability-governance.md` | Shared agent skill, hook, plugin, and MCP governance |
| `docs/governance/sub_agents.md` | Sub-agent candidate policy |
| `docs/governance/cleanup.md` | Retired/deleted component record |
| `docs/governance/media-pipeline.md` | Media pipeline and context policy |
| `docs/governance/sticker-catalog.md` | Cross-channel sticker catalog and safe `RAN_MEDIA` contract |
| `docs/governance/hermes-action-contract-gate.md` | Hermes action contract validation, repair, and pending-action rules |
| `docs/governance/hermes-context-optimization.md` | Hermes context optimization, cache-friendly history, and soft reset |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat media buffering semantics |
| `docs/governance/mimo-power-mcp.md` | Retired MiMo Power MCP record |
| `docs/governance/multi_frontend_identity_strategy.md` | Multi-frontend identity and timeline |
| `docs/governance/prompt-slimming-audit.md` | Prompt slimming ownership audit |

## Conflict Rule

1. Runtime code behavior is first truth.
2. Then the public source-of-truth docs listed above.
3. Local archives are context only and are not part of the public release
   surface.

## Governance Rules

- Keep `AGENTS.md` light and self-contained. Keep `CLAUDE.md` as a shim to
  `AGENTS.md`. Detailed runtime facts belong in `docs/governance/` or skills.
- Keep `docs/governance/current_runtime_status.md` compact; move commands to
  `server_runtime_commands.md` and historical detail to `phase_status.md`.
- Keep `server_runtime_commands.md` script-first. Do not add one-off pasteable
  repair logs.
- Keep governance docs in English. README files may be Chinese/English pairs.
- Keep runtime state, private vault content, logs, databases, debug outputs,
  env files, and local archive material out of Git.
- Completed code/doc changes that need GitHub synchronization must go through
  `skills/archive-and-push/SKILL.md`.

## Current Closed Runtime Fixes

- Hermes lite/full runtime split is closed on
  `scripts/apply-hermes-runtime-split.sh` and
  `scripts/diagnose-lite-full.sh`.
- Search Hub is the unified fresh web/news/academic search entry; actual
  social links still read through `social_reader` / `media_reader`.
- XHS browse backend and generic fallback are both prepared at deploy time:
  browse uses `ran-agent-xhs-browse.service` plus the marker at
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json`; generic
  fallback uses
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`.
- XHS evidence gate separates `link_resolution`, `metadata_read`, and
  `content_read`; token cache hits cannot claim content read.
- Request id logging is unified across context-size, routing, evidence, and
  evidence-gate logs.
- Node root env and `node_bridge/.env.local` are both managed for XHS browse and
  generic fallback marker consistency.
- Media reader startup fallback now matches production DashScope OCR defaults;
  PaddleOCR is an explicit local override.
- Opt-in AI daily digest is the only scheduled outbound allowlist path; it uses
  the learned Feishu DM target and the normal Hermes/Feishu reply flow without
  reopening proactive check-ins or reminders.
- `co_reading` Web reader is Tailscale-only, supports bilingual reading,
  browser imports, scoped Hermes margin replies, and explicit shared annotation
  deposit to `vault/inbox/co_reading/`.
- `sticker_catalog` is the current cross-channel sticker surface. Hermes may
  emit only safe `RAN_MEDIA` markers with `stickerId`; assets stay in ignored
  runtime state.
- Hermes Action Contract Gate is the current guard for tool-backed actions:
  high-risk writes require explicit confirmation or pending-action state.
- Hermes context optimization is closed as a conservative package: local recent
  history, bounded global active topic, optional cache-friendly append history,
  and opt-in lite soft reset all write only under ignored runtime state.
- `external_mcp_gateway` is registered as a stable default-disabled MCP broker
  for future reviewed game/forum/browser MCPs. Production defaults remain
  `EXTERNAL_MCP_GATEWAY_ENABLED=false` and
  `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=false`; notifications require watchlist
  and rate budget, while T4/T5 writes require pending action evidence.
