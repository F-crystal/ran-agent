# Current Runtime Status

Status: CURRENT (2026-07-06)

This is the compact source of truth for current production behavior. Detailed
commands live in `docs/governance/server_runtime_commands.md`; focused runtime
contracts live in the linked governance docs below.

## Mainline

```text
WeChat / Feishu / Desktop Proxy
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> Hermes gateway lite/full
  -> DeepSeek V4 Flash
  -> reply

Python backend
  -> ingest / memory / knowledge / reflection / scheduler / reminders

External MCP candidates
  -> external_mcp_gateway
  -> optional /external-mcp/system-queue synthetic Hermes turn
```

- Provider: `hermes`; model: `deepseek-v4-flash`; fallback provider: none.
- Python frontend `/chat` returns 410.
- OpenClaw, Kimi, GLM, and MiMo Power are retired frontend paths.
- WeChat, Feishu/Lark, and Desktop proxy share `ChannelHub`, `IdentityMap`,
  `GlobalTimeline`, and the same `replyBackend` path.
- Desktop Proxy is disabled by default and should stay bound to localhost or a
  controlled private network when enabled. Set `DESKTOP_PROXY_API_KEY` before
  exposing it beyond the local machine.
- Scheduled outbound is limited to allowlisted paths: explicit reminders, the
  opt-in AI daily digest, and governed external MCP watchlist notifications.
  Generic life-loop/check-in outbound remains retired.

## Lite/Full Runtime

| Entry | Port | Profile | Home | Default Use |
|-------|------|---------|------|-------------|
| lite | `8642` | `ran-assistant-lite` | `/home/ubuntu/.hermes-ran-agent/lite` | Normal chat, XHS, media, memory |
| full | `8643` | `ran-assistant` | `/home/ubuntu/.hermes-ran-agent` | Debug, commands, logs, Playwright, media generation, `lark-cli` |

- `8642` is a lite-context entry, not a security sandbox.
- Node bridge auto-selects via `RAN_AGENT_CAPABILITY_MODE=auto`.
- Full unavailable -> lite fallback with logged reason.
- Compact systemd is current: `ran-agent-hermes.service` owns lite and
  `ran-agent-hermes-full.service` owns full.
- Stale lite/full drop-ins should be absent after
  `scripts/apply-hermes-runtime-split.sh`.

## Deployment And Diagnostics

- Standard deploy/drift repair: `bash scripts/apply-hermes-runtime-split.sh`.
- Standard lite/full diagnosis: `bash scripts/diagnose-lite-full.sh`.
- Search Hub diagnosis: `bash scripts/diagnose-search-hub.sh`.
- Ombre Brain diagnosis: `bash scripts/diagnose-ombre-memory.sh`.
- Continuity diagnosis: `bash scripts/diagnose-hermes-continuity.sh`.
- Multi-frontend diagnosis: `bash scripts/diagnose-multi-frontend.sh`.
- Tool visibility diagnosis: `bash scripts/diagnose-hermes-tools.sh`.
- Media/XHS diagnosis: `bash scripts/diagnose-media-xhs.sh`.
- Sticker Catalog smoke: `bash scripts/diagnose-sticker-catalog.sh`.
- External MCP gateway diagnosis:
  `bash scripts/diagnose-external-mcp-gateway.sh`.
- Proactive event diagnosis:
  `bash scripts/diagnose-proactive-events.sh`.

Do not hand-edit systemd or runtime env as the normal repair path.

## Runtime Env Contract

The deploy script keeps these env files aligned:

- `/opt/ran_agent/.env.local`
- `/opt/ran_agent/node_bridge/.env.local`
- `/home/ubuntu/.hermes-ran-agent/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/.env`
- `/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/.env`

Important non-secret env groups:

- Hermes routing and cache: `HERMES_LITE_API_BASE_URL`,
  `HERMES_FULL_API_BASE_URL`, `HERMES_CONTEXT_INJECTION_MODE`,
  `HERMES_CONTEXT_CACHE_STRATEGY`, `HERMES_CACHE_*`.
- Public XHS/media: `SOCIAL_READER_GENERIC_FALLBACK_ENABLED`,
  `XHS_PUBLIC_*`, `MEDIA_READER_*`, `PERSONAL_AGENT_OCR_*`.
- Managed UV/Ombre state: `UV_CACHE_DIR`, `UV_TOOL_DIR`,
  `OMBRE_BRAIN_*`, `PERSONAL_AGENT_OMBRE_*`.
- External MCP/proactive gates: `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`,
  `EXTERNAL_MCP_GATEWAY_ENABLED=true`,
  `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`, `HERMES_PROACTIVE_*`.

UV/UVX runtime work must use the managed cache/tool directories. Use
`scripts/clean-uv-cache-safe.sh` for cleanup and do not delete social-reader
state, vault, data, or XHS note debug output.

## MCP And Routing

| Server | Purpose |
|--------|---------|
| `search_hub` | Fresh web/news/academic/platform search entry |
| `co_reading` | Full-profile shared reading room and Web reader |
| `time` | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_reader` | OCR, ASR, VLM, video, batch media analysis |
| `social_reader` | Social content reading (Bilibili, XHS, WeChat articles, music) |
| `sticker_catalog` | Local sticker picker/attach/save catalog |
| `personal_memory` | Personal memory recall and backend health check |
| `obsidian_memory` | Optional Obsidian vault search, disabled by default |
| `ombre_memory` / `ombre_memory_extra` | Optional upstream Ombre Brain direct MCP |
| `media_generation` | Image and speech generation |
| `playwright` | Dynamic/visual web pages, full/debug use |
| `external_mcp_gateway` | Stable broker for governed external MCPs |

- Search Hub is the daily fresh-search entry. Actual social links still use
  `social_reader` / `media_reader` first.
- XHS links are public-only and must not first-read through browser navigation,
  terminal navigation, cookies, QR login, or account-backed MCPs.
- Co Reading is kept out of the lite daily conversation toolset; it remains
  available in full and through the Tailscale-only Web reader.
- Sticker Catalog is registered in lite/full. Lite can pick/attach stickers and
  save trusted inbound media only when the user explicitly asks to save it.

## Safety Gates

- Media pipeline details: `docs/governance/media-pipeline.md`.
- Sticker Catalog details and server smoke: `docs/governance/sticker-catalog.md`.
- Multi-frontend identity/timeline details:
  `docs/governance/multi_frontend_identity_strategy.md`.
- WeChat media buffer details:
  `docs/governance/wechat-bridge-media-buffer.md`.
- Hermes context optimization:
  `docs/governance/hermes-context-optimization.md`.
- Hermes Action Contract Gate:
  `docs/governance/hermes-action-contract-gate.md`.
- External MCP gateway and system queue:
  `docs/governance/external-mcp-gateway.md`.

Core safety facts:

- `replyBackend` runs Hermes Action Contract Gate before replies leave Node.
  Unsupported success claims are observed, rewritten, or repaired according to
  mode; pending state lives under `.ran_agent_state/action_contract/`.
- Public XHS parsers are resource resolvers, not OCR/VLM readers. Complete
  image understanding happens only after assets enter `media_reader`.
- Complete-read claims require content evidence; canonical URLs and public
  metadata are only link-resolution/metadata evidence.
- External MCP manifests are untrusted until normalized and classified. Local
  executable MCP candidates cannot self-enable; T4/T5 side effects require
  pending action evidence or trusted scoped grants plus real executor evidence.

## Scheduled AI Daily Digest

- Enable with `AI_DAILY_DIGEST_ENABLED=true`; default time is `10:00`
  `Asia/Shanghai`.
- The job fetches AIHOT facts, applies
  `src/personal_agent/prompts/ai_daily_digest_report.md`, and sends a synthetic
  Feishu DM turn to Node bridge `/scheduled/ai-daily-digest`.
- Delivery reuses `ChannelHub -> replyBackend -> hermesGatewayClient ->
  sendFeishuReply()`, so follow-up questions stay in the same Feishu/Hermes
  timeline.
- If no Feishu DM target exists, the digest is skipped. Do not hard-code raw
  Feishu ids in public docs.

## Protected Local State

Never commit or force-add:

- `.env.local`, `node_bridge/.env.local`, credentials, cookies, proxy URLs.
- `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`.
- Runtime substate under `.ran_agent_state/stickers/`,
  `.ran_agent_state/wechat/inbound/`, `.ran_agent_state/feishu/inbound/`,
  `.ran_agent_state/action_contract/`, `.ran_agent_state/external_mcp/`,
  `.ran_agent_state/hermes/`, and `.ran_agent_state/co_reading/`.
- Provider-visible history, pending action state, sticker assets, inbound media,
  co-reading chunks, parser/sidecar markers, private `vault/` content,
  `local_archive/`, `.venv/`, `.pytest_cache/`, and `node_modules/`.
