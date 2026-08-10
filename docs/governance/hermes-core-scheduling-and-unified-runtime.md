# Hermes Core Scheduling and Unified Runtime

Status: CURRENT (2026-08-10)

Lifecycle: Runtime Phase `PROD_VERIFIED` for the bounded channel, identity,
memory, capability, topology and 2026-08-07 digest evidence in
`docs/governance/current_runtime_status.md`; Core Packages C-E/S11
`LOCAL_VERIFIED`.

This decision record amends the implementation direction of the archived v0.4 cutover
contract. It does not modify frozen Schema v1 or authorize a production Core
write path. Runtime deployment facts are recorded separately from the still
unimplemented Core cutover.

## Decision

ran-agent will converge on one companion Hermes gateway and one wake clock.
Hermes cron may own the clock edge, but Core remains the only authority for
schedule intent, occurrence identity, Work Run authority, effects,
presentation outbox, and delivery truth.

The production target is:

```text
one managed-core-tick
  -> idempotent Core wake_due(now)
  -> ScheduleSpec + WakeOccurrence transaction
  -> WorkRun claim/fence
  -> Hermes draft and governed effects
  -> Core final/effect/presentation commit
  -> adapter receipt or durable ambiguous
```

Hermes `jobs.json`, `executions.db`, output files, and direct-delivery state are
not Canon and are never migrated as Core truth.

## First-principles boundary

A clock answers only "check what is due now." It cannot decide that a logical
occurrence exists, that work acquired authority, that an external effect
happened, or that a message was delivered. Those facts must survive process
death and must compose with the existing Core transaction, fence, effect, and
outbox contracts.

Therefore the managed tick:

- does not invoke an agent;
- does not create user-visible text;
- does not call a presentation adapter;
- carries no private memory or destination payload;
- may be duplicated, delayed, or missed without duplicating an occurrence;
- cannot make an occurrence successful by itself.

The Core endpoint accepts a trigger identity, reads time from the Core-owned
clock, then returns only counts and opaque Journal IDs for mutations. An empty
tick writes only a redacted runtime metric. Caller time, when supplied, is
diagnostic only. It never returns private schedule content.

## Authority split

| Concern | Authority |
|---|---|
| clock edge | one deploy-owned Hermes managed job |
| goal, scope, grant, budget, pause/cancel | Core `Activity` |
| recurrence and next due instant | Core `ScheduleSpec` |
| logical due instance | Core `WakeOccurrence` |
| execution authority | Core `WorkRun` revision, lease, and fence |
| external action truth | Core Action Intent / Effect Attempt / receipt |
| assistant semantic final | Core Package B final transaction |
| physical delivery | Core presentation outbox and adapter receipt |
| Hermes job/config files | deploy projection only |

Same-UID operator CLI and authenticated job API remain an operator trust
boundary, not a second runtime writer. The companion profile must not expose
the Hermes-native `cronjob`, `delegate_task`, or `execute_code` tools. The
legacy Lite/Full terminal, file, session-search, Playwright, and MCP product
capabilities remain available through the unified allowlist.

The deploy-owned managed-job manifest is exact: `no_agent=true`,
`deliver=local`, one owner-only absolute script path, fixed working directory,
bounded timeout, and no private arguments. Success writes no private stdout;
failure writes only redacted local diagnostics. When the candidate selects the
Hermes projection, startup and release acceptance require exactly one job and
compare its immutable managed fields with the manifest. Hermes may update an
allowlisted set of runtime fields such as next
run and execution timestamps and may retain local output/execution diagnostics;
those are short-lived non-Canon and never Core input. Ordinary agent and
external-delivery job paths are not valid substitutes.

Hermes cron is the only clock projection over the owner-only idempotent
`core-wake` command. Core catch-up makes a second timer unnecessary; add a
fallback only after an observed availability requirement justifies it.

## Schema v2 contract

Schema v1 remains byte-for-byte frozen. A new immutable `1 -> 2` migration
adds only the scheduling objects required by current product behavior.

### ScheduleSpec

A ScheduleSpec is the canonical recurrence attached to exactly one Activity,
including an explicit system Activity for system-owned work. Activity remains
the only authority for goal, owner, scope, Grant, budget, product lifecycle,
pause/cancel, and contract revision. A ScheduleSpec stores recurrence,
catch-up, and next-due state only. The first implementation supports only:

- `one_shot` at one UTC instant;
- `interval` with a positive whole-second period;
- `daily` at one local wall time plus an IANA timezone.

Full cron syntax, calendars, and arbitrary recurrence DSLs are out of scope
until a real use case cannot be represented by these three forms.

Each spec has stable identity, required Activity identity, current immutable
revision pointer, next due instant, scheduling state, and timestamps.
Scheduling state is only `enabled | exhausted | retired`; Activity state is
the sole product pause/cancel authority. A separate append-only `ScheduleSpecRevision`
stores normalized recurrence, allowlisted task kind, payload reference,
catch-up policy, Activity contract revision, semantic digest, causation,
optional existing conversation/presentation-binding identities plus expected
binding revision, and creation time. Old occurrences bind the exact immutable
revision.

Create, revise, enable, exhaust, and retire use a parent-scoped operation key
plus versioned semantic digest, expected current revision, CAS, and the existing
Journal/typed operation replay primitives; no new receipt table is added. Exact
key+digest replay returns the original result before current-state validation;
equal key with different semantics fails with zero mutation.

Catch-up is one of:

- `skip`: advance without creating an overdue occurrence;
- `latest`: create only the most recent due occurrence;
- `bounded`: create at most the configured recovery limit, hard-capped at eight.

One recovery consumes at most that limit, atomically advances `next_due_at` to
the first future instant, and writes one aggregate Journal skip event for all
remaining elapsed windows. Later ticks never continue draining old backlog.

### WakeOccurrence

A WakeOccurrence is the immutable scheduling fact that one ScheduleSpec
revision became due. It does not summarize execution, effects, or delivery.
Its uniqueness key is `(schedule_spec_id, scheduled_for)`; the row records the
immutable ScheduleSpec revision that produced it. The occurrence ID is
deterministic from that pair and a versioned domain separator. Repeated ticks
and later Schedule revisions therefore cannot recreate the same logical slot.
Revision sets its next due strictly after Core `now` and every existing
occurrence for that spec; a committed occurrence is never replaced.

WakeOccurrence has no lifecycle state. In one transaction, `wake_due` inserts
the immutable occurrence, creates its initial queued WorkRun, creates the
optional scheduled Exchange, and advances `next_due_at`. Schema v2 adds a
nullable `wake_occurrence_id` reference to WorkRun; explicit retry creates a
new WorkRun bound to the same occurrence and optional Exchange while retaining
the Activity-wide `work_run.attempt_no` required by Schema v1. WorkRun alone
owns lease/fence and execution state; EffectAttempt/receipt alone owns external
effect truth; presentation_outbox alone owns delivery truth.

Every message-capable Schedule revision references an existing Conversation,
PresentationBinding, and expected binding revision. The occurrence transaction
verifies Conversation and binding are active and unchanged; mismatch creates
no visible WorkRun/Exchange and atomically retires the Schedule head with one
reconciliation Journal event; reenabling requires a new valid revision. A
valid occurrence has exactly one deterministic scheduled Exchange, and all
later attempts bind it. Visible final and presentation operation identity
derives from occurrence/Exchange, never from attempt identity. A silent/system
Schedule has no Exchange and can never enter the final/presentation path.
Before any recovery attempt dispatch, Core reads the existing final, effect,
and presentation ledgers. A committed final, confirmed effect, or any
ambiguous effect/delivery forbids redispatch and requires reconciliation.

Creating occurrence/WorkRun/optional Exchange and advancing `next_due_at`
happen in the same transaction. A crash cannot advance the schedule without
creating the work or recording one aggregate Journal skip event. Skip creates
no WakeOccurrence. A one-shot spec becomes exhausted in that transaction;
recurring specs compute their next instant from the previous scheduled instant,
not from worker completion time.

`scheduled_for` is canonical UTC with whole-second precision. Interval
recurrence advances from its immutable anchor, never from tick or worker
completion time. Daily recurrence uses its revision's IANA timezone: a missing
local time resolves to the first valid instant after the gap, and a repeated
local time resolves to the earlier instant exactly once. Core's injected clock
is authoritative in tests and Core's process clock is authoritative at
runtime; caller timestamps never decide due state.

## Required transactions

1. Create or revise a ScheduleSpec and its next due instant.
2. For each due spec, atomically create/deduplicate WakeOccurrence, queued
   WorkRun, optional Exchange, and next due; or append one aggregate Journal
   skip event and advance directly to the first future instant.
3. That transaction CAS-checks Activity is active at the bound contract
   revision and, for visible work, Conversation/PresentationBinding are active
   at the expected revision. Terminal/stale Activity authority or binding
   mismatch retires the Schedule once and creates no occurrence, WorkRun,
   Exchange, effect, final, or outbox. A merely paused Activity produces no
   mutation and is reconsidered after resume under catch-up policy. Every later
   WorkRun lease claim repeats the Activity state/revision check before
   authority is granted.
4. Stop/cancel remains Activity/WorkRun authority: WorkRun stop rotates only
   that run's fence; any Activity contract revision change fences active runs
   from the old revision. `wake_due` simply refuses non-active or stale
   Activity authority. Schedule revise switches the immutable head revision;
   retire disables future recurrence. There is no pending occurrence to cancel.
   Stale results cannot create another occurrence, effect, final turn, or
   presentation item.
5. Package C adds a typed scheduled instruction Exchange path bound to a
   verified Conversation, Activity, WakeOccurrence, and PresentationBinding.
   It never fabricates user ingress or writes ordinary chat history. Only a
   message-capable decision that produces visible speech enters an additive
   Package B final + presentation transaction; a silent/system Schedule has no
   Exchange and commits only WorkRun/effect state.
6. Final/effect/presentation commits use existing Core authority. The cron
   adapter never writes those outcomes.

The endpoint processes a bounded batch and returns promptly. Remaining due
specs wait for the next tick. No network, model, MCP, or adapter call occurs
inside a Core SQLite transaction.

## Attention and proactive delivery

An internal wake is not permission to interrupt the owner. Forum watchers,
RSS readers, and other external MCP sources use the same `external_poll`
schedule class: polling records Core facts and creates WorkRun authority, but
the poller never sends a message directly.

Hermes proposes semantic content plus an attention identifier. Node validates
that identifier against the content class and payload format, then applies the
owner's delivery policy. The S12 candidate treats ordinary timely content as
eligible by default and ambient content as silent. Optional future policy
providers may inject coarse quiet states such as gaming/focused/dnd, but they
run outside Core transactions, expose only the minimum state needed by the
valve, and are not prerequisites for proactive delivery.

- `ambient` results remain silent and can be surfaced on the next owner turn;
- `timely` results may be delayed and coalesced while the owner is gaming,
  focused, busy, or in do-not-disturb mode;
- only an owner-allowlisted `critical` content class may bypass those guards;
  a model-proposed label alone cannot create that authority.

Suppression never discards the Core fact or stops internal polling/work. It
changes only visible delivery timing. Repeated equivalent source facts share a
stable fingerprint and one presentation identity so a flapping source cannot
produce an alert storm. Package D inventories existing external pollers under
this split; Package E verifies gaming suppression, delayed coalescing, and the
critical allowlist with synthetic targets. S11 implements this valve as
`node_bridge/src/attentionValve.mjs` with a durable coalescing store; active
hours and the notification budget remain unwired design inputs, and no
production delivery path consumes the valve yet.

## Unified companion runtime

Lite/Full is retired as a deployment topology because it duplicates state,
gateway processes, cron tickers, cache/history policy, and release gates
without providing a security boundary. The target has one Hermes home, one
gateway, one provider policy, and one companion profile.

The profile preserves the exact union of the current Lite and Full product
surfaces: terminal, file, session search, Playwright, media, co-reading, and all
existing MCP servers. The merge removes duplicate topology, not capabilities.
Hermes-native `cronjob`, `delegate_task`, and `execute_code` remain outside the
companion runtime because neither legacy profile approved them.

Transition has two releases and only one Core write-path cutover.

### Runtime Phase

Deployment checkpoint (2026-08-06): exact candidate
`0b793e8fea85c409800ee7e0d615501816c99387` applied the `LINUX_VERIFIED`
immutable artifact. The archive is 133,558,059 bytes,
with tree SHA256
`3049a082c0d1794bdf0f5d681132eaeb84fd7006b5ddb1514694717874214698`
and archive SHA256
`44572a7be51e66b43aa5f15b9d8442bff52052d4dd0167b75dd85206660cff30`.
It retains the deterministic offline v0.20 runtime and adds exactly eight
digest-bound MCP server files as a service-private read-only overlay; the host
checkout and production Node namespace now use the accepted `0cbeed7` source
binding without changing the Runtime artifact or Hermes MainPID.
Native Linux, relocation, read-only, compiled-import, system-terminfo, offline
unified-profile, zero-lazy-install, zero-Tirith, exact mount-namespace, and
218-second MCP keepalive gates passed. Exact evidence, including the disclosed
superseded probe that restarted only the v0.13 Lite gateway before recovering,
is in `hermes_runtime_linux_verification.v1.json`. Candidate `44b84fb11fe8`
passed dry-run and received authorization for the exact eight
`BindReadOnlyPaths`, but apply failed closed during the wrapper's same-PID exec
transition and rolled production back. The deployed successor added the
bounded MainPID-settle correction, passed exact-SHA gates and dry-run, then
returned `APPLIED`. Immediate acceptance found one v0.20 gateway on `8642`, no
`8643`, zero cron jobs/executions, and retired Full condition-blocked. Bounded
production observation has since reached `PROD_VERIFIED` for the channel,
identity, memory, capability, topology and 2026-08-07 digest evidence recorded
in `docs/governance/current_runtime_status.md`.

1. Build a candidate-SHA-bound offline v0.20 runtime artifact. Its manifest
   records upstream version/source digest, dependency lock digest, every wheel
   digest, interpreter digest, and final tree digest. Install it under a
   versioned read-only root; systemd uses its absolute executable. It must not
   depend on the P3 tree, a user cache, or an online install. Keep the v0.13
   runtime path intact for rollback.
2. Build the unified profile from the digest-bound
   `hermes/profile/config.companion.yaml`. During the bounded transition its
   compatibility profile ID remains `ran-assistant-lite`, but all Node profile
   selectors resolve to that one ID and both base URLs resolve to one gateway;
   the old name does not represent a second capability tier. Validate it in an
   isolated home with Tirith auto-download
   disabled. A production candidate must either use a pinned verified Tirith
   binary by absolute path or explicitly accept the disabled scanner; startup
   may not download it.
3. Point both compatibility base URLs at the same gateway while Node routing
   code remains unchanged. Use the current Lite subdirectory as the candidate
   canonical home only through an exact path manifest. The real Full parent is
   `/home/ubuntu/.hermes-ran-agent` and Lite is its `lite/` child: never
   recursively chmod/archive the parent. Preserve only enumerated Full-specific
   paths; do not merge or delete them.
4. Keep the Hermes cron store empty and retain the existing legacy wake owners.
   The v0.20 ticker may run but cannot fire work, so this phase creates no dual
   visible wake and no Core write.
5. Run the Runtime observation gate. Failure may restore the complete runtime
   snapshot and v0.13 absolute executable because Core has not accepted writes.

The current split apply/release path is not configuration authority for this
phase: it hard-codes v0.13, Lite/Full, and undeployed O1/O2 policy. The exact
candidate must instead carry a machine-readable mutation manifest for every
unit, env key, home, schema, runtime artifact, and file. Unlisted production
configuration is preserved. O1/O2, identity, and model policy may not change
as a side effect. The candidate updates its topology-aware release controller,
acceptance, rollback, runbook, and server-runtime skill together; all validate
the same manifest.

### Core Phase

1. Preinstall the deploy-owned Hermes managed job disabled. Create/migrate an inactive
   Schema v2 Core candidate and validate it without enabling a business writer.
2. Acquire the cutover lock, stop new ingress and legacy visible wake, and let
   in-flight provider/effect/outbox work reach a terminal or ambiguous state.
3. Record a legacy cutover watermark, source DB/file hashes, writer/handle
   inventory, count/digest reconciliation, and an exact migration manifest.
4. Stage decoded todo/reminder and paused external-activity rows as paused
   candidates without Core business writes. Never catch up or auto-activate
   them. `last_reminded_at`, any
   ambiguous delivery, and the already-observed 2026-08-05 digest occurrence
   create suppression/reconciliation Journal evidence rather than new delivery work.
5. In one SQLite transaction, import the accepted state, seed system
   schedules, and append one canonical `core_cutover_committed_at` Journal
   event. This commit is the sole formal Core write-path cutover and the only
   irreversible boundary.
6. After that commit, start/verify Core writer health, enable exactly one clock
   projection, then resume ingress. Clock activation is ordered after the
   SQLite commit and is not falsely described as atomic with it. Failure after
   the commit uses Core catch-up plus forward repair, never legacy wake.
7. After that commit, rollback may
   never restore a pre-Core database or restart a legacy visible scheduler.
   Allowed recovery is limited to a runtime-only Hermes artifact/unit rollback,
   or stopped ingress plus Core catch-up, forward repair, and reconciliation.
   The cutover event is the single durable interlock that makes destructive full
   rollback fail closed.

Before Core Phase, every existing scheduled component has a reviewed row with
exactly one disposition:

```text
MIGRATE_TO_SCHEDULE
RETAIN_NON_VISIBLE_MAINTENANCE
REPLACE_WITH_CORE_WORKER
RETIRE_EMPTY
```

APScheduler maintenance and the Lite soft-reset timer are not visible wake and
are not retired by the one-clock rule. The legacy durable dispatcher is an
executor, not merely a clock; it stops only after its queue is proven empty and
the Core WorkRun worker is accepted. The Node external poller is decomposed
into scan, execution, and system-queue responsibilities before each part is
migrated or retired.

A machine-readable system-schedule manifest creates every replacement active
system ScheduleSpec, including the opt-in daily digest. Initial `next_due_at`
is strictly later than the cutover watermark. Any elapsed window at or before
the watermark receives one aggregate skip/suppression Journal event and is never backfilled, so
stopping old wake neither loses the next future run nor replays an old one.

## A-E amendment

- Package A and frozen Schema v1 remain accepted.
- Package B/B.1 final-turn and presentation transaction semantics remain
  accepted. Package C adds a typed scheduled/system instruction and optional
  visible-final entry; it does not weaken or impersonate the existing user-turn
  path. Current source is still inactive in production.
- Package C locally implements Schema v2 ScheduleSpec/WakeOccurrence
  repositories, `wake_due`, WorkRun creation and lease/fence authority, plus an
  injected managed-clock adapter. It is not composed into production.
- Package D builds the watermark/quiesce manifest and stages legacy candidates
  paused in a zero-business-write rehearsal. The actual cutover transaction
  later imports accepted candidates with suppression/reconciliation Journal
  evidence. Every old component has one disposition before it stops; long-lived
  dual visible wake is forbidden.
- Package E adds duplicate/missed tick, long downtime, clock rollback/DST,
  crash before/after occurrence commit, stale WorkRun fence, stop/cancel,
  timeout ambiguous, restart no-resend, gaming/focus suppression with delayed
  coalescing, and one real synthetic delivery. S11 now binds one exact
  WakeOccurrence→scheduled Exchange→claimed WorkRun revision/fence/lease→typed
  system instruction→provider epoch/attempt→final→presentation outbox→injected
  effect→terminal receipt chain. A thrown post-dispatch timeout becomes durable
  `ambiguous`, restart does not resend, post-commit restart reuses the existing
  WorkRun, stale WorkRun authority rejects before final/effect, and a delayed
  fingerprint remains one candidate across gaming/focus→available. “Stale
  fence” here is WorkRun authority; disabling legacy visible wake remains S12.
  The focused set passes 29/29 and the full Core suite 151/151 locally.
  Production is unchanged.

## S12 local composition status

The R1 review candidate archived at
`aabf9bc97ea3fcd95bf6d79798c56315543d0c37` has one cutover
transaction/marker, an exact verify/apply command, a disabled Hermes no-agent wake projection, an official
create/pause/edit/resume reconciler, and a non-overlapping Node executor. The
executor claims queued WorkRuns, delegates by typed task kind, records one
terminal result and releases the lease. Visible scheduled instructions use the
real system/internal Turn, Hermes provider epoch/attempt, Package B final,
presentation outbox and typed adapter receipt; non-visible knowledge,
reflection, memory and night-cycle work reuses the existing Python tool
endpoints. Timed todo writes now register immediately through the local Core
control route, while the managed scan repairs a missed registration into the
same Core-owned one-shot schedule; delivery fetches the retained todo content
and acknowledges that projection only after a durable terminal. The expanded
Core/attention set passes 183 tests locally; the earlier affected Python set
passes 67 and the current affected set passes 55. The complete Node baseline
passes 1,337 with zero failures and four declared environment skips.

This is not yet a cutover candidate. The archived composition stops
the legacy external-MCP runtime timer in Core mode and runs its existing
scan/executor through an `external_poll` WorkRun into hash-bound Core facts and
Core delivery. R1E now reuses the generic claimed-WorkRun assertion before
provider execution, rechecks the same authority at fact commit, binds the
current external Activity revision/checkpoint and derives server identity from
trusted runtime scope. The first archive `c8e5a882` was review-blocked because
a committed fact had no atomic replayable attention projection and an old
notification could read a newer mutable checkpoint. The repaired path reserves
a deterministic Core projection in the same transaction as the fact, completes
attention/schedule projection idempotently after the transaction, and recovers
it without another provider call. Notification tasks carry the exact Activity
revision, checkpoint digest and fact event; any mismatch suppresses before
Hermes. Fresh repair evidence is `18/18` focused and `52/52` shared affected;
the repaired archive `493c77aa90fe53bba8a10fd94dd03136ba51d4eb`
passed independent exact-SHA rereview. R1F deliberately does not make owner
attention depend on desktop presence. The S12 composition leaves the existing
valve's no-provider default in authority: ordinary timely proactive content is
eligible, ambient content is silent, and synthetic quiet policies exercise the
durable delayed backlog. Hermes game activity never establishes owner gaming.
Desktop presence and explicit owner DND are optional `POST_CUTOVER_OK` provider
work, not S12 dependencies. The existing managed `attention-flush` schedule is
the single Core-owned flush clock; no desktop callback or second timer is added.
R1F archive `08e3eea81c336ac48f3e0b85a87b0b5c6d445307` passed independent
review. R2 then rehearsed that exact runtime against a fresh isolated
production copy and recorded clear zero-effect evidence; the later R2 archive
contains governance/evidence only. Production Core/source remains unchanged
and S12 is not started.

## Semantic request, stable effect and provider boundary

Routing follows an assembly truth principle: governed wording, the actual
profile/toolset capability surface, and a representative runtime call must
agree. Prompt preference without assembly evidence is not a valid route.

Private reply protocol follows the same principle. Provider-origin content that
has the private envelope shape must be normalized and validated before any
owner-visible release. The unambiguous version aliases `"1"` and `"v1"` may be
canonicalized to numeric `1`; every other malformed private envelope fails
closed to a safe bridge reply and a content-free error code. It must never fall
back to raw `reply_text`. Ordinary JSON without the private envelope shape is
still user-visible when requested.

Task recipes and input sources do not create authority. `minutes -> note`,
`web -> study note` and `paper -> study note` are recipes that may all end in
the same stable reversible effect: `document.write` with an explicit provider,
operation, target and content reference. Node resolves that semantic request to
one existing executor, validates trusted conversation/tool facts, actor,
target, payload hash, idempotency and evidence policy, then executes or returns
one bounded structured repair result. Hermes may revise the document type once,
but Node extracts only one `document.write` candidate from that repair response.
A repair response with activity, commitments, claims or another action family
fails closed before execution; it is never returned to the ordinary
full-envelope pipeline. Hermes cannot grant itself a capability, choose its own
risk class or claim success without the adapter receipt.

This change is intentionally narrow. R1 adds the one missing Feishu document
effect and reuses existing adapter/readback primitives; it does not introduce a
universal capability registry or replace the contained Minutes recipe. A
repairable source/recipe mismatch is `needs_replan`; unresolved target
ambiguity, missing authority, payload drift and an unknown post-dispatch result
remain deterministic stops. User-visible acknowledgement reports the actual
stage and result rather than rewriting every failure as a readback problem.

The stable `document.write` contract is independent of `lark-cli` versions and
wire response shapes. Feishu CLI commands, parsing and normalization stay
inside the provider adapter. R1C neither upgrades the CLI nor treats local
`1.0.85` as production truth; production was observed at `1.0.66`. R1D confirms
the two versions are compatible on the required search/create/fetch/files-list
and canonical XML surfaces. Both versions require
`docs +update --command overwrite`; R1D-L1 adds exactly that pair inside the
adapter. It leaves stable effect semantics and exact fetch/readback unchanged,
passes the focused set `6/6`, and is accepted by fake-token dry-runs on both
versions without a CLI upgrade or external write. Its archived SHA
`af25198654e048cc70e7e94a4c9974f2070428e0` passed narrow independent review;
R1D dependency compatibility is closed. The first R1E archive `c8e5a882` is
review-blocked by `R1E-FACT-PROJECTION-GAP` and
`R1E-REVISION-EVIDENCE-SKEW`; the commit containing the bounded repair is
accepted at `493c77aa90fe53bba8a10fd94dd03136ba51d4eb` after exact-SHA
rereview. The recalibrated R1F candidate
`08e3eea81c336ac48f3e0b85a87b0b5c6d445307` is `LOCAL_VERIFIED`, `ARCHIVED`
and `REVIEWED`. Desktop presence remains uncomposed and Telegram remains future
channel work. Fresh R2-A/R2-B evidence is clear and archived separately; R3 is
ready but not started, and S12 has not started.

The first R1C archive `e4161721d253c160558aeaf22b7fda77e1a331b4` was rejected
by independent review. The bounded repair verifies one synthetic
Web-learning-note create against the exact returned document ID, canonical body
and resolved parent membership; update verifies the exact supplied document ID
and canonical body. Adversarial repair responses cannot execute activity or an
unrelated action, and reopen remains no-resend. The final focused R1C/reply set
passes `75/75`; the smallest shared private-envelope, receipt and ledger
boundary set passes `125/125`. The repaired archive
`02b8f6491f4ca3013f847decdc59974a90bebdca` passed independent exact-SHA review,
so R1C is `LOCAL_VERIFIED`, `REVIEWED` and `ARCHIVED`. R1D records the exact
dependency decisions in `r1d_dependency_compatibility.v1.json`. Ombre projection
is not composed by the S12 candidate, Agent Reach is only a feasible future
Search Hub provider, and both are `POST_CUTOVER_OK`. External MCP remains
bridge-owned and is itself `COMPATIBLE_AS_IS`; R1E has locally verified its
WorkRun/replay/no-direct-send acceptance but remains unreviewed. No production claim follows from
these local compatibility decisions or the R1D-L1 repair.

Web acquisition is a separate prerequisite, not a document subtype. Production
Hermes uses `search_hub` for ordinary web/research and the governed social/media
readers for those sources. A model-visible direct tool must be invoked directly;
deferred discovery is only for a capability that is not already exposed. The
archived companion profile exposes both the built-in `web` toolset and
`mcp-search_hub`; this conflicts with the otherwise explicit route. The local
R1B candidate proves that `search_hub` covers the accepted generic
search/read/research surface and removes the built-in `web` toolset plus its
provider block from the default companion surface. It retains the distinct
Playwright browser/debug capability because Search Hub's Playwright fallback is
not yet implemented. The DLM-shaped MCP-handler check observes typed
`search_hub.research`; this closes the local assembly defect that prompt wording
alone did not prevent. Production still runs the archived dual-entry profile.

External MCP remains behind `external_mcp_gateway`. Its dynamic server/tool
schema, risk class and grant scope are execution descriptors, not new global
task types. A poll may create a sanitized Core fact under WorkRun authority;
if that fact should interrupt the owner, Hermes proposes the presentation and
Node still applies attention policy before the Core outbox and channel adapter.
No MCP server receives owner-visible send authority merely because it can emit
events or protocol notifications.

This boundary follows mature prior art rather than inventing a new framework:
MCP keeps orchestration and authorization in the host while servers expose
focused negotiated tools; Home Assistant separates trigger/condition recipes
from reusable actions such as `notify.send_message`; Temporal separates durable
Workflow orchestration from idempotent side-effecting Activities; Kubernetes
controllers reconcile recorded desired state with observed provider state and
report status back to the authority. These patterns support the design, but
ran-agent implements only the existing seams needed by the current incident.

- MCP architecture: <https://modelcontextprotocol.io/docs/learn/architecture>
- Home Assistant automations: <https://www.home-assistant.io/docs/automation/>
- Temporal Activity idempotency: <https://docs.temporal.io/activity-definition>
- Kubernetes controllers: <https://kubernetes.io/docs/concepts/architecture/controller/>

The dual gateway/profile contract, regex Full routing, Full-to-Lite fallback,
and duplicated history/cache/cron stores are removed from the target. Existing
compatibility code may remain only during the bounded transition.

## Hard acceptance gates

Every production mutation is bound to one exact immutable candidate and one
machine-readable mutation manifest.

Capacity admission uses the stricter existing release reserve or:

```text
free_before >= 15 GiB + peak_new_allocated_bytes
```

`peak_new_allocated_bytes` includes candidate archive/tree, gate copy,
dependencies, v0.20 runtime, snapshot, migration copy, and temporary files.
A 2026-08-06 05:18 post-verification cleanup observed 18,587,557,888 free
bytes; the exact 133,558,059-byte artifact was already staged and therefore
counts as preallocated capacity. Against the contracted 1,715,167,443-byte
peak inventory, this leaves 899,821,144 bytes above the 15 GiB floor plus peak
requirement. This is a preliminary pass, not admission: free space is
time-varying and the same inventory is recomputed against the exact candidate
immediately before apply.

Runtime pre-mutation admission proves the immutable artifact, mutation
manifest, capacity, isolated smoke, and complete runtime rollback. Its atomic
apply starts one unified gateway with one home/provider policy and an empty cron
store while legacy wake remains authoritative. Immediate blocking acceptance
proves the exact audited production baseline is still checked out, the running
Node MainPID has all four compatibility URLs set to the one `8642` gateway, the
single listener belongs to the Hermes MainPID, `8643` is absent, the
profile/unit/runtime digests match, Full is persistently no-start, and the cron
jobs/execution stores remain empty. Exact-candidate source-contract tests prove
the unchanged Node router consumes those four keys; this phase does not claim a
second black-box Node request.

Runtime observation then requires at least 7 days, 30 normal Exchanges, one
media generation, one co-reading operation, and one gateway restart, with zero
Full fallback. Before Core pre-mutation admission it also performs black-box
tool enumeration/negative calls, confirms the preserved legacy Full terminal,
file, session-search, Playwright, Obsidian and remaining MCP surfaces, and runs
real recall, proactive-decision, digest, media and co-reading paths, with zero
Tirith download and zero unexpected tool.

Core pre-mutation admission proves the schema/migration candidate, cutover and
system-schedule manifests, per-job disposition inventory, capacity, isolated
`core-wake` projections, duplicate/missed tick, crash/restart, fence, ambiguous,
and no-resend tests, plus independent adversarial CLEAR. Fault tests and
runtime smoke use only synthetic, non-delivering schedules/targets; production
fault injection still requires separate authorization.

The Core ordered cutover has one irreversible SQLite transaction as defined in
`Core Phase` above. Core becomes authoritative at that commit, not after clock
activation or observation. Immediate
blocking acceptance proves:

- one gateway and exactly one active work-producing clock projection: one
  deploy-owned Hermes managed job, zero unmanaged job, and zero legacy visible
  wake;
- zero Hermes agent or external-delivery path for any managed job;
- cutover watermark/hash/count/digest reconciliation;
- Core schema/writer health and one occurrence for repeated synthetic ticks;
- the cutover Journal interlock rejects legacy scheduler/database
  restoration;
- one allowlisted synthetic Feishu target receives exactly one message.

Core observation then requires at least 7 days, one managed-tick restart, one
missed/duplicate synthetic tick probe, zero duplicate delivery, and no
ambiguous auto-retry. Observation decides cleanup eligibility, not Core
authority.

After Runtime immediate acceptance, stop/disable the split service topology
and remove exact temporary validation artifacts under the recorded user
authorization. The active rollback contract still verifies the live v0.13
executables by digest, so retain those executables until its rollback window
closes; then remove them with the other exact v0.13-only assets. Preserve
personal data, the unified Lite/Full capability union, and shared runtimes.
Full-specific product state, legacy scheduler code, and Core write-path cleanup
still wait for their own acceptance boundary.

If the Hermes managed-job projection later misses a measured availability SLO,
design a fallback from that evidence. No second timer is prebuilt in the MVP.

## Production and deletion boundary

This design does not authorize production Core writes, state migration,
Full-home deletion, or legacy scheduler retirement. Runtime service mutation
and exact v0.13-only cleanup are authorized only through the reviewed Runtime
transaction and its immediate acceptance/inventory sequence. Production has
passed Runtime admission, atomic apply, and immediate acceptance on unified
Hermes v0.20. Legacy wake owners remain authoritative
through Runtime observation and stop only at the separate Core atomic cutover;
Core is authoritative immediately after that cutover and its blocking
acceptance, while observation controls later Core cleanup.
