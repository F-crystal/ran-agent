# Hermes Playground Boundary

Status: CURRENT (2026-08-17); H0-H5 LOCAL_VERIFIED / FINAL LOCAL_VERIFIED

## Owner Decision

Hermes is the resettable conversation, emotional-companionship and external-MCP
playground. Codex is the owner-facing work console for Calendar, Todo, Minutes,
documents, daily reports, code, debugging and deployment. Hermes must not emit
those production-effect actions or regain them through natural-language
grounding.

The external MCP gateway is available by default. Admitted tools remain subject
to the existing trusted registry, grants, budgets, cancellation, evidence and
side-effect confirmation. Default availability does not grant background
autonomy to every registered server.

Long-term continuity is a required product capability. The stable memory layer
curates writes, Core remains the fact authority, and the existing S8 Ombre
projector must be composed so confirmed personal learning and relationship
summaries grow the derived Ombre memory. Bounded proactive companionship is
required, not optional.

## Invariants

1. One Hermes runtime and one gateway remain. No second conversation runtime is
   introduced.
2. Hermes owns conversation and play, not work effects. Calendar, Todo,
   reminders, daily reports, Minutes/document writes, code and deployment are
   not Hermes-visible actions.
3. Node is a deterministic valve. It validates trusted actor/capability tokens,
   action type, schema, scope, idempotency and receipts; it must not infer from
   user prose whether Hermes was allowed to act.
4. `external_mcp_gateway` is the only ingress for external game, forum and
   browser MCPs. Unknown MCP descriptions and results remain untrusted. T4/T5,
   payment, post, delete and account effects require confirmation or an exact
   trusted grant.
5. Hermes may receive bounded read-only memory context and may propose typed
   `memory.remember/correct/forget` candidates. The stable backend decides and
   records durable memory; Hermes never mutates the memory store or Ombre
   directly.
6. Ombre is a derived, erasable and rebuildable relationship-memory projection.
   Core and the governed personal-learning store remain authoritative.
7. Proactive companionship uses a durable candidate, admission, structured
   `ProactiveEvent`, Hermes `silent|notify` decision, egress gate and receipt.
   Generic timer greetings and direct text sends are forbidden.
8. Infrastructure/provider failure text is never a user-visible assistant
   reply and is never written into conversation continuity.

## Verified Current Facts

- The local reply-envelope valve now keeps only
  `memory.remember/correct/forget`; work actions are removed before any trusted
  adapter or Core job client runs. Node no longer replans work from user prose.
- The local companion profile no longer exposes terminal, file, session search
  or direct Playwright. Search Hub retains its internal fallback.
- External MCP admission, registry, policy, grants, sessions, evidence,
  cancellation and pending confirmation remain intact. The canonical active
  companion profile exposes the governed gateway by default while the
  launcher's allow-env gate still rejects ambient enable flags. Retired profile
  sources are not padded with deployment-irrelevant edits.
- `personal_memory` is query-only. Durable writes already use backend extraction
  and typed personal-learning candidates.
- Ombre recall is active on loopback `18001`. The local candidate composes the
  accepted S8 projector with the live Core runtime. A verified successful
  personal-learning receipt creates the hash-bound Core source and projects it;
  correction replaces the prior subject scope and forget erases it. The
  existing confirmed relationship-summary path remains `grow`. Production is
  unchanged.
- The local candidate now surfaces at most one companion candidate per life-loop
  scan, and only from an active confirmed personal-learning record. Python
  submits a structured event without composing visible text. Node consumes
  `/checkin on|off`, the bounded cadence range, quiet hours, daily limit,
  evidence and dedupe before Hermes; generic check-ins remain rejected and the
  existing Feishu receipt commits only after send success. Production is
  unchanged.
- Python `/chat` is 410, but the backend still constructs the retired frontend
  agent/runtime/tool/reviewer graph in production. The local H5 candidate stops
  that construction: the backend runtime creates no chat model or frontend
  orchestrator, and creates a tool model only when optional memory LLM
  extraction is explicitly enabled. `/chat` remains 410.
- The Core daily digest remains active in production. The owner assigned daily
  reports to Codex, so F6OBS is superseded and the exact digest activity must be
  stopped in a separately authorized production transaction. Locally, the
  replacement schedule manifest no longer seeds it, deploy defaults are off,
  and an old occurrence is suppressed before Python, Hermes or Feishu.
- Empty provider content and the upstream `No reply` sentinel now fail as
  infrastructure errors. An ordinary conversation rotates once through the
  existing soft-reset seam and retries once; neither failed attempt enters
  recent or provider-visible history.

## Target Flow

```text
WeChat / Feishu / Desktop
  -> ChannelHub owner and conversation binding
  -> replyBackend
      -> stop / confirmation / privacy deterministic controls
      -> Hermes playground
          -> chat and emotional companionship
          -> bounded read-only memory recall
          -> search, social/media reading, co-reading, stickers, generation
          -> external_mcp_gateway (available by default)
               -> admitted read/play call
               -> confirmed or exactly granted side effect

Codex
  -> owner-requested work through its native governed connectors/tools
  -> Calendar / Todo / Minutes / documents / daily reports / code / deployment

Stable background services
  -> memory candidate curation -> confirmed Core event
  -> Ombre projector -> hold/grow -> read-only recall
  -> companionship candidate -> ProactiveEvent -> Hermes -> egress receipt
```

Hermes does not gain a `/todo` or `/cal` command parser. The unreachable
Hermes-side Calendar, Todo, digest, document and Core-job adapters were removed
after repository-wide caller evidence showed the work-action valve made them
dead. Codex and deterministic service-owned paths remain separate.

## Stages

| Stage | Status | Scope | Exit evidence |
|---|---|---|---|
| H0 decision and governance | COMPLETE | This contract and canonical topology reflect the owner's corrected boundary. | No default-off MCP, optional Ombre/proactive, Hermes slash-command or Hermes daily-report requirement remains. |
| H1 playground boundary | LOCAL_VERIFIED | Remove Hermes work action instructions/exposure and broad shell/file/session/browser tools; make the governed external MCP gateway source-default available; retire ran-agent daily digest locally. | Work effects stop before executors, profiles expose only playground tools, the external gateway diagnostic passes, and reminder/companionship clocks remain enabled. |
| H2 conversation reliability | LOCAL_VERIFIED | Treat known upstream empty/no-reply sentinels as provider failure, keep them out of history, and reuse the existing soft-reset/retry seam. | Gateway tests prove one rotated retry can resume, repeated failure stays infrastructure-only, and sentinel text never enters history. |
| H3 live Ombre continuity | LOCAL_VERIFIED | Compose the accepted S8 projector for confirmed learning and relationship-summary events; add emotional-continuity recall acceptance. | The focused Node set proves verified-receipt hold, correction/forget scope replacement, existing relationship-summary grow, idempotency, lost-response recovery, erase/rebuild and subsequent read-only emotional recall. Production apply remains separately authorized. |
| H4 bounded proactive companionship | LOCAL_VERIFIED | Give companion opportunities a minimal stable producer and route only context-grounded candidates through ProactiveEvent. Define explicit cadence, quiet window, dedupe and stop state. | Focused checks prove daily/rate limit, quiet/silence, user stop, no generic greeting, no direct send, one receipt, and memory-grounded content. |
| H5 zombie-runtime excision | LOCAL_VERIFIED | Remove the retired Python frontend chat/runtime/tool/reviewer graph after H4 owns the required opportunity slice. | Python `/chat` stays 410, H4 behavior is unchanged, runtime construction omits chat/Qwen/frontend/reviewer objects, and the affected Python set passes. |

## Ombre Acceptance Contract

- `personal_learning_confirmed` projects through `hold`.
- `core_relationship_summary_confirmed` projects through `grow`.
- Stable event/scope markers reconcile a lost mutation response without a
  duplicate mutation.
- Failed projection leaves the Core source unchanged and retryable.
- A scope can be erased and rebuilt from unchanged Core facts.
- Public/model-facing recall continues to reject all mutation tools.
- Emotional acceptance covers unresolved threads, important relationships and
  recurring preferences, not only factual preferences.

## Proactive Companionship Policy Shape

The exact cadence and quiet window are owner product settings, but the mechanism
is fixed: a stable producer creates a context-grounded candidate; admission
checks owner stop state, time/rate/dedupe and evidence; Hermes chooses
`silent|notify`; Node validates structure and sends only through the existing
receipt path. The implementation must not revive the retired direct proactive
text route or accept vague "moderate initiative" policy.

## Non-Goals

- No second Hermes runtime, gateway process or port.
- No new dynamic MCP/autonomy platform.
- No Hermes slash-command work console.
- No direct model-to-Ombre or model-to-database write.
- No credential, Unix identity, permission or storage-layout change.
- No production apply, database mutation, service restart, archive or push
  without its separately required authorization.

## Handoff

- Canonical order: H0 -> H1 -> H2 -> H3 -> H4 -> H5.
- H0-H5 and final local verification are complete; no production apply, restart
  or database mutation has occurred.
- H3 reuses the S8 projector instead of adding a writer. The production-shaped
  personal-learning path is `verified action receipt -> hash-bound Core event ->
  Ombre hold`; relationship-summary events retain the accepted `grow` mapping.
  No new relationship-summary generator was invented because no authoritative
  producer exists in the current source.
- H1/H2 evidence: the focused Node set passes 213/213, the release/profile
  Python set passes 69/69, and
  `scripts/diagnose-external-mcp-gateway.sh` passes its gateway safety and
  acceptance suite. The new no-reply checks cover recovery and terminal failure.
- H3 evidence: the focused Ombre/reply/recall/gateway Node set passes with the
  dot reporter, `node --check node_bridge/src/index.mjs` passes, and the new
  acceptance covers an unresolved relationship recalled from Ombre after the
  verified learning path.
- H4 evidence: the focused Node set passes 75/75 and the affected Python set
  passes 16/16. Acceptance covers the real `/checkin off` path, quiet hours,
  deterministic bounded cooldown, per-owner daily limit, memory-evidence
  binding, generic-message suppression, a reservation lasting through the
  configured Hermes/Feishu deadline, and one post-send receipt. The Core
  life-loop source scan is 20 minutes; Node applies the configured 20–N minute
  range. Legacy `PERSONAL_AGENT_PROACTIVE_ENABLED=false` stays frozen because
  direct proactive text remains retired; the structured event gate is the
  separate authority.
- H5 evidence: the affected backend/runtime set passes 170/170. A construction
  regression proves `build_runtime()` creates neither a chat model nor a tool
  model under the default memory configuration; the retired chat-client builder
  and its Qwen-chat environment setting are removed. Optional memory LLM keeps
  the existing tool-model builder as a backend-only capability.
- Final evidence: the combined affected Node set passes 356/356, the combined
  affected Python set passes 251/251, and the external MCP gateway diagnostic
  passes 252/252. `git diff --check` passes and retired chat-model names plus
  stale default-off external-MCP wording are absent from the governed source
  and public documentation. The read-only `hermes-playground-final`
  workflow-guard verification also passes.
- Post-review evidence: the fresh guarded Node suite passes 1,401 total with
  1,395 pass, zero fail and six declared platform skips; the changed Python
  set passes 96/96. The broader Python suite passes 584 tests and has only
  three environment-required Hermes v0.20 provider checks outstanding. The
  desktop has no sealed v0.20 runtime, so those three Python checks and the one
  equivalent Node provider-boundary integration remain `MISSING_PROOF` for the
  immutable server candidate gate, not local false-green passes.
- Adversarial release review fixed two shared trust-boundary defects before
  archive: `/proactive/event` now requires the existing loopback control-secret
  contract, and upstream empty/`No reply` text is rejected even when wrapped in
  an otherwise valid reply envelope. Focused bridge identity tests use explicit
  owner bindings instead of bypassing ChannelHub.
- Ponytail excision removed five unreachable Hermes work executors and their
  obsolete dedicated suites. The release diff is net-negative; no replacement
  abstraction, compatibility layer or second runtime was added.
- The local digest retirement has three layers: no replacement manifest row,
  deploy default off, and a runtime guard for a residual old occurrence.
  Production still requires an exact separately authorized stop transaction.
- F6OBS is superseded by the decision to stop ran-agent daily reports; production
  still runs the digest until an authorized stop transaction completes.
- The transformation and Package B locks are closed. Release ownership is
  recorded by `.agents/task-locks/hermes-playground-release-20260817.md`.
- The first immutable production dry-run stopped before mutation because the
  profile migration contract still named the S4 source and required a fixed
  historical two-file delta. The repaired contract binds the actual accepted
  production source and requires its declared closed-subset paths to equal the
  real candidate diff exactly. Only active `config.companion.yaml` is in the
  deployment delta; retired profile sources were restored unchanged.
- The first post-apply blocking acceptance reached the real server suite and
  found one redundant identity-context assertion that still required wording
  from the restored initial-runtime `AGENTS.md`. The active system instruction
  and companion-profile boundary had already passed. The stale wording
  assertion was removed instead of changing an inactive deployment surface.
