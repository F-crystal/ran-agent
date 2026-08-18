# External MCP Gateway

Status: CURRENT (2026-08-18)

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

Source profiles make the governed gateway available by default:

- `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`
- `EXTERNAL_MCP_GATEWAY_ENABLED=true`
- `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`

The launcher still requires the allow-env gate, so an ambient enable flag alone
cannot bypass the profile decision. Default availability exposes only admitted,
policy-checked calls; it does not grant background autonomy to every registered
server. Standard server deploy preserves:

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

Production composes external polling with Core authority. Forum, RSS, and
other external MCP watchers follow:

```text
poll/scan -> sanitized Core fact -> WakeOccurrence/WorkRun -> Hermes decision
  -> Node attention valve -> Core presentation outbox/receipt
```

The scan must hold the exact `external_poll` WorkRun revision, fence, lease,
active Activity, and bound aggregate payload before provider execution. The
fact and deterministic pending projection commit together. Recovery may replay
attention/schedule projection, never the provider call or fact creation.

The watcher never sends directly. Hermes proposes structured content, evidence,
and an attention identifier; Node validates all three. Ordinary timely content
may notify, ambient content stays silent, and delayed content is durably
coalesced. The Core-managed attention-flush schedule is the only flush clock.
Legacy watch scopes remain paused until their watermark is explicitly accepted,
so historical results cannot replay as new notifications.

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
