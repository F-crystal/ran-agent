# Current Runtime Status

Status: CURRENT (2026-06-09)

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
```

- Provider: `hermes`; model: `deepseek-v4-flash`; fallback provider: none.
- Python frontend `/chat` returns 410.
- OpenClaw, Kimi, and GLM are retired frontend paths.
- WeChat, Feishu/Lark, and Desktop proxy share `ChannelHub`, `IdentityMap`,
  `GlobalTimeline`, and the same `replyBackend` path.
- The only scheduled outbound message is the opt-in AI daily digest. It runs
  through the Feishu/Hermes mainline and does not reopen old proactive
  check-ins, reminders, or life-loop outbound behavior.

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
- Continuity diagnosis: `bash scripts/diagnose-hermes-continuity.sh`.
- Multi-frontend diagnosis: `bash scripts/diagnose-multi-frontend.sh`.
- Tool visibility diagnosis: `bash scripts/diagnose-hermes-tools.sh`.
- Media/XHS diagnosis: `bash scripts/diagnose-media-xhs.sh`.
- Sticker Catalog smoke: `bash scripts/diagnose-sticker-catalog.sh`.

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
- `SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true`
- `XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`
- `UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache`
- `UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools`
- `UV_LINK_MODE=copy`
- `UV_PYTHON_DOWNLOADS=never`

UV/UVX runtime work must use the managed cache/tool directories. Use
`scripts/clean-uv-cache-safe.sh` for cleanup and do not delete social-reader
state, vault, data, or XHS note debug output.

## MCP And Routing

| Server | Purpose |
|--------|---------|
| `search_hub` | Fresh web/news/academic/platform search entry |
| `co_reading` | Full-profile private shared reading room plus Web reader with chunked books, synced progress, bilingual reading, shared annotations, scoped Hermes margin replies, and explicit Vault deposit |
| `time` | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_reader` | OCR, ASR, VLM, video, batch media analysis |
| `social_reader` | Social content reading (Bilibili, XHS, WeChat articles, music) |
| `sticker_catalog` | Local sticker picker/attach/save catalog; lite uses public pick/attach, full may use owner-only management |
| `personal_memory` | Personal memory recall and backend health check |
| `obsidian_memory` | Optional Obsidian vault search, disabled by default |
| `media_generation` | Image and speech generation |
| `playwright` | Dynamic/visual web pages, full/debug use |

- Search Hub is registered in both lite and full. Lite uses lightweight public
  providers; full may use Playwright fallback. OpenCLI browser-backed remains
  disabled by default for the 2C4G/60G server.
- Sticker Catalog is registered in both lite and full. Lite should only use
  `sticker_tags`, `sticker_pick`, and `sticker_attach`; owner-only
  save/update/delete/list actions are for explicit full-profile owner requests.
  Assets stay in `.ran_agent_state/stickers/`, and `RAN_MEDIA` carries only
  `stickerId`. Details: `docs/governance/sticker-catalog.md`.
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

## XHS And Evidence Gate

- XHS content reading uses the prepared generic parser fallback
  (`wanyi-watermark`) as the primary read path. `jobson-xhs-mcp` remains a
  token-aware compatibility path when a fresh `xsec_token` exists.
- Long XHS share URLs are read through URL candidates: resolved URL first,
  canonical `/explore/<note_id>` URL second. This keeps `/discovery/item/...`
  PC-share links with tracking params from failing on the first parser shape.
- XHS deep read skips the token-aware `jobson-xhs-mcp` detail backend when no
  `xsec_token` or cached token is available, so image/OCR fallback does not wait
  for a predictable 90s detail timeout.
- `media_reader.resolve_platform_media(platform="xhs")` treats missing
  `xsec_token` as recoverable: it tries the prepared generic parser fallback,
  preserves returned XHS image URLs as normalized media assets, and lets OCR/VLM
  continue instead of returning a hard backend error.
- XHS platform media resolution canonicalizes PC-share
  `/discovery/item/<note_id>` URLs to `/explore/<note_id>` while preserving
  `xsec_token` and `xsec_source` before calling the backend provider.
- Runtime marker:
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`.
- Token cache paths:
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json`,
  then `/opt/ran_agent/node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json`.
- Token cache supports `{ entries: {} }`, arrays, direct objects, http/https
  normalization, xhslink short-code matching, canonical note ids, and trailing
  punctuation stripping.
- Token cache writes and repairs canonical URLs as `/explore/<note_id>` with
  `xsec_token` and `xsec_source` preserved, so older cached `/discovery/item`
  PC-share URLs do not keep poisoning token-aware backend calls.
- `buildSocialEvidenceReport()` separates `link_resolution`,
  `metadata_read`, and `content_read`.
- Canonical URLs and token cache hits are link-resolution evidence only.
  `allow_claim_read=true` requires content fields such as `post_text`, `desc`,
  `note_text`, `content`, `ocr_text`, `image_text`, or `full_text`.
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

## Protected Local State

Never commit or force-add:

- `.env.local`, `node_bridge/.env.local`, credentials, cookies, proxy URLs.
- `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`.
- `local_archive/`.
- private `vault/` content.
- generated caches such as `.venv/`, `.pytest_cache/`, `node_modules/`.
