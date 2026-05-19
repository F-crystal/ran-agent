# Current Runtime Status

Status: CURRENT (2026-05-19)

## Frontend Path

- Active path: `WeChat / Desktop proxy / Feishu -> ChannelHub -> replyBackend -> Hermes gateway (lite/full) -> DeepSeek V4 Flash -> reply`
- Provider: `hermes`; model: `deepseek-v4-flash`; fallbacks: none.
- Kimi, GLM, and OpenClaw retired. Python frontend `/chat` returns 410.
- Single front speaker: Hermes (personal assistant + chat companion).

## Lite/Full Runtime

- **8642 (lite):** `ran-assistant-lite` profile, `/home/ubuntu/.hermes-ran-agent/lite` home. Low-context daily entry (~22644 tokens). Used for normal chat, XHS, memory, image understanding.
- **8643 (full):** `ran-assistant` profile, `/home/ubuntu/.hermes-ran-agent` home. Full debug entry (~24331 tokens). Used for debug/commands/generation.
- Phase 11.1 systemd compact is the current target: `ran-agent-hermes.service`
  directly represents lite (8642 / `ran-assistant-lite`), and
  `ran-agent-hermes-full.service` directly represents full (8643 /
  `ran-assistant`). Lite is no longer produced by layering
  `90-lite-runtime.conf` over an old/full main unit.
- Search Hub MCP is registered in both lite and full. Lite/full differ by
  Search Hub provider capability, not by whether the tool exists.
- Lite Search Hub uses lightweight public providers by default: Tavily, AIHOT,
  OpenCLI public-only adapters, and public academic adapters such as
  OpenAlex/arxiv/pubmed. It does not enable OpenCLI browser-backed adapters or
  Playwright fallback.
- Full Search Hub uses Playwright fallback for debug/heavy web work. OpenCLI
  browser-backed is disabled by default (2C4G/60G server constraint). OpenCLI
  public adapters remain available. Browser-backed OpenCLI is deferred to
  Phase 11.2 as optional enhancement.
- Node bridge auto-selects per request via `RAN_AGENT_CAPABILITY_MODE=auto`.
- 8642 is lite-context, not a security sandbox. Full unavailable → fallback to lite with logged reason.
- Standard deployment and drift repair entry since `dda3499 Add Hermes runtime split deploy script`:
  `bash scripts/apply-hermes-runtime-split.sh`.
- Standard diagnosis entry: `bash scripts/diagnose-lite-full.sh`.
- Search Hub diagnosis entry: `bash scripts/diagnose-search-hub.sh`.
- Conversation continuity diagnosis entry:
  `bash scripts/diagnose-hermes-continuity.sh`.
- Do not hand-edit systemd or runtime env for the lite/full split. Inspect
  compact effective runtime state with `systemctl cat ran-agent-hermes.service`
  and `systemctl cat ran-agent-hermes-full.service`; stale
  `90-lite-runtime.conf`, `30-hermes-runtime.conf`, and `30-hermes-env.conf`
  should be absent after running `scripts/apply-hermes-runtime-split.sh`.

## Production Fix Closure

- Runtime split is closed on `scripts/apply-hermes-runtime-split.sh`; do not
  hand-edit systemd/env as the normal deployment path.
- Multi-frontend entry is closed on `ChannelHub`: WeChat, Feishu/Lark, and
  desktop OpenAI-compatible proxy all enter `replyBackend` through the same
  identity/timeline layer.
- Deployment verification is closed for:
  - `25a6ff2 Add unified multi-frontend agent hub`
  - `6b46276 Add global timeline retention compaction`
  - `8a3fa69 Fix Feishu bridge bot identity handling`
- Verified runtime facts: WeChat/Desktop/Feishu all enter ChannelHub;
  IdentityMap single-user mode maps all frontends to `user:ran`;
  GlobalTimeline records cross-platform turns; Hermes session key is shared
  across frontends while platform-specific session ids remain isolated; Desktop
  Proxy and Feishu Bridge are verified; timeline retention env is active;
  Feishu bridge uses bot identity and parses plain string content.
- Prompt slimming is closed for the active Hermes profiles: `SOUL.md`,
  `AGENTS.md`, and Node system instruction stay compact and layered.
- WeChat continuity is closed on client-side bounded recent history plus stable
  Hermes session headers; ordinary replies must not explain the continuity
  mechanism.
- XHS media fallback is closed on `social_reader -> media_reader/mimo_power`
  behavior. User-facing failures should describe unreadable media plainly, not
  DeepSeek vision limits or retired Hermes native vision tools.
- GitHub sync is closed on the `archive-and-push` skill: future commit/push
  work should use that flow and continue excluding runtime state and local
  caches.

## Phase Status

- Phase 5 is code-closed for Hermes profile/gateway migration; current script names are `scripts/phase5_hermes_gateway_smoke.sh` and `scripts/phase5_hermes_full_chain_smoke.mjs`.
- Default Phase 5 script behavior is minimal and does not exercise Python backend, memory bridge, Obsidian, social reader, media generation, MiMo, or other external MCP backends unless explicitly opted in.
- The old `phase6_hermes_*` names were incorrect and are removed. Phase 6 is reserved for Python backend and memory bridge work.
- Phase 6 is code-closed for backend/memory bridge boundaries: backend ingest timeout, personal memory backend health check, and personal memory recall timeout.
- Detailed phase scope: `docs/governance/phase_status.md`.

## Hermes Contract

- Runtime constraints: `hermes/profile/AGENTS.md`.
- Config: `hermes/profile/config.yaml`.
- Startup: managed by `scripts/apply-hermes-runtime-split.sh` in production.
- Smoke: `scripts/phase5_hermes_gateway_smoke.sh`.
- Node bridge sends stable `X-Hermes-Session-Id` /
  `X-Hermes-Session-Key` headers and a bounded recent text history to the
  Hermes API. This client-side history is the source of truth for short-term
  pronoun/reference continuity across WeChat, Desktop, and Feishu conversations.

## MCP Servers

| Server | Tool Prefix | Purpose |
|--------|-------------|---------|
| `playwright` | `playwright__` | Browser automation for dynamic/visual pages |
| `search_hub` | `search_hub__` | Unified fresh web/news/academic/platform search entry |
| `time` | — | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_generation` | `media_generation__` | Image and speech generation (DashScope) |
| `media_reader` | `media_reader__` | Unified media facade (OCR, ASR, VLM, video, batch) |
| `social_reader` | `social_reader__` | Social content reading (Bilibili, XHS, music) |
| `mimo_power` | `mimo_power__` | Deep multimodal analysis (MiMo Token Plan) |
| `obsidian_memory` | — | Obsidian vault memory integration |
| `personal_memory` | — | Personal memory management |

- Bundled `browser` plugin disabled; Playwright via `mcp.servers.playwright`.
- Fresh web facts, news, academic search, AI hot topics, platform search, and
  normal URL reads should enter through `search_hub`. Tavily, OpenCLI,
  Playwright, and AIHOT are Search Hub providers, not normal frontend search
  tools.
- Social platform link reading still uses `social_reader` first. Search Hub can
  route platform search requests, but it must not replace `social_reader` for
  actual XHS/Bilibili/Zhihu/WeChat link reading.
- Media pipeline details: `docs/governance/media-pipeline.md`.
- XHS content reading uses generic parser fallback (`wanyi-watermark`) as the primary read path. `jobson-xhs-mcp` is retained as a token-aware compatibility path when a fresh `xsec_token` is available.
- XHS browse search stores `note_id -> xsec_token` context in `.openclaw_state/social_reader/xhs-note-token-cache.json` by default and returns `read_ref` handles without exposing token values.
- XHS browse note treats backend `success:false` / `ok:false` payloads as read failures and retries through the generic parser fallback before returning `XHS_NOTE_READ_FAILED`.
- Generic parser JSON payloads are normalized before output: `status:success` exposes readable text and image metadata, while `status:error` becomes `GENERIC_PARSE_FAILED`.
- XHS backend timeout is controlled by `SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS`
  and `XHS_BACKEND_MCP_TIMEOUT_MS` (default 90000ms), separate from the general
  `SOCIAL_READER_MCP_TIMEOUT_MS`. Timeout errors return typed
  `XHS_BACKEND_TIMEOUT` code with `retryable: true`. xhslink http:// URLs are
  normalized to https:// before resolution.

## Tools Config

- `tools.profile = coding`
- `tools.allow`: `web_search`, `web_fetch`, `session_status`, `exec`, `process`
- Listed agent adds `read` on top.
- Native `todo-tools` disabled (bridge-managed).
- After changing `tools.profile` or `tools.allow`, run `/new` or `/reset`.

## UV Cache Management

- UV/UVX cache is pinned to `/opt/ran_agent/.ran_agent_state/uv-cache` and
  `/opt/ran_agent/.ran_agent_state/uv-tools` via systemd `Environment=` and
  runtime env files.
- `UV_LINK_MODE=copy` and `UV_PYTHON_DOWNLOADS=never` prevent uvx from
  downloading Python or creating hardlink-heavy archives.
- `~/.cache/uv` should be a symlink to the managed cache directory.
- If uv-cache exceeds 6G, run `scripts/clean-uv-cache-safe.sh` to review.
  If it exceeds 10G, stop services and run `scripts/clean-uv-cache-safe.sh --yes`.
- Do NOT delete `/opt/ran_agent/.ran_agent_state/social_reader/` or
  `/opt/ran_agent/node_bridge/.ran_agent_state/social_reader/` — these contain
  XHS token cache required for note reading.
- Do NOT delete `/opt/ran_agent/debug/wechat/xhs_notes`,
  `/opt/ran_agent/vault`, or `/opt/ran_agent/data`.

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
WeChat / Desktop / Feishu inbound
  -> platform adapter
     - WeChat: weixin-agent-sdk -> wechatBridge -> inboundMessageBuffer
     - Desktop: desktopProxyServer OpenAI-compatible endpoint
     - Feishu: feishuBridge -> lark-cli event consume --as bot
  -> ChannelHub
  -> IdentityMap (global_user_id=user:ran)
  -> GlobalTimeline (local recent + global active topic)
  -> replyBackend.getReply(payload)
  -> sendChatToHermesGateway(payload)
  -> search_hub for fresh web/news/academic/platform search when needed
  -> preparePayloadMediaForAgent (path validation, external file copy)
  -> ensureConversationMediaContext (MiMo/media_reader analysis, artifact persistence)
  -> hermes gateway (port 8642 lite or 8643 full by capability route)
  -> DeepSeek V4 Flash
  -> ingestExchangeToBackend() -> POST /ingest
  -> sanitizeReplyText()
  -> adapter reply
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
- `node_bridge/src/channelHub.mjs` — unified frontend entry and timeline write path
- `node_bridge/src/identityMap.mjs` — global user mapping and Hermes session ids/keys
- `node_bridge/src/globalTimeline.mjs` — cross-platform recent history, active topic, retention compaction
- `node_bridge/src/desktopProxyServer.mjs` — OpenAI-compatible desktop proxy
- `node_bridge/src/feishuBridge.mjs` — Lark event consumer and bot reply bridge
- `node_bridge/src/inboundMessageBuffer.mjs` — turn aggregation
- `node_bridge/src/mediaContextStore.mjs` — media artifact persistence
- `node_bridge/src/hermesGatewayClient.mjs` — Hermes gateway client
- `node_bridge/src/dashscopeMediaClient.mjs` — DashScope media generation
- `node_bridge/src/replyBackend.mjs` — reply dispatch
- `src/personal_agent/http_server.py` — Python HTTP server
- `src/personal_agent/service.py` — service layer
- `src/personal_agent/scheduler.py` — job scheduler
