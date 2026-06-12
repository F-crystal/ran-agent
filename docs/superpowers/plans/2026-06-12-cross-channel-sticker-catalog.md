# Cross-Channel Sticker Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-neutral sticker catalog so Hermes can attach saved sticker images/GIFs in WeChat and Feishu without breaking Unicode emoji, ordinary text, existing `media_generation`, or scheduled/digest paths.

**Architecture:** Stickers live in a trusted local catalog under `.ran_agent_state/stickers/` and are referenced by `stickerId`, never by model-visible absolute paths. Hermes calls `sticker_catalog` MCP tools to pick/attach/save/update/delete stickers; `replyBackend` parses `RAN_MEDIA` marker intents, resolves sticker assets server-side, and `channelHub` routes `{ text, media }` to WeChat or Feishu adapters. Existing `WECHAT_MEDIA` remains compatible.

**Tech Stack:** Node.js ESM modules, Hermes MCP stdio servers, existing WeChat vendor SDK media sending, `lark-cli` for Feishu, Node test runner.

---

## File Map

- Create `node_bridge/src/stickerCatalog.mjs`: catalog storage, atomic JSON writes, MIME sniffing, quota, hash dedupe, asset resolution, safe soft delete.
- Create `node_bridge/src/stickerCatalogMcpServer.mjs`: MCP tools `sticker_tags`, `sticker_pick`, `sticker_attach`, `sticker_save_from_inbox`, `sticker_update`, `sticker_delete`, `sticker_list`.
- Create `scripts/start_sticker_catalog_mcp.sh`: Hermes MCP launcher.
- Create `node_bridge/src/replyMediaMarkers.mjs`: shared parser for `RAN_MEDIA` and legacy `WECHAT_MEDIA`; sticker marker resolves by `stickerId`.
- Modify `node_bridge/src/replyBackend.mjs`: use shared marker parser and return resolved `media`.
- Modify `node_bridge/src/index.mjs`: use shared marker parser for direct SDK-boundary replies; preserve existing media normalization.
- Modify `node_bridge/src/channelHub.mjs`: preserve `media` in adapter sends and timeline summaries; add media failure safe fallback if adapter reports failure.
- Modify `node_bridge/src/feishuBridge.mjs`: add `sendFeishuMediaReply`, keep `sendFeishuReply` unchanged, add inbound media extraction/download hooks after command verification.
- Modify `node_bridge/src/trustedMediaPaths.mjs`: trust sticker assets and Feishu inbound dirs for the right readers only.
- Modify `hermes/profile/AGENTS.md`: sticker behavior rules.
- Modify `hermes/profile/config.yaml`, `hermes/profile/config.lite.yaml`, `scripts/apply-hermes-runtime-split.sh`: register sticker tools with lite/full split.
- Modify `.gitignore`: ensure `.ran_agent_state/stickers/` and inbound media stay untracked.
- Create tests:
  - `node_bridge/tests/stickerCatalog.test.mjs`
  - `node_bridge/tests/stickerCatalogMcpServer.test.mjs`
  - `node_bridge/tests/replyMediaMarkers.test.mjs`
  - update `node_bridge/tests/replyBackend.test.mjs`
  - update `node_bridge/tests/index.test.mjs`
  - update `node_bridge/tests/feishuBridge.test.mjs`
  - update `node_bridge/tests/searchHubProfileMode.test.mjs`
  - update `node_bridge/tests/searchHubApplyScript.test.mjs`
- Create docs:
  - `docs/governance/sticker-catalog.md`
  - deployment note under `local_archive/deployment/` after implementation, not committed if repo policy keeps `local_archive/` out of git.

---

## Task 1: Verify Feishu Media Commands

**Files:**
- Modify: `docs/governance/sticker-catalog.md`
- Later modify: `node_bridge/src/feishuBridge.mjs`
- Test: `node_bridge/tests/feishuBridge.test.mjs`

- [ ] **Step 1: Run local command discovery**

Run:

```bash
command -v lark-cli || true
lark-cli --version || true
lark-cli im --help || true
lark-cli im +messages-send --help || true
lark-cli drive --help || true
lark-cli file --help || true
```

Expected locally: command may be unavailable. Record that local command discovery is inconclusive.

- [ ] **Step 2: Run server command discovery with Python environment active**

Run on server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
lark-cli --version
lark-cli im --help
lark-cli im +messages-send --help
lark-cli drive --help
lark-cli file --help
```

Expected: capture the exact supported command for sending an image or file as bot to `--user-id` and `--chat-id`. Do not implement guessed flags.

- [ ] **Step 3: Document verified command contract**

Create `docs/governance/sticker-catalog.md` with a `Feishu media send contract` section containing the verified commands and fallback order:

```markdown
# Sticker Catalog

## Feishu Media Send Contract

Local development does not assume `lark-cli` is installed. The server must verify the exact CLI command before enabling Feishu sticker send.

Verified on server:
- `lark-cli --version`: write the exact version printed by the server command discovery step.
- image send command: write the exact server-verified command, including identity and receiver-id flags.
- file send command: write the exact server-verified command, including identity and receiver-id flags.

Fallback order:
1. Send image/GIF through Feishu image command when supported.
2. Send as file when image send is unavailable or rejects GIF.
3. Return a sanitized failure without exposing local paths, tokens, or upload payloads.
```

- [ ] **Step 4: Commit command discovery docs after verification**

Run:

```bash
git add docs/governance/sticker-catalog.md
git commit -m "docs: record sticker catalog feishu media contract"
```

---

## Task 2: Sticker Catalog Core

**Files:**
- Create: `node_bridge/src/stickerCatalog.mjs`
- Test: `node_bridge/tests/stickerCatalog.test.mjs`

- [ ] **Step 1: Write failing catalog initialization and safety tests**

Cover:
- empty catalog initializes `assets`, `trash`, `index.json`, `tags.json`, `hashes.json`
- JSON writes are atomic through temp + rename
- no public API returns absolute paths except internal `resolveStickerAsset`
- realpath must stay under `assets`

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/stickerCatalog.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 2: Implement catalog paths and atomic JSON helpers**

In `stickerCatalog.mjs`, export:

```js
export function resolveStickerCatalogPaths(env = process.env) {}
export function ensureStickerCatalog(env = process.env) {}
export function readStickerIndex(env = process.env) {}
export function readStickerTags(env = process.env) {}
export function readStickerHashes(env = process.env) {}
export function atomicWriteJson(filePath, payload) {}
```

Implementation constraints:
- state root comes from `resolveStateDir(env)` in `runtimeState.mjs`
- catalog path is `<stateDir>/stickers`
- temp file suffix includes process id and timestamp
- `renameSync` is the final write step

- [ ] **Step 3: Add MIME sniffing and quota tests**

Cover:
- PNG/JPEG/GIF/WebP accepted by magic bytes
- SVG/HTML/unknown rejected
- `STICKER_MAX_BYTES` default `10485760`
- oversize files rejected
- user-provided filename ignored

- [ ] **Step 4: Implement content sniffing and quota**

Export:

```js
export function sniffStickerMime(buffer) {}
export function assertStickerFileAllowed(filePath, env = process.env) {}
```

Allowed magic:
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- JPEG: `FF D8 FF`
- GIF: `GIF87a` or `GIF89a`
- WebP: `RIFF....WEBP`

- [ ] **Step 5: Add save/pick/update/delete tests**

Cover:
- save from trusted inbound path copies into generated `stk_NNN.ext`
- sha256 dedupes repeated files
- `pick` supports `tag`, `query`, and `limit`
- `update` changes `tags` and `desc`
- `delete` soft moves to `trash`
- save batch limit 10, delete batch limit 50

- [ ] **Step 6: Implement catalog operations**

Export:

```js
export async function saveStickersFromInbox({ items }, options = {}) {}
export function listStickerTags(options = {}) {}
export function pickStickers({ tag, query, limit }, options = {}) {}
export function updateStickers({ items }, options = {}) {}
export function deleteStickers({ items, hardDelete = false }, options = {}) {}
export function listStickers({ tag, query, status, limit }, options = {}) {}
export function resolveStickerAsset(stickerId, options = {}) {}
```

Public list/pick returns omit `filePath`. `resolveStickerAsset` is internal server-side and returns `{ stickerId, filePath, fileName, mime, bytes, tags, desc }` after realpath validation.

- [ ] **Step 7: Run core tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/stickerCatalog.test.mjs
```

Expected: PASS.

---

## Task 3: Sticker Catalog MCP Server

**Files:**
- Create: `node_bridge/src/stickerCatalogMcpServer.mjs`
- Create: `scripts/start_sticker_catalog_mcp.sh`
- Test: `node_bridge/tests/stickerCatalogMcpServer.test.mjs`

- [ ] **Step 1: Write failing MCP tool schema tests**

Assert tool names:

```js
[
  'sticker_tags',
  'sticker_pick',
  'sticker_attach',
  'sticker_save_from_inbox',
  'sticker_update',
  'sticker_delete',
  'sticker_list',
]
```

Assert:
- `sticker_attach` returns `RAN_MEDIA` with `stickerId`, no path
- daily tools do not require owner permission
- management tools require owner/full profile permission
- errors are sanitized

- [ ] **Step 2: Implement MCP server**

Follow existing JSON-RPC pattern from `mediaGenerationMcpServer.mjs`. `sticker_attach` returns:

```text
RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":""}
```

Do not include URL or absolute path.

- [ ] **Step 3: Implement launcher**

`scripts/start_sticker_catalog_mcp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
exec node node_bridge/src/stickerCatalogMcpServer.mjs
```

- [ ] **Step 4: Run MCP tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/stickerCatalogMcpServer.test.mjs
bash -n scripts/start_sticker_catalog_mcp.sh
```

Expected: PASS.

---

## Task 4: Shared RAN_MEDIA Parser

**Files:**
- Create: `node_bridge/src/replyMediaMarkers.mjs`
- Modify: `node_bridge/src/replyBackend.mjs`
- Modify: `node_bridge/src/index.mjs`
- Test: `node_bridge/tests/replyMediaMarkers.test.mjs`
- Update: `node_bridge/tests/replyBackend.test.mjs`, `node_bridge/tests/index.test.mjs`

- [ ] **Step 1: Write failing parser tests**

Cover:
- accepts `RAN_MEDIA source=sticker_catalog kind=sticker stickerId=stk_001`
- rejects `RAN_MEDIA` with `url` or `filePath` for sticker source
- rejects unknown source
- accepts legacy `WECHAT_MEDIA source=media_generation_mcp`
- strips marker from visible text
- never returns internal path in marker parse output before resolver runs

- [ ] **Step 2: Implement parser and resolver hook**

Export:

```js
export function extractTrustedReplyMedia(text, options = {}) {}
```

Behavior:
- parse one marker line
- for `sticker_catalog`, call `options.resolveStickerAsset(stickerId)`
- return `{ text, media }`
- `media` for sticker includes internal `url: filePath`, `fileName`, `type: 'image'`, `source`, `kind`, `stickerId`
- sanitize thrown errors to `STICKER_MEDIA_UNAVAILABLE`

- [ ] **Step 3: Replace duplicate marker parsers**

Use `extractTrustedReplyMedia` in:
- `replyBackend.mjs`
- `index.mjs`

Keep old `WECHAT_MEDIA` behavior for generated image/audio.

- [ ] **Step 4: Run parser/backend/index tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/replyMediaMarkers.test.mjs node_bridge/tests/replyBackend.test.mjs node_bridge/tests/index.test.mjs
```

Expected: PASS.

---

## Task 5: WeChat Sticker Send Path

**Files:**
- Modify: `node_bridge/src/index.mjs`
- Modify: `node_bridge/src/outboundServer.mjs`
- Test: `node_bridge/tests/index.test.mjs`, `node_bridge/tests/outboundServer.test.mjs`

- [ ] **Step 1: Write failing WeChat send tests**

Cover:
- Hermes reply with sticker `RAN_MEDIA` leads to `responsePayload.media`
- marker is absent from visible text
- pure text reply unchanged
- media send failure returns sanitized fallback
- scheduled/digest paths do not auto attach sticker unless explicit marker is present

- [ ] **Step 2: Implement WeChat media handling**

Reuse existing `Bot.sendMessage({ text, media })` path. Preserve audio-to-file conversion in `normalizeReplyMediaForWeixinSdk`.

- [ ] **Step 3: Run WeChat tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/index.test.mjs node_bridge/tests/outboundServer.test.mjs
```

Expected: PASS.

---

## Task 6: Feishu Sticker Send Path

**Files:**
- Modify: `node_bridge/src/feishuBridge.mjs`
- Modify: `node_bridge/src/channelHub.mjs` only if adapter result handling needs media failure fallback
- Test: `node_bridge/tests/feishuBridge.test.mjs`, `node_bridge/tests/channelHub.test.mjs`

- [ ] **Step 1: Write failing Feishu media tests**

Use fake `execFileImpl` to assert exact commands discovered in Task 1:
- image/GIF sends through verified image command
- image command failure falls back to verified file command
- text and sticker are split when both exist
- text-only `sendFeishuReply` unchanged
- no internal path in user-visible text or thrown public error

- [ ] **Step 2: Implement `sendFeishuMediaReply`**

Export:

```js
export async function sendFeishuMediaReply({ target, media, text, execFileImpl, env } = {}) {}
```

Rules:
- resolve receive id exactly as `sendFeishuReply`
- send `text` first if present
- send media second
- image/GIF first, file fallback second
- throw sanitized `FEISHU_MEDIA_SEND_FAILED` after both fail

- [ ] **Step 3: Wire adapter**

In `handleFeishuEventLine`, adapter `sendReply` must call:
- `sendFeishuReply` for text-only
- `sendFeishuMediaReply` for media

- [ ] **Step 4: Run Feishu tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/feishuBridge.test.mjs node_bridge/tests/channelHub.test.mjs
```

Expected: PASS.

---

## Task 7: Feishu Inbound Media

**Files:**
- Modify: `node_bridge/src/feishuBridge.mjs`
- Create helper if needed: `node_bridge/src/feishuMedia.mjs`
- Test: `node_bridge/tests/feishuBridge.test.mjs`

- [ ] **Step 1: Write failing inbound tests**

Cover:
- Feishu image event produces `media: [{ type:'image', filePath, mimeType }]`
- Feishu file/image download stores under `.ran_agent_state/feishu/inbound/...`
- bad MIME rejected
- oversize rejected
- ordinary text events unchanged

- [ ] **Step 2: Implement media extraction and download**

Use verified `lark-cli` download command from Task 1. If current lark-cli lacks a download path, implement event metadata extraction and return a structured warning while keeping text flow stable.

- [ ] **Step 3: Run inbound tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/feishuBridge.test.mjs
```

Expected: PASS.

---

## Task 8: Hermes Profile and Tool Registration

**Files:**
- Modify: `hermes/profile/AGENTS.md`
- Modify: `hermes/profile/config.yaml`
- Modify: `hermes/profile/config.lite.yaml`
- Modify: `scripts/apply-hermes-runtime-split.sh`
- Test: `node_bridge/tests/searchHubProfileMode.test.mjs`, `node_bridge/tests/searchHubApplyScript.test.mjs`

- [ ] **Step 1: Write failing profile tests**

Assert:
- lite has `mcp-sticker_catalog`
- full has `mcp-sticker_catalog`
- management tools are gated by MCP server profile/owner checks
- generated runtime split includes sticker catalog in both homes

- [ ] **Step 2: Add profile config**

Lite/full both register:

```yaml
sticker_catalog:
  command: bash
  args:
    - -lc
    - cd "$RAN_AGENT_REPO_ROOT" && exec bash scripts/start_sticker_catalog_mcp.sh
  timeout: 120
  connect_timeout: 60
```

Toolset strategy:
- lite: tags/pick/attach exposed by server permission
- full: all tools exposed by server permission

- [ ] **Step 3: Add Hermes behavior rules**

Add concise rules:
- ordinary chat may use sparse Unicode emoji
- sticker only for fitting emotional/casual reactions
- do not use stickers in reports, digests, formal notices, or errors
- do not explain sticker tool calls
- respect "别发表情包"
- save/update/delete are asset management and require explicit user intent

- [ ] **Step 4: Run profile tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test node_bridge/tests/searchHubProfileMode.test.mjs node_bridge/tests/searchHubApplyScript.test.mjs
bash -n scripts/apply-hermes-runtime-split.sh
```

Expected: PASS.

---

## Task 9: Docs, Git Ignore, and Deployment Guide

**Files:**
- Modify: `.gitignore`
- Modify: `docs/governance/current_runtime_status.md`
- Modify: `docs/governance/media-pipeline.md`
- Modify: `docs/governance/sticker-catalog.md`
- Create: `local_archive/deployment/YYYY-MM-DD-sticker-catalog-cross-channel.md`

- [ ] **Step 1: Add gitignore tests by inspection**

Ensure:

```gitignore
.ran_agent_state/stickers/
.ran_agent_state/feishu/inbound/
.ran_agent_state/wechat/inbound/
```

Do not commit real sticker assets.

- [ ] **Step 2: Write governance docs**

Document:
- storage layout
- RAN_MEDIA marker
- security rules
- profile registration
- WeChat/Feishu send behavior
- GIF playback caveat

- [ ] **Step 3: Write deployment note**

Include server commands:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git rev-parse --short HEAD
git pull --ff-only
bash scripts/apply-hermes-runtime-split.sh
systemctl --user restart ran-agent-node.service
systemctl --user restart hermes-ran-assistant-lite.service
systemctl --user restart hermes-ran-assistant.service
```

Use the real service names if deployment docs show different names.

---

## Task 10: Full Verification

**Files:**
- No new files unless fixing issues found by verification.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  node_bridge/tests/stickerCatalog.test.mjs \
  node_bridge/tests/stickerCatalogMcpServer.test.mjs \
  node_bridge/tests/replyMediaMarkers.test.mjs \
  node_bridge/tests/replyBackend.test.mjs \
  node_bridge/tests/index.test.mjs \
  node_bridge/tests/feishuBridge.test.mjs \
  node_bridge/tests/channelHub.test.mjs \
  node_bridge/tests/outboundServer.test.mjs \
  node_bridge/tests/searchHubProfileMode.test.mjs \
  node_bridge/tests/searchHubApplyScript.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run syntax and shell checks**

Run:

```bash
bash -n scripts/start_sticker_catalog_mcp.sh
bash -n scripts/apply-hermes-runtime-split.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Server smoke verification**

Run on server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git rev-parse --short HEAD
lark-cli --version
bash scripts/apply-hermes-runtime-split.sh
```

Then verify manually:
- WeChat text reply unchanged.
- Feishu text reply unchanged.
- WeChat sticker marker sends media and marker is hidden.
- Feishu sticker marker sends media and marker is hidden.
- `sticker_save_from_inbox` works for WeChat media.
- `sticker_save_from_inbox` works for Feishu media if Task 7 command discovery supports download.
- fake `RAN_MEDIA` path/url is rejected.
- scheduled AI digest does not send stickers by default.

- [ ] **Step 4: Final report**

Report:
1. Modified file list.
2. lark-cli image/file command verification result.
3. stickerCatalog design summary.
4. RAN_MEDIA protocol summary.
5. WeChat send verification result.
6. Feishu send verification result.
7. Inbound save verification result.
8. profile registration result.
9. test result.
10. known issues and next steps.

---

## Scope Risks

- Feishu media send depends on real `lark-cli` capabilities. If server CLI cannot send image/file, implement wrapper hooks and document the blocker instead of guessing.
- GIF animation may render static on WeChat or Feishu. Treat sticker delivery as image/GIF asset delivery, not native animated sticker delivery.
- Feishu inbound media download may require extra permissions/scopes. If missing, keep outbound sticker support complete and report inbound save as blocked by Feishu permission.
