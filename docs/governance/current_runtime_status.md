# Current Runtime Status

Status: CURRENT (2026-07-04)

This is the compact source of truth for current production behavior. Detailed
operator commands live in `docs/governance/server_runtime_commands.md`.

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
  -> external_mcp_gateway admission/registry/executor/policy/session/evidence/activity
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
- The only scheduled outbound message is the opt-in AI daily digest. It runs
  through the Feishu/Hermes mainline and does not reopen old proactive
  check-ins, reminders, or life-loop outbound behavior.
- `external_mcp_gateway` is registered as a stable MCP surface in lite/full.
  Source profiles still fall back to disabled flags, but the standard server
  deploy now writes `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`,
  `EXTERNAL_MCP_GATEWAY_ENABLED=true`,
  `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`, and explicit
  `EXTERNAL_MCP_GATEWAY_PROFILE=full|lite` so Hermes can use the broker without
  hand-editing env files. Dynamic external MCP admission now uses
  `probe -> candidate registry -> classify -> auto_admitted / needs_owner /
  denied`; only safe remote HTTPS sandbox activity candidates can auto-admit.
  Streamable HTTP execution is implemented with legacy SSE endpoint fallback.
  Bounded activities create scoped grants, consume call budgets, and can be
  stopped by global user id before Hermes summarizes. The broker must not
  replace `social_reader`, `media_reader`, `search_hub`, `sticker_catalog`, or
  `co_reading`.

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
- Hermes context/cache observation:
  `journalctl -u ran-agent-node.service --since '30 minutes ago' --no-pager | grep -E 'hermes-provider-usage|hermes-context-components'`.

Do not hand-edit systemd or runtime env as the normal repair path.

## Env And Cache Contract

The deploy script keeps these env files aligned:

- `/opt/ran_agent/.env.local`
- `/opt/ran_agent/node_bridge/.env.local`
- `/home/ubuntu/.hermes-ran-agent/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/.env`
- `/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/.env`

Current shared non-secret keys include:

- `HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1`
- `HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1`
- `HERMES_CONTEXT_INJECTION_MODE=auto`
- `HERMES_CONTEXT_CACHE_STRATEGY=balanced`
- `HERMES_CACHE_FRIENDLY_HISTORY=false`
- `HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=6`
- `HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=12000`
- `HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=lite`
- `HERMES_CACHE_TELEMETRY_ENABLED=true`
- `SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true`
- `XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`
- `XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0`
- `XHS_PUBLIC_SIDECAR_URL=http://127.0.0.1:18061/xhs/detail`
- `XHS_PUBLIC_SIDECAR_TIMEOUT_MS=90000`
- `XHS_PUBLIC_HTML_FALLBACK_ENABLED=true`
- `XHS_PUBLIC_SIDECAR_MARKER_PATH=/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json`
- `UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache`
- `UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools`
- `UV_LINK_MODE=copy`
- `UV_PYTHON_DOWNLOADS=never`
- `WEIXIN_SDK_INBOUND_MEDIA_DIRS=/tmp/weixin-agent/media/inbound`
- `OMBRE_BRAIN_ENABLED=true`
- `OMBRE_BRAIN_MCP_ENABLED=true`
- `OMBRE_BRAIN_RUNNER=source`
- `OMBRE_BRAIN_REPO_URL=https://github.com/P0luz/Ombre-Brain`
- `OMBRE_BRAIN_HOME=/opt/ran_agent/.ran_agent_state/ombre-brain`
- `OMBRE_BRAIN_SOURCE_DIR=/opt/ran_agent/.ran_agent_state/ombre-brain/upstream`
- `OMBRE_BRAIN_VENV=/opt/ran_agent/.ran_agent_state/ombre-brain/.venv`
- `OMBRE_BUCKETS_DIR=/opt/ran_agent/vault/ombre`
- `OMBRE_BRAIN_MCP_URL=http://127.0.0.1:18001/mcp`
- `OMBRE_BRAIN_MCP_EXTRA_URL=http://127.0.0.1:18001/mcp-extra`
- `PERSONAL_AGENT_OMBRE_BACKEND=official_with_legacy_fallback`
- `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`
- `EXTERNAL_MCP_GATEWAY_ENABLED=true`
- `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`
- `EXTERNAL_MCP_GATEWAY_PROFILE=full|lite`

UV/UVX runtime work must use the managed cache/tool directories. Use
`scripts/clean-uv-cache-safe.sh` for cleanup and do not delete social-reader
state, vault, data, or XHS note debug output.

WeChat SDK inbound media is copied into
`/opt/ran_agent/.ran_agent_state/wechat/inbound` before Hermes/media_reader
analysis. `scripts/apply-hermes-runtime-split.sh` owns creation of the trusted
media directories so redeploys do not depend on manual `mkdir`.

## MCP And Routing

| Server | Purpose |
|--------|---------|
| `search_hub` | Fresh web/news/academic/platform search entry |
| `co_reading` | Full-profile private shared reading room plus Web reader with chunked books, synced progress, bilingual reading, shared annotations, scoped Hermes margin replies, and explicit Vault deposit |
| `time` | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_reader` | OCR, ASR, VLM, video, batch media analysis |
| `social_reader` | Social content reading (Bilibili, XHS, WeChat articles, music) |
| `sticker_catalog` | Local sticker picker/attach/save catalog; lite uses public pick/attach plus explicit inbound save, full may use owner-only management |
| `personal_memory` | Personal memory recall and backend health check |
| `obsidian_memory` | Optional Obsidian vault search, disabled by default |
| `ombre_memory` / `ombre_memory_extra` | Optional upstream Ombre Brain direct MCP, full-profile memory/debug surface |
| `media_generation` | Image and speech generation |
| `playwright` | Dynamic/visual web pages, full/debug use |
| `external_mcp_gateway` | Stable broker for dynamically admitted game/forum/browser MCPs |

- Search Hub is registered in both lite and full. Lite uses lightweight public
  providers; full may use Playwright fallback. OpenCLI browser-backed remains
  disabled by default for the 2C4G/60G server.
- Sticker Catalog is registered in both lite and full. Lite may use
  `sticker_tags`, `sticker_pick`, `sticker_attach`, and
  `sticker_save_from_inbox` only when the user explicitly asks to save trusted
  inbound media as a sticker. `sticker_update`, `sticker_delete`, and
  `sticker_list` remain explicit full-profile owner actions.
  Assets stay in `.ran_agent_state/stickers/`, and `RAN_MEDIA` carries only
  `stickerId`. Details: `docs/governance/sticker-catalog.md`.
- Ombre Brain uses the canonical upstream
  `https://github.com/P0luz/Ombre-Brain`. The deploy script prepares its local
  source runner under `.ran_agent_state/ombre-brain/upstream`, keeps buckets in
  private `vault/ombre/`, and makes Python `personal_memory` use upstream Ombre
  first with the repo-local shim as fallback. Direct `/mcp` plus `/mcp-extra`
  tools are exposed to full only when the runner is available and
  `OMBRE_BRAIN_MCP_ENABLED=true`. Lite keeps using `personal_memory` as the small
  memory surface and must not directly expose `mcp-ombre_memory`. Docker is an
  optional runner, not a Hermes prerequisite.
- Co Reading is not exposed in the lite daily conversation toolset to keep the
  default prompt smaller. The MCP remains available in the full profile, while
  the Web reader remains available independently. Chunk text lives under
  `.ran_agent_state/co_reading/library/**/*.txt.gz`; SQLite stores metadata,
  FTS index rows, progress, annotations, threads, events, imports, and storage
  stats. Private annotations are not returned to Hermes-facing read/search
  tools. Optional Web reader `/reader` is controlled by `CO_READING_WEB_ENABLED`
  and should be exposed only through Tailscale. It supports browser imports,
  bilingual reading, scoped Hermes margin replies, and explicit shared
  annotation deposit to `vault/inbox/co_reading/`. Details:
  `docs/governance/co-reading.md` and
  `docs/governance/co-reading-web-reader.md`.
- Actual social links still use `social_reader` / `media_reader` first. Search
  Hub must not replace the XHS/Bilibili/Zhihu/WeChat link-read mainline.
- XHS links must not first-read through browser navigation or terminal.
- External MCP manifests are untrusted until normalized and classified. Local
  executable MCP candidates (`stdio`, command, `uvx`, `npx`) cannot be
  self-enabled by Hermes and remain `needs_owner`. Remote candidates must pass
  HTTPS, redirect/DNS/SSRF, no OAuth/account/local-file/local-command, and
  low-risk tool checks before `auto_admitted`.
- Bounded external MCP activities use scoped `game_play` or `forum_read` grants.
  The runner owns budget, cadence, cancellation, and evidence only; Hermes still
  receives synthetic turns for decisions and sharing. T4/T5 side effects, forum
  comments, social writes, payment/delete/account actions, and external writes
  still require pending action/待确认 or a trusted scoped grant plus real executor
  evidence. No reply may claim success without an `external_mcp_tool_result`.
  User stop phrases such as "停下这局" are handled before Hermes is called:
  grants are revoked, runtime fetch/SSE work is aborted, sessions are closed,
  and Hermes then receives a stop synthetic turn to summarize.
- Proactive external MCP notices require an explicit watchlist/关注 scope and
  rate budget before a synthetic Hermes turn may notify the Feishu target. The
  system queue only creates synthetic Hermes turns; `silent`, `remember`, and
  empty replies are suppressed instead of sending visible text.

## XHS And Evidence Gate

- XHS content reading is public-only. The chain is URL/short-link resolution,
  `wanyi-watermark parse_xhs_link`, XHS-Downloader sidecar
  `POST /xhs/detail`, `wanyi-watermark parse_generic_link`, and minimal
  HTML/OG fallback. Account-backed `XHS_COOKIE`, QR login, `xiaohongshu-mcp`,
  `jobson-xhs-mcp`, `xhs_browse_*`, and token caches are not runtime paths.
- Deploy prepares the generic parser marker at
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`
  and the XHS-Downloader sidecar marker at
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json`.
  `scripts/apply-hermes-runtime-split.sh` removes the old
  `ran-agent-xhs-browse.service`, browse marker, and token cache.
- `read_social_post_deep` merges media found by public parsers, preserving
  known `image`/`video` types before sending assets to `media_reader`. It must
  not rely on XHS CDN URL suffixes to infer image type.
- Public XHS parsers are resource resolvers, not OCR/VLM readers. Complete
  image understanding happens only after merged assets enter
  `media_reader.analyze_media_batch`. The default full-read cap is 100 media
  assets, with 20-minute MCP/batch budgets so normal multi-image notes are not
  silently truncated by legacy 20-asset or 120s defaults.
  `scripts/start_media_reader_mcp.sh` defaults to DashScope Qwen-VL OCR with a
  120s OCR budget when env files are absent; PaddleOCR is explicit override
  only.
- Public parse failure is an explicit unreadable/metadata-only result. Hermes
  must not ask the user to refresh cookies or scan QR codes for XHS.
- `buildSocialEvidenceReport()` separates `link_resolution`,
  `metadata_read`, and `content_read`.
- Canonical URLs and public metadata are link-resolution/metadata evidence
  only. `allow_claim_read=true` requires content fields such as `post_text`,
  `desc`, `note_text`, `content`, `ocr_text`, `image_text`, or `full_text`.
- XHS deep-read media evidence keeps both `analyzed_media_count` (assets sent to
  media analysis) and `successful_media_count` (assets that produced analysis
  items). Complete-read claims must not pass when successful media coverage is
  partial.
- Evidence logs must not print raw XHS query tokens; canonical URLs are logged
  with redacted query strings.
- `sendChatToHermesGateway()` creates one request id per request and reuses it
  across context-size, routing, evidence, and gate logs.
- `replyBackend` runs Hermes Action Contract Gate before replies leave Node.
  `observe` logs evidence contracts, `enforce` rewrites unsupported success
  claims, and `repair` enables low-risk repair plus high-risk pending
  confirmation. Pending state lives under
  `.ran_agent_state/action_contract/`; details:
  `docs/governance/hermes-action-contract-gate.md`.

## Media And Frontends

- Media pipeline details: `docs/governance/media-pipeline.md`.
- Sticker Catalog details and server smoke: `docs/governance/sticker-catalog.md`.
- Multi-frontend identity/timeline details:
  `docs/governance/multi_frontend_identity_strategy.md`.
- WeChat media buffer details:
  `docs/governance/wechat-bridge-media-buffer.md`.
- MiMo Power is retired and no longer exposed in Hermes runtime profiles.

## Scheduled AI Daily Digest

- Enable with `AI_DAILY_DIGEST_ENABLED=true`; default time is `10:00`
  `Asia/Shanghai` through `AI_DAILY_DIGEST_HOUR=10` and
  `AI_DAILY_DIGEST_MINUTE=0`.
- The job fetches AIHOT facts, applies the editable report-style template at
  `src/personal_agent/prompts/ai_daily_digest_report.md`, and sends a synthetic
  Feishu DM turn to Node bridge `/scheduled/ai-daily-digest`.
- Node bridge records the latest Feishu DM target from normal incoming Feishu
  private messages. If no DM target exists, the digest is skipped; do not hard
  code raw Feishu ids in public docs.
- Delivery reuses `ChannelHub -> replyBackend -> hermesGatewayClient ->
  sendFeishuReply()`, so follow-up questions stay in the same Feishu/Hermes
  timeline.
- `PERSONAL_AGENT_PROACTIVE_ENABLED` and
  `PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED` remain `false`.
- External MCP proactive delivery is not part of the old proactive mainline.
  The separate system queue is deploy-enabled but watchlist/rate-budget limited
  and enters Hermes as a synthetic Feishu turn. No watch means no visible
  outbound message.

## Protected Local State

Never commit or force-add:

- `.env.local`, `node_bridge/.env.local`, credentials, cookies, proxy URLs.
- `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`.
- `.ran_agent_state/stickers/`,
  `.ran_agent_state/wechat/inbound/`,
  `.ran_agent_state/feishu/inbound/`,
  `.ran_agent_state/action_contract/`,
  `.ran_agent_state/external_mcp/`,
  `.ran_agent_state/hermes/`,
  `.ran_agent_state/co_reading/`.
- Provider-visible history, pending action state, sticker assets, inbound media,
  co-reading chunks, and public parser/sidecar markers are runtime state only.
- `local_archive/`.
- private `vault/` content.
- generated caches such as `.venv/`, `.pytest_cache/`, `node_modules/`.
