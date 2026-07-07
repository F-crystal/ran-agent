# External MCP Gateway

Status: CURRENT (2026-07-07)

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
