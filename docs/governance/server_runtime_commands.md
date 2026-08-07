# Server Runtime Commands

Status: CURRENT (2026-08-07)

This is the public server runbook for the real `/opt/ran_agent` runtime. It is
an operator index, not a deployment journal. Prefer repo-managed scripts over
manual systemd or env edits.

`POINT_IN_TIME_AUDIT`
(`2026-08-05T13:30:09+08:00..13:35:11+08:00`) observed production at
`bb66f1e6a8a400d599c7f86139107742bbedddc8` with a clean worktree, Node
v22.22.2, and four active core services. All observed runtime processes used
`ubuntu:ubuntu`. Lite/Full used Hermes v0.13.0 with `deepseek-v4-flash`.
The existing direct Ombre Brain service on `18001` was active; recall-only O1
on `18002` was inactive and O2 was absent. Storage was 39/59 GB used, 19 GB
available, 68%. These are bounded observations, not mutation authority.

O1 `1be3ee5`, V4+O1 `c52f8ba`, O2 `a978444`, and unified-identity line
`b5b4ff4` are archived but not deployed to production. Commands that describe
`18002`, O2, or unified-identity apply behavior are target-release contracts,
not claims about the active host. Historical failed traces included 95% disk
utilization; that value is not current. Use only the verified pruner below and
never remove snapshot directories manually.

The exact `44b84fb11fe8854f510a78d0bea462e9b77b1bb0` Runtime apply on
2026-08-06 failed closed while its shell wrapper was completing the same-PID
exec into the private Python runtime, then rolled back successfully. Do not
retry that candidate. A successor must carry the bounded MainPID-settle fix,
preserve the exact legacy Lite/Full capability union, and pass a fresh
exact-SHA dry-run. Authorization for the unchanged exact eight-file read-only
bind boundary is recorded; any target or path expansion requires new
authorization.

Successor `0b793e8fea85c409800ee7e0d615501816c99387` was applied on
2026-08-06 and is `PROD_VERIFIED` for the bounded evidence in
`current_runtime_status.md`. Production now has one
Hermes v0.20 gateway on `8642`; `8643` is absent and the retired Full unit is
inactive, disabled and condition-blocked. Its retained evidence set is:

```text
controller: /opt/ran_agent-release/runtime-artifacts/deploy-hermes-runtime-release-0b793e8fea85c409800ee7e0d615501816c99387.py
candidate ref: refs/ran-agent/runtime-candidates/0b793e8fea85c409800ee7e0d615501816c99387
snapshot: /opt/ran_agent-release/runtime-snapshots/runtime-20260806T010417Z-0b793e8fea85
```

Four bounded source-only transactions advanced the clean checkout to
`2c8e97cacd1d2eaed30738abe621f3393cffb885` without replacing a service PID.
Binding.v4 is accepted after a real source apply/rollback/reapply and records
`runtimeRollbackAuthorized=false`; only its candidate-extracted source rollback
remains authorized. The retired v0.13 payloads have been deleted under the
root-owned `v013-payloads.deleted.json` record. The Runtime controller,
candidate ref, artifact, topology, snapshot state and sealed builder remain
evidence-only. Do not invoke Runtime rollback, relax checkout-SHA validation,
or use the legacy split release scripts.

Do not retry `44b84fb11fe8` or use the split deploy scripts against the unified
topology.

A separate account audit
(`2026-08-05T13:42:19.295+08:00..13:42:20.223+08:00`) observed the legacy
`ran-agent` account at UID 999/GID 988 with a nologin shell. No ran-agent-owned
runtime process was observed in the base audit window. Do not mutate or delete
the account without separate authorization.

## Source Of Truth

- Unified Hermes v0.20 Runtime transactions use the candidate-extracted,
  root-owned controller and artifact. Replace every placeholder with the exact
  reviewed values; do not use `HEAD`, a branch, or a worktree copy:

  The deployed Runtime binds exactly the eight files enumerated in
  `hermes_runtime_artifact.v1.json` read-only inside only the Hermes systemd
  mount namespace. General deployment authorization does not by itself approve
  that permission-boundary mutation: record separate authorization before
  `--mode apply`. Dry-run and isolated transient verification do not require
  production activation of those binds.

  ```bash
  cd /opt/ran_agent
  source /opt/ran_agent/.venv/bin/activate
  RUNTIME_CANDIDATE=<reviewed-40-char-sha>
  RUNTIME_CANDIDATE_REF=refs/ran-agent/runtime-candidates/$RUNTIME_CANDIDATE
  RUNTIME_CONTROLLER=/opt/ran_agent-release/runtime-artifacts/deploy-hermes-runtime-release-<reviewed-40-char-sha>.py
  RUNTIME_ARTIFACT=/opt/ran_agent-release/runtime-artifacts/hermes-runtime-<candidate-short-sha>.tar.gz
  git update-ref "$RUNTIME_CANDIDATE_REF" "$RUNTIME_CANDIDATE" 0000000000000000000000000000000000000000
  test "$(git rev-parse --verify "$RUNTIME_CANDIDATE_REF^{commit}")" = "$RUNTIME_CANDIDATE"
  sudo "$RUNTIME_CONTROLLER" --candidate "$RUNTIME_CANDIDATE" --artifact "$RUNTIME_ARTIFACT" --mode dry-run
  sudo "$RUNTIME_CONTROLLER" --candidate "$RUNTIME_CANDIDATE" --artifact "$RUNTIME_ARTIFACT" --mode apply
  ```

  Apply prints the exact snapshot path. For the deployed 0b793e8 Runtime,
  binding.v4 has since closed Runtime rollback. Its controller and snapshot are
  evidence-only; do not invoke `--mode rollback`.

  After the unified topology marker is published, the legacy
  `deploy-hermes-candidate.sh` and standalone Lite/Full repair intentionally
  refuse to operate. They are not rollback paths for the unified Runtime. The
  candidate-named controller, candidate ref, artifact, topology, snapshot state
  and sealed builder remain the retained evidence set.
- Companion MCP overlay refreshes use the exact candidate-bound manifest and
  narrow controller. The current contract mounts the exact candidate companion
  profile read-only at the two existing Home profile paths so MCP registration
  changes, MCP source changes and the one Python memory-facade source file
  activate and roll back together. It does not replace the Hermes executable,
  source checkout, database, or closed Runtime rollback authority:

  ```bash
  cd /opt/ran_agent
  source /opt/ran_agent/.venv/bin/activate
  set -euo pipefail
  OVERLAY_CANDIDATE=<reviewed-40-char-sha>
  OVERLAY_CANDIDATE_REF=refs/ran-agent/overlay-candidates/$OVERLAY_CANDIDATE
  OVERLAY_CONTROLLER=/opt/ran_agent-release/runtime-artifacts/deploy-hermes-companion-overlay-$OVERLAY_CANDIDATE.py
  git fetch origin main
  test ! "$(git rev-parse --verify "$OVERLAY_CANDIDATE_REF" 2>/dev/null)" || test "$(git rev-parse --verify "$OVERLAY_CANDIDATE_REF^{commit}")" = "$OVERLAY_CANDIDATE"
  git update-ref "$OVERLAY_CANDIDATE_REF" "$OVERLAY_CANDIDATE"
  git show "$OVERLAY_CANDIDATE:scripts/deploy-hermes-companion-overlay.py" | sudo tee "$OVERLAY_CONTROLLER" >/dev/null
  sudo chown root:root "$OVERLAY_CONTROLLER"
  sudo chmod 0500 "$OVERLAY_CONTROLLER"
  sudo "$OVERLAY_CONTROLLER" --mode preflight --candidate "$OVERLAY_CANDIDATE"
  OVERLAY_APPLY_UNIT=ran-agent-companion-overlay-${OVERLAY_CANDIDATE:0:12}
  sudo systemd-run --unit="$OVERLAY_APPLY_UNIT" --property=Type=exec --wait --collect \
    "$OVERLAY_CONTROLLER" --mode apply --candidate "$OVERLAY_CANDIDATE"
  sudo journalctl -u "$OVERLAY_APPLY_UNIT" --no-pager -n 80
  ```

  The transient systemd service keeps the transaction alive if the SSH client
  disconnects; acceptance still comes only from the controller state and
  journal. Apply prints the accepted transaction directory. A later explicit overlay
  rollback may use only that candidate-extracted controller and exact directory:
  `sudo "$OVERLAY_CONTROLLER" --mode rollback --transaction <exact-transaction-directory>`.
  This is independent of, and does not reopen, v0.20 Runtime rollback.
- After unified v0.20 passes immediate acceptance, the user has authorized
  disabling the split topology and removing exact temporary validation assets
  to reclaim space. Inventory references first. The active rollback contract
  formerly verified the v0.13 payloads by digest. That retention window is now
  closed and the exact payloads are absent. Preserve
  the unified capability union, personal data, and shared runtimes. Do not
  treat the old Full service name as permission to delete Full product state
  or MCP capability.
- Validate an exact reviewed release: `bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --dry-run`
- Apply that same exact release after separate authorization: `bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --apply`
- `deploy-hermes-main.sh --dry-run` may discover and test the then-current main head, but it is not apply authority; record and review its resolved SHA, then use the exact `--commit` path above.
- Lite/Full drift repair is release-internal only. Do not invoke
  `apply-hermes-runtime-split.sh` standalone; use the exact candidate
  transaction above.
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
corrupt state, symlinks, mount boundaries, path or inode drift, and a concurrent
payload cleanup. It removes a verified rollback-used snapshot's `files/` payload
while retaining its evidence. A final `release-transaction.*` directory with no
`transaction-state.json` cannot be rollback authority and is removed only after
the same identity, production-pointer, and mount checks.
Deploy also runs this pruner while holding the cross-UID global release lock
before the next runtime snapshot. It measures allocated blocks and inodes for
the complete snapshot source set, adds the candidate archive/stage reserve,
and requires the larger of 25% or 2 GiB byte headroom plus inode headroom.
Insufficient capacity fails before a snapshot directory, service stop, or
checkout change. Pre-prune `df` is an observation, not permission to delete
uncertain artifacts by hand and not the final capacity authority.

Agents changing or operating server runtime should first load
`skills/server-runtime/SKILL.md`. That skill owns the virtualenv activation
reminder and the env-preserving deploy rules.

## Standard Deploy

Hermes configuration prerequisites:

- Run from the server checkout at `/opt/ran_agent`.
- Activate `/opt/ran_agent/.venv` before deploy or diagnostic commands.
- Do not invoke `scripts/apply-hermes-runtime-split.sh` standalone. It is a
  legacy v0.13 compatibility step callable only by the immutable release
  controller. Do not hand-edit systemd or env as the normal path.

Code releases use the immutable-SHA transaction in
`docs/governance/hermes_release_deployment.md`. Do not run `git pull`, `git
switch`, or `git checkout` in `/opt/ran_agent` as a pre-deploy step. The
transaction fetches a source ref only to resolve one SHA, gates an immutable
stage, snapshots the active runtime, then changes the checkout only inside the
apply transaction.

The unified Hermes v0.20 Runtime transaction above is narrower than a code
release: it leaves `/opt/ran_agent` on its current clean SHA, installs an
immutable Runtime under `/opt/ran-agent-runtimes`, replaces only the managed
Hermes/Node routing files, and records rollback state under
`/opt/ran_agent-release/runtime-snapshots`. Use its controller for Runtime
dry-run, apply, and rollback; use the ordinary candidate transaction only for
later code releases that are compatible with the unified topology.

The gate runs the same Git-less read-only candidate as root and as the
validated non-root `RAN_AGENT_RUNTIME_USER/GROUP` identity (default
`ubuntu:ubuntu`). Before and after checkout activation, tracked paths are
projected to their Git modes and checkout owner; root-owned restrictive residue
is repaired through no-follow file descriptors, then the Node entry and runtime
dependencies are imported as that validated runtime identity. Do not manually
`chown -R` or loosen repository env-file modes.

After the quiesced Node and migration payloads extend the snapshot manifest,
deploy reseals and re-verifies the in-progress snapshot before checkout. An
interrupted explicit rollback remains eligible for the same rollback command;
a completed rollback with only stale pointer metadata is finalized by that
command rather than by manual Git or file deletion.

For rollback interpretation only, the retired v0.13 split transaction used
`apply-hermes-runtime-split.sh` to own:

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
bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --apply
```

Rollback to telemetry-only behavior:

```bash
RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY=balanced \
RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY=false \
RAN_AGENT_DEPLOY_HERMES_CACHE_TELEMETRY_ENABLED=true \
bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --apply
```

## Runtime Services

The table describes the deployed Runtime topology. The existing direct Ombre
service on `18001` remains active; `18002` and `18061` remain inactive. The next
personal-memory candidate keeps `18001` internal behind Python and removes the
direct Hermes tool; it does not activate `18002`.

| Service | Port | Profile | Home | Purpose |
|---------|------|---------|------|---------|
| `ran-agent-hermes.service` | `8642` | `ran-assistant-lite` compatibility ID | `/home/ubuntu/.hermes-ran-agent/lite` | Unified legacy Lite/Full capability surface |
| `ran-agent-hermes-full.service` | none | retired | retained rollback state only | Inactive, disabled and condition-blocked |
| `ran-agent-xhs-public-sidecar.service` | `18061` | n/a | `/opt/ran_agent/.ran_agent_state/xhs-public-sidecar` | XHS-Downloader public API sidecar for `social_reader` |
| `ran-agent-ombre-brain.service` | `18001` | n/a | `/opt/ran_agent/.ran_agent_state/ombre-brain` | Current direct service; next candidate reads it only through Python personal_memory |
| `ran-agent-ombre-recall.service` | `18002` | n/a | `/opt/ran_agent` | Inactive v0.13 rollback-era adapter; not a target service |

All legacy Lite/Full bridge URLs and selectors resolve to `8642`. The unified
profile includes terminal, file, session-search, Playwright, media and
co-reading instead of routing heavy intents to a second gateway.

## Required Env Locations

The unified Runtime controller manages public routing in:

- `/opt/ran_agent/.env.local`
- `/opt/ran_agent/node_bridge/.env.local`

These homes remain legacy rollback state, not unified-controller routing
authorities:

- `/home/ubuntu/.hermes-ran-agent/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/.env`
- `/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env`
- `/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/.env`

Important non-secret keys:

```text
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8642/v1
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

The recall-only `18002` service and its `OMBRE_RECALL_MCP_URL`,
`PERSONAL_AGENT_OMBRE_BACKEND=recall_only`, and
`PERSONAL_AGENT_OMBRE_MCP_URL` keys are retired. Do not restore them as current
runtime configuration; personal memory uses the loopback `18001` boundary.

Ombre deliberately has no network authenticator.
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
ran-agent-xhs-public-sidecar.service active on 127.0.0.1:18061 when the marker is ready and the optional sidecar is enabled
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
