# Active Work Sequence

Status: CURRENT (2026-08-09)

This is the canonical order for active project work. Historical P-numbered plans
do not control current execution. Keep exactly one stage `IN_PROGRESS` when the
ready frontier is authorized; if its required authorization is absent, keep it
`NOT STARTED` and state the waiting condition explicitly. Update this file in
the same change that completes or advances a stage.

```text
S0 facts/runtime selection
  -> S1 main/production source convergence
  -> S2 existing Feishu transcript to document
  -> S3 personal memory and Ombre value chain
  -> S4 worktree and branch convergence
  -> S5 Core B.2 local closed loop
  -> S6 root-worktree convergence, draft triage and governance sync
  -> S7 Node to Core local wiring
  -> S8 Ombre rebuildable projection (owner authorized 2026-08-08)
  -> S9 Package C scheduling
  -> S10 migration rehearsal
  -> S11 synthetic fault acceptance
  -> S12 production cutover (owner authorization; waiting)
  -> S13 observation and cleanup
```

| Stage | Status | Depends | Scope | Exit condition |
|---|---|---|---|---|
| S0 | COMPLETE | — | — | Runtime facts and v0.20 selection recorded. |
| S1 | COMPLETE | S0 | — | `main`, production source authority and the exact-SHA release seam converged; apply, rollback and reapply passed. |
| S2 | COMPLETE | S1 | — | One existing Feishu Minutes transcript produced the bounded typed document action and passed production verification without adding ASR or PPT handling. |
| S3 | COMPLETE | S2 | — | Production source `cc663876881e4d1f5cfb67f20d74230730a2f68c` completed one observable capture-and-recall path through `personal_memory`: an existing active personal-learning fact returned `personal_learning=hit`, while independent read-only Ombre returned the observable `empty` outcome. The model proposes semantic content plus an identifier; Node remains the deterministic valve and accepts it only when identifier, content class and payload format agree. Project/runtime facts continue to use governed documents, not Ombre; O2 and direct Ombre mutation remain off. |
| S4 | COMPLETE | S3 | — | Source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d` deleted inactive O2 source, Steward/token/model endpoint tooling and its dedicated gate while preserving direct Ombre recall on `18001`; the full release suite, source-controller tests, archive/push, production dry-run/apply and post-deploy checks passed. Obsolete worktrees and branches were deliberately closed after recoverable local snapshots; the root S5 draft was preserved. |
| S5 | COMPLETE | S4 | — | `runPackageBLocalDelivery` composes the existing typed final transaction, presentation outbox claim/dispatch boundary, one injected effect and durable terminal receipt. A reopen/replay regression proves the effect runs once, and the Core suite passes 121 tests. The service is not wired into production. |
| S6 | COMPLETE | S5 | Verify facts; triage all 33 root-worktree status entries; retain the 30 runtime draft paths in the checksummed desktop recovery patch and hand the three governance-hook paths to their dedicated task; re-implement the three still-missing runtime semantics on current main; sync governance documents; land the S6–S13 topology. | Root worktree is clean on current main; documents are consistent; the topology is in effect. |
| S7 | COMPLETE | S6 | Real local Node to Core link: identity, ingress, Turn, provider attempt, final, B.2 outbox, receipt. | One synthetic Feishu text passes end to end through Core; concurrent callers share one effect, and reopen/replay returns the durable `sent` receipt without another send. Non-owner input writes no Core fact; an unknown result or adapter exception becomes durable `ambiguous` without resend. The combined ChannelHub and Core suite passes 145 tests; production is not connected. |
| S8 | COMPLETE | S7 + owner authorization granted 2026-08-08 | The single internal projector uses the existing Core projection outbox/cursor to map payload-hash-bound `personal_learning_confirmed` events through Ombre `hold`, and confirmed long relationship summaries through `grow`. Stable event/scope markers reconcile a lost response before retry; scope-tagged buckets can be soft-deleted and replayed from unchanged Core facts. The public recall MCP still rejects every upstream mutation tool. | Concurrent/repeated events perform one Ombre mutation; a post-commit lost response recovers by marker without a second `hold` or `grow`; a failed projector leaves the Core source intact and retryable; one scope erases and a new scope rebuilds. Six focused checks and the 181-test Core/Ombre suite pass locally (180 pass, one existing root-only skip). Production remains unchanged. |
| S9 | COMPLETE | S8 | Schema v2, ScheduleSpec, WakeOccurrence, WorkRun, `wake_due`, and the single managed tick. | Schema v1 remains frozen; v1 upgrades in place to v2. One-shot, interval and daily schedules, immutable revisions, duplicate/missed tick catch-up, DST, scheduled Exchange isolation and WorkRun lease/fence authority pass locally; the managed tick has no network or direct presentation path. |
| S10 | COMPLETE | S9 | Inventory legacy scheduler, reminders, daily digest, external MCP/forum/RSS pollers and dispatchers; split polling facts from visible attention; build manifest/watermark; rehearse on a production copy. | The 19-row machine manifest gives every legacy component one disposition. A production SQLite/state copy at `2026-08-08T08:28:45.000Z` migrated 0→2 with zero business rows/effects; three historical reminders were suppressed, future reminders and watches were zero, 13 legacy external activities were staged paused, one pending outbound item was held for reconciliation, and 58 sent plus 65 ambiguous legacy outbox rows became receipt/no-resend evidence only. These counts are historical rehearsal evidence, not current cutover readiness, and must be freshly inspected and reconciled at the S12 gate. The local external-poll worker seam records one hash-bound Core fact after WorkRun authority and exposes no send operation. |
| S11 | COMPLETE | S10 | Synthetic acceptance: duplicate/missed ticks, DST, crash, stale WorkRun fence, ambiguous outcomes, restart no-resend, and gaming/focus suppression with delayed coalescing. | One synthetic chain binds the WakeOccurrence to its exact generated Exchange, claimed WorkRun revision/fence/lease, typed system/internal instruction, provider epoch/attempt, final, presentation outbox, single injected effect and durable terminal receipt. A thrown post-dispatch `ETIMEDOUT` records durable `ambiguous` evidence and replay never calls the adapter; a post-commit restart claims the existing WorkRun without another occurrence; stale WorkRun authority rejects before final/effect; an equivalent delayed fingerprint remains one candidate across gaming→available while explicit owner bypasses remain intact. The focused set passes 29/29 and the full Core suite 151/151 locally. Production is unchanged. |
| S12 | NOT STARTED | S11 + production authorization | Stop ingress, let legacy effect/outbox drain, execute the single Core Cutover Gate, enable one tick, disable legacy visible wake. | Core becomes the production authority; one synthetic Feishu message is sent exactly once. |
| S13 | NOT STARTED | S12 + observation window + separate owner deletion authorization | After observation, remove the legacy scheduler, JSON outbox and compatibility writer. | No duplicate delivery; the legacy writer and legacy clock are truly gone. |

## S12 Readiness Topology

The detailed node topology, acceptance checklists, evidence ledger and reviewer
handoff template are canonical in
`docs/governance/s12-readiness-topology.md`. This summary records only the
current ready frontier without starting S12 or authorizing a production
mutation:

```text
S12-R0 fresh read-only production audit (COMPLETE)
  -> S12-R1 local cutover assets and composition (IN PROGRESS)
       -> R1A accepted local Core/cutover composition (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> R1B web acquisition routing repair (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> R1B.1 private reply envelope fail-closed (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> previous R1A/R1B/R1B.1 candidate archive aabf9bc (R1A BLOCKED)
       -> R1A-ACK-ORDER bounded repair archive dfb8b41 (LOCAL_VERIFIED, ARCHIVED)
       -> independent exact-SHA R1A repair delta review (CLEAR)
       -> R1C effect-oriented Feishu document write and truthful reply (LOCAL_VERIFIED, NOT_REVIEWED, ARCHIVED)
       -> independent exact-SHA R1C review (REQUIRED)
       -> R1D bounded dependency compatibility decision
       -> R1E external MCP poll through WorkRun authority
       -> R1F real presence and attention admission/flush
  -> S12-R2 fresh production-copy rehearsal and candidate gates (NOT STARTED)
  -> S12-R3 independent review plus exact-SHA dry-run evidence (NOT STARTED)
  -> explicit owner production authorization
  -> S12 Core Cutover Gate
```

- Independent review found `R1A-ACK-ORDER` in the previous candidate
  `aabf9bc97ea3fcd95bf6d79798c56315543d0c37`. The locally verified bounded
  repair candidate is `dfb8b41df86a65136f3fa5c2cd181fc1f2045ba1`; its
  independent exact-SHA delta review is clear. R1A, R1B and R1B.1 are
  `REVIEWED`.
- On 2026-08-09 the owner explicitly authorized R1C local implementation while
  that review remains open. This changes the implementation frontier only:
  R1C is locally verified and archived by the commit containing this update,
  but remains `NOT_REVIEWED` until a later independent exact-SHA R1C review.
  R1D through R3 remain serial and have not started.
  Exact exit evidence and prohibited scope are defined in the detailed ledger.
- S12 remains `NOT STARTED`; production source and services are unchanged.

## Update Rule

- Runtime facts and fresh evidence outrank this schedule if they conflict.
- Do not renumber stages or revive the historical P sequence.
- A stage becomes `COMPLETE` only with its stated exit evidence.
- When a stage completes, mark the next authorized stage `IN_PROGRESS` and
  update `current_runtime_status.md` in the same archive. An empty or
  authorization-blocked ready frontier stays explicit rather than inventing or
  prematurely starting a stage.
- Production apply remains a separate explicit step after archive, push and
  dry-run evidence.
