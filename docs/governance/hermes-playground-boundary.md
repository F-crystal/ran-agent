# Hermes Playground Boundary

Status: CURRENT (2026-08-18); H0-H5 PROD_VERIFIED

## Owner Decision

Hermes is the resettable conversation, emotional-companionship, co-reading,
media, search, and external-MCP playground. Codex is the owner-facing work
console for Calendar, Todo, reminders, Minutes/documents, daily reports, code,
debugging, and deployment. Hermes must not regain those work effects through a
prompt, slash command, fallback, or natural-language grounding rule.

External MCP is available by default only through the governed gateway.
Registry, grants, budgets, cancellation, evidence, and side-effect confirmation
still apply. Default availability is not ambient autonomy.

Long-term continuity remains required. Core and the stable personal-learning
store own facts; one rebuildable projector maintains derived Ombre relationship
context. Bounded proactive companionship is part of the product, not a second
chat runtime.

## Invariants

1. Exactly one Hermes runtime and gateway serve the frontends.
2. Hermes owns conversation and play, never owner-facing work effects.
3. Node validates actor, capability, schema, scope, idempotency, and receipts;
   it never decides permission by interpreting user prose.
4. Unknown external MCPs enter only through `external_mcp_gateway`; T4/T5,
   payment, post, delete, and account effects require confirmation or an exact
   trusted grant.
5. Hermes may query bounded memory and propose only typed personal-memory
   candidates. It never writes Core, SQLite, Vault, or Ombre directly.
6. Ombre is derived, erasable, and rebuildable; it cannot override Core facts,
   identity, permissions, delivery truth, or governed runtime documents.
7. Proactive companionship uses evidence, a structured ProactiveEvent, Hermes
   `silent|notify`, Node cadence/quiet/stop/dedupe gates, and a send receipt.
8. Infrastructure/provider failure text never becomes an assistant reply or
   conversation history.

## Current Flow

```text
WeChat / Feishu / optional Desktop
  -> ChannelHub owner + conversation binding
  -> replyBackend deterministic controls
  -> Hermes companion
      -> chat / emotional companionship
      -> bounded query-only memory
      -> search / social + media / co-reading / stickers / generation
      -> external_mcp_gateway -> admitted call -> governed evidence

Codex
  -> Calendar / Todo / reminders / Minutes + documents / reports / code / deploy

Stable background services
  -> verified personal learning -> Core source -> Ombre projection
  -> evidence-bound companion candidate -> ProactiveEvent -> receipt
```

The active companion profile contains no terminal, file, session-search, direct
Playwright, native cron, delegation, or code-execution toolset. Search Hub may
retain an internal governed Playwright fallback.

## Action And Memory Boundary

Hermes reply envelopes may contain only `memory.remember`, `memory.correct`, or
`memory.forget` action requests. Node requires explicit owner intent and exact
scope, executes through the personal-learning adapter, verifies the receipt,
and invokes the existing Core/Ombre projector. Every work-action type is
removed before an executor.

Projection mappings:

- verified remember -> `hold`;
- verified correction -> replace the subject scope;
- verified forget -> erase the subject scope;
- confirmed relationship summary -> `grow`.

Stable event/scope markers reconcile a lost response. Failed projection leaves
the Core source intact and retryable. Public recall remains query-only.

## Proactive Companionship

The producer may surface at most one candidate per life-loop scan and only from
active confirmed personal learning. Node owns the configured 20–N minute
cadence, quiet hours, daily limit, evidence, dedupe, reservation, owner stop,
and post-send receipt. Python does not compose visible greeting text. Generic
check-ins and the retired direct proactive-text route remain blocked.

## Conversation Reliability

Known empty output and `No reply` sentinel text are provider failures. One
ordinary turn may rotate once through the existing soft-reset seam and retry;
neither failed attempt enters recent/global/provider-visible history. Python
`/chat` remains 410 and the backend constructs no competing frontend agent.

## Stage Closure

| Stage | Status | Durable outcome |
|---|---|---|
| H0 | COMPLETE | Owner boundary and topology corrected. |
| H1 | PROD_VERIFIED | Work actions and broad local tools removed; external MCP default-available; ran-agent digest stopped. |
| H2 | PROD_VERIFIED | Empty/no-reply output is infrastructure-only with one bounded retry. |
| H3 | PROD_VERIFIED | Existing Core/Ombre projector composed for verified memory continuity. |
| H4 | PROD_VERIFIED | One evidence-grounded companionship producer uses the structured event/receipt path. |
| H5 | PROD_VERIFIED | Retired Python frontend graph removed; `/chat` stays 410. |

The source projection refresh repair is also production verified: its digest
covers ordered projected Activity rows, so unrelated SQLite writes do not cause
false same-revision conflicts; changed projected data still fails closed.

## Non-Goals

- No second runtime, gateway, writer, outbox, or scheduler.
- No Hermes slash-command work console.
- No direct model-to-Ombre/database/Vault mutation.
- No revival of Calendar/Todo/Minutes/digest executors for Hermes.
- No credential, Unix identity, permission, ownership, or storage-layout change.
- No production apply, deletion, archive, or risk acceptance without its own
  required authority.
