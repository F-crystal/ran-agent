# Current Runtime Status

Status: CURRENT (2026-05-13)

## Frontend Path

- Active path: `WeChat -> Node bridge -> OpenClaw agent -> Claude Code primary -> reply`
- Provider: `claude_code`; model: `qwen3.5-plus`; fallbacks: none.
- Kimi and GLM retired. Python frontend `/chat` returns 410.
- Single front speaker: OpenClaw (personal assistant + chat companion).

## OpenClaw Contract

- Runtime constraints: `openclaw/AGENTS.md` (injected by `bootstrap-extra-files` hook).
- Config: `openclaw/openclaw.personal-system.json`.
- Startup: `./start_openclaw.sh` (not raw `npx openclaw`).
- CLI checks: `scripts/openclaw_with_env.sh`.
- Smoke: `./scripts/connectivity_smoke.sh`.

## MCP Servers

| Server | Tool Prefix | Purpose |
|--------|-------------|---------|
| `playwright` | `playwright__` | Browser automation for dynamic/visual pages |
| `time` | — | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_generation` | `media_generation__` | Image and speech generation (DashScope) |
| `media_reader` | `media_reader__` | Unified media facade (OCR, ASR, VLM, video, batch) |
| `social_reader` | `social_reader__` | Social content reading (Bilibili, XHS, music) |
| `mimo_power` | `mimo_power__` | Deep multimodal analysis (MiMo Token Plan) |

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
- Hermes budget files (`openclaw/HERMES_*.md`) are repo references only, not injected.

## Media Reply Flow

- Default: `openclaw agent --json` (agent runtime, MCP tools visible).
- Inbound media: bridge validates paths, copies external files to trusted dirs, generates artifacts under `debug/media_context/`, injects recent-media context.
- Turn aggregation: `inboundMessageBuffer.mjs` holds media-only messages, merges with text-ref.
- Context Policy v1: compact media context injection (max 3 artifacts, ≤180 chars each), priority-based selection, legacy fallback via `OPENCLAW_CONTEXT_POLICY=legacy`.
- Fallback: `NODE_BRIDGE_OPENCLAW_REPLY_MODE=http` uses OpenAI-compatible gateway (MCP tools not visible).

## Backend Layer (Python)

- Capabilities: `/ingest`, memory recall/update, knowledge state/run, reflection, life-loop, night-cycle.
- Scheduler: `brain_loop_job`, `life_loop_job`, `knowledge_agent_job`, `self_reflection_job`, `night_cycle_job`, `reminder_check_job` (5 min).
- Knowledge path: `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`.

## Skills

- On-demand: `memory-specialist`, `reflection-specialist`, `knowledge-state`, `life-loop`, `night-cycle`, `ombre-memory`, `weather`, `web-search-live`, `archive-and-push`, `code-simplifier`, `context-compact`, `aihot`, `doc-governance`.
- Workspace overrides: `skills/weather/SKILL.md`, `skills/web-search-live/SKILL.md`.

## Troubleshooting

- `401` / `Unauthorized`: confirm `.env.local` key values; use `./start_openclaw.sh`.
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
  -> sendChatToOpenClawAgent(payload)
  -> preparePayloadMediaForAgent (path validation, external file copy)
  -> ensureConversationMediaContext (MiMo/media_reader analysis, artifact persistence)
  -> buildOpenClawAgentMessage (media instruction + context injection)
  -> npx openclaw agent --json
  -> OpenClaw agent runtime (MCP tools visible)
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
- `node_bridge/src/openclawGatewayClient.mjs` — OpenClaw agent/gateway client
- `node_bridge/src/replyBackend.mjs` — reply dispatch
- `src/personal_agent/http_server.py` — Python HTTP server
- `src/personal_agent/service.py` — service layer
- `src/personal_agent/scheduler.py` — job scheduler
