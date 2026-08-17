# Current Runtime Status

Status: S12 COMPLETE / PROD_ACCEPTED; PRODUCT-EFFECT RECOVERY COMPLETE; F6 PROD_APPLIED; MINUTES REPLAN LOCAL_VERIFIED; S13 NOT STARTED (2026-08-17)

This is the compact source of truth for current production behavior. Commands
live in `docs/governance/server_runtime_commands.md`; design contracts and
historical phase records stay in their focused governance documents.

## Production

```text
repository_state: post-S12 product-effect repair applied 2026-08-17
source_pointer: current archived F6 production source
core_authority: core-cutover:v1 committed at e298bab161bf0f4882bcef6e9cd701d546b63ff2
companion_overlay: dc5fcf13f86483073c54ac046e1b238a90c91921 retained as rollback-only evidence
runtime: Hermes v0.20.0; deepseek-v4-flash; one gateway on 127.0.0.1:8642
retired_runtime: 8643 absent; ran-agent-hermes-full inactive, disabled and condition-blocked
runtime_stage: S12 COMPLETE / PROD_ACCEPTED; S13 NOT STARTED
services: Node, Python, unified Hermes and direct Ombre Brain active; normal ingress restored
core_runtime: exactly one semantic writer; managed wake active
acceptance_canary: TERMINAL_AMBIGUOUS_NO_RESEND; one attempt; external effect unknown; no resend or duplicate
owner_acceptance_ref: owner-s12-e298-terminal-ambiguous-acceptance-20260813
identity: production processes run as ubuntu:ubuntu
storage: 70% used; 18201784320 bytes available after S4 source activation
```

WeChat, Feishu/Lark and the optional Desktop proxy share
`ChannelHub -> replyBackend -> hermesGatewayClient -> Hermes`. Conversation
sessions are channel/conversation scoped; non-referential requests do not
inherit another channel's last turn. Python `/chat` is retired and returns 410.

The unified companion keeps the former Lite/Full capability union on one
runtime. Search, terminal/file/session tools, Playwright, media, co-reading and
the supported MCP registrations remain available. The accepted companion
overlay removes `obsidian_memory` from the active Hermes mount namespace and
routes bounded Vault recall through `personal_memory`; the host-visible profile
files remain on the old source checkout and still contain that retired
registration. No replacement dependency was installed.
Hermes-native `cronjob`, `delegate_task` and `execute_code` remain disabled.
Scheduled outbound is limited to explicit reminders, the opt-in AI digest and
governed `external_mcp_gateway` notifications.

The current production source keeps the trusted `todo.create` reminder
contract and unified Companion source/wake release path. The post-S12
product-effect repair was applied on 2026-08-17; the two dated digest
backfills, verified Calendar creation, replay-safe Todo schedule registration
and managed-wake activation completed. The first catch-up digest then exposed
malformed private-envelope leakage and a missing Core wake exact-date gate.
The bounded F6 repair was deployed through the unified source transaction on
2026-08-17; its production boundary checks pass and the next real 08:00 digest
observation remains. The source makes Python the sole date-specific AIHOT/template/prompt
owner, binds scheduled reports to the persisted occurrence due date and
timezone, restores explicit historical-date preparation, restores verified
`feishu.calendar.create`, keeps Todo and Calendar semantics distinct, and fixes
`/tools/todo/list` to call the existing pending-Todo owner. It adds no runtime,
scheduler, wake, action registry, or delivery authority. That operation exposed
three bounded product-effect defects (reminder binding resolution, dateless
digest acceptance, missing calendar envelope replan); their repair is locally
verified and independently reviewed per
`docs/governance/post-s12-product-effect-repair.md`. Managed wake is active.

## Memory

Production memory uses local SQLite with free offline FastEmbed/HNSW plus
keyword retrieval. `personal_memory` also performs a bounded direct Ombre
`breath_search` through the loopback-only service on `18001`; source failures
are surfaced separately from an empty result. The recall-only adapter on
`18002` and the O2 writer are absent. S4 removed that writer, its
Steward/token/model endpoint code, and its dedicated release gate without
changing the direct `18001` read path.

Ombre is a derived relationship/context source, not the authority for Core
facts or deployment truth. Core and governed runtime documents remain the
authorities. S8 adds one local-only rebuildable projector for confirmed,
payload-hash-bound Core/personal-learning events; production still has no
Ombre mutation path.

The converged source deploys main's strict query-only
`personalMemoryMcpServer`, explicit `source_status`, Vault retrieval, Python
extractor assembly, and a fixed 15000 ms child-process boundary. For explicit
owner requests, Hermes proposes the existing typed personal-learning action and
Node accepts it only when the identifier, content class and exact scope format
agree; Python remains the persistence owner.

## Delivery Evidence

Directed isolation probes returned only `飞书独立` on Feishu and `微信独立`
on WeChat; neither channel inherited the sibling channel's answer.

The 2026-08-07 08:00 AI digest produced exactly one observed Feishu message
without trailing envelope JSON. Node recorded a sent attempt once, and Python
stored the matching sent marker and timeline event without the earlier caller
timeout. This closes the named digest occurrence; it is not a universal
exactly-once guarantee.

Hermes identity was observed on WeChat and Feishu, a real personal-memory hit
was observed, and a Full-origin search capability completed through the
unified runtime. `8643` remained absent.

S2 accepted one production `feishu.minutes_to_doc` action envelope for the
existing `个人成长` Minutes transcript with the four bounded scope fields and a
421-character text-only DocxXML fragment. The canary stopped before the Node
executor to avoid creating a duplicate. Before deployment, the same existing
transcript was organized into one document directly in the uniquely matched
`中海油` folder and passed document readback and folder-parent verification.
The action path adds no ASR or PPT dependency.

On 2026-08-17 a new owner Minutes request first failed before lark-cli because
Hermes added model-owned `id`, then after the initial repair returned an empty
action list with unverified submission prose. Neither attempt created a bridge
operation; a read-only exact-title check found no target document. The current
local repair requests one strict Hermes replan whenever the grounded Minutes
turn has no executable action, while preserving the fail-closed schema, unique
resource lookup and readback boundary. The final local repair also binds a
missing public requestRef only for the exact unambiguous Minutes action shape;
the same narrow normalization binds the body title to `documentTitle` after
live zero-effect rejections exposed missing model title metadata. Other
invalid actions remain rejected. It is not yet deployed.

S3 deployed source `cc663876881e4d1f5cfb67f20d74230730a2f68c`. A
privacy-preserving production probe selected an existing active
personal-learning record without printing its key or content and observed
`personal_learning=hit` through `personal_memory`; the independent Ombre source
returned the valid observable outcome `empty`. Node, Python, unified Hermes and
direct Ombre remained active.

S4 archived and deployed source
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. The full release suite passed
80 tests with three Linux-root-only skips, the source controller passed 33
tests, and production independently reported Node, Python, unified Hermes and
direct Ombre active. Node had no O2 environment residue; `18001` was open and
`18002`/`8643` were closed. Obsolete worktrees and branches were closed only
after a verified Git bundle plus binary patches and untracked-file archives
made their remaining drafts recoverable.

S5 local verification composes the existing Package B final transaction,
presentation outbox claim and dispatch-start boundary, one injected effect and
typed terminal receipt. The focused reopen/replay check invokes the effect once
and returns the durable sent state on replay; all 121 Core tests pass. No
production service, database, route, flag or source pointer changed.

S6 converged the root worktree to a clean current `main` and triaged all 33
S5-era status entries. The 30 runtime draft paths are retained in the
desktop-only `local_archive/debug/ombre-p3-root-wip-20260808.patch` with SHA-256
`aaf278e59f31fda5fdb45465eac2e5d06141174143c87bc8cef26cdd8004e53b`.
The other three paths (`docs/governance/agent-capability-governance.md`,
`scripts/agent_governance_guard.py`, and
`scripts/install_agent_capability_governance.py`) were governance-hook work
handed to the dedicated hook-fix task. That task retired the repo hook guard and
installer, and constrained the remaining project watcher to an explicit-root,
read-only audit. This host governance work is not represented as recoverable S5
runtime drafts and changes no production state. The three still-missing runtime
semantics were re-implemented on current main:
Python outbound caller deadlines for proactive events now outlive the Node
Hermes plus Feishu deadlines by the same margin as the digest path; task-scoped
synthetic Hermes turns never project into the ordinary backend ingest; and an
adapter exception or invalid adapter result now terminalizes as `ambiguous`
with a durable receipt, so it is never automatically resent. Every other draft
content class (O2/Steward/token, superseded deployment documents, the second
proactive-delivery framework and the JSON outbox expansion) is retired. No
production service, database, route, flag or source pointer changed.

S7 completes the local Package B.3 link without enabling it in production.
When a caller explicitly injects a migrated local Core and content hasher,
ChannelHub converts one verified-owner Feishu text into the existing typed
Conversation identity, ingress, sealed user Turn, provider epoch/attempt,
assistant final, B.2 presentation outbox and adapter receipt. One in-process
outbox promise owns concurrent effects; the durable terminal receipt prevents
another send after reopen or replay. The synthetic Feishu journey passes with
one effect; non-owner input writes no Core fact; an unknown adapter result or
exception is durably ambiguous and does not resend after reopen. The combined
ChannelHub/Core suite passes 145 tests. No production database, route, flag,
service or source pointer changed.

S8 is locally verified under the owner's 2026-08-08 authorization for one
governed projector. It reuses Core's projection outbox, cursor and fence
receipts; only two confirmed event classes select Ombre `hold` or `grow`, and
the content must match the keyed journal-payload hash. Stable event/scope tags
reconcile a lost Ombre response before retry, support scope-level soft erasure,
and permit replay into a new scope from unchanged Core facts. Concurrent and
restart-like replays mutate Ombre once, projector failure leaves the Core source
fact intact, and the existing public recall MCP still rejects `hold`, `grow`
and every other upstream mutation. Six focused tests plus the combined
Core/Ombre suite pass locally (180 pass, one existing root-only skip). The
projector is not composed into production and no real vault data was changed.

S9 is locally verified without production composition. Immutable migration
`core-0002-scheduling` adds ScheduleSpec revisions and WakeOccurrence while the
frozen v1 checksum/fingerprint remains exact; a real v1 fixture upgrades in
place. The injected managed tick supports one-shot, interval and daily
recurrence, bounded catch-up, DST gap/fold behavior, deterministic occurrences,
scheduled WorkRun creation and Activity-rechecked lease/fence claims. Repeated
and missed ticks do not duplicate an occurrence. A message-capable wake creates
only a typed Exchange: it creates no ordinary chat Turn, presentation outbox or
adapter call. Forum/RSS/external MCP polling is therefore a future Core fact
producer, not direct-send authority; gaming/focus-aware attention routing is an
S11 synthetic-acceptance concern. The S9 Core suite passes 140
tests locally. No production database, clock, route, service or source pointer
changed.

S10 is locally verified and production remains unchanged. The 19-row
`core_schedule_migration.v1.json` assigns one disposition to every legacy
clock/executor/outbox path. An isolated server-local production copy at
`2026-08-08T08:28:45.000Z` migrated to Schema v2 with zero business rows and
zero external effects: three historical reminders were suppressed, no future
reminder or external-watch candidate existed, 13 legacy external activities
were staged paused, the durable-job queue and proactive reservation ledger were
empty, one pending outbound item was held for reconciliation, and 58 sent plus
65 ambiguous legacy outbox rows were classified as receipt or no-resend
reconciliation evidence. The temporary server/local rehearsal files
were deleted and absence rechecked. Local source also adds a hash-bound
`recordFact`-only external-poll seam after WorkRun authority; it has no send
surface. The Core suite passes 143 tests locally. S11 now owns synthetic
attention/fault acceptance. The `2026-08-08T08:28:45.000Z` counts are a
historical rehearsal snapshot, not current cutover readiness; S12 must freshly
inspect and reconcile the production state before any cutover decision.

S11 is locally verified after owner-audit remediation with only synthetic,
non-delivering targets and no production change. The acceptance chain now uses
the WakeOccurrence's exact generated Exchange and claimed WorkRun
revision/fence/lease to commit a distinct system/internal scheduled instruction;
that same authority binds the provider epoch and attempt, final assistant Turn,
presentation outbox, one injected effect and durable terminal receipt. The
fixture creates no ordinary user Turn. A real injected adapter throws
`ETIMEDOUT` after the dispatch-start boundary; Core records hash-bound
`ambiguous` evidence, and reopen/replay returns the terminal receipt without a
second adapter call. Rotating the WorkRun fence rejects the stale final before
an outbox or effect. A restart after `wakeDue()` commit claims the existing
WorkRun once, while another tick creates no occurrence or WorkRun.

The durable attention valve now coalesces an equivalent delayed fingerprint
across gaming/focus→available instead of returning an immediate candidate while
leaving a backlog duplicate. Ambient silence, focused/busy/dnd/unknown delay,
owner-allowlisted critical delivery, explicit owner-reminder bypass, restart
recovery, interrupted-flush recovery and fact-during-flush protection remain
covered. Existing acceptance also retains concurrent duplicate/missed ticks,
six-hour latest-only catch-up plus one aggregate skip event, clock rollback,
DST gap/fold, all-or-nothing tick rollback, Activity stop/cancel, S10 paused
migration candidates and the fact-only/no-send external-poll seam. The focused
acceptance set passes 29/29 and the full Core suite passes 151/151 locally.
Here “stale fence” means the Package E stale WorkRun revision/fence authority;
the legacy visible-wake interlock remains exclusively S12 cutover scope.

An S12 read-only readiness audit at `2026-08-08T14:42:15Z` reconfirmed a clean
production checkout and accepted source pointer at
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. Python, Node and Hermes are active;
the retained non-visible soft-reset timer is active/enabled; Hermes native cron
contains zero jobs and zero executions. The refreshed legacy snapshot has 14
todos, zero future reminder candidates, three historical reminders, zero
invalid reminder times, zero active/leased durable jobs, zero watches, and zero
notification reservations. All 13 external activities are paused with no
lease, next wake or pending operation. The durable outbox has 58 `sent` and 65
`ambiguous` rows; every ambiguous row has one attempt and durable terminal
receipt evidence, so none may be resent. Proactive reservations are zero. The
single pending outbound item dates from `2026-07-03`, is already past due and
must be suppressed/reconciled rather than replayed; its legacy dispatch state
is from the same instant.

Production is quiescent enough for a new rehearsal, but the implementation
archived at `aabf9bc97ea3fcd95bf6d79798c56315543d0c37` was blocked by
independent review finding `R1A-ACK-ORDER`; it is not a deployable S12
candidate. The repair starts from governance HEAD
`6def06aa45a6d4c64b9a4e78cda35dd38331678f`; its replacement candidate is
`dfb8b41df86a65136f3fa5c2cd181fc1f2045ba1`. The earlier candidate supplies
the cutover Journal interlock, paused
candidate/suppression transaction path, system and managed-wake manifests,
fail-closed `core-wake`, Node Core lifecycle composition, generic WorkRun
claim/terminal execution, typed scheduled Hermes/Package B delivery, Python
maintenance reuse, a non-overlapping Node executor, an attention-flush WorkRun
owner and the non-empty adapter-exception evidence rule. The exact cutover
command, legacy Python scheduler disable projection and official Hermes
create/pause/edit/resume reconciler also exist locally. The expanded local
Core/attention set passes 183/183; the earlier affected Python set passes 67/67
and the current affected set passes 55/55. After binding the project Python
explicitly, the complete Node baseline passes 1,337 with zero failures and four
declared environment skips.
A timed todo write registers immediately through the authenticated local Core
route; the reminder scan repairs a missed registration into the same replay-safe
one-shot schedule. Independent review found that the scheduled suppression and
delivery paths called the Python acknowledgement before the worker committed the
WorkRun terminal. The repaired local path returns a typed delivery outcome to
the worker, commits the durable WorkRun terminal, rereads `completed`, and only
then invokes the Python acknowledgement. A post-terminal/pre-ack failure leaves
the WorkRun terminal and a missing Core acknowledgement marker; reopen skips the
delivery/effect and safely completes only the idempotent Python acknowledgement.
Focused WorkRun/scheduled-delivery/reminder checks pass 15/15, the Python
acknowledgement check passes 1/1, and the affected Core set passes 180/180.
The archived R1E candidate now stops the legacy external-MCP timer in Core
mode and runs the existing scan/executor through an `external_poll` WorkRun.
Before provider execution it validates the exact durable WorkRun revision,
fence, lease owner/id/expiry, active Core Activity contract, task kind and
aggregate payload. Candidate activity/revision/checkpoint identity is checked
against the bridge-owned runtime store, server identity is derived from that
trusted scope, and sanitized canonical output reaches only the existing
hash-bound Core fact writer. Duplicate candidates coalesce, terminal restart
does not repeat provider work, and the active Core path cannot reach the legacy
direct checkpoint sender. Independent review blocked the first R1E archive
`c8e5a88291bfe7e66a607a753a4994617aab0565` on a fact-to-projection crash gap
and revision/evidence skew. The bounded repair writes each external fact and
its deterministic `projection_outbox` intent in one Core transaction. Recovery
resumes attention or deterministic notification registration without rerunning
the provider; scheduled presentation requires the exact bound Activity
revision, checkpoint digest and fact event. Fresh focused crash/binding checks
pass `18/18`, and the smallest shared affected set passes `52/52`. The repaired
archive `493c77aa90fe53bba8a10fd94dd03136ba51d4eb` passed independent
exact-SHA rereview, so R1E is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`.

R1F is recalibrated around owner attention policy rather than desktop sensing.
The S12 candidate composes the existing attention valve without a desktop
presence provider: ordinary timely proactive content is eligible under its
default state, ambient content remains silent, and synthetic quiet states prove
the durable delayed/coalescing seam. Hermes activity in a game domain no longer
implies that the owner is gaming. The existing managed
`system-task:attention-flush` schedule is the single Core-owned flush clock;
focused local evidence passes `60/60`, including a typed synthetic delivery with
no presence file or real send. Desktop presence and explicit owner DND are
`POST_CUTOVER_OK`; Telegram is future channel work. Candidate
`08e3eea81c336ac48f3e0b85a87b0b5c6d445307` passed independent exact-SHA
review, so R1F is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`.

## Fresh R2 Readiness Evidence

R2-A re-audited production at `2026-08-10T02:14:52Z`: the detached clean
checkout remained at `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`; Core was
disabled with no database, cutover marker or managed tick, and legacy visible
clocks remained authority. Cutover-relevant aggregates were 14 todos, zero
future reminder candidates, three historical reminders, zero active/leased
durable jobs, zero watches, 13 paused and zero active/leased external
activities, 65 sent plus 65 terminal/no-resend ambiguous legacy outbox rows,
zero proactive reservations, and one historical past-due outbound item. Sent
history drifted from the earlier rehearsal's 58 to 65; this was captured as
fresh truth rather than normalized away.

R2-B copied only migration inputs into an isolated private root. SQLite used a
read-only source connection plus backup API/WAL-consistent snapshot; atomic
state inputs passed pre/post inode, size, mtime and hash stability. The copy
matched R2-A, migrated legacy/no-Core to Schema v2, suppressed all three
historical reminders, staged all 13 external activities paused, converted the
65 sent and 65 ambiguous rows to non-runnable evidence, and held the one old
pending outbound item for reconciliation with zero adapter calls. The cutover
rehearsal bound exact runtime SHA
`08e3eea81c336ac48f3e0b85a87b0b5c6d445307`, seeded 13 enabled schedules with
exactly one attention-flush and one external-mcp-poll schedule, and reopened as
`already_applied`. Synthetic fault/replay probes passed `33/33`; real model,
MCP, channel and Ombre effects were zero. The private copy and candidate were
deleted with no residual private data. Aggregate evidence, watermark and exact
digests are in `r2_fresh_production_copy_rehearsal.v1.json`.

The first rehearsal apply used an unsupported pure `synthetic` platform and
failed before transaction commit with zero Journal, Activity and Schedule
rows. Re-running with a valid Feishu protocol identity shape and a synthetic
non-delivering destination succeeded. This is
`NON_BLOCKING_OPERATING_INPUT_CORRECTION`, not a Core identity or source defect.
R2 caused no production mutation.

A separate authorized production maintenance transaction completed at
`2026-08-10T03:07:02Z`: it terminated exact orphaned account-backed XHS
mcporter PID `269670`, removed its exact legacy token cache without backup, and
started the existing enabled `ran-agent-xhs-public-sidecar.service`. The public
sidecar was active on loopback `18061` only with observed MainPID `672255`, a
valid public marker, empty cookie, downloads disabled and public fallback ready;
legacy `18060`, account login and cookie consumption were absent. No
Node/Python/Hermes/Ombre restart, Core change or source/worktree change occurred.
This mutation is not attributable to R2. Account-backed/cookie/login XHS is
retired; public cookie-free XHS is the only accepted production path and may
never fall back to account login. A real public fixture was intentionally not
used, so `XHS_PUBLIC_NETWORK_SMOKE_PENDING_R3`. Shared or unproven Chrome/Xvfb
processes were left untouched; legacy XHS env-name residue there is a
non-blocking hygiene observation, not an active account-backed route.

R2 is `LOCAL_VERIFIED`, `REVIEWED` and archived by the commit containing the
redacted evidence. That governance-only archive was not the runtime rehearsed
by R2-B. R3-A reviewed frozen candidate
`08ea6b0ccb499bb84ddd4d20a2ebad6a48c1af92` clear except for server proofs.
Follow-up source inspection then confirmed blocker
`R3-GATE-HERMES-TOPOLOGY-STALE`. Independent review of first repair
`d70a08fc19699f439d50845b846678a9f65a2ef9` classified that blocker
`NOT_RESOLVED` and added `R3-GATE-FULL-CONDITION-BLOCK-UNPROVEN` plus
`R3-GATE-PYTHON-PROBE-STALE`. Repair 2 keeps one unified v0.20 runtime authority,
derives the retired Full drop-in from `hermes_runtime_mutation.v1.json`, proves
the installed/effective condition is blocking without resolving a Full
executable, and updates the provider probe to require exact v0.20 and explicit
import-capable runtime Python without a `Project:`/PYTHONPATH layout. Focused
resolver/gate checks pass `2/2`, focused Python checks pass `4/4`, and the
affected release/portability file reports 83 total tests: 80 pass and three
unchanged Linux root-only skips. No Core or runtime product behavior changed.
Repair 2 is `LOCAL_VERIFIED / REVIEWED / ARCHIVED` at
`d6adb1061b5a819407582690ca6a9adcb63c8d26`; its independent exact-SHA review is
clear. A complete service-managed v0.20 `--all` proof is not representable on
the v0.13-only desktop and remains R3-B.

Follow-up source-delivery inspection confirmed
`R3-R1B-PROFILE-DELIVERY-GAP`: the accepted R1B changes existed in
`config.companion.yaml`, but the post-S1 source controller rejected every
profile delta and source activation still copied legacy `config.yaml` into the
active companion destinations. The local bounded repair introduces
`hermes_source_profile_migration.v1.json`, binds the exact prior source and
companion digest, permits only the companion plus inert Pro-template delta,
and activates the exact companion bytes at both existing live destinations.
The existing source snapshot restores both profiles and the prior source
pointer together. The historical overlay stays fail-closed and gains no
authority. This repair passed independent exact-SHA review at
`790546a34285a101948e301363381d094ec14b83`.

The first R3-B run proved that candidate's R1B YAML semantics and exact source
dry-run, then stopped fail-closed during the root runtime resolver. The sealed
Hermes v0.20 CLI reported the correct version across five
presentation/build lines, but the gate required one exact output line; the
sealed Python also correctly kept `gateway` and `hermes_cli` under the governed
`runtime/app` path rather than site-packages. The non-root gate did not run.
The post-check found the same production source, worktree, Hermes PID/services,
Core state and profile.

The class-level repair archived by the commit containing this status audits all
immutable/local provider-version and import consumers. Exact package metadata
is the version authority, CLI output is checked semantically, one shared sealed
runtime probe binds launcher/Python/app/site-packages, and the live process is
checked against the launcher's argv and non-secret environment contract. The
source controller now parses companion YAML through that explicit sealed
runtime instead of textual list matching. This repair is `LOCAL_VERIFIED /
NOT_REVIEWED / ARCHIVED`. Fresh local evidence is `8/8` realistic runtime
fixtures, `41/41` source/profile release tests, and the affected release file at
`81` pass plus three unchanged Linux root-only skips; the three real sealed
provider cases remain server-only rather than being falsely skipped locally.
R3-B retry and S12 remain `NOT_STARTED`. Production was not contacted during
the repair.

Before independent review, `R3-GATE-SEALED-PROBE-BYTECODE-WRITE-RISK` was
confirmed against archived candidate `d845e994`: `-I` isolates imports but does
not disable bytecode writes, so a root gate could mutate a writable sealed
runtime. The bounded superseding repair makes explicit `-B` mandatory at every
A/B/C sealed-Python import/parser/self-check call, makes the shared probe reject
callers without explicit `-B` before imports, and proves a writable synthetic
runtime tree remains identical. Focused evidence is `9/9` realistic runtime
fixtures, `41/41` source/profile checks, and the affected release file at
`81 passed / 0 failed / 3 environment skips`; real sealed-provider execution
remains an R3-B server proof. The blocker is `RESOLVED`; this repair is
`LOCAL_VERIFIED / NOT_REVIEWED / ARCHIVED` by the commit containing this status.

Independent exact-SHA review of the complete runtime-contract/no-write repair
is clear at `250a39fc1ce40ea8e5fa2fa27a50d4f058dd7ea4`. The second R3-B server
proof kept the production source at `98fd8b38`, passed the exact-candidate
source dry-run and the sealed v0.20 resolver/live-process/Full-retirement
checks, then stopped fail-closed in six tests inside
`hermesReleaseScript.test.mjs`. The non-root gate and Python provider suite did
not run; production remained unchanged.

An exact root reproduction of only that Node file produced the complete six-row
failure set. No row demonstrated a production gate-authority defect: four used
the outer root runner as the modeled runtime identity, one manually assembled
complete candidate omitted the newly mandatory runtime-identity verifier, and
one focused Python-prerequisite test had not isolated the newer checkout-access
probe. The bounded repair changes only the test fixture plus this synchronized
governance. It resolves an existing non-root fixture identity independently of
the runner, centralizes the bounded complete-stage helper surface, keeps root
identity rejection explicit, runs the modeled non-root nested gate through
`runuser` on Linux/root, and gives runtime-owned synthetic paths their truthful
identity. Local evidence is 85 tests with 81 pass and four declared platform
skips; Linux/root evidence is 85 tests with 84 pass and the one declared
desktop-only skip. That repair passed independent exact-SHA review at
`76c72988e8f6e989cd6d2ea61b09e8e7cc9ac917`.

The third R3-B retry kept production at `98fd8b38`, passed baseline and source
dry-run, then stopped fail-closed in root immutable `--all`: 655 total, 653
pass, one declared skip and one failure in `preserve runtime shape prepares
Ombre and starts recall before lite and full without requiring Hermes CLI`.
Non-root did not run and the Python provider proof was not reached. Exact
read-only production-host reproduction under root and `umask 077` captured
`/bin/bash: .../scripts/prepare-ombre-brain.sh: Permission denied`. The
candidate source and fixture `bin`/`state` leaves were behind root-created
`0700` parents, so modeled non-root `ubuntu:ubuntu` could not traverse them.
This is `R3-B-PRESERVE-OMBRE-FIXTURE-PATH-ACCESS-DRIFT`, not a production gate
or runtime defect.

The bounded repair changes only `hermesReleaseScript.test.mjs`: it supplies the
modeled runtime with a minimal root-owned, read-only authority copy, keeps the
fake tool path readable/executable but non-writable, makes the state parent
traversable but non-writable, preserves runtime ownership and writability for
Ombre/Core/projection leaves, and asserts those boundaries through `runuser`.
The exact Linux/root test passes under `umask 077`; the full Linux/root file is
85 total with 84 pass, zero fail and one declared skip; the local file is 85
total with 81 pass, zero fail and four declared platform skips. Workflow guard,
syntax and diff checks pass. The repair passed independent exact-SHA review at
`7019c805342084797c1e1bd201001d80ef1dd4ee`.

The fourth R3-B retry again kept production at `98fd8b38`, passed baseline and
source dry-run, then stopped fail-closed in root immutable `--all`: 655 total,
653 pass, one declared skip and one failure. The Ombre path-access case passed;
the sole failure moved to the projection-mode negative assertion with `Missing
expected exception`. Non-root did not run and the Python provider proof was not
reached. Bounded Linux/root instrumentation showed the injector selected the
pointer's active manifest, changed its mode from `0600` to `0644`, and then the
production `verify-runtime` command returned status 1 with
`projection_runtime_mode_invalid`. The production verifier is correct. The
negative fixture discarded the wrapped publisher status and did not prove its
mutation or target, so its result was not auditable across the root authority
copy and `runuser` boundary.

The bounded repair remains test-only. It derives the exact active manifest from
the publication pointer, checks the `0600` precondition, verifies the `0644`
postcondition and unchanged UID/GID, writes a required one-shot marker,
propagates the real Node status, and asserts that Hermes/Node restart does not
proceed. The Linux/root named test passes `1/1`; the full Linux/root file is 85
total with 84 pass, zero fail and one declared skip; direct projection tests
pass `39/39`; the local file is 85 total with 81 pass, zero fail and four
declared platform skips. That repair entered reviewed candidate
`0d7c5ce200567425b791d79ff78dcd04a17d293b`.

The fifth R3-B run on that candidate passed baseline and source dry-run. Root
`--all` reached Node 1177 total / 1176 pass / zero fail / one governed skip and
Python 462 pass / one fail plus nine passing pytest subtests. The sealed Hermes
Node provider boundary, DeepSeek non-thinking proof and enabled-thinking
fail-closed negative all passed. Non-root did not run. The sole blocker was
`R3-B-ARCHIVE-LOCAL-PATH-SYMLINK-RESOLUTION-BYPASS`: the archive helper
resolved the final lock leaf into a root-owned `0600` target before
`O_NOFOLLOW` and path-inode verification, so the transaction succeeded and
published the target. The same full-leaf assumption also affected archive
record normalization and recovery publication.

The bounded authority repair archived at
`28c4054989c1176a4d8988872c43363b09c74494` resolves parents for containment
while preserving ordinary final leaves, rejects parent escape before `mkdir`,
requires no-follow opens, and routes normal and recovery publication through
the existing hard-link no-replace publisher. Independent review accepted those
boundaries but returned `FIX_REQUIRED` for
`RAW-FINAL-COMPONENT-NORMALIZATION-BYPASS`: `Path(path)` discarded a trailing
separator or final `.` before `.name` validation, so `foo/` and `foo/.` could
silently become `foo`. Candidate `28c40549` is therefore
`LOCAL_VERIFIED / REVIEWED / FIX_REQUIRED`, not retry-ready.

The bounded successor validates the raw POSIX final entry before constructing
a `Path`, rejects empty, `.` and `..` final entries including repeated-separator
forms, then canonicalizes only the parent. Safe parent normalization, final
symlink preservation, containment, no-follow inode checks and no-replace
publication remain unchanged. The complete archive transaction file passes
39/39, focused recovery path tests pass 3/3, and a Git-less read-only Linux/root
probe passes under EUID 0 with `umask 077`. Independent review cleared that
raw-final repair at `e4a6d205afc4183cfda503aa6bb4977dac29fb25`.

The sixth R3-B run on `e4a6d205` passed baseline, source dry-run and root
immutable `--all`. Root evidence was Node 1177 total / 1176 pass / zero fail /
one governed skip, Python 472 pass plus nine passing subtests, sealed Hermes
Node, DeepSeek non-thinking, enabled-thinking fail-closed and Linux/root
portability all passing. Non-root reached 524/524 passing Node tests before the
shared sealed-runtime resolver stopped fail-closed. Its `HOME=/nonexistent`
sentinel was not an absence guarantee: the host had root-owned mode `0700`
`/nonexistent/.hermes`, which root could inspect but the governed `ubuntu`
identity could not read. The resolver therefore returned
`runtime_contract_invalid` and `hermes_v0_20_runtime_required`. Production was
unchanged.

The shared probe repair creates a unique caller-owned mode `0700` scratch
namespace per invocation and replaces the child environment so HOME, TMPDIR and
the XDG config/cache/state/data roots all remain beneath it. Hermes may create
legitimate ephemeral initialization state there; the probe instead verifies
the same scratch inode, owner and mode after the CLI, recursively removes only
that invocation's namespace on success or failure, and refuses success if
cleanup fails. The sealed runtime no-write/import/origin/version checks remain
unchanged. The exact implementation bytes passed bounded scratch-only
TECserver validation under both root and `ubuntu`: the shared probe, staged
resolver, Node provider route, Python non-thinking route and enabled-thinking
negative all passed; ambient HOME/XDG/TMP and `/nonexistent` had zero influence;
sealed-runtime content/metadata hashes, service PIDs/restarts, production HEAD,
worktree and source pointer were unchanged. The repair was archived and passed
independent exact-SHA review at
`9653d030473b3e9870ddea9158c4a2f9570c243b`. The complete immutable R3-B run on
that base is `CLEAR`; its observed production source remained
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`.

S12 entered orchestration remediation as `NOT_STARTED /
BLOCKED_BY_ORCHESTRATION_INTERLOCK`. Candidate
`e6ce78aaeb3c7117daac25ccbeb7b66b570cd0b1` is `LOCAL_VERIFIED / REVIEWED /
FIX_REQUIRED / ARCHIVED`. Independent review accepted its overall composition
but found `S12-VERIFY-SOURCE-REF-MUTATION`,
`S12-ACCEPTED-JOURNAL-OVERRIDES-SQLITE` and
`PRE-MARKER-COMPOSED-ROLLBACK-PROOF-MISSING`. Successor
`91172d4c1925aa82a6d153671165b1c20473c4e7` makes
source VERIFY candidate-extracted and persistently read-only, gives the
SQLite `core-cutover:v1` marker precedence over every accepted/rollback journal
branch, validates accepted replay without restart or effect, and proves exact
P0-P4 authority-vector restoration including source-apply-before-P1 recovery.
Independent review accepted those semantics but returned `FIX_REQUIRED` for two
remaining read-only primitives: Git could refresh `.git/index` during VERIFY,
and acceptance inspection used writable Core initialization. Candidate
`959b8f0d4503448da3bb44205d40bddd7d32e43a` repaired those primitives and is
`LOCAL_VERIFIED / REVIEWED / FIX_REQUIRED / ARCHIVED`. Its exact-candidate
review found one real blocker: the bootstrap's manually synchronized SHA256
manifest still named older controller bytes, so canonical VERIFY correctly
failed closed. The review also observed SQLite-managed live-WAL SHM read-mark
changes; first-principles analysis classifies those derived coordination bytes
as `NON_BLOCKING`, because DB/WAL business state, schema, receipt, permissions,
writer/wake/service authority and effects remain unchanged. Candidate
`e120f1c246135d566e58847684e14521ea15809d` removes the duplicate manifest
authority and is `LOCAL_VERIFIED / REVIEWED / ARCHIVED`. Its production
critical proof stopped before P0 with
`S12-P0-PREAPPLY-CANDIDATE-SUBORDINATE-AUTHORITY-GAP`: candidate-only S12
code/manifests still resolved from the older production checkout. The bounded
successor establishes one scratch-only read-only execution closure from the
exact Git candidate and uses it across P0-P10; `/opt/ran_agent` remains state,
never fallback S12 control code. It is archived at
`6d5d5b3a4b5b5da2eb7dbd84f37c4ec3170de41a`, independently reviewed `CLEAR`,
and its production candidate-closure proof passed. That proof then exposed
`S12-VISIBLE-BINDING-FEISHU-DESTINATION-HANDOFF-GAP`: the generic visible
binding could not preserve direct-user versus chat recipient semantics through
Core, so Feishu direct-message dispatch reached an empty user ID. The bounded
successor keeps the existing Package B `destinationKind`/`destinationRef`
contract through the durable scheduled effect, maps `user` and `conversation`
without fallback, and rejects an empty recipient before CLI invocation. It is
archived at `2f822d9ae3878a4f6d6e5a6f0adf1725a838f63b`. Terminal audit accepted the
route semantics but returned `FIX_REQUIRED` for the sole remaining blocker
`S12-VISIBLE-BINDING-APPROVAL-AND-CUSTODY-GAP`: the controller derived expected
authority from mutable path bytes, reopened that path across phases and again
at P8. The bounded successor requires the owner-approved digest, captures the
protected input once, pins it under the existing S12 transaction, binds its
digest into the existing `core-cutover:v1`, and resolves post-P5 acceptance
from the existing Package B binding receipt. That repair is independently clear
at `482e70083afb067f1e804cf1a8abd20e4ebf41ab`; the owner-approved protected
binding remains installed byte-identically at mode `0600` with digest
`sha256:dde57df0d2fc34860a52e486aaccdb1aacccb83d3eedb3de40ccd5109959542f`.
Source convergence excision is archived at
`3302472676131f7046fa6e9bd4d5727e31ee28f3`. Production cleanup removed all 29
logical refs in the retired source-candidate namespace; ubuntu ref enumeration,
fetch and status are healthy while production remains clean at
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. Canonical VERIFY passed for
`3302472`; APPLY completed P1, then P2 failed before Core authority or any
external effect and source rollback succeeded. The cause was ubuntu reopening
root-owned inherited inputs through `/proc/self/fd`, which Linux rejected with
`EACCES`; direct inherited-FD reads succeed. The local bounded repair passes
focused tests and the exact Linux root-to-ubuntu P2 proof. That failure and
rollback remain historical evidence. The direct-FD successor
`e298bab161bf0f4882bcef6e9cd701d546b63ff2` later passed canonical VERIFY and
completed the same S12 transaction through P10/ACCEPTED. Source pointer and
`core-cutover:v1` bind e298; exactly one semantic writer and the managed wake
are active, normal ingress is restored, and Node/Python/Hermes are active. P9
is owner-accepted `TERMINAL_AMBIGUOUS_NO_RESEND`: one attempt, external effect
unknown, resend forbidden and no duplicate presentation result, under
`owner-s12-e298-terminal-ambiguous-acceptance-20260813`.

A 2026-08-09 owner-visible incident adds two serial R1 blockers without
changing production. For an ordinary DLM web-research task, Hermes attempted an
already exposed `web_extract` surface through deferred tool discovery instead
of the governed `search_hub` route; the research step did not complete. It then
selected the Minutes-only `feishu.minutes_to_doc` action for a non-Minutes
document request. Node correctly rejected the ungrounded action before document
execution but incorrectly collapsed that pre-execution failure into “document
readback not confirmed”; a separate response-envelope shape gap exposed private
JSON to the owner. The requested learning note has since been recovered
out-of-band and read back successfully, which repairs the owner's artifact but
is not evidence that production routing, action resolution, acknowledgement or
envelope parsing is fixed.

R1B is locally verified in the archived review candidate. The companion
candidate removes the built-in `web` toolset and its unused built-in provider
block while preserving `mcp-search_hub`, its `search`/`read`/`research` tools,
internal provider policy and the distinct Playwright browser/debug capability.
Both diagnostics accept that assembly. A DLM-shaped real MCP-handler call
entered typed `research`, selected the academic provider seam and returned
structured evidence without `web_extract`, `web_search` or `tool_describe`.
The complete affected Node set passes 62/62, the profile/release Python set
passes 43/43, and Shell syntax plus `git diff --check` pass. Independent source
review found no R1B blocker; its grouped review status is now released after the
independent exact-SHA R1A repair review passed.

Fresh owner evidence then reproduced a separate ordinary-chat failure: a
provider-origin private reply envelope used string `"v1"` instead of numeric
version `1`, strict parsing rejected it, and the Gateway degraded the same JSON
to ordinary `reply_text`. Local R1B.1 now requires numeric `1` in the producer
instruction, canonicalizes only unambiguous `"1"`/`"v1"` aliases, and fails
other private-envelope-shaped JSON closed to a safe reply. Rejection logs carry
only a stable code; ordinary non-envelope JSON remains visible. The affected
Gateway/Backend/ChannelHub/entry set passes 259/259 locally. Production still
runs the archived parser. Independent source review found no R1B.1 blocker; its
grouped review status is now released after the R1A review passed.

The previous bounded candidate archive completed at
`aabf9bc97ea3fcd95bf6d79798c56315543d0c37`; its `R1A-ACK-ORDER` repair is
archived at `dfb8b41df86a65136f3fa5c2cd181fc1f2045ba1` and the independent
exact-SHA delta review is clear. R1A, R1B and R1B.1 are now `REVIEWED`. R1C
adds the smallest effect-oriented Feishu `document.write` seam plus bounded
internal replan. R1D has now decided exact dependency compatibility before
external-MCP WorkRun composition, owner-attention policy acceptance and the
fresh R2 rehearsal. The current server `lark-cli` observed during artifact
recovery is `1.0.66` while `1.0.85` is offered; no upgrade occurred. Ombre and
external providers remain optional adapters behind stable Hermes-facing product
surfaces and cannot replace Core or Node authority. That readiness work did not
itself start S12 or change production. The canonical per-node dependency
and acceptance ledger is `docs/governance/s12-readiness-topology.md`; its
verification/delivery split prevents local evidence from being mistaken for an
archived or deployable candidate.

R1C must keep `document.write` semantics independent of those CLI versions and
contain all command/response-shape handling inside the Feishu adapter. It does
not upgrade `lark-cli` and cannot claim production-candidate readiness. The
first R1C archive `e4161721d253c160558aeaf22b7fda77e1a331b4` failed independent
review because a second Hermes envelope could escape the document repair scope
and because title-only readback could certify the wrong body or parent. The
bounded repair extracts exactly one `document.write` request, rejects repair
activity/commitments/claims/other actions before execution, and requires exact
document ID, canonical body and resolved parent membership from the Feishu
adapter. The current provider surface exposes the required exact evidence, so
R1C did not start R1D and no dependency changed. The final focused R1C/reply set
passes `75/75`; the smallest shared envelope/receipt/ledger boundary set passes
`125/125`. The repaired archive is
`02b8f6491f4ca3013f847decdc59974a90bebdca`; its independent exact-SHA review
is clear, so R1C is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`. R1D is now a
complete bounded decision: server `lark-cli` `1.0.66` and candidate `1.0.85`
are compatible on the accepted search/create/fetch/files-list and canonical
XML surfaces, and neither version requires an upgrade for S12. Both versions
do require `docs +update --command overwrite`. R1D-L1 adds exactly that missing
pair inside the Feishu adapter without changing `document.write` semantics,
create behavior, readback or replay handling. The focused set passes `6/6`;
fresh fake-token dry-runs on production CLI `1.0.66` and isolated `1.0.85`
both resolve to PUT, `command=overwrite` and the supplied document ID without
performing an external write. R1D-L1 is archived at
`af25198654e048cc70e7e94a4c9974f2070428e0`; its independent exact-SHA delta
review is clear, so it is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`. R1D
dependency compatibility is closed. Ombre projection is not composed
by the S12 candidate and Agent
Reach remains an optional future Search Hub provider, both `POST_CUTOVER_OK`.
External MCP remains behind the bridge-owned gateway and passes the focused
compatibility set `26/26`; the dependency is `COMPATIBLE_AS_IS`. R1E preserves
its accepted WorkRun/replay/no-direct-send acceptance while repairing
`R1E-FACT-PROJECTION-GAP` and `R1E-REVISION-EVIDENCE-SKEW`. Its repaired archive
`493c77aa90fe53bba8a10fd94dd03136ba51d4eb` passed independent exact-SHA
rereview. R1F is accepted at `08e3eea8`; R2-A/R2-B are clear and archived as
governance/evidence only. R3 is the ready, not-started frontier. No dependency
or production source changed; the separately authorized XHS public-only runtime
maintenance is recorded above and is not attributable to R2. Exact dependency
evidence and dispositions are recorded in
`docs/governance/r1d_dependency_compatibility.v1.json`.

The local Python entrypoint is now the ignored repository `.venv`, created from
the existing Anaconda Python 3.10 with system site packages. Local archive and
Node release tests resolve explicit environment input first and that project
entrypoint second; they no longer select an arbitrary `python3` from `PATH`.
Production release gates retain their existing explicit absolute
`RAN_AGENT_PYTHON_BIN` contract.

The desktop test host now also resolves the bundled Node `24.14.0` before the
obsolete `/usr/local/bin` executable in Codex and fresh login shells. This is a
host-local development fix, not a production source or deployment change;
production release gates continue to receive their runtime executable as an
explicit validated input.

## Source And Recovery Authority

Binding.v4 completed the earlier runtime apply, rollback and reapply and records
`runtimeRollbackAuthorized=false`; the retained Runtime controller, artifact,
candidate ref, topology and snapshot state are evidence-only. S1 then completed
the source dry-run, apply, source rollback and reapply at `c6c0baf`. Post-S1
source advances then accepted S2 at `2dc6d1a`, S3 at `cc66387`, and S4 at
`98fd8b3`; the exact snapshot recorded by
`source-snapshots/current-source.json` is now the source rollback authority and
retains the prior pointer chain. Runtime rollback remains forbidden.

The owner authorized closing the v0.13 rollback window before the 2026-08-07
cleanup. Closure relied on bounded v0.20 production acceptance plus the real
binding.v4 source apply/rollback/reapply; no separate v0.13 Runtime rollback was
used as a close-out drill. Six exact retired payloads were then removed under
the root-owned `v013-payloads.deleted.json` record, reclaiming 224079872
allocated bytes. Shared runtimes, MCP capabilities, model/index assets, the
v0.20 Runtime and personal data were preserved.

Two earlier companion-overlay attempts are closed as `rolled_back`: the first
exposed the parked Obsidian startup dependency, and the second exposed
client-lifetime and rollback-readiness defects. Candidate
`dc5fcf13f86483073c54ac046e1b238a90c91921` then ran under a transient systemd
unit and was accepted at `2026-08-07T12:46:10Z`. Its transaction records the
exact profile, MCP namespace, Python source, drop-in and overlay digests. The
historical rollback target was the real `2c8e97c + accepted overlay` topology,
not the bare host-visible old profile; S1 source convergence superseded it.

## Main Source State

S1a was archived at `0fef0427683a8f3f77deec9e6cff937f7ab0a02e`;
its bounded successor completed at
`c6c0baf6dfbcf2cc38a68986292f55649ec93932`. The post-S1 source controller then
advanced the clean production checkout and accepted source pointer through S4
to runtime source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. GitHub `main`
also contains the local-only S5 B.2 seam and S7 Package B.3 Node wiring;
production remained on the accepted S4 source until the separately authorized
S12 cutover advanced it to e298; later unified-source transactions advanced the
runtime source to `9df626f` while preserving the e298 Core authority.
The source shape keeps one `ran-agent-companion` profile, one `8642` route, the
supported Lite/Full capability union and a fixed 15000 ms memory boundary.
The source still aligns four production-backed contracts:

- canonical `memory_bge_vector_index.*` paths;
- Ombre endpoint absence classified as transport failure;
- unified Hermes and co-reading defaults on `8642`;
- no production-composed or model-facing Ombre mutation; inactive O2 seams are
  absent.

Legacy split-profile release inputs remain excluded from the companion
distribution. The source mode reuses the existing candidate controller and is
the only authorized seam through the unified marker; after S1 it advances only
from the accepted source pointer to an exact archived `main` descendant and
restores that pointer on rollback. The legacy release mode continues to fail
closed.

## Active Follow-Ups

The canonical execution order and stage exit conditions live in
`docs/governance/active_sequence.md`. S0-S12 are complete and S12 is
`PROD_ACCEPTED`; Core authority remains e298. Product-effect recovery and
managed-wake activation and F6 production apply are complete. F6OBS is the
ready frontier: observe one real 08:00 digest with a plain dated body and no
visible private protocol. S13 remains not
started. Cleanup also requires separate explicit owner deletion authorization;
none is current.
The S5-era root-worktree drafts
were triaged in S6: the 30 runtime paths remain in the checksummed desktop
patch, the three governance-hook paths belong to their dedicated task, the
three retained runtime semantics were re-implemented on current main, and the
remaining O2/Steward, legacy-deployment, second proactive-delivery and
JSON-outbox content is retired.

The remote branch set is intentionally `main` only. Historical candidate
branches are neither production nor rollback authority; recoverable local S4
convergence artifacts remain ignored under `local_archive/`.

Package A and B.1 Core primitives exist in source; S5 verifies the local B.2
final/outbox/effect/receipt loop, S7 completes local B.3 Node wiring, S8
completes the local governed Ombre projection seam, S9 completes local Package
C scheduling, S10 completes the migration inventory/rehearsal and external
poll fact seam; S11 completes synthetic fault/attention acceptance, including
the still-unwired `attentionValve.mjs`. None is composed into the
production Node write path.
Ombre Gate 5 is retired with O2 and the historical
name is retained only as retired evidence; the single future Core production
gate is uniformly named the Core Cutover Gate (S12). O2 is a retired
migration-era path; only rollback evidence may remain.

## Protected State

Never commit or print env files, credentials, cookies, proxy URLs, runtime
state, private vault content, databases, logs, debug output, provider-visible
history, local archives, caches or personal media.
