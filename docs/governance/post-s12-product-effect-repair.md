# Post-S12 Product-Effect Defect Repair Plan

Status: CURRENT (2026-08-16)

Bounded repair of three production product-effect defects found on
2026-08-15/16 during the post-S12 capability-parity backfill operation. The
owner approved this plan on 2026-08-16. Execution is serial in topology
order; a node is checked off only with its stated exit evidence.

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
  -> R2 retry the screenshot calendar request
  -> R3 register the Core schedule for the existing orphan Todo (no second Todo)
  -> W  managed wake activation (owner-signed)
  -> S13 observation frontier (unchanged; deletion not authorized)
```

F1/F2/F3 share one ready frontier with disjoint write scopes but execute
serially per owner decision. REV/ARCH/DEPLOY run once for the single
combined candidate. R1 depends on F2, R2 on F3, R3 on F1; R1-R3 execute
serially in the stated order. W depends on R1+R2+R3 evidence.

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
- [ ] **ARCH** — Archive and push via `skills/archive-and-push`; reconcile
  `active_sequence.md`, `current_runtime_status.md`, `doc_status.md` and
  this plan in the same commit; final checks wrapped in
  `workflow_guard.py verify`. Exit: archive transaction complete, push
  confirmed.
- [ ] **DEPLOY** — Production apply via `skills/server-runtime` (dry-run
  first). **Owner-signed step.** Exit: dry-run clean, apply complete,
  services active, route smoke checks pass.
- [ ] **R1** — Re-backfill the 2026-08-15 digest through the manual action.
  Exit: exactly one new Feishu message containing `2026-08-15`, terminal
  `sent` receipt with the date gate satisfied; the old dateless message is
  left untouched (deletion not authorized).
- [ ] **R2** — Retry the screenshot calendar request through normal
  ingress. Exit: exactly one new event created, adapter readback matches
  title/time/reminder, no duplicate event, no `schedule.create` execution
  trace.
- [ ] **R3** — Inventory pending Todos, confirm exactly one orphan
  (canonical reminder `2026-08-22 08:25:00`), then issue one replay-safe
  registration for that existing todoId via the repaired route. Exit: Core
  reminder schedule count 1 -> 2, Todo row count unchanged, no second Todo;
  firing on 2026-08-22 is future work, registration and scan reconciliation
  evidence suffice here.
- [ ] **W** — Activate managed wake. **Owner-signed step.** Exit:
  `enabled=true` confirmed via status; S13 observation frontier becomes the
  next ready node (deletion still not authorized).

## Reconciliation Items

- `doc_status.md` and `active_sequence.md` still describe the post-S12
  parity successor as "reviewed but not yet deployed", while the fresh
  2026-08-15/16 production evidence (new digest route, lark-cli calendar
  adapter, Core reminder route all live) shows the successor code running in
  production. Fresh facts outrank the stale schedule; reconcile in the same
  archive as this repair.
- R3 uses one manual replay-safe registration through the repaired route
  because the `system-task:reminder-check` scan does not run while managed
  wake is paused; after W, the scan resumes as the standing recovery path.

## Prohibitions

- No second Todo row for the orphan reminder.
- No duplicate calendar event; adapter readback must prove exactly one.
- No deletion of the old dateless 2026-08-15 message.
- Managed wake stays `paused / enabled=false` until node W.
- `schedule.create` remains rejected; only a fully valid
  `feishu.calendar.create` envelope may reach the adapter.
