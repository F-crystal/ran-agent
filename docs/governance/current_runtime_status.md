# Current Runtime Status

Status: CURRENT (2026-07-27)

This is the compact source of truth for current production behavior. Detailed
commands live in `docs/governance/server_runtime_commands.md`; focused runtime
contracts live in the linked governance docs below.

## Release Lineage

```text
production_repository_sha: bb66f1e6a8a400d599c7f86139107742bbedddc8
runtime_evidence_class: USER_SUPPLIED_RUNTIME
local_o1_online_revalidation: not performed
production_manual_hotfixes: present; verify on host
ombre_o1_archived_baseline: 1be3ee58919fb01f1c442d75ba2463e237fba0b2; undeployed
local_v4_o1_integration: uncommitted, unarchived, undeployed
v4_pro: local Lite/Full integration candidate; undeployed
node_receipt: deferred
ombre_o2: not started, not authorized
package_b_2_b_3: not started
```

This production statement is `USER_SUPPLIED_RUNTIME`, not revalidated by this
local integration line. The formal production release does not contain the
archived O1 baseline or the local V4+O1 integration candidate.
Production has manual hotfixes, but this document does not guess their exact
live shape; server acceptance evidence remains the authority for those patches.

The repository candidate keeps every O1 invariant from
`1be3ee58919fb01f1c442d75ba2463e237fba0b2` and changes only the Lite/Full
model policy to `deepseek-v4-pro` with explicit provider-boundary
`thinking: {"type":"disabled"}`. It is not a production capability.

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
- Local V4+O1 candidate: Lite and Full both select `deepseek-v4-pro`; the
  installed Hermes v0.13 DeepSeek provider policy adds
  `thinking: {"type":"disabled"}` to the final provider HTTP body. Flash is
  the simultaneous Lite/Full model rollback value; O1 runtime safety is not
  rolled back.
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
- Hermes action semantics are declared by typed `replyEnvelope.actionRequests`
  or verified from protected compatibility signals. The bridge audits those
  inputs and never selects an MCP tool from ordinary user/reply text.
- Manual and scheduled AI-digest generation run in a task-scoped Hermes
  session and deliver through the durable outbox. They do not consume or write
  ordinary conversation/cache/soft-reset history.
- The same closed task scope also applies to action repair, release journey,
  proactive events, and external-MCP system-queue turns; their audit state stays
  in their existing receipts/ledgers/outboxes, never the ordinary timeline.

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

Standard deploy/drift repair is `bash scripts/apply-hermes-runtime-split.sh`.
Run diagnostics through the repo scripts named in
`docs/governance/server_runtime_commands.md`, including lite/full,
external MCP, proactive events, multi-frontend, continuity, and Ombre Brain.
Do not hand-edit systemd or runtime env as the normal repair path.

## Runtime Env Contract

The deploy script keeps root Node env, `node_bridge/.env.local`, lite/full
Hermes homes, and lite/full Hermes profile env files aligned.

Important non-secret env groups:

- Local candidate model policy: `HERMES_PROVIDER=deepseek`,
  `HERMES_INFERENCE_PROVIDER=deepseek`,
  `HERMES_DEFAULT_MODEL=deepseek-v4-pro`,
  `HERMES_INFERENCE_MODEL=deepseek-v4-pro`,
  `HERMES_PRO_MODEL=deepseek-v4-pro`, and
  `HERMES_DEEPSEEK_THINKING_MODE=disabled`.
- Hermes routing and cache: `HERMES_LITE_API_BASE_URL`,
  `HERMES_FULL_API_BASE_URL`, `HERMES_CONTEXT_INJECTION_MODE`,
  `HERMES_CONTEXT_CACHE_STRATEGY`, `HERMES_CACHE_*`.
- Public XHS/media: `SOCIAL_READER_GENERIC_FALLBACK_ENABLED`,
  `XHS_PUBLIC_*`, `MEDIA_READER_*`, `PERSONAL_AGENT_OCR_*`.
- Managed UV/Ombre state: `UV_CACHE_DIR`, `UV_TOOL_DIR`,
  `OMBRE_BRAIN_*`, `OMBRE_BRAIN_STATUS_FILE`, `PERSONAL_AGENT_OMBRE_*`.
- External MCP/proactive gates: `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`,
  `EXTERNAL_MCP_GATEWAY_ENABLED=true`,
  `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`,
  `EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=true`, `HERMES_PROACTIVE_*`.
- Reply-window gates: `HERMES_REPLY_TIMEOUT_SECONDS`,
  `NODE_BRIDGE_QUICK_ACK_*`, `FEISHU_SEND_TIMEOUT_SECONDS`, and
  `FEISHU_DOWNLOAD_TIMEOUT_SECONDS`.

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
| legacy direct Ombre surfaces | Prior production-repository shape; the local O1 recall-only replacement is not deployed |
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
- Local-only Hermes Core Foundation and frozen Schema v1:
  `docs/governance/hermes-core-foundation.md`.

Core safety facts:

- `replyBackend` runs Hermes Action Contract Gate before replies leave Node.
  Unsupported success claims are observed, rewritten, or repaired according to
  mode; pending state lives under `.ran_agent_state/action_contract/`.
- Bridge-authored action-gate, repair, and pending-action notices use `bridge_*`
  sources and are not replayed into Hermes assistant history.
- Ordinary WeChat/Feishu chats do not quick-ack by default. Long authorized
  background work must return a later proactive final through approved event
  gates and the same adapter path.
- External MCP background activity uses a short bridge-created target token
  only on explicit user intent, then uses `activityId` for later tool calls;
  session ids, target ids, upstream ids, cookies, and tokens must not appear
  in activity prompts or public evidence.
- Public XHS parsers are resource resolvers, not OCR/VLM readers. Complete
  image understanding happens only after assets enter `media_reader`.
- Complete-read claims require content evidence; canonical URLs and public
  metadata are only link-resolution/metadata evidence.
- External MCP manifests are untrusted until normalized and classified. Local
  executable MCP candidates cannot self-enable; T4/T5 side effects require
  pending action evidence or trusted scoped grants plus real executor evidence.

## Scheduled AI Daily Digest

Enable with `AI_DAILY_DIGEST_ENABLED=true`; default time is `08:00`
`Asia/Shanghai`. Delivery reuses the Feishu `ChannelHub -> replyBackend`
path, so follow-up questions stay in the same timeline. If no Feishu DM target
exists, the digest is skipped. Do not hard-code raw Feishu ids in public docs.

## Protected Local State

Never commit or force-add env files, credentials, cookies, proxy URLs, runtime
state, logs, debug output, provider-visible history, pending-action state,
media assets, parser/sidecar markers, private `vault/` content,
`local_archive/`, `.venv/`, caches, or `node_modules/`.

## Known Follow-Up Boundaries

Hermes Core Package A and frozen Schema v1 exist in repository source. Package
B.1 typed business transactions are also implemented there and have received
owner acceptance. Its additive recovery API is also owner accepted and gives a
future B.2 service atomic ingress/intent and part/processing operations,
durable reference/deferred state, factual recovery/candidate readers, and a
reference-aware seal digest. The owner-accepted global pending ingress reader
also provides verified cold-start discovery without an identity seed. These
are inactive repository primitives, not a runtime service.
`node_bridge/src/index.mjs` does not compose the Core B path;
ChannelHub, frontends, the provider gateway/history, Global Timeline,
`durableOutbox`, and Python ingest remain on their existing paths. Package B.2
service implementation has not started, no Core B path has been deployed, and
no partial Core production write path is authorized.

The deployed release does not yet unify automatic memory recall, Ombre direct
and wrapper surfaces, Vault recall, ordinary session continuity, and
provider-visible history under one control plane. It also does not establish a
single final-delivered assistant turn as the proven shared source for every
timeline, backend, provider-history, and session layer. These are follow-up
audit topics, not claims about current production behavior.
