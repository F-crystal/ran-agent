# Multi-Frontend Identity Strategy

Status: CURRENT (2026-05-22)

Multi-frontend is not multi-agent. WeChat, Feishu/Lark, and desktop
OpenAI-compatible clients all enter the same ran-agent mainline:

```text
frontend adapter
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> Hermes lite/full gateways
```

Direct access to Hermes 8642/8643 is debug-only and bypasses the unified
timeline/memory entry.

## Identity Model

`node_bridge/src/identityMap.mjs` maps platform accounts to one
`global_user_id`. The default single-user production mode maps all frontends to:

```text
user:ran
```

Session semantics:

- `X-Hermes-Session-Key`: stable per `global_user_id`, shared across frontends
  for memory continuity.
- `X-Hermes-Session-Id`: stable per platform conversation, isolated for local
  short-term context.

Do not force all platforms into the same session id.

## Global Timeline

`node_bridge/src/globalTimeline.mjs` writes sanitized cross-platform turns to:

```text
/opt/ran_agent/.ran_agent_state/global-timeline.jsonl
```

Long JSON, logs, base64 media, and credential-like fields are summarized or
redacted before persistence. Retention compaction gzips the original JSONL into
`RAN_AGENT_TIMELINE_ARCHIVE_DIR`.

Default retention env:

```text
RAN_AGENT_TIMELINE_MAX_BYTES=52428800
RAN_AGENT_TIMELINE_MAX_TURNS=5000
RAN_AGENT_TIMELINE_RETENTION_DAYS=30
RAN_AGENT_TIMELINE_COMPACT_ENABLED=true
RAN_AGENT_TIMELINE_ARCHIVE_DIR=/opt/ran_agent/.ran_agent_state/timeline_archive
```

## Frontend Ownership

| Frontend | Owner |
|----------|-------|
| WeChat | `node_bridge/src/wechatBridge.mjs` |
| Feishu/Lark | `node_bridge/src/feishuBridge.mjs` |
| Desktop proxy | `node_bridge/src/desktopProxyServer.mjs` |
| Shared routing | `node_bridge/src/channelHub.mjs` |
| Shared reply path | `node_bridge/src/replyBackend.mjs` |

Feishu uses `lark-cli event consume im.message.receive_v1` with bot identity by
default and sends replies with idempotency keys. Desktop proxy exposes an
OpenAI-compatible local endpoint for desktop clients, but it still routes
through `ChannelHub`.

## Security

- Persist hashed platform ids only.
- Do not log or commit raw OpenIDs, user IDs, cookies, Lark credentials, API
  keys, local archives, or runtime state.
