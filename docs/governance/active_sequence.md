# Active Work Sequence

Status: CURRENT (2026-08-08)

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
  -> S9 Package C scheduling (current)
  -> S10 migration rehearsal
  -> S11 synthetic fault acceptance
  -> S12 production cutover (owner authorization)
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
| S9 | IN_PROGRESS | S8 | Schema v2, ScheduleSpec, WakeOccurrence, WorkRun, `wake_due`, and the single managed tick. | One-shot, interval and daily schedules work; duplicate or missed ticks never duplicate an occurrence; no network inside the transaction. |
| S10 | NOT STARTED | S9 | Inventory legacy scheduler, reminders, daily digest, pollers and dispatchers; build manifest/watermark; rehearse on a production copy. | Every legacy component has a recorded disposition; legacy jobs default to paused; no historical reminder is re-sent. |
| S11 | NOT STARTED | S10 | Synthetic acceptance: duplicate/missed ticks, DST, crash, legacy fence, ambiguous outcomes, restart no-resend. | A deployable SHA exists; every external effect uses a synthetic target. |
| S12 | NOT STARTED | S11 + production authorization | Stop ingress, let legacy effect/outbox drain, execute the single Core Cutover Gate, enable one tick, disable legacy visible wake. | Core becomes the production authority; one synthetic Feishu message is sent exactly once. |
| S13 | NOT STARTED | S12 + observation window + separate owner deletion authorization | After observation, remove the legacy scheduler, JSON outbox and compatibility writer. | No duplicate delivery; the legacy writer and legacy clock are truly gone. |

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
