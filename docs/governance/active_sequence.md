# Active Work Sequence

Status: CURRENT (2026-08-17)

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
  -> S12 production cutover (COMPLETE / PROD_ACCEPTED at e298bab)
  -> post-S12 capability parity restoration (LOCAL_VERIFIED / REVIEWED / ARCHIVED; code paths live in production per 2026-08-15/16 evidence)
  -> post-S12 product-effect defect repair (PROD_APPLIED / RECOVERY_COMPLETE)
  -> post-S12 F6 delivery guards (PROD_APPLIED; F6OBS SUPERSEDED by owner decision to retire ran-agent daily reports)
  -> post-S12 Minutes strict replan (PROD_VERIFIED; one readback-proven document; 2026-08-17)
  -> H0 Hermes playground boundary decision (COMPLETE; owner reordered ahead of S13 on 2026-08-17)
  -> H1 Hermes playground boundary transformation (PROD_VERIFIED)
  -> H2 conversation reliability (PROD_VERIFIED)
  -> H3 live Ombre continuity (PROD_VERIFIED)
  -> H4 bounded proactive companionship (PROD_VERIFIED)
  -> H5 zombie-runtime excision (PROD_VERIFIED)
  -> S13 observation and cleanup (NOT STARTED; deletion not authorized)
```

The post-S12 repair restores AI digest, Feishu Calendar, and Todo reminder
capability parity inside the single Companion/Core topology. Core authority
remains `e298bab`; the repaired post-S12 source is applied, the three recovery
effects are verified, and managed wake is active. Its first catch-up digest
exposed F6: malformed private-envelope text could escape when JSON contained
literal newlines, and the Core wake path lacked the exact-date egress gate.
F6a/F6b are deployed and their production boundary checks pass. The owner later
assigned daily reports to Codex and superseded the real-08:00 F6OBS rather than
waiting for another ran-agent digest. The Minutes strict replan is isolated from ordinary
DM context, exact public metadata is normalized without accepting unknown
fields, and production contains exactly one readback-proven `前辈对话3` document
in the unique `中海油` folder. The owner explicitly reordered H0-H5 ahead of
S13; H0-H5 are archived, deployed and production verified. The digest is
stopped and daily reports belong to Codex. S13 has not started, and cleanup
still lacks deletion authorization.

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
| S12 | COMPLETE / PROD_ACCEPTED | S11 + R3-B CLEAR + exact successor `e298bab161bf0f4882bcef6e9cd701d546b63ff2` + production authorization | The candidate-bound transaction reached P10/ACCEPTED; source pointer and `core-cutover:v1` both bind e298. P9 is owner-accepted `TERMINAL_AMBIGUOUS_NO_RESEND`: one attempt, external effect unknown, no resend or duplicate. | Exactly one semantic writer, active managed wake, restored normal ingress and active Node/Python/Hermes were confirmed. |
| S13 | NOT STARTED | S12 COMPLETE + post-S12 repair deployment/observation exit evidence + separate explicit owner deletion authorization | Observe only; no cleanup is authorized. Exit evidence must use the then-current production source, stable e298 Core authority, one semantic writer, the owner-approved managed-wake disposition, stable services/ingress, no second canary attempt or resend, no duplicate presentation result, and no unexpected legacy writer/clock production activity. | Observation criteria pass and the owner separately authorizes the exact deletion scope. |

## S12 Readiness Topology

The detailed node topology, acceptance checklists, evidence ledger and reviewer
handoff template are canonical in
`docs/governance/s12-readiness-topology.md`. This summary records the completed
S12 path and the observation-only frontier; it does not start S13 or authorize
cleanup:

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
  -> R3-B root-gate six-fixture repair 76c72988 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> independent exact-SHA six-fixture repair review (CLEAR)
  -> third S12-R3B immutable server gate/dry-run proof (FIX_REQUIRED, STOPPED FAIL-CLOSED)
  -> R3-B Ombre path-access fixture repair 7019c805 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> independent exact-SHA Ombre fixture review (CLEAR)
  -> fourth S12-R3B immutable server gate/dry-run proof (FIX_REQUIRED, STOPPED FAIL-CLOSED)
  -> R3-B projection negative-injection harness repair (LOCAL_VERIFIED, NOT_REVIEWED, ARCHIVED by containing commit)
  -> independent exact-SHA projection-injection repair review (CLEAR at 0d7c5ce2)
  -> fifth S12-R3B immutable server gate/dry-run proof (FIX_REQUIRED, STOPPED FAIL-CLOSED)
  -> R3-B archive local-path authority repair 28c40549 (LOCAL_VERIFIED, REVIEWED / FIX_REQUIRED, ARCHIVED)
  -> raw-final authority repair e4a6d205 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> sealed-runtime scratch-home repair 9653d030 (LOCAL_VERIFIED, REVIEWED, ARCHIVED)
  -> S12-R3B immutable server gate/dry-run proof on 9653d030 (CLEAR)
  -> S12 orchestration / rollback-interlock candidate e6ce78aa (LOCAL_VERIFIED, REVIEWED / FIX_REQUIRED, ARCHIVED)
  -> S12 authority-order remediation 91172d4c (LOCAL_VERIFIED, REVIEWED / FIX_REQUIRED, ARCHIVED)
  -> final S12 read-only primitive remediation 959b8f0d (LOCAL_VERIFIED, REVIEWED / FIX_REQUIRED, ARCHIVED)
  -> systemic byte-authority / SQLite-test remediation e120f1c2 (LOCAL_VERIFIED, REVIEWED, ARCHIVED; production critical proof STOPPED)
  -> candidate execution-closure remediation 6d5d5b3a (LOCAL_VERIFIED, REVIEWED / CLEAR, ARCHIVED)
  -> Feishu route-contract remediation 2f822d9a (LOCAL_VERIFIED, REVIEWED / FIX_REQUIRED, ARCHIVED)
  -> visible-binding approval/custody remediation 482e700 (LOCAL_VERIFIED, REVIEWED / CLEAR, ARCHIVED)
  -> production canonical VERIFY (STOPPED FAIL-CLOSED before source verification)
  -> source Git convergence excision 3302472 (ARCHIVED; production Git health CLEAR)
  -> P2 protected direct-FD successor e298bab (ARCHIVED)
  -> canonical VERIFY and exact-SHA APPLY/recovery (PROD_ACCEPTED)
  -> P10 ACCEPTED
  -> observation exit evidence (S13 NOT STARTED; deletion not authorized)
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
  desktop-only skip. Production gate authority is unchanged. That repair passed
  independent exact-SHA review at
  `76c72988e8f6e989cd6d2ea61b09e8e7cc9ac917`. The third R3-B retry then passed
  baseline and source dry-run. Root immutable `--all` reached 655 tests with
  653 pass, one declared skip and one failure: `preserve runtime shape prepares
  Ombre and starts recall before lite and full without requiring Hermes CLI`.
  Non-root did not run, Python provider proof was not reached and production
  remained unchanged. Exact Linux/root reproduction under `umask 077` exposed
  `/bin/bash: .../scripts/prepare-ombre-brain.sh: Permission denied`: modeled
  `ubuntu:ubuntu` could not traverse root-created `0700` synthetic parents. The
  bounded test-only repair provides a root-owned read-only authority copy,
  makes only required tool/state parents traversable, preserves runtime-owned
  writable leaves and asserts the cross-UID boundary. The exact root test
  passes `1/1`; the Linux/root file is 85 total, 84 pass, zero fail and one
  declared skip; the local file is 85 total, 81 pass, zero fail and four
  declared platform skips. Workflow guard, syntax and diff checks pass. The
  repair passed independent exact-SHA review at
  `7019c805342084797c1e1bd201001d80ef1dd4ee`. The fourth R3-B retry again
  passed baseline and source dry-run; root immutable `--all` reached 655 total,
  653 pass, one declared skip and one failure. The Ombre path-access case now
  passed, and the sole failure moved to its projection-mode negative assertion:
  `Missing expected exception`. Non-root did not run, Python provider proof was
  not reached and production remained unchanged. Bounded root instrumentation
  proved the wrapper selected the active manifest and changed it from `0600` to
  `0644`, while the production `verify-runtime` command correctly failed with
  `projection_runtime_mode_invalid`. The defect was the negative harness: it
  discarded the wrapped command status and never proved that its target or
  mutation was active. The test-only repair resolves the active manifest from
  the pointer, verifies the exact before/after mode and identity, requires an
  injection marker, propagates the wrapped status, and proves restart does not
  cross the projection boundary. Linux/root evidence is the named test `1/1`,
  the full release test file 85 total / 84 pass / zero fail / one governed skip,
  and direct projection tests `39/39`; the local file is 85 total / 81 pass /
  zero fail / four governed platform skips. The repair entered the reviewed
  candidate `0d7c5ce200567425b791d79ff78dcd04a17d293b`. The fifth R3-B then
  passed baseline and source dry-run. Root `--all` reached Node 1177 total /
  1176 pass / zero fail / one governed skip and Python 462 pass / one fail plus
  nine passing pytest subtests. All three root provider proofs passed: sealed
  Hermes Node, DeepSeek non-thinking and the enabled-thinking fail-closed
  negative. Non-root did not run. The sole failure was
  `R3-B-ARCHIVE-LOCAL-PATH-SYMLINK-RESOLUTION-BYPASS`: full-leaf path
  canonicalization erased the final lock symlink before the no-follow boundary,
  allowing a root `umask 077` transaction to mutate and publish its target.
  The bounded repair canonicalizes only parents, validates containment before
  parent creation, preserves ordinary final leaves for no-follow verification
  and uses the same no-replace publisher for recovery records. It was archived
  at `28c4054989c1176a4d8988872c43363b09c74494`; independent review accepted
  those boundaries but returned `FIX_REQUIRED` for
  `RAW-FINAL-COMPONENT-NORMALIZATION-BYPASS`, because `Path(path)` erased a
  trailing separator or final `.` before `.name` validation. The bounded
  successor splits the raw POSIX pathname first, rejects empty, `.` and `..`
  terminal entries including repeated-separator forms, then canonicalizes only
  the parent. Its complete archive transaction file passes 39/39, focused
  recovery path tests pass 3/3, and the Git-less Linux/root probe passes under
  EUID 0 with `umask 077`. Independent review cleared that raw-final repair at
  `e4a6d205afc4183cfda503aa6bb4977dac29fb25`, which became the sixth R3-B
  candidate. That run passed baseline, source dry-run and root immutable
  `--all`: Node 1177 total / 1176 pass / zero fail / one governed skip, Python
  472 pass plus nine passing subtests, all three root provider proofs and
  Linux/root portability. Non-root then passed 524/524 Node tests before
  stopping fail-closed because the shared sealed-runtime probe used
  `HOME=/nonexistent`; the host's root-owned `0700` `/nonexistent/.hermes` was
  inspectable by root but raised `PermissionError` for the governed `ubuntu`
  identity. Production remained unchanged. The new shared-probe repair replaces
  that host-global sentinel with one unique caller-owned `0700` scratch
  namespace, isolates HOME/TMP/XDG state beneath it, permits legitimate
  ephemeral Hermes initialization, verifies the scratch identity, and fails
  closed unless recursive cleanup completes. Exact unarchived repair bytes
  passed bounded TECserver root/ubuntu probe, resolver, Node-provider and both
  Python-provider-route proofs with sealed-runtime hashes and production state
  unchanged. The repair was archived and independently reviewed at
  `9653d030473b3e9870ddea9158c4a2f9570c243b`; the subsequent complete R3-B is
  `CLEAR` on that exact base. The first orchestration candidate
  `e6ce78aaeb3c7117daac25ccbeb7b66b570cd0b1` is `LOCAL_VERIFIED / REVIEWED /
  FIX_REQUIRED / ARCHIVED`: independent review found
  `S12-VERIFY-SOURCE-REF-MUTATION`,
  `S12-ACCEPTED-JOURNAL-OVERRIDES-SQLITE` and
  `PRE-MARKER-COMPOSED-ROLLBACK-PROOF-MISSING`. Successor
  `91172d4c1925aa82a6d153671165b1c20473c4e7` routes
  VERIFY through candidate-extracted `source-verify` without creating refs or
  release metadata, reads and validates the SQLite marker before every terminal
  journal branch, and proves complete P0-P4 restoration through the real
  orchestration rollback method. Independent review accepted those repairs but
  returned `FIX_REQUIRED`: VERIFY could still refresh `.git/index`, and accepted
  replay opened Core through writable initialization. Candidate
  `959b8f0d4503448da3bb44205d40bddd7d32e43a` repaired both primitives, but its
  independent review found `BOOTSTRAP-MANIFEST-DUPLICATE-AUTHORITY-DRIFT`: the
  candidate-extracted controller bytes no longer matched a manually
  synchronized bootstrap digest manifest, so canonical VERIFY stopped
  fail-closed. The same review's live-WAL SHM-byte observation is
  `NON_BLOCKING`: SQLite read marks are derived coordination state, not durable
  product authority. Candidate
  `e120f1c246135d566e58847684e14521ea15809d` removes the redundant manifest and
  is `LOCAL_VERIFIED / REVIEWED / ARCHIVED`; its production critical proof
  stopped before P0 because candidate-only subordinates were still loaded from
  the older live checkout. The bounded successor materializes the exact Git
  candidate once under private read-only `/tmp`, uses that closure for all S12
  code/manifests while keeping `/opt/ran_agent` state-only, and removes it
  afterward. It is archived at `6d5d5b3a4b5b5da2eb7dbd84f37c4ec3170de41a`,
  independently reviewed `CLEAR`, and its production candidate-closure proof
  passed.
- S12 is `COMPLETE / PROD_ACCEPTED` at
  `e298bab161bf0f4882bcef6e9cd701d546b63ff2`. Source pointer and
  `core-cutover:v1` bind that SHA; P10 is ACCEPTED, one semantic writer and the
  managed wake are active, normal ingress is restored, and Node/Python/Hermes
  are active. P9 is truthfully terminalized as owner-accepted
  `TERMINAL_AMBIGUOUS_NO_RESEND`: attempt count 1, external effect unknown,
  resend forbidden and duplicate/resend count 0. Earlier failed attempts and
  their recovery evidence remain historical facts. S13 is `NOT STARTED`; its
  observation exit criteria are the stable e298 authorities/runtime plus no
  second canary attempt/result and no unexpected legacy writer/clock production
  activity. Cleanup additionally requires separate explicit owner deletion
  authorization, which has not been granted. A private
  diagnostic trace briefly exposed the raw route, was deleted, and caused no
  effect; this is an operational privacy incident, not a product route/custody
  defect. R2 caused no production mutation. A separately authorized XHS
  maintenance transaction
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
