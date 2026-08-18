# Hermes Stability And One-Shot Deploy Implementation Plan

Status: SUPERSEDED (2026-07-10)

Do not execute the remaining unchecked tasks verbatim. Landed fixes remain in
Git history and current governance. Unexecuted or later-evolved requirements
are split between:

- `docs/superpowers/specs/2026-07-10-hermes-core-reliability-learning-one-shot-runtime-design.md`;
- `docs/superpowers/specs/2026-07-10-hermes-external-mcp-autonomy-capability-growth-design.md`.

Those documents are historical design baselines, not current runtime authority.
The durable-game spec
remains a historical compatibility pointer, not an execution entry point.

**Goal:** Stabilize Hermes scheduled digest, bridge notices, reply windows, lite session governance, and external-MCP game autonomy so local work can iterate safely and production can deploy in one server pass.

**Architecture:** Keep the current split runtime. Python scheduler jobs create durable, diagnosable triggers; Node bridge owns message delivery and action evidence; Hermes gateway owns bounded model sessions; external MCP activity owns game progress. Do not add a new generic queue in v1: use existing scheduler, activity, evidence, and runtime-state files, and disable fake quick-ack promises by default.

**Tech Stack:** Python 3.12 stdlib `urllib`, APScheduler, Node.js ESM, `node:test`, shell deployment scripts, systemd env files, Hermes lite/full profiles.

---

## Verified Facts And References

- User-provided server log for 2026-07-09 10:00 proves `ai_daily_digest_job` started and failed before Node/Feishu/Hermes, at `load_aihot_facts()` fallback fetch with `urllib.error.URLError: <urlopen error [Errno -2] Name or service not known>`.
- User-provided follow-up proves `aihot.virxact.com` later resolved and `/api/public/daily` returned `HTTP/2 200`, so the failure is transient dependency failure plus missing job degradation, not a permanently bad endpoint.
- Python documents `URLError` as the base exception for `urllib.request` failures, and `socket.gaierror` as an address-resolution exception raised by `getaddrinfo()`: https://docs.python.org/3/library/urllib.error.html and https://docs.python.org/3/library/socket.html
- APScheduler `CronTrigger` fires when hour/minute/timezone fields match; changing the digest time is an env/deploy contract, not a runtime mystery: https://apscheduler.readthedocs.io/en/stable/modules/triggers/cron.html
- Node has native `AbortSignal.timeout(delay)`; the current local `sendChatToHermesApi()` already uses it, so keep this as a regression check, not a new feature: https://nodejs.org/api/globals.html#class-abortcontroller
- MCP Streamable HTTP sessions must reuse `Mcp-Session-Id` after initialization and reopen on 404; external MCP policy/execution must share the same session/activity context: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Cyberboss is useful only as a pattern for local runtime state, random/system wakes, deferred replies, and shared thread discipline; do not copy broad direct-send behavior. Its README lists `system-message-queue.json`, `deferred-system-replies.json`, and random wake behavior: https://github.com/WenXiaoWendy/cyberboss

## First Principles

1. A visible action claim needs trusted runtime evidence. If evidence is missing, bridge text must not impersonate Hermes or expose internal reasoning.
2. A promise to reply later needs durable state and a delivery record. If there is no durable task, do not send a quick ack that promises a future result.
3. External dependencies fail. Scheduled jobs must turn transient network failures into structured skip/failure telemetry, not uncaught scheduler exceptions.
4. Long-lived model/provider sessions must be bounded by measured provider input, not only by client prompt size.
5. Server deployment has one source of truth: `scripts/apply-hermes-runtime-split.sh` plus diagnostics. Manual `.env` edits are not the plan.

## Execution Model

- Worker A: Python scheduler, AI daily digest, deploy env, digest diagnostics.
- Worker B: Bridge notices, quick ack, Feishu/WeChat reply-window tests.
- Worker C: Hermes lite session auto-reset, external MCP policy/session/activity/game tests.
- Reviewer: after every phase, run the adversarial checklist in that phase before the next phase starts.

Subagents are recommended during implementation because these lanes touch different files. The main agent must review and integrate every diff.

## File Map

- Modify `src/personal_agent/ai_daily_digest.py`: retry and structured failure for AIHOT facts; no uncaught network exception from `run_ai_daily_digest()`.
- Modify `tests/test_ai_daily_digest.py`: regression tests for transient DNS failure, fallback success, and no sent marker on facts failure.
- Modify `src/personal_agent/config.py` and `tests/test_config.py`: set the default digest hour to 8 and update scheduler assertions to 08:00.
- Modify `scripts/apply-hermes-runtime-split.sh`: manage `AI_DAILY_DIGEST_ENABLED/HOUR/MINUTE` through `RAN_AGENT_DEPLOY_*` defaults, `is_managed_env_key`, env upserts, and systemd-visible env where needed.
- Create `scripts/diagnose-ai-daily-digest.sh`: script-first diagnostics for env, next cron config, AIHOT reachability, Feishu target path, and recent logs.
- Modify `.env.example`, `docs/governance/server_runtime_commands.md`, and `docs/governance/current_runtime_status.md`: keep public docs aligned with deploy behavior.
- Modify `node_bridge/src/actionContract.mjs` and `node_bridge/tests/actionContract.test.mjs`: replace first-person/internal bridge rewrites with neutral notices.
- Modify `node_bridge/src/quickAck.mjs`, `node_bridge/src/index.mjs`, `node_bridge/src/feishuBridge.mjs`, `node_bridge/tests/index.test.mjs`, and `node_bridge/tests/feishuBridge.test.mjs`: quick ack remains default-off; when enabled, it must not promise a final unless the final path is active and logged.
- Modify `node_bridge/src/hermesGatewayClient.mjs`, `node_bridge/src/hermesSessionMaintenance.mjs`, `node_bridge/tests/hermesGatewayClient.test.mjs`, and `node_bridge/tests/hermesSessionMaintenance.test.mjs`: auto-trigger lite soft reset after provider accumulation warnings with cooldown.
- Modify existing external MCP files under `node_bridge/src/externalMcp/` and `node_bridge/tests/externalMcp*.test.mjs`: policy/call parity, upstream session reuse, activity-id first game calls, CedarToy alias/tool classification, and `life` chat-profile alias handling without security escalation.

## Phase 0: Baseline And Evidence Lock

- [ ] **Step 1: Record current local state**

Run:

```bash
git status --short
```

Expected before implementation: note existing local edits to `scripts/hermes-lite-soft-reset.sh` and `node_bridge/tests/searchHubApplyScript.test.mjs`; do not overwrite them.

- [ ] **Step 2: Run the current focused baseline**

Run:

```bash
python -m unittest tests.test_ai_daily_digest tests.test_config
node --test node_bridge/tests/actionContract.test.mjs node_bridge/tests/index.test.mjs node_bridge/tests/feishuBridge.test.mjs node_bridge/tests/hermesGatewayClient.test.mjs node_bridge/tests/hermesSessionMaintenance.test.mjs
node --test node_bridge/tests/searchHubApplyScript.test.mjs
```

Expected: record failures before changing behavior. If unrelated failures appear, inspect before editing.

- [ ] **Step 3: Adversarial review**

Check:

- Are we fixing an observed failure, not a guessed one?
- Are any runtime secrets, tokens, raw logs, or state files being copied into git?
- Is any task trying to add a generic framework where existing scheduler/activity state is enough?

## Phase 1: AI Daily Digest Resilience And 08:00 Deploy Contract

**Root cause:** transient AIHOT DNS failure reached the second fallback fetch uncaught, so APScheduler reported an exception and no digest was sent.

- [ ] **Step 1: Add failing Python tests for facts-source failure**

In `tests/test_ai_daily_digest.py`, import `urllib.error` and add:

```python
def test_run_ai_daily_digest_skips_without_throwing_when_facts_unavailable(self) -> None:
    outbound = StubDigestOutboundClient()

    def failing_loader() -> str:
        raise urllib.error.URLError("temporary DNS failure")

    result = run_ai_daily_digest(
        config=self.config,
        database=self.database,
        outbound_client=outbound,
        logger=self.logger,
        now_local=datetime(2026, 7, 9, 8, 0, 0),
        facts_loader=failing_loader,
    )

    self.assertFalse(result["sent"])
    self.assertEqual(result["reason"], "facts_unavailable")
    self.assertEqual(outbound.sent_facts, [])
    sent_key = f"{AI_DAILY_DIGEST_SENT_PREFIX}2026-07-09"
    self.assertIsNone(self.database.get_handoff_value(sent_key))
```

Run:

```bash
python -m unittest tests.test_ai_daily_digest -v
```

Expected: fail because `run_ai_daily_digest()` still lets facts loader exceptions escape.

- [ ] **Step 2: Add failing Python tests for AIHOT fallback behavior**

In `tests/test_ai_daily_digest.py`, import `io`, `socket`, and `load_aihot_facts`. Add a tiny response helper:

```python
class StubHttpResponse:
    def __init__(self, payload: str) -> None:
        self.payload = payload.encode("utf-8")

    def __enter__(self) -> "StubHttpResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def read(self) -> bytes:
        return self.payload
```

Add:

```python
def test_load_aihot_facts_falls_back_after_daily_dns_failure(self) -> None:
    calls: list[str] = []

    def urlopen(request, timeout=20):
        calls.append(request.full_url)
        if request.full_url.endswith("/daily"):
            raise urllib.error.URLError(socket.gaierror(-2, "Name or service not known"))
        return StubHttpResponse('{"items":[{"title":"Model news","summary":"Short summary","source":"Lab","url":"https://example.test"}]}')

    facts = load_aihot_facts(urlopen=urlopen)

    self.assertEqual(len(calls), 2)
    self.assertIn("Model news", facts)
    self.assertIn("Short summary", facts)
```

Run:

```bash
python -m unittest tests.test_ai_daily_digest -v
```

Expected: fallback test may pass today; the next step still adds retries and clearer errors.

- [ ] **Step 3: Implement minimal digest resilience**

In `src/personal_agent/ai_daily_digest.py`:

- Catch `Exception` around `facts_loader().strip()` inside `run_ai_daily_digest()`.
- Log `AI daily digest facts unavailable error=%s`.
- Return `{"sent": False, "reason": "facts_unavailable", "date": local_date}`.
- Do not write the sent marker when facts fail.
- In `load_aihot_facts()`, catch the second endpoint the same way as the first and raise `RuntimeError("AIHOT facts unavailable")` from the last error.
- Add a simple two-attempt retry inside `_fetch_json()` or around each endpoint. Use stdlib only; no new dependency.

Implementation shape:

```python
FETCH_RETRY_COUNT = 2

def _fetch_json(url: str, opener: Callable[..., object]) -> dict[str, object]:
    last_error: Exception | None = None
    for attempt in range(FETCH_RETRY_COUNT):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": AIHOT_USER_AGENT})
            with opener(request, timeout=20) as response:
                raw = response.read().decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("AIHOT response must be an object")
            return payload
        except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as error:
            last_error = error
    raise RuntimeError("AIHOT fetch failed") from last_error
```

Keep retry count low: two attempts handles DNS/cache flickers without hiding a real outage.

- [ ] **Step 4: Manage 08:00 digest env in deploy script**

In `scripts/apply-hermes-runtime-split.sh`, add defaults near other deploy defaults:

```bash
AI_DAILY_DIGEST_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_ENABLED:-true}"
AI_DAILY_DIGEST_HOUR_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_HOUR:-8}"
AI_DAILY_DIGEST_MINUTE_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_MINUTE:-0}"
```

Add keys to `is_managed_env_key`:

```bash
AI_DAILY_DIGEST_ENABLED|AI_DAILY_DIGEST_HOUR|AI_DAILY_DIGEST_MINUTE
```

Upsert into the root runtime env file that Python service reads:

```bash
"AI_DAILY_DIGEST_ENABLED=$AI_DAILY_DIGEST_ENABLED_DEFAULT"
"AI_DAILY_DIGEST_HOUR=$AI_DAILY_DIGEST_HOUR_DEFAULT"
"AI_DAILY_DIGEST_MINUTE=$AI_DAILY_DIGEST_MINUTE_DEFAULT"
```

If the generated Python systemd unit has explicit `Environment=` lines for scheduler keys, add the same values there. If it only uses `EnvironmentFile=/opt/ran_agent/.env.local`, do not duplicate.

- [ ] **Step 5: Add daily digest diagnostics**

Create `scripts/diagnose-ai-daily-digest.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${RAN_AGENT_ROOT:-/opt/ran_agent}"
cd "$ROOT"

if [ -f "$ROOT/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT/.venv/bin/activate"
fi

echo "== ai daily digest env =="
grep -E '^(AI_DAILY_DIGEST|NODE_BRIDGE_OUTBOUND_BASE_URL|FEISHU_BRIDGE_ENABLED|FEISHU_LARK_CLI_IDENTITY|RAN_AGENT_STATE_DIR)=' "$ROOT/.env.local" "$ROOT/node_bridge/.env.local" 2>/dev/null || true

echo "== aihot dns =="
getent hosts aihot.virxact.com || true

echo "== aihot daily head =="
curl -I --max-time 20 https://aihot.virxact.com/api/public/daily || true

echo "== feishu home dm target =="
find "$ROOT/.ran_agent_state" -path '*/node-bridge-runtime/feishu-home-dm-target.json' -print 2>/dev/null | tail -20 || true

echo "== recent python digest logs =="
journalctl -u ran-agent-python.service --since '24 hours ago' --no-pager | grep -E 'AI daily digest|ai_daily_digest|facts unavailable|Job "ai_daily_digest' || true
```

Run locally for syntax only:

```bash
bash -n scripts/diagnose-ai-daily-digest.sh
```

- [ ] **Step 6: Update docs and env examples**

Update:

- `.env.example`: set `AI_DAILY_DIGEST_HOUR=8`; keep `AI_DAILY_DIGEST_ENABLED=false` for sample safety unless deploy script intentionally documents production true.
- `docs/governance/server_runtime_commands.md`: document the 08:00 production default and add `bash scripts/diagnose-ai-daily-digest.sh` to rollout diagnostics.
- `docs/governance/current_runtime_status.md`: update the default time statement.

- [ ] **Step 7: Verify Phase 1**

Run:

```bash
python -m unittest tests.test_ai_daily_digest tests.test_config -v
bash -n scripts/apply-hermes-runtime-split.sh
bash -n scripts/diagnose-ai-daily-digest.sh
node --test node_bridge/tests/searchHubApplyScript.test.mjs
```

Expected: all pass.

- [ ] **Step 8: Phase 1 adversarial review**

Check:

- Does any AIHOT failure still escape `run_ai_daily_digest()`?
- Is the sent marker written only after Node bridge accepts the scheduled digest?
- Does `apply-hermes-runtime-split.sh` make 08:00 reproducible on a fresh server?
- Did the plan avoid embedding live AIHOT response bodies or private Feishu targets in git?

## Phase 2: Bridge Notices And Quick Ack De-Noise

**Root cause:** action gate safe rewrites are sent as user-visible bridge text, and quick ack promised delayed results without durable completion guarantees.

- [ ] **Step 1: Add failing tests for non-persona bridge rewrites**

In `node_bridge/tests/actionContract.test.mjs`, update the memory write expectation:

```js
assert.equal(gate.rewrittenText, '保存结果尚未返回，未写入长期记忆。');
assert.doesNotMatch(gate.rewrittenText, /我|臣|不能说|已经保存/);
```

Add equivalent checks for media generation, external send, and external MCP write rewrites:

```js
assert.doesNotMatch(gate.rewrittenText, /我|臣|不能说|tool|MCP|token|provider/i);
```

Run:

```bash
node --test node_bridge/tests/actionContract.test.mjs
```

Expected: fail on old "暂不能说" strings.

- [ ] **Step 2: Replace unsafe bridge wording**

In `node_bridge/src/actionContract.mjs`, change only `missingEvidenceRewriteForIntent()` and failed outbound wording. Use neutral text:

```js
case 'media_generate':
  return '生成结果尚未返回，暂未发送成品。';
case 'memory_write':
  return '保存结果尚未返回，未写入长期记忆。';
case 'external_send':
  return '发送结果尚未确认，未发送给外部对象。';
case 'external_mcp_write':
  return '外部操作结果尚未确认，未执行外部写入。';
```

Keep the invariant: no evidence means no completion claim.

- [ ] **Step 3: Quick ack stays default-off and non-promissory**

In `node_bridge/src/quickAck.mjs`, change fallback text to a non-promissory status:

```js
const ackText = String(env.NODE_BRIDGE_QUICK_ACK_TEXT || '收到，正在处理。').trim()
  || '收到，正在处理。';
```

Update `.env.example`, `scripts/apply-hermes-runtime-split.sh`, and `docs/governance/server_runtime_commands.md` to the same text. Keep `NODE_BRIDGE_QUICK_ACK_ENABLED=false`.

- [ ] **Step 4: Keep async final tests, add failure observability**

In `node_bridge/tests/index.test.mjs` and `node_bridge/tests/feishuBridge.test.mjs`, keep the existing explicit opt-in quick ack tests. Add one test where async final rejects and assert a warning is logged once, without claiming success to the user.

Run:

```bash
node --test node_bridge/tests/actionContract.test.mjs node_bridge/tests/index.test.mjs node_bridge/tests/feishuBridge.test.mjs
```

- [ ] **Step 5: Phase 2 adversarial review**

Check:

- No bridge-authored text contains `我`, `臣`, `不能说`, provider names, token hints, raw tool paths, or session IDs.
- Quick ack default is false in `.env.example`, deploy script defaults, docs, and diagnostics.
- If quick ack is enabled manually, there is no wording that promises final delivery unless the final delivery path is actually attempted and logged.

## Phase 3: Hermes Lite Session Auto-Governance

**Root cause:** provider token accumulation is detected but only logged; it does not trigger the already-existing lite soft reset.

- [ ] **Step 1: Add failing telemetry-to-reset test**

In `node_bridge/tests/hermesGatewayClient.test.mjs`, add a test near the existing provider accumulation test:

```js
test('provider accumulation warning schedules lite soft reset once', async () => {
  const stateDir = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'auto-soft-reset-'));
  const logs = [];
  const warns = [];
  await sendChatToHermesGateway(
    { text: 'hello', sender_id: 'auto-reset', conversation_id: 'auto-reset', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        HERMES_LITE_SOFT_RESET_ENABLED: 'true',
        HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
        RAN_AGENT_STATE_DIR: stateDir,
      }),
      fetchImpl: async () => makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 350000, completion_tokens: 45, total_tokens: 350045 },
      }),
      logger: { log(line) { logs.push(line); }, warn(line) { warns.push(line); } },
    }
  );

  assert.ok(warns.some((line) => line.includes('possible_server_session_accumulation')));
  assert.ok(fs.existsSync(path.join(stateDir, 'hermes', 'session_maintenance.json')));
});
```

Run:

```bash
node --test node_bridge/tests/hermesGatewayClient.test.mjs
```

Expected: fail because logging does not reset.

- [ ] **Step 2: Return telemetry and trigger reset**

In `node_bridge/src/hermesGatewayClient.mjs`:

- Make `logProviderUsageTelemetry()` return the telemetry payload object.
- Import `runHermesLiteSoftReset`.
- After successful `parseHermesJson()` and telemetry logging, if:
  - `telemetry.possible_server_session_accumulation === true`
  - `config.softResetEnabled === true`
  - `options.softResetResume !== true`
  - there is no pending unconsumed digest
  then call:

```js
runHermesLiteSoftReset({
  action: 'apply',
  env: { ...process.env, ...configToSoftResetEnv(config) },
  reason: 'provider_session_accumulation',
});
```

If creating `configToSoftResetEnv()` would be larger than passing the original env through options, pass `env` from `sendChatToHermesGateway()` into `sendChatToHermesApi()` instead. Prefer the smaller root-cause change.

- [ ] **Step 3: Add cooldown only if needed**

If tests show repeated resets in a single request loop, add a timestamp in existing `hermes/session_maintenance.json` and skip if the last reset reason was `provider_session_accumulation` within 30 minutes.

Do not add a separate state file.

- [ ] **Step 4: Verify existing soft reset script patch**

Keep the existing local patch that loads `/opt/ran_agent/.env.local` and `node_bridge/.env.local` in `scripts/hermes-lite-soft-reset.sh`. Verify:

```bash
node --test node_bridge/tests/searchHubApplyScript.test.mjs
node --test node_bridge/tests/hermesSessionMaintenance.test.mjs node_bridge/tests/hermesGatewayClient.test.mjs
```

- [ ] **Step 5: Phase 3 adversarial review**

Check:

- Auto-reset does not run on every request.
- Auto-reset does not consume or expose raw conversation text beyond existing digest behavior.
- Reset state remains under ignored `.ran_agent_state`.
- No provider token counts, session IDs, or digest paths are sent to the user.

## Phase 4: External MCP And Game Autonomy

**Root cause:** games need a durable activity loop. Same-session policy explain/call, upstream session reuse, activity evidence, and notify egress must line up.

**Profile vocabulary note:** `life` is a chat/lifecycle context label in this repo, not an external-MCP security profile. The gateway security profiles remain `lite`, `full`, and `owner_full`. A user-visible or model-supplied `life` profile must not fail schema validation, and must not grant extra permissions. With a live `sessionId` or `activityId`, trusted session/activity context wins. Without live context, `mcp_explain_policy(profile: "life")` is hypothetical and may normalize to the configured default full/lite runtime profile while reporting the alias.

**Game-profile note:** Do not solve spicy-monopoly by changing the whole lite Hermes runtime to `full`. Current registry classification makes sandbox game tools `T3/full/sandbox_activity`, which blocks lite. The safer fix is policy-scoped: a trusted `game_play` scoped grant may allow `T3` `sandbox_activity` tools in lite, bounded by activity budget and allowed tool pattern. `account`, `T4`, and `T5` tools remain denied or confirmation-gated.

- [ ] **Step 1: Policy/call parity tests**

In existing `node_bridge/tests/externalMcp*.test.mjs`, ensure tests cover:

```js
// mcp_explain_policy({ serverId, toolName: 'list_games', sessionId })
// and mcp_call({ serverId, toolName: 'listgames', sessionId })
// both resolve the same policy context and final decision.
```

Expected safe CedarToy read/game tools:

```js
['listgames', 'list_games', 'getguide', 'play']
```

Expected quarantined tool:

```js
['account']
```

Add a policy regression for tonight's game blocker:

```js
const liteGrantedGame = evaluateExternalMcpPolicy({
  profile: 'lite',
  trigger: 'activity',
  sessionMode: 'interactive',
  tool: {
    serverId: 'spicy-monopoly',
    name: 'play',
    tier: 'T3',
    profileScope: 'full',
    proactiveAllowed: true,
    confirmationRequired: false,
    reason: 'sandbox_activity',
  },
  scopedGrant: trustExternalMcpScopedGrant({
    grantId: 'grant-spicy-game',
    kind: 'game_play',
    serverId: 'spicy-monopoly',
    mode: 'interactive',
    allowedToolPattern: '^(?:listgames|getguide|play)$',
    expiresAt: '2026-07-09T23:59:00Z',
  }),
});

assert.equal(liteGrantedGame.allowed, true);
assert.equal(liteGrantedGame.scopedGrantId, 'grant-spicy-game');
```

And keep the account boundary closed:

```js
const liteAccount = evaluateExternalMcpPolicy({
  profile: 'lite',
  trigger: 'activity',
  sessionMode: 'interactive',
  tool: {
    serverId: 'spicy-monopoly',
    name: 'account',
    tier: 'T5',
    profileScope: 'owner_full',
    proactiveAllowed: false,
    confirmationRequired: true,
    reason: 'unclassified_or_high_risk',
  },
  scopedGrant: trustExternalMcpScopedGrant({
    grantId: 'grant-spicy-game',
    kind: 'game_play',
    serverId: 'spicy-monopoly',
    mode: 'interactive',
    allowedToolPattern: '^(?:listgames|getguide|play)$',
    expiresAt: '2026-07-09T23:59:00Z',
  }),
});

assert.equal(liteAccount.allowed, false);
```

Implement by checking a valid `game_play` grant before the generic profile-rank denial, but only for `tier === 'T3'` and `reason === 'sandbox_activity'`.

- [ ] **Step 1a: Life profile alias test**

Add a gateway test proving the earlier "life profile unsupported" failure cannot recur:

```js
const explain = await callGatewayTool('mcp_explain_policy', {
  serverId: 'cedartoy-games',
  toolName: 'listgames',
  profile: 'life',
});

assert.equal(explain.ok, true);
assert.equal(explain.context_source, 'hypothetical');
assert.equal(explain.profile_alias, 'life');
assert.match(['lite', 'full', 'owner_full'], explain.profile);
assert.notEqual(explain.profile, 'owner_full');
```

Add a second test with a live lite session:

```js
const session = await callGatewayTool('mcp_open_session', {
  globalUserId: 'ran',
  serverId: 'cedartoy-games',
  mode: 'interactive',
});
const explain = await callGatewayTool('mcp_explain_policy', {
  serverId: 'cedartoy-games',
  toolName: 'listgames',
  sessionId: session.sessionId,
  profile: 'life',
});

assert.equal(explain.context_source, 'session');
assert.equal(explain.profile, 'lite');
```

If the current tool schema rejects `"life"` before the handler sees it, extend only the `mcp_explain_policy.profile` schema to accept `"life"` and normalize it in policy context resolution. Do not add a new `life` security rank.

- [ ] **Step 2: Activity-id first game calls**

Update external MCP gateway schema/tests so background activity calls can supply `activityId` without public `sessionId`. The executor must derive the private local session and its private upstream session.

Acceptance:

```js
assert.equal(publicResult.upstreamSessionId, undefined);
assert.equal(publicEvidence.includes('Mcp-Session-Id'), false);
```

- [ ] **Step 3: Upstream Streamable HTTP session reuse**

Store `upstreamSessionId` only on the private local session record. Reuse it for Streamable HTTP requests. On upstream HTTP 404, initialize once and retry once, matching MCP session guidance.

Do not expose upstream session in public session output or evidence.

- [ ] **Step 4: Game activity notify quality**

Change proactive activity notify behavior so one game tick sends at most one user-visible message, with enough detail:

- current game/state summary
- action taken
- result
- next intent or stop reason

Keep `HERMES_PROACTIVE_NOTIFY_MAX_CHARS` as the upper bound; do not send 3 to 4 tiny fragments.

- [ ] **Step 5: Phase 4 adversarial review**

Check:

- `account` and other credential/account tools fail closed.
- Alias matching is exact first, compact unique second, collision deny.
- Activity grants do not permit T4/T5 actions without explicit pending/authorization.
- Evidence refs are trusted and fresh; spoofed refs fail.
- Visible proactive messages still pass deterministic egress review.

## Phase 5: Full Local Gate, Docs, And Server One-Shot

- [ ] **Step 1: Run full focused local gate**

Run:

```bash
python -m unittest tests.test_ai_daily_digest tests.test_config
node --test node_bridge/tests/externalMcp*.test.mjs node_bridge/tests/actionContract.test.mjs node_bridge/tests/replyBackend.test.mjs node_bridge/tests/channelHub.test.mjs node_bridge/tests/outboundServer.test.mjs node_bridge/tests/hermesGatewayClient.test.mjs node_bridge/tests/hermesSessionMaintenance.test.mjs node_bridge/tests/index.test.mjs node_bridge/tests/feishuBridge.test.mjs node_bridge/tests/searchHubApplyScript.test.mjs
bash -n scripts/apply-hermes-runtime-split.sh
bash -n scripts/diagnose-ai-daily-digest.sh
bash scripts/diagnose-external-mcp-gateway.sh
```

- [ ] **Step 2: Documentation governance check**

Run:

```bash
rg -n 'AI_DAILY_DIGEST|NODE_BRIDGE_QUICK_ACK|HERMES_LITE_SOFT_RESET|external MCP|CedarToy' .env.example docs/governance scripts
```

Expected:

- 08:00 digest is documented.
- quick ack default is off and text is non-promissory.
- soft reset behavior is documented as automatic on provider accumulation.
- no docs tell operators to hand-edit server env instead of running the deploy script.

- [ ] **Step 3: Final adversarial review**

Check:

- T4/T5 actions remain blocked without explicit authorization.
- `PERSONAL_AGENT_PROACTIVE_ENABLED=false` remains frozen.
- Approved proactive paths are only reminder/digest/external-MCP system queue/activity paths.
- No credential/session/log/state file enters git.
- Deployment script owns every new env key through defaults, managed-key filtering, and upserts.
- The implementation did not add a generic durable queue without a measured need.

- [ ] **Step 4: Commit and archive**

Use the repo archive workflow, not ad hoc git:

```bash
./scripts/archive_and_push.sh
```

If the archive skill requires a main merge before push, follow its current `archive-and-push` contract.

- [ ] **Step 5: One-shot server rollout**

On the server, run exactly:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull --ff-only
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-ai-daily-digest.sh
bash scripts/diagnose-external-mcp-gateway.sh
bash scripts/diagnose-multi-frontend.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-ombre-memory.sh
```

Expected server results:

- `AI_DAILY_DIGEST_ENABLED=true`
- `AI_DAILY_DIGEST_HOUR=8`
- `NODE_BRIDGE_QUICK_ACK_ENABLED=false`
- `HERMES_LITE_SOFT_RESET_ENABLED=true`
- AIHOT diagnostics either show HTTP 200 or a structured failure, never an uncaught scheduler exception.
- Feishu home DM target is found under `.ran_agent_state/node-bridge-runtime/feishu-home-dm-target.json` or a clearly reported missing-target reason.

## Out Of Scope For This Plan

- A broad generic durable queue for every possible long-running Hermes reply. V1 fixes false promises by keeping quick ack off, and uses durable scheduled digest plus external MCP activity where the current system already has state.
- Enabling broad legacy proactive chat. Keep `PERSONAL_AGENT_PROACTIVE_ENABLED=false`.
- Copying Cyberboss direct-send behavior. Only copy its local-state and wake/queue discipline.
