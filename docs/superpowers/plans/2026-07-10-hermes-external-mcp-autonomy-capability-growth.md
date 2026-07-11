# Hermes External MCP Autonomy And Capability Growth Implementation Plan

> **Execution rule:** Start only after Core Tasks 1-10 are green. Use
> `superpowers:subagent-driven-development` sequentially and TDD for every
> production change. Do not activate a new MCP, mutate production, archive, or
> push before the integrated pre-deploy review. One local immutable candidate
> commit is permitted only after that review so the deploy transaction has a
> real candidate/previous revision.

**Goal:** Let Hermes accept one natural game or forum goal, continue it durably,
learn evidence-backed non-executable strategies, and ask once only when a real
new capability boundary is crossed. Hermes and the user never orchestrate MCP
sessions, tool names, activity IDs, profiles, transports, or recovery steps.

**Architecture:** `replyBackend` owns a versioned private `activityRequest`
sidecar because only the bridge has trusted actor/conversation context. One Node
supervisor owns goal, scope, lease, operation, checkpoint, experience, and
terminal state. Small evidence-derived drivers normalize each environment. The
existing registry/policy/session/executor/evidence components remain the
capability plane but become an internal broker, not Hermes's low-level autonomy
protocol. Every narrator/checkpoint returns through the Core reply/receipt/
privacy/outbox pipeline.

## Task 0: Build A Provider-Neutral MCP Conformance Corpus

**Files:**

- Create sanitized fixtures under
  `node_bridge/tests/fixtures/externalMcp/conformance/`
- Create `node_bridge/tests/fixtures/externalMcp/PROVENANCE.md`
- Update no runtime code in this task

- [ ] Capture sanitized live shapes from the currently configured CedarToy MCP
  plus diverse real/synthetic protocol fixtures: missing annotations, open
  schemas, text-only output, dynamic tools, no terminal, no idempotency, no
  observation tool, malformed result, read-only forum, effectful forum,
  credentialed/local-executable MCP, and embodied-style commands. Fixtures test
  adapter behavior; they do not select or ban a provider.
- [ ] Record fixture origin and whether each field is observed or synthetic.
  Remove credentials, account IDs, private content, session values, and raw
  logs. Never invent a provider-specific terminal/idempotency fact.
- [ ] Treat missing capability as a conformance mode (`ongoing`,
  `unknown_outcome`, `opaque_observation`, or `needs_boundary`), not a reason to
  disable the MCP. The same corpus must be reusable when future MCPs are added
  without changing this plan.

## Task 0A: Lock The Protected First-Party Capability Plane

**Files:**

- Modify `docs/governance/hermes_protected_capabilities.v1.json` only if current
  first-party source behavior proves the baseline was recorded incorrectly
- Create `node_bridge/tests/protectedCapabilityRegistry.test.mjs`
- Extend `node_bridge/tests/protectedCapabilities.test.mjs`

- [ ] Add RED tests for every reserved server name/tool prefix:
  `search_hub`, `social_reader`, `media_reader`, `personal_memory`,
  `obsidian_memory`, `ombre_memory`, `ombre_memory_extra`, `co_reading`,
  `sticker_catalog`, `media_generation`, `time`, and `playwright`.
- [ ] Reject registry candidates, generated mappings, and drivers that collide,
  shadow, redirect, or edit a protected capability. Return exactly
  `PROTECTED_CAPABILITY_NAME_COLLISION`; never auto-rename and continue.
- [ ] Prove External activation cannot edit `hermes/profile/config*.yaml`, alter
  protected launcher/provider configuration, move a mature data root, or treat
  a protected MCP/model-copied result as an operation receipt.
- [ ] Run the complete protected-capability baseline before modifying the broker.

## Task 1: Make The Facade Bridge-Owned, Actor-Safe, And Unambiguous

**Files:**

- Modify `hermesGatewayClient.mjs` and `replyBackend.mjs`
- Create `externalMcp/activityFacade.mjs`
- Create `externalMcpActivityFacade.test.mjs` and extend reply tests

- [ ] Add RED tests rejecting/ignoring model-supplied actor, recipient, server,
  session, activity, grant, token, profile, transport, scope, budget, receipt,
  operation ID, and consent fields. A foreign actor cannot start/adjust/stop or
  receive another actor's activity.
- [ ] Extend the single Core envelope with only an untrusted local `requestRef`,
  `command=start_or_resume|adjust|stop`, natural goal/reference, environment
  hint, and reporting preferences. Core attaches trusted context and mints all
  private IDs.
- [ ] Select activities by actor+conversation+domain+normalized goal digest.
  Exact active start dedupes; resume selects the same unfinished goal; zero
  adjust/stop matches is a no-op; multiple natural matches produce one
  nontechnical clarification; explicit “stop all” affects only the current
  actor/conversation.
- [ ] Keep one-shot specialist routing outside the facade. Reading/summarizing an
  XHS, Bilibili, WeChat, music, media, or ordinary URL uses the existing
  social/media/search capability; co-reading, generation, memory, time, sticker,
  and browser-debug requests retain their dedicated routes. Only an explicit
  durable environment goal such as continue playing, keep watching, or prepare
  future drafts creates an `activityRequest`.
- [ ] Return a Core-compatible durable-job receipt only after supervisor state
  and first wake commit. Remove prompt token choreography and phrase-regex start
  authority.
- [ ] Prove the full processing order: facade/job commit before commitment gate,
  then verifier/privacy, then outbox/projections.

## Task 2: Make Every External Critical State Atomic And Single-Owner

**Files:**

- Create `externalMcp/activityStore.mjs` and its tests
- Modify `activityRunner.mjs`, `registry.mjs`, `watchlist.mjs`,
  `sessionManager.mjs`, and `evidenceLog.mjs`
- Modify all matching tests

- [ ] Add RED tests for legacy migration, truncated/incompatible/corrupt state,
  read-only old files, two-runner lease race, revision CAS, stale callback,
  stopped activity, registry/watch/session/evidence corruption, and interrupted
  atomic replacement.
- [ ] Use Core atomic helpers and explicit schemas. The activity record contains
  actor, domain/driver, goal/constraints, immutable resource scope/risk envelope,
  status/checkpoint/pending operation/next wake, revision, lease, notify target,
  and timestamps.
- [ ] Registry, watchlist, session, and compact evidence indexes also fail closed
  and quarantine corruption. Evidence JSONL tolerates only a validated incomplete
  tail; it never silently discards earlier records.
- [ ] Define one writer for each file. All mutations use CAS/revision or
  append-only records; migration preserves safe existing enabled entries without
  granting new authority.

## Task 3: Extract One Trusted Broker And Receipt/Reconciliation Path

**Files:**

- Create `externalMcp/gatewayService.mjs`, `operationReceipt.mjs`, and
  `transportRouter.mjs`
- Modify `gatewayMcpServer.mjs`, `policy.mjs`, `sessionManager.mjs`,
  `executor.mjs`, and `evidenceLog.mjs`
- Create parity, receipt, transport, and reconciliation tests

- [ ] Add RED tests proving diagnostic MCP and supervisor calls share registry,
  policy, actor/activity/scope, session, executor, receipt, and evidence checks;
  forged model JSON never becomes trusted context.
- [ ] Implement one bridge-owned broker call. It receives a private Core
  operation capability and issues an exact typed receipt only after the bounded
  operation result is validated. The model-visible diagnostic wrapper cannot
  mint trust.
- [ ] Remove hidden effectful replay after session loss. Known failed reads may
  retry through a governed transport. An effectful timeout persists
  `pendingOperation`; driver reconciliation returns
  `applied|not_applied|unknown`. Only `not_applied` may retry; `unknown` blocks.
- [ ] Gateway/direct transport use the same manifest, risk/scope checks,
  operation ID, evidence, session/activity truth, and receipt. No curl/Python
  side ledger becomes a production truth path.

## Task 4: Implement The Generic Six-Operation MCP Adapter

**Files:**

- Create `externalMcp/genericAdapter.mjs`
- Create `externalMcpGenericAdapter.test.mjs`

- [ ] Add RED cases for missing annotations, open/recursive schemas, text-only or
  malformed results, dynamic tool lists, unknown effects, no terminal, no
  observe tool, no idempotency/reconcile, credential/local executable tools,
  schema drift, prompt injection, unbounded arguments, and duplicate operations.
- [ ] Compile live discovery into `resolveScope`, `observe`, `legalActions`,
  `execute`, `reconcile`, and `classify`. Do not require a provider-specific
  driver or universal ontology. Hermes selects only normalized action IDs; the
  adapter validates and emits native tool arguments.
- [ ] Missing capabilities select constrained modes instead of rejecting the
  server: ongoing without completion, opaque observation, unknown write outcome,
  no blind replay, and one boundary for a genuinely new effect.
- [ ] Pin the observed manifest hash for drift detection, but recompile
  compatible changes automatically. Optional mappings may improve quality after
  replay/shadow evaluation; generic compatibility never depends on them.

## Task 5: Prove The Generic Adapter On The Current CedarToy Connection

**Files:**

- Create `externalMcpCedarToyCompatibility.test.mjs`
- Consume only sanitized Task 0 live shapes through `genericAdapter.mjs`

- [ ] Preserve CedarToy's configured activation and native tool contract. Adapt
  `list_games`, `get_guide`, and `play` without requiring CedarToy to add
  operation IDs, revisions, or typed terminals. Do not replace it with another
  game.
- [ ] Prove one natural goal commits, advances across multiple observed
  checkpoints, survives Node/Hermes/session restart, obeys stop, and never asks
  the user for tool names/IDs/JSON. Games without trustworthy terminal evidence
  stay ongoing and never produce a false completion claim.
- [ ] Account/login/delete/payment-like tools remain connectable but outside the
  standing autonomous game scope; an explicit goal crossing that effect asks
  once and uses unknown-outcome handling when reconciliation is unavailable.
- [ ] Keep account/payment/files/terminal/external-send/forum/embodied effects
  outside the game envelope regardless of model output.

## Task 6: Prove Provider-Neutral Forum And Arbitrary-MCP Compatibility

**Files:**

- Create `externalMcpForumCompatibility.test.mjs`
- Create `externalMcpArbitraryCompatibility.test.mjs`

- [ ] Run the same generic adapter fixtures against multiple different forum
  schemas without naming a production forum. Map read/watch/draft/submit only
  from discovered tools and the user's goal; local draft remains available when
  the upstream has no draft tool.
- [ ] Prove read-only, authenticated, write-capable, text-only, and badly
  annotated forums all connect. Risk affects consent, allowed effects, evidence,
  and retry—not provider eligibility.
- [ ] Prove a previously unseen MCP fixture can start/resume/stop through the
  generic adapter with no source change. No site-specific scraper, hard-coded
  tool name, or provider package is required.

## Task 7: Separate Strong Planner From Grounded Narrator

**Files:**

- Create `externalMcp/planner.mjs` and `narrator.mjs`
- Create exact adversarial tests
- Modify `hermesGatewayClient.mjs` and managed config fixtures

- [ ] Add RED tests for illegal/missing/multiple action IDs, malformed JSON,
  prompt injection in MCP content, unavailable model, internal-ID leakage,
  invented causes, and unsupported save/post/send/completion narration.
- [ ] Planner sees only objective, normalized observation, bounded proven
  experiences, and legal action IDs. It returns one ID with one schema repair and
  has no tools. Narrator sees only sanitized facts/receipts and returns one
  natural candidate message.
- [ ] Configure explicit autonomy provider/base URL/model/timeout/concurrency
  keys. A deploy preflight verifies strict JSON/no-tools behavior, accuracy
  corpus, failure rate, and p95 latency against the real endpoint. A model name
  alone is not evidence.
- [ ] Unavailable planning selects a driver-defined safe observation/no-op or a
  natural blocked state; it never widens scope or asks the user to choose a
  model. Narrator output re-enters the full Core gate and cannot send directly.

## Task 8: Implement The Durable Autonomy Supervisor

**Files:**

- Create `externalMcp/autonomySupervisor.mjs`
- Create `externalMcpAutonomySupervisor.test.mjs`
- Reduce `activityRunner.mjs` to compatibility scheduling
- Modify `index.mjs`

- [ ] Add RED lifecycle tests for deduped start, restart resume, multiple
  checkpoints, narrowing adjust, widening pause/one approval, budget expiry,
  blocked recovery, stop race, duplicate runner, one terminal, and no chat
  history dependency.
- [ ] One tick acquires lease, rechecks status, observes, reconciles, checks scope
  and terminal truth, retrieves bounded experience, plans one legal action,
  executes/normalizes, commits checkpoint/next wake, and submits at most one
  narrator candidate to Core.
- [ ] A sent checkpoint never stops nonterminal work. `index.mjs` scans committed
  due activities on startup. Legacy synthetic turns that teach Hermes tool
  protocol are removed.

## Task 9: Add Evidence-Backed Capability Experience

**Files:**

- Create `experienceStore.mjs`, `experienceRanking.mjs`, and their tests

- [ ] Add RED poisoning/promotion tests for private content, credentials, raw
  reasoning, evidence-free, contradictory, cross-domain, stale driver-version,
  and unsafe action experiences.
- [ ] Store only domain, driver/version, goal/scope class, observation/action/
  outcome/effect/evidence digests, and timestamps. Append is atomic; the compact
  index supports supersession.
- [ ] Auto-promote only non-executable action ranking, recovery outcome, and
  reporting preference. Current scope, risk, observation, and legal actions
  always override experience.

## Task 10: Implement Candidate Evaluation And Governed Activation

**Files:**

- Create `candidateEvaluator.mjs`, `governedInventory.mjs`, and
  `capabilityActivation.mjs`
- Create their tests
- Modify `registry.mjs`, `pendingActionState.mjs`, and `replyBackend.mjs`

- [ ] Implement one connection/effect-boundary state machine:

  ```text
  probe -> connected -> active | constrained | needs_boundary
  ```

  Existing configured/enabled servers remain active. Explicit owner
  configuration is the server-boundary decision and is never followed by a
  redundant schema confirmation. Remote read-only discovery inside an existing
  standing scope can activate automatically.
- [ ] Bind one combined approval only when the requested goal crosses a new
  credential/local-process/write/account/payment/destructive/device boundary.
  The digest covers server, effects, limits, and inventory record; it does not
  ask the user to inspect tools or schemas.
- [ ] Store immutable content-addressed candidate artifacts and a sanitized
  server-governed activation ledger. Approval of a reviewed declarative mapping
  or already packaged artifact atomically updates the active pointer, runs
  strict smoke, and restores the previous pointer on failure.
- [ ] Activation writes only External registry/inventory/candidate/active-pointer
  state. Even owner approval cannot authorize it to edit `.mcp.json`,
  `hermes/profile/*`, first-party launchers, protected providers, or protected
  state roots; a collision is denied instead of renamed or shadowed.
- [ ] Do not autonomously download/install generated local code, skills,
  plugins, hooks, settings, or MCP processes. Those remain inactive until a
  separately reviewed immutable package exists; activation still requires the
  same approval and inventory transaction.
- [ ] Manifest drift recompiles the generic adapter automatically. Compatible
  reads continue; only invalid arguments and newly widened effects pause.
  Repeated hard failure constrains the affected tool/operation and restores a
  compatible mapping when available, never replacing or disabling the whole MCP
  merely because its contract is weak.

## Task 11: Integrate Commitment Repair, Stop, Reporting, And Core Outbox

**Files:**

- Modify `actionContract.mjs`, `actionRepair.mjs`, `replyBackend.mjs`,
  `autonomySupervisor.mjs`, and `outboundServer.mjs`
- Extend action/reply/outbound/supervisor tests

- [ ] Add RED cases for omitted/malformed/duplicate facade requests, unsupported
  future promise, no standing consent, stop during transport, late callback,
  duplicate checkpoint, adapter ambiguity, and direct narrator-send attempt.
- [ ] A future external promise is held until its matching activity/job commit.
  Inside existing standing consent, one bounded repair may create the facade
  request; otherwise remove the promise naturally. Repair cannot enable or
  widen a capability.
- [ ] Stop commits terminal state and revision before revoke/abort/session close;
  late work cannot act, restore state, or notify. Narrow adjust is automatic;
  wider scope pauses only the affected branch for one combined confirmation.
- [ ] No-change is silent. One checkpoint creates at most one candidate reply;
  completion requires driver terminal truth. Every candidate passes Core
  receipts/verifier/privacy/outbox/projections.

## Task 12: Converge Profiles, Deploy Inputs, Diagnostics, And Rollback

**Files:**

- Modify `hermes/profile/config.yaml`, `config.lite.yaml`
- Modify `apply-hermes-runtime-split.sh`, `deploy-hermes-release.sh`,
  `diagnose-external-mcp-gateway.sh`, and `diagnose-lite-full.sh`
- Extend `hermesReleaseScript.test.mjs`, `externalMcpProfileDocs.test.mjs`, and
  `searchHubApplyScript.test.mjs`

- [ ] Add RED tests proving normal lite/full toolsets do not expose low-level
  autonomy tools, while the internal broker/diagnostic surface remains
  available only to trusted runtime paths.
- [ ] Manage all new verifier/autonomy/state/inventory keys, absolute Node/Python
  service interpreters, service user, directories, state copy migration, strict
  smoke, and idempotent apply. Diagnostics require production Node >=22.13 plus the
  actual feature probes and suites, use isolated state,
  redact values, and return nonzero on critical failure.
- [ ] Preserve full/lite by design. Profile/model routing is internal metadata,
  never authority or a user choice.
- [ ] Do not batch-rewrite source profiles or mature launchers. Only add the
  minimum internal autonomy configuration proven necessary, then compare the
  protected manifest and live snapshot. Existing dedicated MCPs keep their
  public contracts, routing, state owners, and profile membership.
- [ ] Run every rollback injection from Core Task 11 and two idempotent applies.

## Task 13: Build The Integrated External Adversarial Gate

**Files:**

- Create `externalActivityJourney.test.mjs`
- Modify `hermes-release-smoke.mjs` and `hermes-release-gate.sh`

- [ ] Encode all 28 External spec invariants across the provider-neutral
  conformance corpus, including weak/malformed model output, open/dynamic
  schemas, missing terminal/idempotency/reconcile, goal drift, unknown outcomes,
  transport fallback,
  restart/double runner/stop race, outbox projection crashes, poisoned
  experience, rejection/drift/quarantine, cross actor, forum no-post, governed
  activation rollback, and embodied-write denial.
- [ ] Prove each invariant RED for the intended reason, then run:

  ```bash
  RAN_AGENT_NODE_BIN=/Users/fengran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
    bash scripts/hermes-release-gate.sh --all
  ```

  Require full isolated Node/Python suites and zero production-state access.

## Task 14: Pre-Deploy Review And Immutable Candidate

- [ ] Dispatch four fresh reviewers: architecture/spec compliance,
  security/capability governance, evaluator/fault injection, and deploy/rollback.
  They review the full diff and local evidence independently.
- [ ] Fix every P0/P1, rerun the affected review and complete local gate. Scan
  docs, secrets, credentials, private paths, stale status, and untracked runtime
  artifacts.
- [ ] Only after all four approve, create one local candidate commit on the
  isolated branch and record its content digest. Do not archive or push. The
  deploy script now has a real candidate and previous commit for rollback.

## Task 15: Automate Server Acceptance And Rollback Evidence

**Files:**

- Complete `scripts/accept-hermes-release.sh`
- Add fixture tests for resumable acceptance and redacted evidence schema
- Modify deploy script to invoke acceptance and rollback automatically

- [ ] Persist a resumable acceptance state so a controlled host reboot continues
  from the next stage. It reads managed owner/channel/game/forum targets from
  server configuration and never asks the user for IDs or commands.
- [ ] Emit one redacted JSON evidence bundle containing release/candidate/
  previous digests, runtimes, snapshot/migration IDs, effective service
  user/ExecStart/EnvironmentFile hashes, services/ports/health, verifier/planner
  preflight metrics, receipt/outbox counts, canary stages, rollback drill, and
  final result. No identity, secret, raw content, session, or state payload.
- [ ] Automatically verify real service-user write/fsync/rename, systemd restart
  and host-reboot resume, timezone/timer, Python/Node/Hermes health, authenticated
  lite/full chat, and external broker discovery.
- [ ] Capture and compare the protected capability snapshot before mutation,
  after apply, after restart, and after rollback. Run real read-only server
  smokes for Search Hub, XHS, Bilibili/media, personal memory, co-reading Web/MCP,
  sticker attach, time, and every currently enabled full-only Ombre/Playwright/
  Obsidian surface without reading private memory/vault content into evidence.
- [ ] Send one clearly marked real WeChat/Feishu canary only to the configured
  owner and prove adapter receipt precedes outbox sent and history projections.
- [ ] Run the currently configured CedarToy game through at least two real
  checkpoints plus Node/Hermes/session restart, resume, and stop. Require a
  terminal result only for a game that actually exposes terminal evidence; do
  not disable or replace CedarToy when it does not. If a forum MCP is configured,
  run its real watch/read/draft journey under its discovered effects. If none is
  configured, run the provider-neutral conformance matrix without installing or
  selecting one. Exercise opaque/high-risk MCP modes and prove constrained
  effects cannot escape their boundary.
- [ ] Inject a post-restart smoke failure, prove automatic restoration of the
  previous release and health, then reapply the approved candidate and rerun
  acceptance. Any unrecovered failure leaves the previous release active and
  reports only `rolled_back:<reason>`; success reports `deployed_verified`.

## Task 16: Post-Deploy Evidence Review, Documentation, Archive, And Push

- [ ] Dispatch four fresh reviewers over the live evidence bundle and deployed
  commit. Any finding returns to implementation, creates a newly reviewed
  candidate, and repeats deployment/acceptance; do not patch production by hand.
- [ ] Update runtime/governance docs only with verified production behavior,
  stable one-command deploy/rollback/acceptance, generic-adapter conformance,
  and configured effect boundaries. Do not choose or recommend a production
  game/forum provider in normative docs.
- [ ] After all reviews and evidence pass, use the repository's
  `archive-and-push` workflow to stage intentional source/tests/public docs,
  exclude local archives/state/secrets/logs, commit final documentation if
  needed, and push GitHub once.
- [ ] User-facing result is only `已部署并验证` or one concrete blocker. No
  roadmap, IDs, manual repair list, or request to choose a technical route.
