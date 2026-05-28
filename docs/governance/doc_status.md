# Documentation Status

Status: CURRENT (2026-05-28)

This file is the public documentation index and conflict rule. Historical
deployment notes belong under ignored `local_archive/`, not under
`docs/governance/`.

## Public Source Of Truth

| Document | Ownership |
|----------|-----------|
| `README.md` / `README_en.md` | User-facing project overview |
| `hermes/README.md` / `hermes/README_en.md` | Hermes profile distribution overview |
| `AGENTS.md` | Repo-root operating rules |
| `CLAUDE.md` | Claude-compatible repo-root operating rules |
| `hermes/profile/AGENTS.md` | Hermes profile runtime constraints |
| `docs/governance/doc_status.md` | Documentation index and conflict rule |
| `docs/governance/current_runtime_status.md` | Compact current runtime truth |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/phase_status.md` | Historical phase closure status |
| `docs/governance/constraints.md` | Runtime and implementation constraints |
| `docs/governance/skills.md` | On-demand skill map |
| `docs/governance/sub_agents.md` | Sub-agent candidate policy |
| `docs/governance/cleanup.md` | Retired/deleted component record |
| `docs/governance/media-pipeline.md` | Media pipeline and context policy |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat media buffering semantics |
| `docs/governance/mimo-power-mcp.md` | MiMo Power MCP configuration |
| `docs/governance/multi_frontend_identity_strategy.md` | Multi-frontend identity and timeline |
| `docs/governance/prompt-slimming-audit.md` | Prompt slimming ownership audit |

## Conflict Rule

1. Runtime code behavior is first truth.
2. Then the public source-of-truth docs listed above.
3. Local archives are context only and are not part of the public release
   surface.

## Governance Rules

- Keep `AGENTS.md` / `CLAUDE.md` light. Detailed runtime facts belong in
  `docs/governance/` or skills.
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
- XHS generic fallback is prepared at deploy time and uses the marker at
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`.
- XHS evidence gate separates `link_resolution`, `metadata_read`, and
  `content_read`; token cache hits cannot claim content read.
- Request id logging is unified across context-size, routing, evidence, and
  evidence-gate logs.
- Node root env and `node_bridge/.env.local` are both managed for XHS fallback
  marker consistency.
- Opt-in AI daily digest is the only scheduled outbound allowlist path; it uses
  the learned Feishu DM target and the normal Hermes/Feishu reply flow without
  reopening proactive check-ins or reminders.
