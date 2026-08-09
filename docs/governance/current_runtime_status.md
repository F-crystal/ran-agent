# Current Runtime Status

Status: S4 PROD_VERIFIED; S5-S11 LOCAL_VERIFIED (2026-08-09)

This is the compact source of truth for current production behavior. Commands
live in `docs/governance/server_runtime_commands.md`; design contracts and
historical phase records stay in their focused governance documents.

## Production

```text
repository_sha: 98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d
companion_overlay: dc5fcf13f86483073c54ac046e1b238a90c91921 retained as rollback-only evidence
runtime: Hermes v0.20.0; deepseek-v4-flash; one gateway on 127.0.0.1:8642
retired_runtime: 8643 absent; ran-agent-hermes-full inactive, disabled and condition-blocked
runtime_stage: PROD_VERIFIED for the bounded channel, identity, memory, capability, topology and 2026-08-07 digest evidence
services: Node, Python, unified Hermes and direct Ombre Brain active; no unexpected restart in the acceptance window
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
handed to the dedicated hook-fix task; they are not represented as recoverable
S5 runtime drafts. The three still-missing runtime semantics were re-implemented
on current main:
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
`6def06aa45a6d4c64b9a4e78cda35dd38331678f`, and the archive commit containing
this status is the replacement candidate. The earlier candidate supplies the cutover Journal interlock, paused
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
Source inspection found that the archived
candidate already stops the legacy external-MCP timer in Core mode, runs its
existing scan/executor through an `external_poll` WorkRun, records hash-bound
Core facts and routes any presentation candidate through Core delivery. That
early implementation is not R1E acceptance: its authority, replay and
no-direct-send checklist remains closed until the serial frontier reaches R1E.
Attention delay/flush still needs an actual presence producer rather than a
guessed available state. Neither proposed timer row is activation evidence. S12
remains `NOT STARTED` until the serial readiness nodes in `active_sequence.md`
pass and the owner separately authorizes production.

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
review found no R1B blocker; grouped review status remains held until R1A closes.

Fresh owner evidence then reproduced a separate ordinary-chat failure: a
provider-origin private reply envelope used string `"v1"` instead of numeric
version `1`, strict parsing rejected it, and the Gateway degraded the same JSON
to ordinary `reply_text`. Local R1B.1 now requires numeric `1` in the producer
instruction, canonicalizes only unambiguous `"1"`/`"v1"` aliases, and fails
other private-envelope-shaped JSON closed to a safe reply. Rejection logs carry
only a stable code; ordinary non-envelope JSON remains visible. The affected
Gateway/Backend/ChannelHub/entry set passes 259/259 locally. Production still
runs the archived parser. Independent source review found no R1B.1 blocker;
grouped review status remains held until R1A closes.

The previous bounded candidate archive completed at
`aabf9bc97ea3fcd95bf6d79798c56315543d0c37`, but R1A remains
`NOT_REVIEWED` after `R1A-ACK-ORDER`. Independent review of the exact repair
delta from `6def06a` through the archive commit containing this status is the
current boundary before R1C becomes ready. R1B and R1B.1 remain source-review-clear
without changing that grouped boundary. R1C adds the smallest effect-oriented Feishu
`document.write` seam plus
bounded internal replan; R1D then decides exact dependency compatibility before
external-MCP WorkRun composition, real presence/attention ownership and the
fresh R2 rehearsal. The current server `lark-cli` observed during artifact
recovery is `1.0.66` while `1.0.85` is offered; no upgrade occurred. Ombre and
external providers remain optional adapters behind stable Hermes-facing product
surfaces and cannot replace Core or Node authority. S12 remains `NOT STARTED`;
production source and services are unchanged. The canonical per-node dependency
and acceptance ledger is `docs/governance/s12-readiness-topology.md`; its
verification/delivery split prevents local evidence from being mistaken for an
archived or deployable candidate.

The local Python entrypoint is now the ignored repository `.venv`, created from
the existing Anaconda Python 3.10 with system site packages. Local archive and
Node release tests resolve explicit environment input first and that project
entrypoint second; they no longer select an arbitrary `python3` from `PATH`.
Production release gates retain their existing explicit absolute
`RAN_AGENT_PYTHON_BIN` contract.

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
production remains on the accepted S4 source until a separately authorized
cutover.
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
`docs/governance/active_sequence.md`. S0-S11 are complete. S12 production cutover waits on explicit owner production
authorization and stays NOT STARTED until it is granted. The S5-era root-worktree drafts
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
