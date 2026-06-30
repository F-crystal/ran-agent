# Server Runtime Commands

Status: CURRENT (2026-06-30)

This is the public server runbook for the real `/opt/ran_agent` runtime. It is
an operator index, not a deployment journal. Prefer repo-managed scripts over
manual systemd or env edits.

## Source Of Truth

- Deploy or repair lite/full runtime drift:
  `bash scripts/apply-hermes-runtime-split.sh`
- Diagnose lite/full convergence:
  `bash scripts/diagnose-lite-full.sh`
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
- Prepare XHS browse MCP backend:
  `bash scripts/prepare-xhs-browse-backend.sh --write-env`
  If GitHub release downloads are flaky on the server, pre-copy the tarball and
  run with `XHS_BROWSE_ARCHIVE_PATH=/path/to/xiaohongshu-mcp-linux-amd64.tar.gz`.
- Start/login XHS browse MCP backend:
  `bash scripts/start_xhs_browse_backend.sh`,
  `bash scripts/login_xhs_browse_backend.sh`
- Clean UV cache safely:
  `bash scripts/clean-uv-cache-safe.sh`

Do not publish one-off pasteable repair blocks in this file. If a repeated
operation is needed, turn it into a script and reference it here.

Agents changing or operating server runtime should first load
`skills/server-runtime/SKILL.md`. That skill owns the virtualenv activation
reminder and the env-preserving deploy rules.

## Standard Deploy

Hermes configuration prerequisites:

- Run from the server checkout at `/opt/ran_agent`.
- Activate `/opt/ran_agent/.venv` before deploy or diagnostic commands.
- Use `scripts/apply-hermes-runtime-split.sh` as the unified Hermes runtime
  configuration script; do not hand-edit systemd or env as the normal path.

Run from the server checkout:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull --ff-only
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-ombre-memory.sh
```

`apply-hermes-runtime-split.sh` owns:

- Hermes profile install for lite and full.
- Compact systemd units for `ran-agent-hermes.service` and
  `ran-agent-hermes-full.service`.
- Runtime env upsert for Hermes homes, root Node env, and
  `/opt/ran_agent/node_bridge/.env.local`.
- UV cache/tool directories under `/opt/ran_agent/.ran_agent_state/`.
- Trusted runtime media directories, including
  `/opt/ran_agent/.ran_agent_state/wechat/inbound` and
  `/opt/ran_agent/debug/wechat/inbound`.
- XHS generic fallback marker path:
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`.
- Non-blocking XHS generic fallback preparation before service restart.
- Non-blocking XHS browse MCP backend preparation before service restart.
- `ran-agent-xhs-browse.service` for the xiaohongshu-mcp HTTP backend on
  `127.0.0.1:18060`; `social_reader` bridges to it through mcporter stdio.
- Ombre Brain runtime preparation under
  `/opt/ran_agent/.ran_agent_state/ombre-brain` and private buckets under
  `/opt/ran_agent/vault/ombre`.
- Restart and verification.

For the Hermes cache-friendly context package, the same deploy command writes
the conservative defaults and restarts the Node bridge. No manual env edits are
required for the default rollout.

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
| `ran-agent-xhs-browse.service` | `18060` | n/a | `/opt/ran_agent/.ran_agent_state/xhs-browse` | Xiaohongshu browse MCP HTTP backend for `social_reader` |
| `ran-agent-ombre-brain.service` | `18001` | n/a | `/opt/ran_agent/.ran_agent_state/ombre-brain` | Optional upstream Ombre Brain memory service |

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
XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json
XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0
XHS_BROWSE_ENABLED=false
SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false
XHS_BROWSE_MARKER_PATH=/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json
XHS_BROWSE_ROOT_DIR=/opt/ran_agent/.ran_agent_state/xhs-browse
XHS_BROWSE_MCP_URL=http://127.0.0.1:18060/mcp
XHS_BROWSE_MCP_COMMAND=bash
XHS_BROWSE_MCP_ARGS_JSON='["/opt/ran_agent/scripts/run_xhs_browse_mcp.sh"]'
XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE
XHS_NOTE_TOKEN_CACHE_PATH=/opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json
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
OMBRE_BRAIN_MCP_URL=http://127.0.0.1:18001/mcp
OMBRE_BRAIN_MCP_EXTRA_URL=http://127.0.0.1:18001/mcp-extra
PERSONAL_AGENT_OMBRE_BACKEND=official_with_legacy_fallback
PERSONAL_AGENT_OMBRE_MCP_URL=http://127.0.0.1:18001/mcp
PERSONAL_AGENT_OMBRE_MCP_EXTRA_URL=http://127.0.0.1:18001/mcp-extra
AI_DAILY_DIGEST_ENABLED=false
AI_DAILY_DIGEST_HOUR=10
AI_DAILY_DIGEST_MINUTE=0
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=repair
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

Secrets such as API keys, cookies, proxy URLs, Lark credentials, and platform
login state must stay in local env files only and must never be printed into
docs, logs, tool output, or Git.

`XHS_BROWSE_ENABLED=false` is the template default before the browse backend is
prepared. `scripts/prepare-xhs-browse-backend.sh --write-env` writes
`XHS_BROWSE_ENABLED=true` only after the marker, binary, mcporter config, and
wrapper command are ready.

For WeChat bridge or login-state debugging, verify the exact CLI package,
runtime SDK package, version, import path, and state directory contract before
proposing token or state migration commands. Treat platform resolver state as
local runtime data, not portable documentation.

## Health Checks

```bash
cd /opt/ran_agent
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-ombre-memory.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-multi-frontend.sh
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-media-xhs.sh --smoke-generic --smoke-browse
```

For direct API checks, use the local Hermes API key from the server env. Do not
paste key-bearing curl commands into public docs.

## Search And Social Routing

- Fresh web facts, news, academic search, AI hot topics, and normal URL reads
  enter through `search_hub`.
- Actual social-platform links enter `social_reader` / `media_reader` first.
- XHS links (`xhslink.com`, `xiaohongshu.com`, `xhs.com`, or `小红书`) must not
  be first-read through `browser_navigate` or terminal.
- Token-cache hits are link resolution evidence only; they do not mean content
  was read.
- XHS browse tools stay hidden from normal Hermes tool lists by default
  (`SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false`). `read_social_post` and
  `read_social_post_deep` may still use the backend internally to refresh
  `xsec_token` and read details before falling back to generic parsing.

## Scheduled AI Daily Digest

- Enable only in local env with `AI_DAILY_DIGEST_ENABLED=true`; keep the default
  disabled in public templates.
- The digest target is learned from the latest normal Feishu DM handled by
  `node_bridge/src/feishuBridge.mjs` and stored under runtime state. To bind it,
  send the bot any private Feishu message once after deployment.
- Manual smoke from the server can POST facts to the local Node bridge endpoint:

```bash
curl -sS -X POST http://127.0.0.1:8791/scheduled/ai-daily-digest \
  -H 'Content-Type: application/json' \
  -d '{"facts":"AI daily digest smoke facts"}'
```

Do not enable `PERSONAL_AGENT_PROACTIVE_ENABLED` for this feature.

## XHS Read Backends

XHS reads have two independent branches inside `social_reader`:

- Detail branch: token-aware browse first (`xiaohongshu-mcp` through
  `mcporter`) to read post text and detail image lists, then `jobson-xhs-mcp`
  as the compatibility text path when browse is unavailable.
- Media branch: generic parser fallback (`wanyi-watermark`) runs independently
  for missing-token, backend-failure, or media-only recovery cases.
  The prepared version must be at least `XHS_GENERIC_FALLBACK_MIN_VERSION`
  (default `1.2.0`) so old `v1.0.1` markers do not silently keep stale XHS
  parsing behavior.

`read_social_post_deep` merges browse detail images with generic parser media
before calling `media_reader`. The deploy script prepares wrappers/markers
once, then runtime uses those wrappers instead of cold-starting tool installers.

Expected state:

```text
/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json
/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json
/opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json
/opt/ran_agent/node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json
```

If XHS content reads fail:

1. Run `bash scripts/diagnose-media-xhs.sh --smoke-generic --smoke-browse`.
2. Confirm five layers in order: generic marker ready, browse marker ready,
   `ran-agent-xhs-browse.service` active, browse bridge search/detail tools
   confirmed, and login valid.
3. Then check whether the specific note fails because of auth/risk/captcha
   (`XHS_COOKIE_EXPIRED`, `XHS_IP_RISK`, `XHS_CAPTCHA_REQUIRED`), backend
   timeout (`XHS_BACKEND_TIMEOUT`), or note visibility/deletion.
4. Do not delete social-reader state while cleaning cache.

## XHS Browse MCP Repair

The XHS browse path has two layers:

- `ran-agent-xhs-browse.service` runs `xiaohongshu-mcp` as a local HTTP MCP
  backend on `127.0.0.1:18060`.
- `scripts/run_xhs_browse_mcp.sh` exposes that HTTP backend to Hermes
  `social_reader` through `mcporter serve --stdio`.

If direct `mcporter list xiaohongshu --schema` works but
`scripts/run_xhs_browse_mcp.sh` exits with:

```text
Server 'xiaohongshu' is not configured for keep-alive and cannot be served by the daemon bridge.
```

then the backend is installed, but the mcporter bridge entry is missing
`lifecycle: keep-alive`. Pull the latest repo and let prepare repair the
project-scoped mcporter config; no binary re-download is needed when the marker
and archive are already valid:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull --ff-only
bash scripts/prepare-xhs-browse-backend.sh --write-env
sudo systemctl daemon-reload
sudo systemctl restart ran-agent-xhs-browse.service
sudo systemctl restart ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-node.service
bash scripts/diagnose-media-xhs.sh --smoke-generic --smoke-browse
```

Expected browse smoke:

```text
xhs browse search tool: CONFIRMED
xhs browse detail tool: CONFIRMED
```

If either line is not confirmed, the diagnostic now prints
`xhs browse bridge error:` with the first bridge startup error. Fix that error
before treating the issue as an XHS auth or note-visibility problem.

Check login only after the bridge smoke confirms the search/detail tools:

```bash
MARKER=/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json
MCPORTER=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_cli'])")
CONF=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_config_path'])")
node "$MCPORTER" --config "$CONF" call 'xiaohongshu.check_login_status()' --timeout 120000
```

Only scan a new QR code if the login check reports not logged in, expired
cookies, or an auth failure:

```bash
MARKER=/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json
MCPORTER=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_cli'])")
CONF=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_config_path'])")
bash scripts/login_xhs_browse_backend.sh --qrcode
node "$MCPORTER" --config "$CONF" call 'xiaohongshu.check_login_status()' --timeout 120000
```

`--qrcode` saves MCP image content under
`/tmp/xhs-browse-login-qrcode` by default; override with
`XHS_BROWSE_QRCODE_DIR=/path/to/dir` when needed.

When browse smoke and login both pass, a specific note can still fail if the
note was deleted, made private, hidden by author settings, or blocked by XHS
risk control. In that case, compare:

- `read_social_post_deep` diagnostics from `social_reader`.
- Direct `mcporter` search/detail calls using parameter-style arguments:

```bash
MARKER=/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json
MCPORTER=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_cli'])")
CONF=$(python3 -c "import json; print(json.load(open('$MARKER'))['mcporter_config_path'])")
umask 077
CHECK_DIR=/opt/ran_agent/.ran_agent_state/social_reader/manual-checks
mkdir -p "$CHECK_DIR"

export XHS_QUERY='title or keyword'
node "$MCPORTER" --config "$CONF" call xiaohongshu.search_feeds \
  keyword="$XHS_QUERY" \
  --timeout 120000 \
  --output json >"$CHECK_DIR/xhs-search.json"

export FEED_ID='matched feed id'
export XSEC_TOKEN='matched xsec token from the search result'
node "$MCPORTER" --config "$CONF" call xiaohongshu.get_feed_detail \
  feed_id="$FEED_ID" \
  xsec_token="$XSEC_TOKEN" \
  --timeout 120000 \
  --output json >"$CHECK_DIR/xhs-detail.json"
```

Delete manual check files after inspection. Do not paste `xsec_token`, cookies,
QR payloads, detail JSON, or session files into public logs or docs.

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
