# Active Work Sequence

Status: CURRENT (2026-08-08)

This is the canonical order for active project work. Historical P-numbered plans
do not control current execution. Keep exactly one stage `IN_PROGRESS`, and
update this file in the same change that completes or advances a stage.

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
| S4 | IN_PROGRESS | Valid retained work is merged or deliberately rejected, temporary worktrees are removed, obsolete local/remote branches are closed, and the inactive O2 compatibility implementation is deleted after its runtime references are proven absent. The preserved root-worktree draft is not lost. |
| S5 | PENDING | Core B.2 has one local typed transaction/outbox/effect/receipt loop with a focused regression check; no production cutover is implied. |

## Update Rule

- Runtime facts and fresh evidence outrank this schedule if they conflict.
- Do not renumber stages or revive the historical P sequence.
- A stage becomes `COMPLETE` only with its stated exit evidence.
- When a stage completes, mark the next stage `IN_PROGRESS` in this file and
  update `current_runtime_status.md` in the same archive.
- Production apply remains a separate explicit step after archive, push and
  dry-run evidence.
