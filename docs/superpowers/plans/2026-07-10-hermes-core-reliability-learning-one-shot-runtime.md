# Hermes Core Reliability And Learning Implementation Plan

Status: HISTORICAL IMPLEMENTATION PLAN (2026-07-13)

This is a contemporaneous execution plan, not current runtime truth. Components
from it landed in the deployed reliability release at
`3f6e7b705854838d9a1e8b466d959f7ead41b643`, but unchecked tasks remain design
and audit work. Use `docs/governance/current_runtime_status.md` for production
facts; do not treat this checklist as a complete-release assertion.

> **Execution rule:** Use `superpowers:subagent-driven-development` one task at a
> time and `superpowers:test-driven-development` for every behavior change. Do
> not mutate production, archive, or push. After both Core and External plans
> pass their local gates and four pre-deploy reviews, one local immutable
> candidate commit may be created for deployment; GitHub push remains forbidden
> until live acceptance and the post-deploy evidence review pass.

**Goal:** Make Hermes action claims, confirmations, durable promises, delivery
history, personal learning, routing, and deployment truthful and recoverable,
without asking the user to choose profiles, copy IDs, interpret policy, or
repeat a goal.

**Architecture:** Preserve `ChannelHub -> replyBackend -> Hermes` as the visible
conversation path. The bridge owns trusted actor context, operation minting,
consent, private envelope processing, typed receipts, durable outbox, and
egress. Python SQLite is the single authority for ordinary Core jobs and
personal learning. The External supervisor owns only external-activity jobs.
There is no mirrored job truth, generic workflow framework, or second persona.

**Verified baseline:** Bundled Node `v24.14.0` passes the current 639 Node tests;
production runs Node 22. Official Node documentation shows `node:sqlite` became
flag-free in v22.13.0, so the supported floor is Node 22.13 plus explicit
feature probes and the same release suites, not an assumed Node 24 upgrade.
Python currently has 195 passes and 18 failures: 17 stale account-backed XHS
tests and one night-cycle result that points at a pre-carryover file. System
Node `v16.17.0` is unsupported and must fail preflight.

## Normative Reply Order

Every ordinary Hermes reply and every future autonomous checkpoint uses this
single pipeline:

```text
parse versioned private envelope
-> attach trusted actor
-> mint and execute/repair action or activity requests
-> commit durable jobs
-> bind claims/commitments to trusted receipts
-> semantic verifier
-> deterministic privacy gate
-> durable outbox and adapter
-> idempotent timeline/backend projections
```

No frontend, follow-up task, proactive event, digest, or External narrator may
skip this order.

## Task 1: Establish A Truthful, Isolated Baseline Gate

**Files:**

- Modify `node_bridge/package.json`
- Modify `node_bridge/src/runtimeState.mjs`
- Create `node_bridge/tests/helpers/isolatedState.mjs`
- Modify all tests that write checkout `.ran_agent_state`, especially
  `pendingActionState.test.mjs`, `channelHub.test.mjs`,
  `hermesSessionMaintenance.test.mjs`, `identityMap.test.mjs`, `index.test.mjs`,
  `feishuBridge.test.mjs`, and `outboundServer.test.mjs`
- Create `tests/conftest.py` production-path guard/isolated config helpers
- Rewrite `tests/test_xhs_browse.py`
- Modify `tests/test_night_cycle.py` and `src/personal_agent/night_cycle.py`
- Create `scripts/hermes-release-gate.sh`
- Modify `node_bridge/tests/searchHubApplyScript.test.mjs`
- Create `docs/governance/hermes_protected_capabilities.v1.json`
- Create `node_bridge/tests/protectedCapabilities.test.mjs`
- Create `tests/test_protected_data_boundaries.py`

- [ ] Add RED tests proving Node `<22.13` is rejected and Node 22 must pass required
  capability probes (including the actual `node:sqlite` API used by the repo),
  production paths are denied
  under test mode, every named Node test uses a unique temporary state root,
  and identity tests never fall back to `/opt/ran_agent`.
- [ ] Add a test-only external-state override that is accepted only when all of
  these are true: `NODE_ENV=test`, an explicit guard flag is set, and the
  canonical path is under the OS temp directory. Production behavior continues
  to require a project or managed server state path.
- [ ] Replace hard-coded checkout state paths with
  `createIsolatedTestEnv(t)`; register cleanup with `t.after`. Python tests use
  `tests/conftest.py::make_test_config(tmp_path, **overrides)`, which explicitly
  fills every required `AppConfig` path, rather than a partial constructor or an
  unused environment variable.
- [ ] Rewrite the XHS suite to prove account-backed scripts fail closed with
  `XHS_ACCOUNT_BACKED_DISABLED`, model-visible `xhs_browse_*` tools are absent,
  and the public-only fallback remains configured. Do not skip or xfail it.
- [ ] Make `NightCycleResult.knowledge_inbox_path` identify the final existing
  carryover artifact when one uniquely exists under the governed vault, or be
  empty when the knowledge action produced no durable artifact. Never return a
  known-nonexistent pre-move path.
- [ ] Implement `hermes-release-gate.sh` with `env -i`, explicit allowlisted
  `HOME/PATH/TMPDIR`, an absolute compatible Node binary, isolated state, and a
  fail-fast path guard. Copy the current tracked/unignored working tree to a
  read-only temporary source snapshot, then run each Node test file with its own
  state/TMPDIR and Python with an isolated `--basetemp`. It must not source
  `.env.local`, checkout virtualenvs, user/site customization, vault,
  credentials, production registry, or live state.
- [ ] Record the protected first-party capability manifest from current source
  behavior: exact full/lite membership, reserved MCP names, locally owned tool
  names/schemas, markers, launchers, and data owners. For upstream-owned Ombre,
  Playwright, time, and optional Obsidian surfaces, record sanitized live
  fingerprints at deployment rather than inventing a source tool list.
- [ ] Add non-regression tests for Search Hub/social/media routing, the complete
  public-only XHS and Bilibili degradation contracts, personal/Ombre/Obsidian
  boundaries, co-reading private/shared/Web/storage semantics, sticker/media
  markers, and exact full/lite exposure. These tests establish the incumbent
  behavior before any Core implementation changes it.
- [ ] Run the focused tests RED, implement the minimum fixes, then run the full
  Node and Python suites with the bundled Node. The exit code, not log text,
  determines success.

## Task 2: Add Validated Atomic State And Single Writers

**Files:**

- Create `node_bridge/src/atomicState.mjs`
- Create `node_bridge/tests/atomicState.test.mjs`
- Modify `runtimeState.mjs`, `pendingActionState.mjs`,
  `proactiveEventLedger.mjs`, `globalTimeline.mjs`, and
  `hermesSessionMaintenance.mjs`
- Modify `scripts/hermes-lite-soft-reset.sh` and its tests
- Modify `node_bridge/src/outboundServer.mjs` (authenticated local reset control
  route), `node_bridge/src/index.mjs` startup wiring, configuration, and exact
  endpoint/auth tests

- [ ] Write RED tests for missing, valid, incompatible, truncated, read-only
  old target, failed flush/rename/directory-flush, and corrupt critical state.
  Corruption must never silently become an empty authorization/job/outbox list.
- [ ] Implement one consistent API:

  ```js
  readJsonState(path, { validate, missingValue, critical })
  writeJsonAtomic(path, value, { validate, mode = 0o600 })
  appendJsonLine(path, value, { validate, mode = 0o600 })
  quarantineCorruptState(path, reason)
  ```

  Writes use same-directory temp files, file flush, atomic rename, and directory
  flush where supported.
- [ ] Migrate the listed Core state. Add a stable event/outbox key to global
  timeline entries so append is idempotent.
- [ ] Make the Node bridge the only soft-reset/session-maintenance state writer.
  The systemd/manual script requests a reset through a local authenticated
  control endpoint; it never edits the state file. Use revision/CAS to reject a
  stale reset completion. The endpoint is loopback-only, uses the same managed
  owner-only internal secret as other control calls, and is wired by `index.mjs`.
- [ ] Re-run focused tests and the isolated full gate.

## Task 3: Version Trusted Identity, Consent, And Pending Actions

**Files:**

- Modify `identityMap.mjs`, `channelHub.mjs`, `replyBackend.mjs`, and
  `pendingActionState.mjs`
- Modify their exact test files
- Add identity migration/preflight fixtures to deploy-script tests

- [ ] Add RED cases for foreign sender/platform/conversation, fallback identity,
  changed recipient/content/bounds, expiry, replay, multiple matches, and stale
  confirmation.
- [ ] Version the identity binding as explicit platform + hashed sender + global
  user + `owner` + provenance + `createdAt`. Legacy fallback may preserve chat
  continuity but is always `owner=false`; migration never infers owner from
  `user:ran`.
- [ ] Derive a private trusted actor context from adapter data only:

  ```js
  { actorKey, owner, platform, channelType, conversationKey, messageKey, receivedAt }
  ```

  No model/payload field can override it.
- [ ] Encode the confirmation policy in deterministic tests: exact bounded
  current-turn effects execute once without redundant confirmation; ambiguous
  third-party or new standing boundaries ask once for actor/target/payload/
  bounds; unbounded, changed, stale, or unauthorized effects are denied.
- [ ] Persist actor/platform/conversation/action digest/status/expiry and use CAS
  `pending -> confirmed -> executed|failed`. The same confirmation cannot run
  twice, and internal IDs/policy wording never appear in the prompt.
- [ ] Add production preflight that proves at least one owner binding exists and
  a foreign-sender canary is denied, while printing neither identity. Absence of
  a provable binding is a single explicit bootstrap blocker, never a guessed
  migration.

## Task 4: Build The Real Action-Request And Receipt Issuer Chain

**Files:**

- Create `node_bridge/src/operationLedger.mjs`
- Create `node_bridge/src/actionRequest.mjs`
- Create `node_bridge/src/actionReceipt.mjs`
- Create `node_bridge/src/trustedExecutorAdapters.mjs`
- Modify `hermesGatewayClient.mjs`, `replyBackend.mjs`, `actionContract.mjs`,
  `actionRepair.mjs`, and sticker/media executors
- Modify `src/personal_agent/http_server.py`, `service.py`, and memory write code
- Create exact Node/Python integration tests for operation, issuer, and replay

- [ ] Write RED tests where failed save/send plus unrelated success, a forged
  model receipt, copied MCP JSON, reused nonce, expired capability, wrong
  actor/action/scope/issuer, or
  an unauthenticated Python response cannot satisfy a claim.
- [ ] Capture and pin the deployed Hermes gateway tool-call/result contract.
  Prove with a real integration fixture whether it exposes a
  non-model-overridable execution trace or trusted call-context hook. Do not
  infer this from model text, copied MCP JSON, or mocked response examples. If
  no hook exists, effectful first-party operations require a bridge-owned
  authenticated adapter before Core may issue a receipt.
- [ ] Parse envelope-local `requestRef` values only as correlations. The bridge
  mints `operationId`, actor/scope digest, nonce, expiry, and a private executor
  capability; a model-supplied private identifier or consent decision is
  rejected.
- [ ] Implement the executor matrix instead of a generic “successful tool”:

  - Node sticker/media operations issue receipts only when a real bridge-owned
    executor result or verified non-model-overridable tool trace exists;
  - memory writes use a bridge-initiated, bounded, authenticated Python call and
    return a stable effect identifier;
  - current-channel delivery is issued by the durable outbox in Task 7;
  - External MCP operations are issued by the internal broker in the External
    plan;
  - unsupported arbitrary third-party sends fail closed rather than pretending
    an executor exists.

- [ ] Protect private Node/Python control calls with a deployment-managed
  owner-only secret file or equivalently restricted channel. The model never
  receives it. Synchronous responses are validated against the registered
  operation before the bridge issues a receipt.
- [ ] Require exact
  `operationId+actorKey+actionType+scopeDigest+evidenceType+status+issuer` binding.
  Module-private constructors alone are not treated as cross-process trust.
- [ ] Run real executor -> receipt -> reply integration tests; hand-constructed
  receipt fixtures are allowed only for unit validation, not the journey gate.
- [ ] Preserve every public MCP `tools/list`, input schema, structured result,
  `RAN_MEDIA`/`WECHAT_MEDIA` marker, and channel behavior. Receipt IDs, actor,
  nonce, capability, issuer, and evidence bindings remain private. Copied MCP
  JSON or a model-written marker can never mint a receipt; if the real tool-trace
  boundary is unavailable, retain the mature read/marker path and reject only
  the unsupported effect claim.

## Task 5: Implement One Versioned Envelope, Semantic Verifier, And Privacy Gate

**Files:**

- Create `semanticClaimVerifier.mjs` and `egressPrivacyGate.mjs`
- Create `replyMediaAttachments.mjs`
- Create their test files
- Modify `hermesGatewayClient.mjs`, `replyBackend.mjs`, `channelHub.mjs`, and all
  reply/checkpoint call sites

- [ ] Add RED tests for malformed/versionless envelopes, omitted declarations,
  arbitrary paraphrases, verifier timeout/bad JSON/disagreement, unsupported
  commitments, internal IDs/paths/policy dumps, and checkpoint narration trying
  to bypass the normal gate.
- [ ] Normalize exactly one private schema containing `message`,
  `actionRequests`, `activityRequest`, `claims`, and `commitments`. Collapse
  provider follow-up fragments into one coherent candidate before verification;
  remove the direct asynchronous follow-up send path.
- [ ] Process in the normative order at the top of this plan. Resolve each
  `requestRef` to a runtime-minted operation/job receipt before claim checking.
- [ ] Implement a bounded one-shot verifier that receives only final text,
  declaration types, and sanitized receipt summaries; it has no tools or full
  history. Configure explicit provider/base URL/model/timeout/concurrency keys.
- [ ] Add a deterministic privacy gate after semantic verification. Unless the
  trusted request is technical diagnostics, it removes private IDs, capability
  tokens, absolute runtime paths, policy dumps, and bridge repair instructions.
- [ ] Preserve trusted `RAN_MEDIA`/`WECHAT_MEDIA` markers and their adapter
  semantics by parsing them server-side into private typed attachments before
  verification/outbox, then stripping the marker from visible text. Model-forged
  or malformed markers are rejected. The verifier sees neither raw media paths
  nor private co-reading/browser authorization.
- [ ] Verifier failure releases one neutral bridge notice excluded from Hermes
  history. Unsupported claims get at most one bounded rewrite; finite phrase
  regexes are not semantic authority.
- [ ] Add a real endpoint preflight corpus for supported/unsupported paraphrases,
  strict schema/no-tools behavior, timeout rate, and p95 latency. Enforcement is
  enabled only after preflight; failure rolls back the release rather than
  leaving all chat fail-closed.

## Task 6: Add Single-Authority Durable Core Jobs And Remove Timeout Ack Races

**Files:**

- Modify `src/personal_agent/db.py`, `scheduler.py`, `jobs.py`, and
  `http_server.py`
- Create `src/personal_agent/durable_jobs.py` and `tests/test_durable_jobs.py`
- Create `node_bridge/src/durableJobClient.mjs` and its tests
- Modify `replyBackend.mjs`, `quickAck.mjs`, `index.mjs`, `feishuBridge.mjs`, and
  their tests

- [ ] Add RED tests for crash before row commit, before first wake, while leased,
  before terminal CAS, duplicate terminal, expired lease, and restart recovery.
- [ ] Make Python SQLite the only authority for ordinary Core jobs. Rows include
  actor/goal digest, state, `nextRunAt`, lease owner/until, revision, terminal
  state, and terminal result reference. A startup/due runner transactionally
  claims rows and reaches exactly one terminal state.
- [ ] APScheduler may wake the durable dispatcher, but scheduler memory is never
  job truth. Startup immediately scans due rows.
- [ ] Node queries or creates a job through the authenticated private Python
  adapter and consumes an immutable receipt; it does not maintain a mirrored
  “active job” JSON index. External supervisor jobs remain Node-owned and expose
  the same receipt shape without copying Python state.
- [ ] Delete the ordinary timeout-race quick acknowledgements in WeChat and
  Feishu. A natural acceptance reply may be returned only after the durable row
  and first wake are committed. Quick ack remains off for all other paths.
- [ ] Gate future-tense commitments by actor+goal+active job receipt and run the
  focused and restart suites.

## Task 7: Make Delivery And History Projection Durable

**Files:**

- Create `durableOutbox.mjs` and `durableOutbox.test.mjs`
- Modify `replyBackend.mjs`, `channelHub.mjs`, `index.mjs`, `wechatBridge.mjs`,
  `feishuBridge.mjs`, `desktopProxyServer.mjs`, `outboundServer.mjs`,
  `proactiveEventLedger.mjs`, `backendIngestClient.mjs`, and `globalTimeline.mjs`
- Modify `src/personal_agent/http_server.py`, `service.py`, and `db.py` for
  idempotent ingest
- Modify every corresponding test

- [ ] Before choosing commit semantics, verify the actual WeChat SDK, Feishu
  client/official API, and Desktop response behavior. Encode the observed return
  receipt and timeout boundary in fixtures; do not assume an idempotency field.
- [ ] Add RED fault injection before/after reserve, send-start, adapter return,
  sent commit, timeline projection, backend projection, and startup recovery.
- [ ] Persist:

  ```text
  delivery: reserved -> sending -> sent|failed|ambiguous
  projection: timeline pending|committed
  projection: backend  pending|committed
  ```

  with one stable outbox/operation key.
- [ ] Persist validated text and typed attachment references separately. Adapter
  results preserve typed text/media partial outcomes, and a text-only success
  cannot support “图片/语音已发送”. Raw marker text, local paths, and remote URLs
  never enter normal timeline/history.
- [ ] Classify per platform: known pre-send rejection is `failed`; a WeChat or
  Feishu timeout after the effect may have occurred is `ambiguous`; Desktop is
  committed at the verified response-finish boundary and close-before-finish is
  classified from whether bytes were handed off. Retry only known failed,
  idempotent operations. If verified Feishu supports a stable idempotency key,
  derive it from outbox ID; otherwise use ambiguity/reconciliation, not fiction.
- [ ] Adapter `sent` commits before projections. Timeline and Python ingest both
  accept outbox ID and dedupe. Startup projects `sent` items with incomplete
  flags and never resends merely to repair history.
- [ ] Route ordinary replies, collapsed follow-ups, proactive events, reminders,
  digests, and External checkpoints through this same outbox. The proactive
  ledger may dedupe source events but cannot claim delivery.
- [ ] Keep non-channel surfaces outside the outbox: Co Reading Web responses,
  browser/owner tokens, private annotations, gzip book bodies, and internal
  knowledge maintenance remain with their current owners. Only a real
  Hermes-authored channel reply enters the delivery state machine.
- [ ] Bind a Core durable job's final result to at most one outbox item and test
  final-delivery dedupe and restart recovery here, after the outbox exists.
- [ ] Run every crash point twice and prove no false-sent history, blind retry,
  duplicate projection, or lost sent history.

## Task 8: Implement One Evidence-Backed Personal Learning Lifecycle

**Files:**

- Create `src/personal_agent/personal_learning.py` and its tests
- Modify `db.py`, `memory.py`, `memory_llm.py`, `memory_specialist.py`,
  `reflection_specialist.py`, `night_cycle.py`, `service.py`, and `http_server.py`
- Modify the Node action-request memory adapter and integration tests

- [ ] Add RED tests for explicit correction, repeated observation threshold,
  contradiction, expiry, atomic supersession, forgetting, “what do you
  remember”, poisoned raw tool/log/path/secret input, and active-only recall.
- [ ] Store the smallest SQLite schema for
  `candidate -> active -> superseded|forgotten`, with subject key, sanitized
  statement, source, evidence digests, confidence, timestamps, and superseded ID.
- [ ] Make memory LLM, reflection, and night cycle candidate producers only.
  Exactly one deterministic promotion service can activate/supersede. Explicit
  user corrections may activate immediately; inferred preferences require
  repeated non-contradictory evidence.
- [ ] Connect remember/correct/forget/query commands through the trusted action
  request and Python API so they produce real typed receipts. No direct legacy
  profile/preference writer may bypass the lifecycle.
- [ ] Apply candidate/active semantics only to newly promoted stable personal
  facts. Preserve existing Ombre buckets, SQLite memories, knowledge-agent
  artifacts, vault documents, co-reading deposits, and their current recall
  owners. Legacy producers use a compatibility adapter for new promotable facts;
  they are not disabled or bulk-migrated.
- [ ] Project active personal-learning preferences idempotently into the current
  `preference_profile.json`/Markdown compatibility views used by existing
  readers. Promotion failure does not block ordinary chat, Ombre recall, night
  cycle carryover, or Knowledge Agent `plan -> apply -> cleanup`.
- [ ] Recall only bounded relevant active learning records in the new learning
  view. Ordinary memory recall, Ombre fallback, and explicit vault search retain
  their current semantics. Capability experiences remain in the External store.

## Task 9: Close Digest, Routing, Reset, And Managed-Config Drift

**Files:**

- Modify `src/personal_agent/ai_daily_digest.py` and tests
- Modify `hermesGatewayClient.mjs`, `hermesSessionMaintenance.mjs`, and tests
- Modify `scripts/apply-hermes-runtime-split.sh`,
  `diagnose-lite-full.sh`, and `diagnose-ai-daily-digest.sh`

- [ ] Add RED tests proving facts failure creates an honest partial digest,
  sent markers require outbox `sent`, managed schedule is `08:00 Asia/Shanghai`,
  and adapter failure leaves it unsent.
- [ ] Remove natural-language “lite/full” words as routing authority. Route from
  trusted task metadata and policy; a failed preferred endpoint retries the same
  operation/actor/scope on the allowed fallback without asking the user to
  restate or choose a model. Stronger reasoning never widens authority.
- [ ] Pair every provider accumulation warning with a committed Node-owned reset
  request and resume digest. Timer/manual paths call the same owner endpoint.
- [ ] Add managed verifier keys and strict diagnostics. Critical diagnostic
  failures return nonzero; apply fixtures remain idempotent and redact values.
- [ ] Freeze the effective server Ombre revision/requirements and current
  Playwright/time/optional-Obsidian versions for this release. Prevent
  `prepare-ombre-brain.sh` or service restart from pulling/reinstalling a new
  upstream. Upgrades are separate changes with their own provenance and tests.
- [ ] Keep ordinary quick ack disabled and run the apply fixture twice.

## Task 10: Build The Core Adversarial Journey Gate

**Files:**

- Create `node_bridge/tests/coreReliabilityJourney.test.mjs`
- Create `tests/test_core_reliability_journey.py`
- Create `scripts/hermes-release-smoke.mjs`
- Modify `scripts/hermes-release-gate.sh`

- [ ] Encode all 21 Core spec invariants plus real executor-to-receipt journeys,
  every outbox/projection crash point, owner fallback denial, durable-job restart,
  verifier preflight failure, route fallback, learning correction, and
  production-path guards.
- [ ] Run the explicit protected-capability baseline: source profile/schema/data
  boundary tests plus existing XHS/Bilibili/media/Search Hub/co-reading/
  personal-memory/Ombre/knowledge/sticker suites. A high aggregate test count is
  not a substitute for this named matrix.
- [ ] Prove each journey first fails for the intended invariant rather than a
  fixture, syntax, or unsupported-Node error.
- [ ] Run:

  ```bash
  RAN_AGENT_NODE_BIN=/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
    bash scripts/hermes-release-gate.sh --core
  ```

  Require complete Node/Python suites under isolated state and zero real
  env/state/vault access.

## Task 11: Implement The One-Command Release Transaction Primitives

**Files:**

- Create `scripts/deploy-hermes-release.sh`
- Create `node_bridge/tests/hermesReleaseScript.test.mjs`
- Modify `scripts/apply-hermes-runtime-split.sh`
- Create the initial `scripts/accept-hermes-release.sh` contract; External plan
  adds real environment journeys

- [ ] Add RED fixture tests for failures at preflight, snapshot, copy-migration,
  permission/fsync smoke, unit write, restart, synthetic smoke, signal, and
  acceptance. Every post-snapshot failure restores the exact previous code,
  env/profile/unit, compatible state pointer, enabled/active service state, and
  health.
- [ ] The deploy command accepts only an immutable local candidate commit/digest,
  records previous commit, runs as the real service user, validates Node/Python,
  disk and owner binding, migrates state copies, atomically switches pointers,
  restarts, and invokes strict smoke/acceptance.
- [ ] Before mutation, capture a sanitized protected-capability snapshot:
  lite/full server/tool/schema hashes, upstream versions, Ombre revision and
  requirements, data-root realpath/owner/mode, and database schema only. Compare
  it after apply and after the rollback drill. Any unallowlisted drift restores
  the previous release before user traffic and forbids archive/push.
- [ ] Snapshot IDs and evidence are sanitized; secrets, identities, raw state,
  sessions, and content never enter logs or the bundle.
- [ ] `apply-hermes-runtime-split.sh` becomes a convergent lower-level function,
  not the user-facing release owner. Run two applies and every rollback fixture.

## Task 12: Core Documentation And Independent Review

**Files:**

- Update verified portions of runtime/governance docs only after behavior lands

- [ ] Run docs consistency, secret, absolute-private-path, and stale-status
  scans. Design status must not be described as production status.
- [ ] Dispatch fresh spec-compliance, security/trust-boundary, code-quality, and
  fault/release reviewers. Fix and re-review every finding.
- [ ] Do not create the deploy candidate yet. Continue with the External plan;
  the integrated local gate and four pre-deploy reviews happen before the one
  allowed candidate commit.
