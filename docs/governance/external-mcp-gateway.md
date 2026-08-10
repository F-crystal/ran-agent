# External MCP Gateway

Status: CURRENT (2026-08-10)

This document owns the current external MCP gateway and system-queue contract.
The design history lives under `docs/superpowers/`; this file records the
runtime governance facts.

## Mainline

```text
Hermes
  -> external_mcp_gateway
  -> admission / registry / executor / policy / session / evidence / activity
  -> optional /external-mcp/system-queue synthetic Hermes turn
```

Hermes sees one stable MCP surface: `external_mcp_gateway`. Unknown game,
forum, browser, or other external MCP servers must enter through the gateway;
do not dynamically wire unknown MCPs directly into Hermes profiles.

## Enablement

Source profiles keep fallback-disabled flags:

- `EXTERNAL_MCP_GATEWAY_ENABLED=false`
- `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=false`

Standard server deploy explicitly enables the governed runtime path with:

- `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`
- `EXTERNAL_MCP_GATEWAY_ENABLED=true`
- `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`
- `HERMES_PROACTIVE_EVENTS_ENABLED=true`
- `HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true`
- `EXTERNAL_MCP_GATEWAY_PROFILE=full|lite`

Diagnosis: `bash scripts/diagnose-external-mcp-gateway.sh`.

## Admission

Dynamic admission uses:

```text
probe -> candidate registry -> classify -> auto_admitted / needs_owner / denied
```

- Local executable candidates (`stdio`, commands, `uvx`, `npx`) cannot
  self-enable and remain `needs_owner`.
- Remote candidates must pass HTTPS, redirect/DNS/SSRF, no OAuth/account,
  no local-file/local-command, and low-risk tool checks before auto admission.
- External MCP descriptions, schemas, and results are untrusted inputs. Normalize
  and classify them before any Hermes-visible use.
- The gateway is a broker, not a replacement for `social_reader`,
  `media_reader`, `search_hub`, `sticker_catalog`, or `co_reading`.

## Execution And Evidence

- Streamable HTTP execution is implemented with legacy SSE endpoint fallback.
- `mcp_explain_policy` and `mcp_call` must use the same trusted policy context
  whenever a `sessionId` or `activityId` is provided. Without live context,
  `mcp_explain_policy` is hypothetical and must report that context source.
- Tool resolution is exact-match first, then unique compact alias match
  (`list_games` can resolve to `listgames`). Alias collisions fail closed.
- The local session may privately persist a remote Streamable HTTP upstream
  session id for reuse. Public session output and executor evidence must never
  expose the upstream session id.
- Every external MCP call must produce sanitized executor evidence before
  Hermes may claim success.
- No reply may claim success without an `external_mcp_tool_result`.
- T4/T5 side effects, forum comments, social writes, payment/delete/account
  actions, and `external_mcp_write` actions require pending action/待确认 or a
  trusted scoped grant plus real executor evidence.
- Bounded activities use scoped `game_play` or `forum_read` grants. The runner
  owns budget, cadence, cancellation, and evidence; Hermes still receives
  synthetic turns for decisions and sharing.
- User stop phrases are handled before Hermes is called: grants are revoked,
  fetch/SSE work is aborted, sessions close, and Hermes receives a stop
  synthetic turn to summarize.

## Proactive System Queue

External MCP proactive delivery is not the old life-loop/check-in path. It may
only notify through:

```text
/external-mcp/system-queue -> ProactiveEvent -> ChannelHub -> replyBackend -> Hermes
```

Requirements:

- Explicit watchlist/关注 scope.
- Trusted evidence refs from the local external MCP evidence log.
- Matching user, server, non-empty watch scope, and service-derived safety tier.
- Rate budget and reservation lease before send; commit only after adapter send
  succeeds.
- Hermes must return structured `notify` with `message`, `evidence_refs`, and
  `why_now`.

`silent`, `remember`, `draft`, malformed JSON, generic text, missing `why_now`,
or missing evidence must not send visible messages.

This is the current production compatibility path. The S9 local Core source
adds the future `external_poll` ScheduleSpec class but does not compose it into
the gateway. During S10 migration, forum, RSS, and other external MCP
watchers must be split into:

```text
poll/scan -> sanitized Core fact -> WakeOccurrence/WorkRun -> Hermes decision
  -> Node attention valve -> Core presentation outbox/receipt
```

R1E now gates the existing runtime scan before provider execution on the exact
durable `external_poll` WorkRun revision, fence, lease owner/id/expiry, active
Core Activity contract and aggregate payload. The existing fact repository
rechecks that authority; candidate Activity/revision/checkpoint identity is
exact, server identity comes from trusted runtime scope, and duplicate or
reopened terminal work does not repeat provider execution or fact creation.
Independent review blocked the first R1E candidate `c8e5a882` on
`R1E-FACT-PROJECTION-GAP` and `R1E-REVISION-EVIDENCE-SKEW`. The bounded repair
uses the existing Core projection outbox: the fact and deterministic pending
projection are one transaction; recovery replays only attention/schedule
projection, never the provider. A notification is released only while the
current external Activity exactly matches the projection's revision and
checkpoint digest, and its evidence names the same Core fact. Fresh focused
repair checks pass `18/18` and shared affected checks pass `52/52`. The repaired
archive `493c77aa90fe53bba8a10fd94dd03136ba51d4eb` passed independent
exact-SHA rereview; it remains local and is not production.

The watcher never sends directly. Hermes continues to propose structured
content and evidence plus an attention identifier; Node validates identifier,
content class and format. In the S12 candidate, ordinary timely content is
eligible under the attention valve's no-provider default and ambient content is
silent. Synthetic focused/gaming/busy/dnd/unknown policies still prove durable
delay and coalescing, but desktop presence and explicit owner DND are
`POST_CUTOVER_OK`, not runtime dependencies. Hermes activity in a game MCP does
not establish owner gaming. The existing Core-managed attention-flush schedule
is the single flush clock, and only an owner-allowlisted critical class or
explicit reminder bypasses a synthetic quiet policy.
The S10 migration manifest preserves existing watch scopes as paused until
their watermark is accepted, so historical forum or external MCP results are
not replayed as new notifications. The local target seam now records only an
opaque payload reference, keyed content hash and stable source fingerprint as
a Core fact after a claimed `external_poll` WorkRun whose schedule payload is
bound to the same server identifier; it exposes no send method.
A production-copy rehearsal at `2026-08-08T08:28:45.000Z` found no current
watch candidate and 13 legacy external activities; the latter are staged
paused and must be quiesced/reconciled before cutover. This changes no
production gateway flag or route.

## Background Activity

When the user explicitly says to continue work and report back later, the bridge
may inject a short-lived `activityTargetToken` into the current Hermes prompt.
Hermes can use that token only to start a bounded `mcp_start_activity` with
`background: true`; the target comes from the trusted inbound message, not from
model-supplied recipient fields.

After startup, Hermes uses `activityId` for `mcp_call`. The gateway resolves the
private session internally. Activity prompts and public tool output must not
contain `sessionId`, `sessionKey`, upstream MCP session ids, recipient ids,
cookies, or tokens. Visible results still require structured `notify` plus
trusted evidence refs.
