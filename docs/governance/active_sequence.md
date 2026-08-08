# Active Work Sequence

Status: CURRENT (2026-08-08)

This is the canonical order for active project work. Historical P-numbered plans
do not control current execution. Keep exactly one stage `IN_PROGRESS` while an
unfinished stage exists, and update this file in the same change that completes
or advances a stage.

```text
S0 facts/runtime selection
  -> S1 main/production source convergence
  -> S2 existing Feishu transcript to document
  -> S3 personal memory and Ombre value chain
  -> S4 worktree and branch convergence
  -> S5 Core B.2 local closed loop
```

| Stage | Status | Exit condition |
|---|---|---|
| S0 | COMPLETE | Runtime facts and v0.20 selection recorded. |
| S1 | COMPLETE | `main`, production source authority and the exact-SHA release seam converged; apply, rollback and reapply passed. |
| S2 | COMPLETE | One existing Feishu Minutes transcript produced the bounded typed document action and passed production verification without adding ASR or PPT handling. |
| S3 | COMPLETE | Production source `cc663876881e4d1f5cfb67f20d74230730a2f68c` completed one observable capture-and-recall path through `personal_memory`: an existing active personal-learning fact returned `personal_learning=hit`, while independent read-only Ombre returned the observable `empty` outcome. The model proposes semantic content plus an identifier; Node remains the deterministic valve and accepts it only when identifier, content class and payload format agree. Project/runtime facts continue to use governed documents, not Ombre; O2 and direct Ombre mutation remain off. |
| S4 | COMPLETE | Source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d` deleted inactive O2 source, Steward/token/model endpoint tooling and its dedicated gate while preserving direct Ombre recall on `18001`; the full release suite, source-controller tests, archive/push, production dry-run/apply and post-deploy checks passed. Obsolete worktrees and branches were deliberately closed after recoverable local snapshots; the root S5 draft was preserved. |
| S5 | COMPLETE | `runPackageBLocalDelivery` composes the existing typed final transaction, presentation outbox claim/dispatch boundary, one injected effect and durable terminal receipt. A reopen/replay regression proves the effect runs once, and the Core suite passes 121 tests. The service is not wired into production. |

## Update Rule

- Runtime facts and fresh evidence outrank this schedule if they conflict.
- Do not renumber stages or revive the historical P sequence.
- A stage becomes `COMPLETE` only with its stated exit evidence.
- When a stage completes, mark the next stage `IN_PROGRESS` if one exists and
  update `current_runtime_status.md` in the same archive. An empty ready
  frontier stays explicit rather than inventing a stage.
- Production apply remains a separate explicit step after archive, push and
  dry-run evidence.
