# Hermes External MCP Capability Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a disabled-by-default external MCP capability plane for Hermes, with registry validation, policy, sessions, evidence, pending side effects, system-queue silent suppression, watchlists, diagnostics, docs, and tests.

**Architecture:** Hermes sees one stable MCP server, `external_mcp_gateway`. The gateway validates and normalizes external MCP capabilities before exposure, enforces policy for every call, writes sanitized evidence, and requires pending actions or scoped grants for side effects. Production remains disabled until the full acceptance gate is complete.

**Tech Stack:** Node.js ESM, JSON-RPC stdio MCP shape used by existing bridge servers, `node:test`, shell launch/diagnostic scripts, Hermes YAML profiles, governance docs.

---

## Source Spec

Use `docs/superpowers/specs/2026-07-01-hermes-external-mcp-capability-plane-design.md`.

The active goal mentions `docs/governance/2026-07-01-hermes-external-mcp-capability-plane-design.md`, but the current worktree contains the accepted spec under `docs/superpowers/specs/`. Do not invent a second source of truth during implementation.

## File Map

- Create `node_bridge/src/externalMcp/registry.mjs`: manifest normalization, validation, secret scanning, classification helpers.
- Create `node_bridge/src/externalMcp/policy.mjs`: tier/profile/session/proactive/pending/scoped-grant decisions.
- Create `node_bridge/src/externalMcp/sessionManager.mjs`: observe/interactive/write session creation, expiry, user binding.
- Create `node_bridge/src/externalMcp/evidenceLog.mjs`: sanitized JSONL evidence events.
- Create `node_bridge/src/externalMcp/watchlist.mjs`: watch scope storage and rate budgets.
- Create `node_bridge/src/externalMcp/systemQueue.mjs`: synthetic Hermes turn queue and silent suppression helpers.
- Create `node_bridge/src/externalMcp/gatewayMcpServer.mjs`: disabled-by-default MCP server surface.
- Create `scripts/start_external_mcp_gateway.sh`: profile launcher.
- Create `scripts/diagnose-external-mcp-gateway.sh`: local diagnostics and acceptance gate.
- Modify `node_bridge/src/pendingActionState.mjs`: allow sanitized external MCP payload fields.
- Modify `node_bridge/src/actionContract.mjs`: detect and verify external MCP action/read claims.
- Modify `node_bridge/src/replyBackend.mjs`: suppress synthetic `silent`/`remember` sends.
- Modify `node_bridge/src/outboundServer.mjs`: add generic external MCP system-turn handler only when enabled.
- Modify `hermes/profile/config.yaml` and `hermes/profile/config.lite.yaml`: register stable `external_mcp_gateway`, disabled by default.
- Modify `hermes/profile/AGENTS.md`: Hermes-facing rules.
- Modify governance docs named in the spec.
- Add focused tests under `node_bridge/tests/`.

## Task 1: Registry Validation And Normalization

**Files:**
- Create: `node_bridge/src/externalMcp/registry.mjs`
- Test: `node_bridge/tests/externalMcpRegistry.test.mjs`

- [ ] **Step 1: Write failing tests**

Create tests that validate a safe manifest, reject credentials/session/cache/log fields, normalize tool descriptions, classify write-like tools as T4, and fail closed on unclassified tools.

Run:

```bash
node --test node_bridge/tests/externalMcpRegistry.test.mjs
```

Expected: fails because the module does not exist.

- [ ] **Step 2: Implement registry module**

Implement exported functions:

```js
export function normalizeManifest(input = {}, options = {}) {}
export function validateManifest(input = {}, options = {}) {}
export function normalizeTool(tool = {}) {}
export function classifyTool(tool = {}) {}
export function scanForForbiddenSecrets(value, path = []) {}
```

Return sanitized objects only. Never preserve raw tool schemas or descriptions without length bounds.

- [ ] **Step 3: Verify**

Run:

```bash
node --test node_bridge/tests/externalMcpRegistry.test.mjs
```

Expected: pass.

## Task 2: Policy Engine

**Files:**
- Create: `node_bridge/src/externalMcp/policy.mjs`
- Test: `node_bridge/tests/externalMcpPolicy.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover T0-T5 decisions, lite/full/owner profile limits, proactive read-only enforcement, T4/T5 pending requirement, scoped grants, and structured denials.

Run:

```bash
node --test node_bridge/tests/externalMcpPolicy.test.mjs
```

Expected: fails because the module does not exist.

- [ ] **Step 2: Implement policy module**

Implement:

```js
export function evaluateExternalMcpPolicy(input = {}) {}
export function normalizeTier(value) {}
export function normalizeProfile(value) {}
export function isSideEffectTier(tier) {}
```

The default decision for missing classification is deny.

- [ ] **Step 3: Verify**

Run policy tests and registry tests together.

## Task 3: Session Manager

**Files:**
- Create: `node_bridge/src/externalMcp/sessionManager.mjs`
- Test: `node_bridge/tests/externalMcpSessionManager.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover session key shape, observe/interactive/write modes, user/server binding, expiry, and proactive write-session denial.

- [ ] **Step 2: Implement session manager**

Use ignored runtime state through `resolveStateDir(env)`. Store only sanitized session records. Session IDs must be random and not authentication.

- [ ] **Step 3: Verify**

Run:

```bash
node --test node_bridge/tests/externalMcpSessionManager.test.mjs
```

## Task 4: Evidence Log

**Files:**
- Create: `node_bridge/src/externalMcp/evidenceLog.mjs`
- Test: `node_bridge/tests/externalMcpEvidenceLog.test.mjs`

- [ ] **Step 1: Write failing tests**

Verify evidence events redact credentials, cookies, absolute private paths, raw content, session ids, and tool traces while retaining request id, server id, tool id, tier, mode, decision, and hashed result refs.

- [ ] **Step 2: Implement evidence logger**

Append JSONL under ignored runtime state. Export `appendExternalMcpEvidence`, `sanitizeExternalMcpEvidence`, and `listExternalMcpEvidence`.

- [ ] **Step 3: Verify**

Run evidence tests.

## Task 5: Gateway MCP Server Disabled By Default

**Files:**
- Create: `node_bridge/src/externalMcp/gatewayMcpServer.mjs`
- Create: `scripts/start_external_mcp_gateway.sh`
- Test: `node_bridge/tests/externalMcpGatewayMcpServer.test.mjs`

- [ ] **Step 1: Write failing tests**

Test initialize/tools-list when disabled, enabled tool list, disabled call denial, registry listing, policy explanation, and startup script initialize response.

- [ ] **Step 2: Implement gateway surface**

Expose stable tools only:

```text
mcp_catalog_search
mcp_probe_server
mcp_list_enabled
mcp_list_tools
mcp_call
mcp_open_session
mcp_close_session
mcp_explain_policy
```

When `EXTERNAL_MCP_GATEWAY_ENABLED` is not true, calls must deny with `EXTERNAL_MCP_GATEWAY_DISABLED`.

- [ ] **Step 3: Verify**

Run gateway tests and startup script initialize test.

## Task 6: Pending External Actions

**Files:**
- Modify: `node_bridge/src/pendingActionState.mjs`
- Test: `node_bridge/tests/pendingActionState.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests for `forum_post`, `forum_comment`, `forum_react`, `forum_follow`, `game_submit_move`, `game_trade`, `game_spend_resource`, and `external_mcp_write` payload sanitization.

- [ ] **Step 2: Extend sanitizer**

Allow `serverId`, `toolId`, `actionFamily`, `watchScope`, `grantId`, and `evidenceId` as sanitized fields. Hash raw arguments and content refs.

- [ ] **Step 3: Verify**

Run pending action tests.

## Task 7: Action Contract External MCP Evidence

**Files:**
- Modify: `node_bridge/src/actionContract.mjs`
- Test: `node_bridge/tests/actionContract.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests that external MCP read claims require `external_mcp_tool_result`, side-effect success claims require authorization plus outbound/tool evidence, and missing evidence rewrites the claim.

- [ ] **Step 2: Implement action contract support**

Add external MCP evidence summaries and intent detection without exposing raw result payloads.

- [ ] **Step 3: Verify**

Run action contract tests.

## Task 8: System Queue And Silent Suppression

**Files:**
- Create: `node_bridge/src/externalMcp/systemQueue.mjs`
- Modify: `node_bridge/src/replyBackend.mjs`
- Modify: `node_bridge/src/outboundServer.mjs`
- Test: `node_bridge/tests/externalMcpSystemQueue.test.mjs`
- Test: `node_bridge/tests/replyBackend.test.mjs`
- Test: `node_bridge/tests/outboundServer.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover synthetic Hermes turn creation, disabled endpoint behavior, `silent` suppression, `remember` suppression, no empty message send, and no literal `silent` text.

- [ ] **Step 2: Implement queue helpers and suppression**

Do not restore old proactive outbound. Queue items enter `ChannelHub`; final sends are suppressed only when Hermes returns explicit silent/remember structured markers or route metadata.

- [ ] **Step 3: Verify**

Run the three targeted tests.

## Task 9: Watchlist And Rate Budget

**Files:**
- Create: `node_bridge/src/externalMcp/watchlist.mjs`
- Test: `node_bridge/tests/externalMcpWatchlist.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover watch add/list/remove, global daily budget, per-server weekly budget, per-topic cooldown, and fail-closed malformed scopes.

- [ ] **Step 2: Implement watchlist store**

Use ignored runtime state. Store only normalized scopes and hashed private ids.

- [ ] **Step 3: Verify**

Run watchlist tests.

## Task 10: Profile, Diagnostics, And Docs

**Files:**
- Create: `scripts/diagnose-external-mcp-gateway.sh`
- Modify: `hermes/profile/config.yaml`
- Modify: `hermes/profile/config.lite.yaml`
- Modify: `hermes/profile/AGENTS.md`
- Modify: `docs/governance/current_runtime_status.md`
- Modify: `docs/governance/constraints.md`
- Modify: `docs/governance/hermes-action-contract-gate.md`
- Modify: `docs/governance/multi_frontend_identity_strategy.md`
- Test: `node_bridge/tests/externalMcpProfileDocs.test.mjs`

- [ ] **Step 1: Write failing docs/profile tests**

Verify profile contains one stable `external_mcp_gateway`, production env default disables it, and governance docs mention disabled-by-default plus pending action requirements.

- [ ] **Step 2: Update profile and docs**

Register the gateway without enabling production behavior. Do not replace existing `social_reader`, `media_reader`, `search_hub`, `sticker_catalog`, or `co_reading`.

- [ ] **Step 3: Implement diagnostics**

Diagnostics must report registry validation, policy, sessions, evidence, pending action support, silent suppression, watchlist/rate budget, and disabled/enabled status.

## Task 11: Adversarial Review And Full Verification

**Files:**
- Modify implementation files only if review finds issues.

- [ ] **Step 1: Run adversarial review**

Review from first principles:

- Can any untrusted external description/schema/result reach Hermes without classification?
- Can any T4/T5 action claim success without pending/scoped grant evidence?
- Can any system queue path send empty text or literal `silent`?
- Can any path enable production gateway before acceptance gates pass?
- Did any existing social/media/search/sticker/co-reading mainline get replaced?

- [ ] **Step 2: Run targeted suite**

Run:

```bash
node --test node_bridge/tests/externalMcp*.test.mjs
node --test node_bridge/tests/actionContract.test.mjs node_bridge/tests/pendingActionState.test.mjs node_bridge/tests/replyBackend.test.mjs node_bridge/tests/outboundServer.test.mjs
bash scripts/diagnose-external-mcp-gateway.sh
git diff --check
```

- [ ] **Step 3: Acceptance decision**

Keep `EXTERNAL_MCP_GATEWAY_ENABLED=false` by default unless every gate is implemented and verified.
