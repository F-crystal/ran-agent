# Current Runtime Status

Status: CURRENT (2026-05-15)

## Frontend Path

- Active path: `WeChat -> Node bridge -> Hermes gateway (lite/full) -> DeepSeek V4 Flash -> reply`
- Provider: `hermes`; model: `deepseek-v4-flash`; fallbacks: none.
- Kimi, GLM, and OpenClaw retired. Python frontend `/chat` returns 410.
- Single front speaker: Hermes (personal assistant + chat companion).

## Lite/Full Runtime

- **8642 (lite):** `ran-assistant-lite` profile, `~/.hermes-ran-agent/lite` home. Low-context daily entry (~22644 tokens). Used for normal chat, XHS, memory, image understanding.
- **8643 (full):** `ran-assistant` profile, `~/.hermes-ran-agent` home. Full debug entry (~24331 tokens). Used for debug/commands/generation.
- Node bridge auto-selects per request via `RAN_AGENT_CAPABILITY_MODE=auto`.
- 8642 is lite-context, not a security sandbox. Full unavailable → fallback to lite with logged reason.

## Phase Status

- Phase 5 is code-closed for Hermes profile/gateway migration; current script names are `scripts/phase5_hermes_gateway_smoke.sh` and `scripts/phase5_hermes_full_chain_smoke.mjs`.
- Default Phase 5 script behavior is minimal and does not exercise Python backend, memory bridge, Obsidian, social reader, media generation, MiMo, or other external MCP backends unless explicitly opted in.
- The old `phase6_hermes_*` names were incorrect and are removed. Phase 6 is reserved for Python backend and memory bridge work.
- Phase 6 is code-closed for backend/memory bridge boundaries: backend ingest timeout, personal memory backend health check, and personal memory recall timeout.
- Detailed phase scope: `docs/governance/phase_status.md`.

## Hermes Contract

- Runtime constraints: `hermes/profile/AGENTS.md`.
- Config: `hermes/profile/config.yaml`.
- Startup: `hermes -p ran-assistant gateway run --replace --accept-hooks`.
- Smoke: `scripts/phase5_hermes_gateway_smoke.sh`.

## MCP Servers

| Server | Tool Prefix | Purpose |
|--------|-------------|---------|
| `playwright` | `playwright__` | Browser automation for dynamic/visual pages |
| `time` | — | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_generation` | `media_generation__` | Image and speech generation (DashScope) |
| `media_reader` | `media_reader__` | Unified media facade (OCR, ASR, VLM, video, batch) |
| `social_reader` | `social_reader__` | Social content reading (Bilibili, XHS, music) |
| `mimo_power` | `mimo_power__` | Deep multimodal analysis (MiMo Token Plan) |
| `obsidian_memory` | — | Obsidian vault memory integration |
| `personal_memory` | — | Personal memory management |

- Bundled `browser` plugin disabled; Playwright via `mcp.servers.playwright`.
- Media pipeline details: `docs/governance/media-pipeline.md`.
- XHS content reading uses generic parser fallback (`wanyi-watermark`) as the primary read path. `jobson-xhs-mcp` is retained as a token-aware compatibility path when a fresh `xsec_token` is available.
- XHS browse search stores `note_id -> xsec_token` context in `.openclaw_state/social_reader/xhs-note-token-cache.json` by default and returns `read_ref` handles without exposing token values.
- XHS browse note treats backend `success:false` / `ok:false` payloads as read failures and retries through the generic parser fallback before returning `XHS_NOTE_READ_FAILED`.
- Generic parser JSON payloads are normalized before output: `status:success` exposes readable text and image metadata, while `status:error` becomes `GENERIC_PARSE_FAILED`.

## Tools Config

- `tools.profile = coding`
- `tools.allow`: `web_search`, `web_fetch`, `session_status`, `exec`, `process`
- Listed agent adds `read` on top.
- Native `todo-tools` disabled (bridge-managed).
- After changing `tools.profile` or `tools.allow`, run `/new` or `/reset`.

## Session And Context

- `session.dmScope = per-channel-peer`
- `session.reset.mode = daily` at `04:00` (Asia/Shanghai)
- `contextTokens = 120000`, `timeoutSeconds = 180`, `idleTimeoutSeconds = 120`
- `contextPruning.mode = cache-ttl`, `ttl = 10m`
- `compaction.mode = safeguard`, `reserveTokensFloor = 12000`
- `blockStreamingDefault = on`
- `params.cacheRetention = short`
- `thinkingDefault = off`, `typingMode = message`

## Heartbeat

- `heartbeat.every = 90m`, `activeHours = 08:30-23:30 (Asia/Shanghai)`, `directPolicy = block`
- `HEARTBEAT.md` in workspace root.
- Heartbeat is internal maintenance only; proactive check-ins/reminders are blocked unless explicitly re-enabled.
- Persona/bootstrap files: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`.
- Hermes budget files (`hermes/profile/HERMES_*.md`) are repo references only, not injected.

## Media Reply Flow

- Default: `hermes gateway` (Hermes runtime, MCP tools visible).
- Inbound media: bridge validates paths, copies external files to trusted dirs, generates artifacts under `debug/media_context/`, injects recent-media context.
- Turn aggregation: `inboundMessageBuffer.mjs` holds media-only messages, merges with text-ref.
- Context Policy v1: compact media context injection (max 3 artifacts, ≤180 chars each), priority-based selection, legacy fallback via `RAN_AGENT_CONTEXT_POLICY=legacy`.

## Backend Layer (Python)

- Capabilities: `/ingest`, memory recall/update, knowledge state/run, reflection, life-loop, night-cycle.
- Node bridge backend ingest uses `PYTHON_BACKEND_INGEST_TIMEOUT_MS` (default 5000 ms).
- `personal_memory` MCP exposes `check_personal_memory_backend` and `recall_personal_memory`; recall uses `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS` (default 5000 ms).
- Scheduler: `brain_loop_job`, `life_loop_job`, `knowledge_agent_job`, `self_reflection_job`, `night_cycle_job`, `reminder_check_job` (5 min).
- Knowledge path: `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`.

## Skills

- On-demand: `memory-specialist`, `reflection-specialist`, `knowledge-state`, `life-loop`, `night-cycle`, `ombre-memory`, `weather`, `web-search-live`, `archive-and-push`, `code-simplifier`, `context-compact`, `aihot`, `doc-governance`.
- Workspace overrides: `skills/weather/SKILL.md`, `skills/web-search-live/SKILL.md`.

## Troubleshooting

- `401` / `Unauthorized`: confirm `.env.local` key values; use `hermes -p ran-assistant gateway run`.
- `HEARTBEAT ENOENT`: check `HEARTBEAT.md` exists in workspace root.
- `skills path warning`: verify `skills/*/SKILL.md` files exist; run from repo root.
- `tools: [] is too short`: ensure `tools.allow` is non-empty; run `/new` after changes.

## Runtime Sequence (Chat Mainline)

```text
WeChat inbound
  -> weixin-agent-sdk
  -> node_bridge/src/wechatBridge.mjs
  -> inboundMessageBuffer (turn aggregation)
  -> createReplyBackend().getReply(payload)
  -> sendChatToHermesGateway(payload)
  -> preparePayloadMediaForAgent (path validation, external file copy)
  -> ensureConversationMediaContext (MiMo/media_reader analysis, artifact persistence)
  -> hermes gateway (port 8642)
  -> DeepSeek V4 Flash
  -> ingestExchangeToBackend() -> POST /ingest
  -> sanitizeReplyText()
  -> reply to WeChat
```

## Bridge Hardening

- Inbound fragment merge: short-window message batching.
- Meta leak sanitization: strips tool-call fragments from replies.
- Outbound failure cache: failed sends queued for retry on next user message.
- Proactive freeze: `PERSONAL_AGENT_PROACTIVE_ENABLED=false` blocks `/outbound/send` check-ins and holds chat-path pending outbound queue without draining.
- Reminder freeze: `PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false` blocks reminder delivery.
- `/checkin` command: update proactive outreach random range.

## Code Anchors

- `node_bridge/src/wechatBridge.mjs` — message normalization, buffer integration
- `node_bridge/src/inboundMessageBuffer.mjs` — turn aggregation
- `node_bridge/src/mediaContextStore.mjs` — media artifact persistence
- `node_bridge/src/hermesGatewayClient.mjs` — Hermes gateway client
- `node_bridge/src/dashscopeMediaClient.mjs` — DashScope media generation
- `node_bridge/src/replyBackend.mjs` — reply dispatch
- `src/personal_agent/http_server.py` — Python HTTP server
- `src/personal_agent/service.py` — service layer
- `src/personal_agent/scheduler.py` — job scheduler
