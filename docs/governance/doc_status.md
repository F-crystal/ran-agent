# Documentation Status

Status: CURRENT (2026-07-08)

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
| `docs/governance/hermes_release_deployment.md` | Immutable-SHA Hermes deployment, acceptance, rollback, and RC-to-main closure |
| `docs/governance/hermes_release_bootstrap.v1.sha256` | Bootstrap framework source-digest manifest |
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
| `docs/governance/external-mcp-gateway.md` | External MCP gateway, admission, evidence, and proactive system queue |
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
  `server_runtime_commands.md`, specialized runtime contracts to focused
  governance docs, and historical detail to `phase_status.md`.
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
- XHS is public-only. Deploy prepares `wanyi-watermark` via
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`
  and the XHS-Downloader sidecar via
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json`;
  account-backed browse service, `XHS_COOKIE`, `xiaohongshu-mcp`, and legacy
  token caches are removed by `scripts/apply-hermes-runtime-split.sh`.
- XHS evidence gate separates `link_resolution`, `metadata_read`, and
  `content_read`; public metadata cannot claim content read.
- Request id logging is unified across context-size, routing, evidence, and
  evidence-gate logs.
- Node root env and `node_bridge/.env.local` are both managed for XHS public
  parser and generic fallback marker consistency.
- Media reader startup fallback now matches production DashScope OCR defaults;
  PaddleOCR is an explicit local override.
- Scheduled outbound allowlist paths are the opt-in AI daily digest and
  explicit user-created reminders. Reminders use ProactiveEvent egress; neither
  path reopens old proactive check-ins.
- `co_reading` Web reader is Tailscale-only, supports bilingual reading,
  browser imports, scoped Hermes margin replies, and explicit shared annotation
  deposit to `vault/inbox/co_reading/`.
- `sticker_catalog` is the current cross-channel sticker surface. Hermes may
  emit only safe `RAN_MEDIA` markers with `stickerId`; assets stay in ignored
  runtime state.
- Hermes Action Contract Gate is the current guard for tool-backed actions:
  high-risk writes require explicit confirmation or pending-action state.
- Bridge-authored safety notices are neutral `bridge_*` messages. They may be
  sent to users, but are filtered out of Hermes recent/global assistant history.
- Hermes context optimization is closed as a conservative package: local recent
  history, bounded global active topic, optional cache-friendly append history,
  and opt-in lite soft reset all write only under ignored runtime state.
- `external_mcp_gateway` is registered as a stable MCP broker for dynamically
  admitted game/forum/browser MCPs. Source profiles fall back disabled, while
  standard server deploy enables the gateway/system-queue env gates. Dynamic
  admission uses candidate states, safe remote Streamable HTTP execution,
  scoped bounded activities, and global-user stop interruption; notifications
  require watchlist and rate budget, while T4/T5 writes require pending action
  evidence or trusted scoped grants.
- External MCP policy explain/call paths share trusted session context; compact
  aliases like `list_games`/`listgames` resolve only when unique, and private
  upstream session ids are reused without entering public evidence.
- External MCP background activities use bridge-created target tokens, then
  internal `activityId` session resolution; public activity prompts must not
  expose target/session/upstream secrets.
- Slow WeChat/Feishu replies use the managed reply-window contract:
  `HERMES_REPLY_TIMEOUT_SECONDS`, default-off quick ack, authorized async final
  send, and distinct Feishu ack/final idempotency keys.
- Ombre Brain deploy readiness is recorded in `OMBRE_BRAIN_STATUS_FILE`; direct
  full-profile Ombre MCP exposure is optional and gated by deploy-ready status.
