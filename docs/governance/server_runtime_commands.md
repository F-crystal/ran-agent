# Server Runtime Commands

Status: CURRENT (2026-07-31)

This is the public server runbook for the real `/opt/ran_agent` runtime. It is
an operator index, not a deployment journal. Prefer repo-managed scripts over
manual systemd or env edits.

`USER_SUPPLIED_RUNTIME`: production repository SHA is
`bb66f1e6a8a400d599c7f86139107742bbedddc8`; this local line has not
revalidated it online. The owner-supplied 2026-07-31 preflight reported a clean
worktree, Node v22.22.2 with `node:sqlite`, and all four core services active.
Candidates `834eabef5a2e8883d3237f7b35c96f70d1fac7a9` and
`f6f6048029de6e4c73b5b8b11f1441069770786c` stopped at the immutable
pre-mutation gate and did not change production. O1 baseline
`1be3ee58919fb01f1c442d75ba2463e237fba0b2` is archived but undeployed; the
V4+O1 baseline `c52f8ba9b26338204e8ae189d1f1df5f3800e630` and independently
reviewed O2 implementation `a978444fc94f21c7d84df1e65e6fa8a8eb7dfdd7`
are archived and pushed but undeployed. The current reviewed line adds
owner-authorized production wiring: the source remains fail-off, while the
formal release defaults to Flash with O2 enabled. Commands below describe
that target state, not behavior already asserted in production.
The later candidate `8c259ddcd2a34e80400ac39e444876807960f689`
passed the immutable gate but failed Ombre startup and rolled back completely;
production therefore remains on the recorded SHA. The owner reported
`56.6GB/60GB` used after repeated failed transactions retained large completed
rollback payloads. Use only the verified pruner below; do not manually remove
snapshot directories.

## Source Of Truth

- Formal main release: `bash scripts/deploy-hermes-main.sh --apply`
- Reviewed release candidate: `bash scripts/deploy-hermes-candidate.sh --branch <remote-branch> --apply` or `bash scripts/deploy-hermes-candidate.sh --commit <40-char-sha> --apply`
- Deploy or repair lite/full runtime drift within an existing release
  transaction: `bash scripts/apply-hermes-runtime-split.sh`
- Diagnose lite/full convergence:
  `bash scripts/diagnose-lite-full.sh`
- Prove the final Hermes v0.13 provider HTTP body without network access:
  `RAN_AGENT_CAPABILITY_MODE=<lite|full> HERMES_SERVICE_UNIT=<unit> HERMES_HOME=<home> bash scripts/diagnose-hermes-provider-boundary.sh`
- Diagnose proactive events:
  `bash scripts/diagnose-proactive-events.sh`
- Diagnose external MCP gateway:
  `bash scripts/diagnose-external-mcp-gateway.sh`
- Diagnose Search Hub:
  `bash scripts/diagnose-search-hub.sh`
- Diagnose Ombre Brain:
  `bash scripts/diagnose-ombre-memory.sh`
- Diagnose Hermes continuity:
  `bash scripts/diagnose-hermes-continuity.sh`
- Diagnose multi-frontend routing:
  `bash scripts/diagnose-multi-frontend.sh`
- Diagnose Hermes tool visibility:
  `bash scripts/diagnose-hermes-tools.sh`
- Diagnose media/XHS routing:
  `bash scripts/diagnose-media-xhs.sh`
- Prepare XHS public parsers:
  `bash scripts/prepare-xhs-generic-fallback.sh` and
  `bash scripts/prepare-xhs-public-sidecar.sh`
- Clean UV cache safely:
  `bash scripts/clean-uv-cache-safe.sh`
- After this reviewed script exists in the active checkout, inspect
  reclaimable completed-release payloads:
  `sudo bash scripts/prune-hermes-release-artifacts.sh --dry-run`
- After this reviewed script exists in the active checkout, reclaim only
  payloads classified as completed `rollback_used` while keeping transaction
  evidence:
  `sudo bash scripts/prune-hermes-release-artifacts.sh --apply`
- Immutable Hermes release transaction and rollback:
  `docs/governance/hermes_release_deployment.md`
- Explicit Pro evaluation, still through the same immutable transaction:
  `RAN_AGENT_DEPLOY_HERMES_MODEL=deepseek-v4-pro bash scripts/deploy-hermes-candidate.sh --commit <CURRENT_REVIEWED_SHA> --apply`

Do not publish one-off pasteable repair blocks in this file. If a repeated
operation is needed, turn it into a script and reference it here.

The old production checkout does not contain the pruner. Its immediate recovery
authority is the reviewed bootstrap/apply transaction, which uses the
candidate-staged pruner under the global release lock before it creates a new
snapshot. It then performs a fresh mandatory capacity gate before any snapshot
copy or service stop. Do not expect `git fetch` alone to add the script to the
worktree.

The artifact pruner fails closed for the current production transaction,
unknown/corrupt state, symlinks, mount boundaries, path or inode drift, and a
concurrent payload cleanup. It removes only a verified snapshot's `files/` payload;
`transaction-state.json`, manifest, service state, and other evidence remain.
Deploy also runs this pruner while holding the global release lock before the
next runtime snapshot. It then measures the complete snapshot source set and
requires its apparent size plus the larger of 25% or 2 GiB on the artifact
filesystem. Insufficient capacity fails before a snapshot directory, service
stop, or checkout change. Pre-prune `df` is an observation, not permission to
delete uncertain artifacts by hand and not the final capacity authority.

Agents changing or operating server runtime should first load
`skills/server-runtime/SKILL.md`. That skill owns the virtualenv activation
reminder and the env-preserving deploy rules.

## Standard Deploy

Hermes configuration prerequisites:

- Run from the server checkout at `/opt/ran_agent`.
- Activate `/opt/ran_agent/.venv` before deploy or diagnostic commands.
- Use `scripts/apply-hermes-runtime-split.sh` as the unified Hermes runtime
  configuration script; do not hand-edit systemd or env as the normal path.

Code releases use the immutable-SHA transaction in
`docs/governance/hermes_release_deployment.md`. Do not run `git pull`, `git
switch`, or `git checkout` in `/opt/ran_agent` as a pre-deploy step. The
transaction fetches a source ref only to resolve one SHA, gates an immutable
stage, snapshots the active runtime, then changes the checkout only inside the
apply transaction.

`apply-hermes-runtime-split.sh` owns:

- Hermes profile install for lite and full.
- Compact systemd units for `ran-agent-hermes.service` and
  `ran-agent-hermes-full.service`.
- Runtime env upsert for Hermes homes, root Node env, and
  `/opt/ran_agent/node_bridge/.env.local`.
- Synchronized Lite/Full `deepseek-v4-flash` selection and the shared DeepSeek
  provider plugin that forces `thinking.type=disabled`. Pro remains available
  only through an explicit deployment override.
- Managed pre-Gate-5 O2 compatibility wiring: official release default
  `OMBRE_COMPAT_ENABLED=true`, canonical state/Steward identity paths, and
  separate tool-less Curator/Reviewer calls using Flash and the existing
  `DEEPSEEK_API_KEY`. Ordinary drift repair preserves an existing effective
  operator `false` across the two Node environment files.
- Service restart for `ran-agent-python.service`, `ran-agent-node.service`,
  `ran-agent-hermes.service`, and `ran-agent-hermes-full.service` so new env
  gates are loaded by running processes.
- Proactive event gates:
  `HERMES_PROACTIVE_EVENTS_ENABLED=true`,
  `HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true`,
  `HERMES_PROACTIVE_REMINDERS_ENABLED=true`,
  `HERMES_PROACTIVE_NOTIFY_MAX_CHARS=1600`, while legacy
  `PERSONAL_AGENT_PROACTIVE_ENABLED=false` remains frozen.
- External MCP activity runner gates:
  `EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=true` and
  `EXTERNAL_MCP_ACTIVITY_TICK_MS=60000`.
- Reply-window gates:
  `HERMES_REPLY_TIMEOUT_SECONDS=1200`,
  `NODE_BRIDGE_QUICK_ACK_ENABLED=false`,
  `NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS=4500`,
  `NODE_BRIDGE_QUICK_ACK_TEXT=收到，正在处理。`,
  `FEISHU_SEND_TIMEOUT_SECONDS=30`, and
  `FEISHU_DOWNLOAD_TIMEOUT_SECONDS=30`.
- `/opt/ran_agent` diagnostics run strict proactive env checks: `.env.local`,
  `node_bridge/.env.local`, and the running Python/Node service environments
  must all show those gates after deployment.
- UV cache/tool directories under `/opt/ran_agent/.ran_agent_state/`.
- Trusted runtime media directories, including
  `/opt/ran_agent/.ran_agent_state/wechat/inbound` and
  `/opt/ran_agent/debug/wechat/inbound`.
- XHS generic fallback marker path:
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`.
- XHS-Downloader public sidecar marker path:
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json`.
- Non-blocking XHS generic fallback and public sidecar preparation before
  service restart.
- Active cleanup of account-backed XHS state: `XHS_COOKIE`, XHS MCP env keys,
  `ran-agent-xhs-browse.service`, the browse marker, and legacy token cache.
- Ombre Brain runtime preparation under
  `/opt/ran_agent/.ran_agent_state/ombre-brain` and private buckets under
  `/opt/ran_agent/vault/ombre`.
- Restart and verification.

For the Hermes cache-friendly context package, the same deploy command writes
the conservative defaults and restarts the Node bridge. No manual env edits are
required for the default rollout.

### One-time owner binding

The release preflight intentionally stops with `owner_binding_required` until
an operator supplies one explicit owner identity. Do not use the legacy
`user:ran` fallback, an ordinary chat payload, or model output as that source.
Obtain the identity JSON only from the authenticated bridge or a verified
platform-operator export, place it in an owner-only (`0600`) local file, then
run the repo-managed command:

```bash
node scripts/bootstrap-owner-binding.mjs --identity-file /secure/path/owner-binding.json
```

The JSON must explicitly contain `platform` (`wechat`, `feishu`, or `desktop`),
`senderId`, `globalUserId`, and `provenance`. The command accepts no fallback
identity, writes only the sender hash to the runtime map, emits only a binding
count, and refuses to replace an existing owner binding. Remove the temporary
identity file according to the server's local secret-handling policy after the
command succeeds.

After deploy, observe cache and context telemetry:

```bash
journalctl -u ran-agent-node.service --since '30 minutes ago' --no-pager \
  | grep -E 'hermes-provider-usage|hermes-context-components'
```

The default should show `cache_strategy=balanced`,
`cache_friendly_history_enabled=false`, and DeepSeek cache telemetry fields when
the provider returns them. To explicitly test provider-visible append history,
deploy with:

```bash
RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY=cache_first \
bash scripts/apply-hermes-runtime-split.sh
```

Rollback to telemetry-only behavior:

```bash
RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY=balanced \
RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY=false \
RAN_AGENT_DEPLOY_HERMES_CACHE_TELEMETRY_ENABLED=true \
bash scripts/apply-hermes-runtime-split.sh
```

## Runtime Services

| Service | Port | Profile | Home | Purpose |
|---------|------|---------|------|---------|
| `ran-agent-hermes.service` | `8642` | `ran-assistant-lite` | `/home/ubuntu/.hermes-ran-agent/lite` | Daily lite-context entry |
| `ran-agent-hermes-full.service` | `8643` | `ran-assistant` | `/home/ubuntu/.hermes-ran-agent` | Full debug/heavy-tool entry |
| `ran-agent-xhs-public-sidecar.service` | `18061` | n/a | `/opt/ran_agent/.ran_agent_state/xhs-public-sidecar` | XHS-Downloader public API sidecar for `social_reader` |
| `ran-agent-ombre-brain.service` | `18001` | n/a | `/opt/ran_agent/.ran_agent_state/ombre-brain` | O1 target: loopback-only internal upstream |
| `ran-agent-ombre-recall.service` | `18002` | n/a | `/opt/ran_agent` | O1 target: local recall-only MCP exposed to Lite/Full |

`8642` is a lite-context entry, not a security sandbox. Node bridge routes
normal chat, XHS, media, and memory requests to lite by default, and routes
debug, command, file, Playwright, media generation, and `lark-cli` intents to
full.

## Required Env Locations

The deploy script should keep the following public routing keys consistent:

- `/opt/ran_agent/.env.local`
- `/opt/ran_agent/node_bridge/.env.local`
- `/home/ubuntu/.hermes-ran-agent/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/.env`
- `/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/.env`

Important non-secret keys:

```text
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1
RAN_AGENT_CAPABILITY_MODE=auto
HERMES_CONTEXT_INJECTION_MODE=auto
HERMES_CONTEXT_CACHE_STRATEGY=balanced
HERMES_CACHE_FRIENDLY_HISTORY=false
HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=6
HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=12000
HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=lite
HERMES_CACHE_TELEMETRY_ENABLED=true
SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true
SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000
SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000
XHS_BACKEND_MCP_TIMEOUT_MS=90000
MEDIA_READER_MCP_TIMEOUT_MS=1200000
PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000
PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3
PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000
PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000
PERSONAL_AGENT_OCR_PROVIDER=dashscope-qwen-vl-ocr
PERSONAL_AGENT_OCR_MODEL=qwen-vl-ocr-2025-11-20
PERSONAL_AGENT_OCR_TIMEOUT_MS=120000
XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json
XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0
XHS_PUBLIC_SIDECAR_ENABLED=true
XHS_PUBLIC_SIDECAR_URL=http://127.0.0.1:18061/xhs/detail
XHS_PUBLIC_SIDECAR_TIMEOUT_MS=90000
XHS_PUBLIC_HTML_FALLBACK_ENABLED=true
XHS_PUBLIC_SIDECAR_MARKER_PATH=/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json
UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache
UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools
UV_LINK_MODE=copy
UV_PYTHON_DOWNLOADS=never
OBSIDIAN_MEMORY_MCP_ENABLED=false
OMBRE_BRAIN_ENABLED=true
OMBRE_BRAIN_MCP_ENABLED=true
OMBRE_BRAIN_RUNNER=source
OMBRE_BRAIN_REPO_URL=https://github.com/P0luz/Ombre-Brain
OMBRE_BRAIN_HOME=/opt/ran_agent/.ran_agent_state/ombre-brain
OMBRE_BRAIN_SOURCE_DIR=/opt/ran_agent/.ran_agent_state/ombre-brain/upstream
OMBRE_BRAIN_VENV=/opt/ran_agent/.ran_agent_state/ombre-brain/.venv
OMBRE_BUCKETS_DIR=/opt/ran_agent/vault/ombre
OMBRE_BRAIN_STATUS_FILE=/opt/ran_agent/.ran_agent_state/ombre-brain/status.json
OMBRE_BIND_HOST=127.0.0.1
OMBRE_MCP_REQUIRE_AUTH=false
OMBRE_BRAIN_MCP_URL=http://127.0.0.1:18001/mcp
OMBRE_RECALL_MCP_URL=http://127.0.0.1:18002/mcp
PERSONAL_AGENT_OMBRE_BACKEND=recall_only
PERSONAL_AGENT_OMBRE_MCP_URL=http://127.0.0.1:18002/mcp
AI_DAILY_DIGEST_ENABLED=true
AI_DAILY_DIGEST_HOUR=8
AI_DAILY_DIGEST_MINUTE=0
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=repair
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
HERMES_REPLY_TIMEOUT_SECONDS=1200
NODE_BRIDGE_QUICK_ACK_ENABLED=false
NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS=4500
NODE_BRIDGE_QUICK_ACK_TEXT=收到，正在处理。
FEISHU_SEND_TIMEOUT_SECONDS=30
FEISHU_DOWNLOAD_TIMEOUT_SECONDS=30
HERMES_PROACTIVE_NOTIFY_MAX_CHARS=1600
EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=true
EXTERNAL_MCP_ACTIVITY_TICK_MS=60000
```

O1 deliberately has no Ombre network authenticator.
`OMBRE_MCP_REQUIRE_AUTH=false` is valid only with the enforced `127.0.0.1`
bind and loopback-only MCP/health URLs. An external bind—or claiming
authentication with `true`—is a release error.

Secrets such as API keys, cookies, proxy URLs, Lark credentials, and platform
login state must stay in local env files only and must never be printed into
docs, logs, tool output, or Git.

The standard deploy removes account-backed XHS keys from all managed env files.
Do not add `XHS_COOKIE`, `XHS_MCP_*`, `PERSONAL_AGENT_XHS_MCP_*`, or
`XHS_BROWSE_*` keys back into Hermes or Node env.

For WeChat bridge or login-state debugging, verify the exact CLI package,
runtime SDK package, version, import path, and state directory contract before
proposing token or state migration commands. Treat platform resolver state as
local runtime data, not portable documentation.

## Health Checks

```bash
cd /opt/ran_agent
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-external-mcp-gateway.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-ombre-memory.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-multi-frontend.sh
bash scripts/diagnose-ai-daily-digest.sh
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-media-xhs.sh --smoke-generic --smoke-public-sidecar --smoke-social-tools
```

For direct API checks, use the local Hermes API key from the server env. Do not
paste key-bearing curl commands into public docs.

## Search And Social Routing

- Fresh web facts, news, academic search, AI hot topics, and normal URL reads
  enter through `search_hub`.
- Actual social-platform links enter `social_reader` / `media_reader` first.
- XHS links (`xhslink.com`, `xiaohongshu.com`, `xhs.com`, or `小红书`) must not
  be first-read through `browser_navigate` or terminal.
- XHS is public-only. Token caches, browse tools, search/feed/profile, QR login,
  and `check_social_login` are not part of Hermes XHS reading.
- Public parser metadata is not content-read evidence. `content_read` requires
  actual text or media/OCR fields.

## Scheduled AI Daily Digest

- Public templates keep `AI_DAILY_DIGEST_ENABLED=false`; the managed server
  deploy writes `AI_DAILY_DIGEST_ENABLED=true` and schedules it for 08:00
  `Asia/Shanghai`.
- The digest target is learned from the latest normal Feishu DM handled by
  `node_bridge/src/feishuBridge.mjs` and stored under runtime state. To bind it,
  send the bot any private Feishu message once after deployment.
- Manual smoke is an owner-only internal control action. The local endpoint
  accepts only loopback requests bearing `RAN_AGENT_INTERNAL_CONTROL_SECRET`;
  use the authenticated deployment/verification procedure, and never place a
  literal secret-bearing `curl` command in public documentation.

Do not enable `PERSONAL_AGENT_PROACTIVE_ENABLED` for this feature.

## XHS Public Read Backends

XHS reads are public-only inside `social_reader`:

1. Resolve short links and note ids.
2. Try `wanyi-watermark parse_xhs_link`.
3. Try the XHS-Downloader sidecar `POST /xhs/detail` with
   `download=false` and `cookie=""`.
4. Try `wanyi-watermark parse_generic_link`.
5. Try minimal HTML/OG metadata fallback.
6. Forward discovered public media URLs to `media_reader.analyze_media_batch`.

The deploy script prepares wrappers/markers once, then runtime uses those
wrappers instead of cold-starting installers. Public parsers only provide
text/media URLs; image OCR/VLM is done by `media_reader`. The default full-read
cap is 100 media assets with 20-minute media MCP/batch budgets, so complete XHS
image reads should fail only as explicit per-asset partial failures rather than
silent truncation.

Expected state:

```text
/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json
/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json
ran-agent-xhs-public-sidecar.service active on 127.0.0.1:18061
ran-agent-xhs-browse.service absent or inactive
no XHS_COOKIE / XHS_BROWSE_* / XHS_NOTE_TOKEN_CACHE_* in managed env files
```

If XHS content reads fail:

1. Run
   `bash scripts/diagnose-media-xhs.sh --smoke-generic --smoke-public-sidecar --smoke-social-tools`.
2. Confirm account-backed XHS is disabled, wanyi is ready, the public sidecar is
   ready, and `tools/list` has no `check_social_login` or `xhs_browse_*`.
3. Check whether the specific note is simply not publicly readable. Do not
   repair this by adding cookies, QR login, `xiaohongshu-mcp`, or token cache.

Old account-backed commands now intentionally fail with
`XHS_ACCOUNT_BACKED_DISABLED`:

```bash
bash scripts/prepare-xhs-browse-backend.sh
bash scripts/start_xhs_browse_backend.sh
bash scripts/login_xhs_browse_backend.sh
bash scripts/run_xhs_browse_mcp.sh
```

## UV Cache Recovery

Use the safe cleaner only:

```bash
bash scripts/clean-uv-cache-safe.sh
bash scripts/clean-uv-cache-safe.sh --yes
```

Protected paths:

- `/opt/ran_agent/.ran_agent_state/social_reader/`
- `/opt/ran_agent/node_bridge/.ran_agent_state/social_reader/`
- `/opt/ran_agent/vault`
- `/opt/ran_agent/data`
- `/opt/ran_agent/debug/wechat/xhs_notes`

## Retired Paths

OpenClaw, Kimi, and GLM are retired frontend/runtime paths. Old
`openclaw-*` names and `.openclaw_state` references are legacy compatibility
artifacts only and must not be used as deployment authority.
