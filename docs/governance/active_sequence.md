# Active Work Sequence

Status: CURRENT (2026-08-10)

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
| S12 | NOT STARTED | S11 + R3 + production authorization | Stop ingress, let legacy effect/outbox drain, execute the single Core Cutover Gate, enable one tick, disable legacy visible wake. | Core becomes the production authority; one synthetic Feishu message is sent exactly once. |
| S13 | NOT STARTED | S12 + observation window + separate owner deletion authorization | After observation, remove the legacy scheduler, JSON outbox and compatibility writer. | No duplicate delivery; the legacy writer and legacy clock are truly gone. |

## S12 Readiness Topology

The detailed node topology, acceptance checklists, evidence ledger and reviewer
handoff template are canonical in
`docs/governance/s12-readiness-topology.md`. This summary records only the
current ready frontier without starting S12 or authorizing a production
mutation:

```text
S12-R0 fresh read-only production audit (COMPLETE)
  -> S12-R1 local cutover assets and composition (COMPLETE)
       -> R1A accepted local Core/cutover composition (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> R1B web acquisition routing repair (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> R1B.1 private reply envelope fail-closed (LOCAL_VERIFIED, ARCHIVED, REVIEWED)
       -> previous R1A/R1B/R1B.1 candidate archive aabf9bc (R1A BLOCKED)
       -> R1A-ACK-ORDER bounded repair archive dfb8b41 (LOCAL_VERIFIED, ARCHIVED)
       -> independent exact-SHA R1A repair delta review (CLEAR)
       -> previous R1C candidate e416172 (INDEPENDENT REVIEW BLOCKED)
       -> bounded R1C replan/readback repair 02b8f649 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
       -> independent exact-SHA repaired R1C review (CLEAR)
       -> R1D bounded dependency compatibility decision 4e4f49e (COMPLETE, ARCHIVED)
       -> R1D-L1 Feishu update command repair af25198 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
       -> independent exact-SHA R1D-L1 delta review (CLEAR)
       -> previous R1E candidate c8e5a882 (INDEPENDENT REVIEW BLOCKED)
       -> bounded R1E projection/evidence repair 493c77aa (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
       -> independent exact-SHA repaired R1E review (CLEAR)
       -> R1F owner attention policy and proactive delivery 08e3eea8 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
       -> independent exact-SHA R1F review (CLEAR)
  -> S12-R2 fresh production audit/copy rehearsal (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> S12-R3A independent exact-SHA source review (CLEAR except server proofs)
  -> first R3 gate repair d70a08fc (INDEPENDENT REVIEW BLOCKED)
  -> R3 gate repair 2 d6adb106 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> independent exact-SHA gate-repair-2 review (CLEAR)
  -> R3-R1B profile delivery repair 790546a3 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> first S12-R3B immutable server gate/dry-run proof (FIX_REQUIRED, STOPPED FAIL-CLOSED)
  -> R3-B sealed-runtime contract repair d845e994 (LOCAL_VERIFIED, NOT_REVIEWED, ARCHIVED; SUPERSEDED BEFORE REVIEW)
  -> R3-B sealed-probe no-write repair (LOCAL_VERIFIED, NOT_REVIEWED, ARCHIVED by containing commit)
  -> independent exact-SHA runtime-contract review at 250a39fc (CLEAR)
  -> second S12-R3B immutable server gate/dry-run proof (FIX_REQUIRED, STOPPED FAIL-CLOSED)
  -> R3-B root-gate self-test fixture repair (LOCAL_VERIFIED, NOT_REVIEWED, ARCHIVED by containing commit)
  -> independent exact-SHA fixture-repair review (REQUIRED)
  -> S12-R3B immutable server gate/dry-run retry (NOT STARTED)
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
  The first R1C archive `e4161721d253c160558aeaf22b7fda77e1a331b4`
  failed independent review on replan authority escape and insufficient
  readback evidence. The commit containing this update is the bounded repair:
  it is archived at `02b8f6491f4ca3013f847decdc59974a90bebdca`, and its
  independent exact-SHA review is clear. R1C is now `LOCAL_VERIFIED`,
  `REVIEWED` and `ARCHIVED`. R1D records all four dependency decisions in
  `r1d_dependency_compatibility.v1.json`: no dependency upgrade is required,
  but the accepted adapter omitted the `docs +update --command overwrite`
  contract required by both checked CLI versions. R1D-L1 now adds exactly that
  adapter argument and passes its focused set `6/6`; both versions accept the
  repaired fake-token dry-run. The commit containing this update is
  `LOCAL_VERIFIED`, `NOT_REVIEWED` and `ARCHIVED` after the archive transaction.
  Its exact-SHA delta review is clear; R1D dependency compatibility is closed
  with `lark-cli` and External MCP both `COMPATIBLE_AS_IS`. R1E now validates
  the exact claimed WorkRun revision/fence/lease, active Core Activity and
  aggregate payload before `runtime.tick`; candidate activity/revision and
  checkpoint identity are rechecked before the existing fact writer. Its
  first candidate `c8e5a88291bfe7e66a607a753a4994617aab0565` passed its
  original focused/full sets but independent review found
  `R1E-FACT-PROJECTION-GAP` and `R1E-REVISION-EVIDENCE-SKEW`. The bounded
  repair atomically reserves a projection with each fact, recovers projection
  without provider replay, and binds any decision to the exact fact, Activity
  revision and checkpoint digest. Fresh repair evidence passes focused `18/18`
  and the smallest shared affected set `52/52`. The commit containing this
  update is archived at `493c77aa90fe53bba8a10fd94dd03136ba51d4eb`;
  its independent exact-SHA review is clear, so R1E is `LOCAL_VERIFIED`,
  `REVIEWED` and `ARCHIVED`. R1F recalibrates the S12 attention policy without
  adding another runtime: ordinary timely proactive content is eligible under
  the valve's default state, ambient content stays silent, and synthetic quiet
  states continue to exercise the durable delayed backlog. Desktop presence is
  uncomposed and `POST_CUTOVER_OK`; Hermes game activity is not owner presence;
  Telegram is future channel work; the existing Core-managed
  `system-task:attention-flush` schedule remains the only flush clock. Fresh
  focused evidence passes `60/60`. The archived implementation
  `08e3eea81c336ac48f3e0b85a87b0b5c6d445307` passed independent exact-SHA
  review, so R1F is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`. Fresh R2-A
  production truth at `2026-08-10T02:14:52Z` and the isolated R2-B copy-only
  rehearsal are `CLEAR`; the runtime actually rehearsed was exactly `08e3eea8`,
  while the commit containing the redacted evidence is only its governance
  archive and was not itself rehearsed. R2 is `LOCAL_VERIFIED`, `REVIEWED`
  and `ARCHIVED`. R3-A found the frozen candidate
  `08ea6b0ccb499bb84ddd4d20a2ebad6a48c1af92` clear except for server proofs,
  but follow-up source inspection confirmed
  `R3-GATE-HERMES-TOPOLOGY-STALE`: the immutable gate still required two
  executable Hermes v0.13 runtimes even though the accepted production
  topology is one unified v0.20 runtime on `8642`. Independent review of the
  first repair `d70a08fc19699f439d50845b846678a9f65a2ef9` returned
  `R3-GATE-HERMES-TOPOLOGY-STALE = NOT_RESOLVED` because it did not prove the
  retired Full unit's governed persistent condition block and the Python
  provider probe still required v0.13/`Project:` semantics. Repair 2 derives
  the exact Full drop-in from the existing mutation contract, verifies its
  installed/effective blocking condition without requiring a Full executable,
  and makes the provider probe require exact v0.20 plus explicit import-capable
  runtime Python without the obsolete Project-line layout. Focused resolver and
  gate checks pass `2/2`; focused Python checks pass `4/4`; the affected release
  and portability file reports 83 total tests: 80 pass and three unchanged
  Linux root-only skips. The desktop has no truthful v0.20 runtime fixture, so
  a complete service-managed `--all` proof remains R3-B. Independent exact-SHA
  review of repair 2 is clear at
  `d6adb1061b5a819407582690ca6a9adcb63c8d26`. Follow-up delivery inspection
  then confirmed `R3-R1B-PROFILE-DELIVERY-GAP`: the post-S1 source transaction
  rejected the accepted R1B companion-profile delta and still activated legacy
  `config.yaml`. The bounded repair adds an exact prior-source/profile-digest
  migration contract, makes `config.companion.yaml` the only active companion
  source, and reuses the existing profile/source snapshot for rollback. That
  repair passed independent exact-SHA review at
  `790546a34285a101948e301363381d094ec14b83`. The first R3-B server proof
  confirmed the exact candidate profile semantics and source dry-run, then
  stopped fail-closed in the root runtime resolver: the real sealed v0.20 CLI
  emits five presentation lines, while the gate required one exact line, and
  the sealed Python correctly could not import application modules without
  the governed `runtime/app` path. The non-root gate did not run. Production
  remained unchanged. The bounded class-level repair now derives version from
  artifact/package metadata, treats CLI output semantically, uses one explicit
  sealed-app import probe in local/staged/provider boundaries, verifies live
  process argv/environment against the same launcher contract, and parses the
  companion YAML semantically. Candidate `d845e994` was `LOCAL_VERIFIED /
  NOT_REVIEWED / ARCHIVED`, then superseded before review when
  `R3-GATE-SEALED-PROBE-BYTECODE-WRITE-RISK` was confirmed: isolated mode did
  not itself prevent root from writing bytecode into the sealed tree. The
  bounded repair requires explicit `-B` at every A/B/C sealed-Python probe,
  self-rejects a shared-probe caller that omits it, and proves a writable
  synthetic runtime tree is unchanged. The combined repair passed independent
  exact-SHA review at `250a39fc1ce40ea8e5fa2fa27a50d4f058dd7ea4`.
  The second R3-B server proof retained the expected production baseline,
  exact-candidate source dry-run, sealed v0.20 resolver, live `/proc` contract
  and Full retirement, then stopped fail-closed in six Node self-tests before
  the Python and non-root gates. Reproduction of the exact test file under the
  same root environment classified all six as fixture drift: four leaked the
  outer `root:root` identity into a non-root runtime fixture, one complete
  stage omitted `verify-runtime-service-identity.sh`, and one focused
  prerequisite fixture hit a later checkout probe before its intended Python
  failure. The bounded test-only repair uses an explicit existing non-root
  fixture identity, one current complete-stage surface and truthful effective
  process ownership. Desktop evidence is `85/85` with four declared platform
  skips; the Linux root fixture is `85/85` with 84 pass and the single declared
  desktop-only skip. Production gate authority is unchanged. The repair is
  `LOCAL_VERIFIED / NOT_REVIEWED / ARCHIVED` by the commit containing this
  status. R3 remains incomplete; independent review and another R3-B retry are
  not started.
- S12 remains `NOT STARTED`. Production source remains `98fd8b3`, and R2 caused
  no production mutation. A separately authorized XHS maintenance transaction
  retired the account-backed route and activated the existing public-only
  sidecar; it is not R2 evidence or a Core/source change.

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
