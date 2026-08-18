# Post-S12 Product-Effect Defect Repair Plan

Status: HISTORICAL COMPLETED REPAIR RECORD (2026-08-18)

This records the bounded repair of production product-effect defects found on
2026-08-15/16 during the post-S12 capability-parity backfill operation, plus
the follow-on F6 delivery guards found after managed wake activation. The owner
approved the original plan on 2026-08-16 and F6a+F6b on 2026-08-17. Execution
is serial in topology order; a node is checked off only with its stated exit
evidence. It is not a current action-surface or execution plan: H1 later removed
Calendar, Todo, digest, and Minutes/document actions from Hermes. Current
behavior lives in `hermes-playground-boundary.md` and
`current_runtime_status.md`.

## Defects And Root Causes

1. `CORE_REMINDER_BINDING_MISSING` (Todo reminder).
   `node_bridge/src/core/coreReminderService.mjs:24-29` resolves the owner
   presentation route through historical constants
   `system-owner-conversation` / `system-owner-binding` instead of the
   committed cutover operation key `core-cutover:system-owner-binding`.
   Production's canonical Feishu binding has different actual IDs, so Core
   schedule registration returned HTTP 400 after Python had already committed
   the Todo, leaving one orphan pending Todo (canonical reminder
   `2026-08-22 08:25:00`) without a Core schedule. The
   `system-task:reminder-check` recovery scan shares the same defect through
   `coreReminderSyncHandler.mjs:17`, which is why best-effort recovery also
   failed.
2. Dateless 2026-08-15 digest. `{YYYY-MM-DD}` in
   `src/personal_agent/prompts/ai_daily_digest_report.md:3` is literal
   instruction text, never substituted (`ai_daily_digest.py:33-40` replaces
   only `{facts}`); the template explicitly permits omitting the date, and
   both delivery gates (`ai_daily_digest.py:136-142`,
   `http_server.py:332-333`) validate only adapter-level `sent`, never the
   target date in the delivered body. The 23:16 send was therefore recorded
   as success while being unrecognizable to the owner.
3. Calendar envelope violation without replan. At 2026-08-15 23:26 the
   provider emitted the retired contract (`actionType=schedule.create`,
   illegal field `id`, illegal scope field `reminderTime`); it was rejected
   as `HERMES_PRIVATE_REPLY_ENVELOPE_INVALID`
   (`hermesGatewayClient.mjs:2006`) and swallowed into a fixed failure text
   (`hermesGatewayClient.mjs:1944-1953`) with no retry, so the adapter never
   executed. The existing one-shot strict replan
   (`replyBackend.mjs:637-668`) is document-only and unreachable for this
   rejection class.
4. Managed-wake digest leaked malformed private protocol. At 2026-08-17 10:07
   Hermes produced the required dated report inside a private reply envelope
   whose `message` contained literal newlines. `JSON.parse` rejected the
   malformed JSON, after which `extractReplyEnvelopeFromChoice` treated the
   whole protocol string as ordinary reply text. The Core managed-wake path
   also lacked the exact-date egress gate already present on the legacy/manual
   digest route, so it could dispatch either leaked protocol or a dateless
   body.
5. Minutes document action could not recover when Hermes supplied no executable
   public action.
   On 2026-08-17 Hermes read `前辈对话3` and produced a bounded single-line
   DocxXML body, but added model-owned `id` beside the allowed action fields.
   The trust boundary correctly rejected `ACTION_REQUEST_UNKNOWN_FIELD` before
   lark-cli; unlike Calendar, the Minutes path had no one-shot strict replan.
   After the first repair deployed, Hermes instead returned a valid envelope
   with `actionRequests=[]` and unverified “request submitted” prose. Node still
   executed nothing; the same missing-action class also needed the strict replan.
   A later live probe showed the long-transcript model can also omit only the
   public `requestRef` while producing the exact Minutes action/scope and a
   bounded 1752-character body. The bridge can safely bind that correlation
   label only for this unambiguous exact shape; all unknown/private fields and
   every other missing-ref action remain rejected.
   The first post-deploy actions then failed before any lark-cli write because
   the model body omitted the required `<title>`. The same exact-shape
   canonicalization now binds only that public title metadata at the front;
   the remaining body and fail-closed executor boundary stay unchanged.
   A later actionless long-session response also showed the replan could inherit
   polluted ordinary DM context. Minutes replan now uses the existing trusted
   `action_gate_repair` task session and may reread the transcript without
   gaining any direct document-write authority.
   That isolated response used complete `root`/`content` wrappers. The exact
   Minutes normalizer now removes only those outer wrappers before binding the
   title; internal forbidden tags still fail closed.

## Topology

```text
F1 Core reminder binding resolution repair
  -> F2 digest exact-date write + date-semantic gates
  -> F3 one-shot strict calendar replan on envelope-invalid
  -> V   local verification (focused + full Node/Python suites)
  -> REV proportional adversarial review of the combined candidate
  -> ARCH archive + push + governance reconciliation (same commit)
  -> DEPLOY production apply (owner-signed; server-runtime skill; dry-run first)
  -> R1 re-backfill the 2026-08-15 digest (must carry the date)
  -> R1b re-backfill the missed 2026-08-17 08:00 scheduled digest (owner
     request 2026-08-17; primary hypothesis is the deliberate managed-wake
     pause, to be confirmed read-only on the server: daily Core schedule
     exists with correct next_due and no occurrence fired at 08:00)
  -> R2 retry the screenshot calendar request
  -> R3 register the Core schedule for the existing orphan Todo (no second Todo)
  -> W  managed wake activation (owner-signed); exit additionally requires
     the daily 08:00 digest Core schedule to be present with next_due at the
     next 08:00 local occurrence
  -> F6a malformed private-envelope fail-closed
  -> F6b managed-wake digest exact-date egress gate
  -> F6V affected-boundary verification
  -> F6REV proportional adversarial review
  -> F6ARCH archive + governance reconciliation
  -> F6DEPLOY production apply (owner-signed)
  -> F7a Minutes missing-action one-shot strict replan
  -> F7V affected-boundary verification + adversarial review
  -> F7ARCH archive + governance reconciliation
  -> F7DEPLOY production apply (owner-authorized repair)
  -> F7RUN one deterministic Minutes-to-document request + readback
  -> F6OBS SUPERSEDED when the owner moved daily reports to Codex
  -> S13 observation frontier (unchanged; deletion not authorized)
```

F1/F2/F3 share one ready frontier with disjoint write scopes but execute
serially per owner decision. REV/ARCH/DEPLOY run once for the single
combined candidate. R1 depends on F2, R2 on F3, R3 on F1; R1-R3 execute
serially in the stated order. W depends on R1+R2+R3 evidence.
F6 followed the first real managed-wake digest. Its owner-signed apply completed;
the later 08:00 observation was superseded when the owner moved daily reports
to Codex and stopped the ran-agent digest.

## Node Checklist

- [x] **F1** — Resolve the reminder route via
  `core.reader.packageBPresentation.bindingsByOperation('core-cutover:system-owner-binding')`
  (pattern: `coreS12Acceptance.mjs:31-47`), requiring exactly one active
  binding; keep `CORE_REMINDER_BINDING_MISSING` otherwise. Both call sites
  (`outboundServer.mjs:829`, `coreReminderSyncHandler.mjs:17`) heal without
  edits. Scope: `coreReminderService.mjs` + `tests/core/coreReminderService.test.mjs`
  (+ sync-handler test if it pins the old constants). Exit: focused tests
  seed a non-default binding/conversation ID pair and pass.
  Done 2026-08-16: historical constants removed, operation-key resolution
  in place; fixture now seeds `owner-conversation:feishu:cutover` /
  `owner-binding:feishu:cutover`; new fail-closed negative test; focused
  4/4 and `outboundServer.test.mjs` 33/33 pass. Sibling note (out of
  scope): `coreExternalNotificationService.mjs:39` carries the same
  historical-constant defaults and `index.mjs:855` relies on them — latent
  same-class risk reported to the owner, not changed in this round.
- [x] **F2** — Force the exact target date into the digest and add date
  semantics to success validation. `build_digest_prompt(facts, local_date)`
  substitutes a real date placeholder; the template mandates the dated
  opening. Python sends an explicit `date` field; the Node digest route
  (`outboundServer.mjs`) requires that exact date string in `replyText`
  before outbox dispatch, failing closed with a distinct error and no send
  otherwise; both Python gates additionally require the verified date.
  Scope: `ai_daily_digest.py`, `prompts/ai_daily_digest_report.md`,
  `http_server.py`, `outbound_channel.py`, `outboundServer.mjs` +
  `tests/test_ai_daily_digest.py`, `tests/test_http_server.py`,
  `tests/outboundServer.test.mjs`. Exit: negative test "reply without the
  date -> no outbox send, explicit error" passes alongside positive tests.
  Done 2026-08-16: template opening is now mandatory and date-bound;
  `build_digest_prompt` raises if the placeholder is lost; Node route
  rejects a missing `date` field (400) and a dateless reply (503
  `digest_date_missing`, zero sends, no outbox item); success echoes
  `digest_date` and both Python gates require it. Python focused 48/48,
  Node `outboundServer.test.mjs` 34/34.
- [x] **F3** — Surface the envelope-invalid rejection to `replyBackend` as
  a machine-readable marker; on calendar intent (`hasCalendarCreateIntent`)
  with zero executed actions, issue exactly one strict replan
  (`NODE_ACTION_REPLAN`-style continuity note). The replan output must be
  exactly one `feishu.calendar.create` action passing full envelope,
  grounding and scope validation before reaching the adapter; any deviation
  (including `schedule.create`) fails closed to the original failure text
  with zero execution and no second replan. Scope: `hermesGatewayClient.mjs`,
  `replyBackend.mjs` + their tests and calendar/replan tests. Exit: the
  incident-shaped payload replans into a valid executed envelope, and a
  replan that returns `schedule.create` again executes nothing.
  Done 2026-08-16: gateway now returns `envelope_error_code` on the
  fail-closed text; `replyBackend` replans once for calendar intent
  (excluding todo-mixed text) and `extractCalendarReplanRequest` admits
  only one fully valid `feishu.calendar.create`. New
  `tests/feishuCalendarReplan.test.mjs` covers success, incident-shaped
  replan, retired-action-type replan, no-intent no-replan, and
  scope-invalid never-executes. Focused 124/124 plus
  replyBackend/replyEnvelope/actionRequest 84/84.
- [x] **V** — Full local verification. Exit: focused sets plus the full
  Node bridge suite and the Python pytest suite pass locally.
  Done 2026-08-16: Node full suite 1417 total / 1396 pass / 6 skipped /
  15 fail — all 15 reproduced identically on a clean `git archive HEAD`
  copy (wechatBridge 8; managed-wake-manifest, packageB repositories,
  desktop proxy 2, feishuBridge 2, provider-boundary integration; all
  require real desktop services/binaries), i.e. pre-existing environment
  failures with zero regression from this change. Python full suite 591
  total / 588 pass / 3 fail — all 3 in
  `tests/test_hermes_deepseek_provider.py`, which requires
  `RAN_AGENT_HERMES_TEST_BIN` / real provider access and imports nothing
  this change touches.
- [x] **REV** — Adversarial review proportional to the change over the
  combined candidate. Exit: review returns CLEAR.
  Done 2026-08-16: independent adversarial review returned CLEAR with five
  informational findings (two guard tests that also pass on old code;
  format-only Node date validation unreachable from the validating Python
  caller; stricter exactly-one route check failing closed; vacuous replay
  CONFLICT edge; HEAD-failure reproduction not independently re-run by the
  reviewer). No blocking finding. Reviewer re-ran the focused suites
  (Node 246/246, Python 48/48) and confirmed the full-suite failure counts
  match this document.
- [x] **ARCH** — Archive and push via `skills/archive-and-push`; reconcile
  `active_sequence.md`, `current_runtime_status.md`, `doc_status.md` and
  this plan in the same commit; final checks wrapped in
  `workflow_guard.py verify`. Exit: archive transaction complete, push
  confirmed.
  Done: commit `e9310bf` on `main`, pushed `d29ef57..e9310bf`, transaction
  `20260817T004053Z-46093`, 19 files. Validation `skipped` with recorded
  reason per the 0d7c5ce desktop precedent; workflow_guard evidence
  `20260816T180252449462Z-de15e3a2` (Node 245/245) and
  `20260816T180304671507Z-9ef49b32` (Python 48/48), both `passed`.
  Governance docs reconciled in the same commit: the parity successor's
  live-in-production state now reflects the 2026-08-15/16 fresh evidence.
- [x] **DEPLOY** — Production apply via `skills/server-runtime` (dry-run
  first). **Owner-signed step.** Exit: dry-run clean, apply complete,
  services active, route smoke checks pass.
  Done 2026-08-17: unified-topology source path (the legacy candidate entry
  failed closed by design); dry-run `SOURCE_DRY_RUN_OK`; owner-signed apply
  `SOURCE_APPLIED`, snapshot
  `/opt/ran_agent-release/source-snapshots/source-20260817T010349Z-e9310bf2a727`,
  production HEAD `e9310bf2…`, three core services active. Blocking
  acceptance `verify-hermes-release.sh --release` failed only at
  `desktopProxyServer.test.mjs` (2 tests); the identical failure reproduces
  on the server at the prior pointer `d29ef57`, proving pre-existing drift
  (parity-successor era, desktop-only surface outside the production
  topology), not a candidate regression. Owner explicitly accepted
  `e9310bf` with this recorded exception; rollback cannot turn the gate
  green at either pointer.
- [-] **F4** — ~~Bounded drift repair~~ **CANCELLED by owner 2026-08-17**:
  the desktop proxy frontend is declared unneeded; the two
  `desktopProxyServer.test.mjs` expectations remain known pre-existing drift
  on an unused surface. Consequence recorded: `verify-hermes-release.sh
  --release` keeps failing at that file until the surface is retired or the
  tests are repaired; retiring is out of this round's scope.
- [x] **R1** — Re-backfill the 2026-08-15 digest through the manual action.
  Exit: exactly one new Feishu message containing `2026-08-15`, terminal
  `sent` receipt with the date gate satisfied; the old dateless message is
  left untouched (deletion not authorized).
  Done 2026-08-17: action `op_7034aea9120db16e37fadd0b317124fd` returned
  200 `{delivery_status: sent, partial: false, date: 2026-08-15}` — both new
  date gates passed (date verified in the body before dispatch). Feishu
  server-side window scan (08-15 12:00 → 08-17 12:30 +08): exactly one new
  digest message (08-17 09:40) carries `2026-08-15`; the dateless 08-16
  23:16 message remains untouched; no duplicate dated message.
- [x] **R1b** — Re-backfill the missed 2026-08-17 08:00 scheduled digest via
  the same manual action (owner request). Pre-check (read-only): confirm the
  daily digest Core schedule exists, its `next_due`, and that no occurrence
  fired at 08:00 while wake is paused. Exit: exactly one new Feishu message
  containing `2026-08-17`, terminal `sent` receipt with the date gate
  satisfied.
  Done 2026-08-17: read-only Core inspection confirmed the hypothesis —
  `system-schedule:ai-daily-digest` is `enabled` with
  `next_due_at=2026-08-17T00:00:00.000Z` (08:00 +08) but no occurrence fired
  this morning (only the 08-16 occurrence exists); the miss is the
  deliberate managed-wake pause, not a new defect. Backfill action
  `op_4f2f36eab38217937df69e620973eb9f` returned 200
  `{delivery_status: sent, partial: false, date: 2026-08-17}`; Feishu-side
  scan shows exactly one new digest message (08-17 09:49) carrying
  `2026-08-17`.
- [x] **R2** — Retry the screenshot calendar request through normal
  ingress. Exit: exactly one new event created, adapter readback matches
  title/time/reminder, no duplicate event, no `schedule.create` execution
  trace.
  Done 2026-08-17: the screenshot event is `剧本杀《持斧奥夫》`
  2026-08-22 14:00-19:00 +08 with a 30-minute reminder (a different event
  from 《七月十三日》; the 08-22 agenda held exactly one event beforehand).
  The owner re-sent the original message through real ingress at 09:53:
  the model first answered from session memory without acting, then at
  09:54 re-emitted the retired contract and was rejected
  (`HERMES_PRIVATE_REPLY_ENVELOPE_INVALID`). F3 was live (Node restarted
  09:04 post-apply) and behaved as designed: the replan gate requires
  calendar intent in the current user text, and the follow-up text
  ("我没在飞书的日历里看到") carries none, so no replan fired and the
  fail-closed text returned with zero execution. The event was then
  created once through the verified adapter contract (create + reminder
  PATCH + readback): event `f6cf6953-cf32-4312-9e8a-33fc4f670fac_0`,
  readback `READBACK_OK`, 08-22 agenda afterwards exactly two events, no
  duplicate.

## Follow-Ups Discovered During Recovery

- **F5 candidate (owner decision pending)** — F3's replan gate keys on the
  current user text; contract violations on follow-up turns whose text
  lacks intent patterns get no replan. Bounded extension idea: evaluate
  intent over the current text plus the recent-turn context tail. Not
  implemented in this round.
- **Memory-honesty observation** — at 09:53 the model asserted from
  session memory that the 08-16 23:26 attempt had booked the event, though
  that attempt executed nothing. Failed attempts should not be recalled as
  completed effects. Recorded as a design observation, no code change in
  this round.
- [x] **R3** — Inventory pending Todos, confirm exactly one orphan
  (canonical reminder `2026-08-22 08:25:00`), then issue one replay-safe
  registration for that existing todoId via the repaired route. Exit: Core
  reminder schedule count 1 -> 2, Todo row count unchanged, no second Todo;
  firing on 2026-08-22 is future work, registration and scan reconciliation
  evidence suffice here.
  Done 2026-08-17: inventory showed exactly one orphan (Todo id 15,
  `2026-08-22 08:25:00`, never reminded; the three legacy April rows carry
  `last_reminded_at` and are scan-ineligible). Registration through the
  repaired route returned `{disposition: registered, scheduleSpecId:
  todo-reminder-schedule:15, scheduledFor: 2026-08-22T00:25:00.000Z}` — the
  F1 operation-key resolution works against the real production binding.
  Replay returned `already_registered`. `schedule_spec` 14 -> 15 (row
  `enabled`, correct `next_due`), `wake_occurrence`/`work_run` unchanged at
  51/51 (occurrence materializes at fire time), Todo count unchanged at 12.
- [x] **W** — Activate managed wake. **Owner-signed step.** Exit:
  `enabled=true` confirmed via status; the daily 08:00 digest Core schedule
  is present with `next_due` at the next local 08:00; S13 observation
  frontier becomes the next ready node (deletion still not authorized).
  Done 2026-08-17: owner chose immediate activation accepting one dated
  catch-up duplicate. `reconcile-core-managed-wake.py --mode activate`
  returned `{status: activated, jobId: 659f138230a7, active: true}`;
  `--mode verify --expect-active` confirms `verified/active:true`. First
  tick ran the designed latest-only catch-up wave (`wake_occurrence` and
  `work_run` 51 -> 64); the digest occurrence for 2026-08-17T00:00Z fired
  and one dated 8/17 digest arrived at 10:07 (the accepted duplicate);
  `system-schedule:ai-daily-digest` next_due advanced to
  2026-08-18T00:00:00.000Z (tomorrow 08:00); `todo-reminder-schedule:15`
  remains due 2026-08-22T00:25:00.000Z. Three core services active.
- [x] **F6a** — Treat syntactically malformed content carrying both private
  `message` and `schemaVersion` keys as a rejected private envelope instead of
  raw visible text. Ordinary JSON without the private shape remains visible.
  Done 2026-08-17: the exact literal-newline incident now returns only the
  existing safe format-error text; the provider content and protocol keys are
  absent from the reply and warning log.
- [x] **F6b** — Require the persisted schedule's local due date in the
  managed-wake digest reply before Package B creates any presentation effect.
  Done 2026-08-17: a dateless reply creates no Feishu send and terminalizes the
  WorkRun once as `failed / CORE_DAILY_DIGEST_DATE_MISSING`. The shared worker
  now runs completed-only post-terminal hooks only for completed WorkRuns.
- [x] **F6V** — Affected Hermes, replyBackend/calendar-replan, legacy/manual
  digest, Core composition and WorkRun worker tests pass 236/236. Each of the
  three new negative checks fails on the prior source and passes on the repair.
- [x] **F6REV** — Proportional adversarial review found no blocking issue:
  malformed non-private JSON remains visible, valid private envelopes still
  normalize, non-digest schedules still deliver, dateless wake output cannot
  reach the adapter, and failed WorkRuns remain durable without replay or a
  completed-only hook.
- [x] **F6ARCH** — Archive and reconcile the canonical status documents via
  `skills/archive-and-push`.
  Done 2026-08-17: transaction `20260817T023259Z-62443` completed after an
  in-place validation resume pinned the current Node runtime; the default
  Python baseline and 236 affected Node tests passed, and `main` was pushed.
- [x] **F6DEPLOY** — Owner-signed production apply after F6ARCH.
  Done 2026-08-17: the unified source controller returned
  `SOURCE_DRY_RUN_OK` then `SOURCE_APPLIED`; Node, Python and unified Hermes
  are active, retired Full remains inactive/disabled, managed wake verifies
  active, and the three focused F6 production regressions pass 3/3. The
  governed read-only final check passed under label `f6-production-deploy`.
- [x] **F7a** — When an owner request grounded in both Minutes and cloud-document
  intent has no executable action (invalid envelope or empty action list), ask
  Hermes once in the trusted `action_gate_repair` task session and return only
  the legal `feishu.minutes_to_doc` fields. It may reread the transcript but
  cannot write the document through a tool. Do not strip `id` or relax schema.
- [x] **F7b** — Bind the fixed public `feishu-minutes-doc-1` requestRef only
  when the model returns exactly one `feishu.minutes_to_doc` action with only
  the exact public fields and four scope keys, and bind the body title to
  `documentTitle` after removing at most two complete outer `root`/`content`
  wrappers. This does not normalize `id`, other missing fields, other action
  types or internal forbidden content.
- [x] **F7V** — An actionless reply replans into one readback-verified document;
  a replan that repeats `id` reaches no lark-cli call. The combined
  replyBackend/Calendar/Hermes boundary passes 191/191.
- [x] **F7ARCH** — Archived the reviewed repair and reconciled current status.
- [x] **F7DEPLOY** — Applied the exact archived source through the unified source
  dry-run/apply transaction; four core services and three focused production
  regressions passed.
- [x] **F7RUN** — Hermes created exactly one `前辈对话3` document. Three prior
  action attempts were rejected before write; the sole applied operation passed
  content readback and unique `中海油` parent proof.
- [x] **F6OBS SUPERSEDED** — No further ran-agent digest observation is due;
  daily reports belong to Codex and the digest is disabled.

## Reconciliation Items

- Production runs the archived F6 source with managed wake active.
- The F7 Minutes strict-replan repair is archived, deployed and production
  verified with one document and one successful operation receipt.
- Current status documents record the digest as retired and S13 as not started.

## Prohibitions

- No second Todo row for the orphan reminder.
- No duplicate calendar event; adapter readback must prove exactly one.
- No deletion of the old dateless 2026-08-15 message.
- Managed wake activation is production state; F6 deployment did not change
  its job contract.
- `schedule.create` remains rejected; only a fully valid
  `feishu.calendar.create` envelope may reach the adapter.
