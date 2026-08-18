# Hermes Context Optimization

Status: CURRENT (2026-08-18)

This document owns the current continuity, cache, and soft-reset contract. The
`lite` token retained in environment names, file names, and timer names is a
compatibility label for the least-privilege policy mode; production has one
Companion gateway, not Lite and Full gateways.

## Invariants

- Context reduction must preserve useful continuity and never turn summaries
  into factual authority.
- Long-term memory remains on demand through `personal_memory`; Vault, Ombre,
  and raw history are never injected wholesale.
- Failed provider content and infrastructure sentinels are not stored or shown.
- A soft reset rotates a session pointer. It does not delete durable memory or
  create another chat runtime.
- Task-scoped synthetic turns never inherit or mutate ordinary conversation
  history.

## Continuity Layers

| Layer | Purpose |
|---|---|
| Hermes session | Short-term provider continuity for the active Companion profile |
| Node context | Bounded local/global turns, active topic, continuity note, and media compact |
| `personal_memory` | Explicit bounded recall across local memory, Vault, and Ombre |
| soft-reset digest | One-shot sanitized continuity aid after session rotation |

`HERMES_CONTINUITY_FRESHNESS_HOURS=24` permits recent cross-day clues. Older
items may be surfaced only as historical clues, never as current state without
confirmation.

## Context And Cache Modes

`HERMES_CONTEXT_INJECTION_MODE=auto|rich|slim|resume` controls bounded context:

- `auto`: select from current continuity signals;
- `rich`: larger debugging/complex-work budget;
- `slim`: normal compact budget;
- `resume`: first successful turn after a soft reset.

`HERMES_CONTEXT_CACHE_STRATEGY=balanced|cache_first|token_first` controls the
provider-visible append log:

- `balanced` is the default: telemetry on, append history off unless explicitly
  enabled;
- `cache_first` opts into bounded exact-prefix replay;
- `token_first` disables append replay.

Current baseline keys are defined in `.env.example`. Append records are written
only after a successful provider response and are sanitized before persistence.
If sanitization changes content, telemetry marks the prefix inexact. Tokens,
cookies, identifiers, API keys, and absolute paths are never preserved for a
cache hit.

Stable prompt sections precede dynamic time, media, and current user text.
Correctness and redaction outrank prefix reuse.

## Task-Scoped Synthetic Turns

`node_bridge/src/hermesTaskScope.mjs` owns the closed task-route registry.
Release journeys, bounded action repair, proactive events, and the external MCP
system queue use isolated session IDs and exclude ordinary local/global history,
active topic, provider append history, and soft-reset digest.

Historical daily-digest route names remain in the registry and tests so old
records fail safely, but production `AI_DAILY_DIGEST_ENABLED=false` and Hermes
has no digest work executor. Daily reports belong to Codex; route compatibility
is not action authority.

## Soft Reset

The current compatibility-named controls are:

```env
HERMES_LITE_SOFT_RESET_ENABLED=true
HERMES_LITE_SOFT_RESET_DRY_RUN=false
HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS=1200
HERMES_LITE_SOFT_RESET_KEEP_LAST_N=4
HERMES_LITE_SOFT_RESET_STATE_FILE=.ran_agent_state/hermes/session_maintenance.json
HERMES_LITE_SOFT_RESET_DIGEST_DIR=.ran_agent_state/hermes/digests/
```

All paths resolve under the ran-agent state directory. Each digest is bounded,
sanitized, injected once on the next successful Companion request, and marked
consumed only after provider success. It may contain short open threads,
commitments, preferences, artifacts, and do-not-carry entries; it must not copy
raw Vault pages, chat logs, secrets, or large quotes.

Manual inspection and recovery do not restart the gateway:

```bash
bash scripts/hermes-lite-soft-reset.sh --status
bash scripts/hermes-lite-soft-reset.sh --dry-run
bash scripts/hermes-lite-soft-reset.sh --apply
bash scripts/hermes-lite-soft-reset.sh --rollback-last
```

The timer installer remains the owner of the compatibility-named service and
timer:

```bash
bash scripts/install-hermes-lite-soft-reset-timer.sh --status
```

Install, disable, environment mutation, and production source apply are
operator actions governed by `server_runtime_commands.md`; do not run the old
standalone split deployment as a shortcut.

## Failure Handling And Observation

An ordinary conversation may use the existing soft-reset seam for one bounded
retry after empty provider content or a known `No reply` sentinel. The retry
must not duplicate a delivered message or persist the failed content.

Useful redacted telemetry includes input/cache tokens, cache exactness,
sanitization reason, component character budgets, reset decision, and task-scope
skip reason. Observe it through the current Node service journal; never log raw
prompts, credentials, cookies, private memory, or state-file contents.
