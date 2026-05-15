# Multi-Frontend Identity Strategy

Status: CURRENT (2026-05-15)

## Positioning

Multi-frontend is not multi-agent. WeChat, Feishu/Lark, and desktop
OpenAI-compatible clients all enter the same ran-agent mainline:

```text
frontend adapter
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> Hermes lite/full gateways
```

Do not make Hermes native Feishu adapter, Open WebUI, Chatbox, or LobeChat a
long-term direct memory entry by pointing them at Hermes 8642/8643. Direct
Hermes access is only a debug path. Unified memory and persona require the
ran-agent desktop proxy.

## Identity Model

`node_bridge/src/identityMap.mjs` maps platform accounts to one
`global_user_id`. The default single-user production mode maps all frontends to:

```text
user:ran
```

`global_user_id` is the scope for long-term memory and cross-platform timeline
continuity. Platform account ids are hashed before logs or persisted binding
keys are produced.

Session semantics remain split:

- `X-Hermes-Session-Key`: stable per `global_user_id`, used for unified memory.
- `X-Hermes-Session-Id`: stable per platform conversation, used for local short
  context isolation.

Do not force all platforms into the same session id. A Feishu group, WeChat DM,
and desktop thread should remain different short-term sessions while sharing
the same user memory key.

## Global Timeline

`node_bridge/src/globalTimeline.mjs` writes sanitized JSONL records to
`RAN_AGENT_GLOBAL_TIMELINE_PATH`:

```text
/opt/ran_agent/.ran_agent_state/global-timeline.jsonl
```

The timeline stores user and assistant turns from every frontend with hashed
conversation and sender ids. Long JSON, logs, base64 media, and credential-like
fields are compressed or redacted before writing. XHS/media turns should keep
the link, title, summary, image/media summary, and user-facing failure reason
when available.

Retention is bounded. `appendTurn()` keeps recent plain text for short-term
continuity, truncates single-turn text above 2000 characters into
`text_summary`, and stores media/log/JSON payloads as summaries rather than raw
payload. `compactTimeline()` archives the original JSONL as gzip under
`RAN_AGENT_TIMELINE_ARCHIVE_DIR` and rewrites the live timeline as daily/topic
summary records plus recent turns when size, turn count, or age thresholds are
exceeded. The production defaults are:

- `RAN_AGENT_TIMELINE_MAX_BYTES=52428800`
- `RAN_AGENT_TIMELINE_MAX_TURNS=5000`
- `RAN_AGENT_TIMELINE_RETENTION_DAYS=30`
- `RAN_AGENT_TIMELINE_COMPACT_ENABLED=true`
- `RAN_AGENT_TIMELINE_ARCHIVE_DIR=/opt/ran_agent/.ran_agent_state/timeline_archive`

Manual maintenance entry:

```bash
bash scripts/compact-global-timeline.sh
```

ChannelHub builds:

- local recent history for "她 / 这篇 / 那张图 / 刚才那个"
- global recent history for cross-platform follow-up
- active topic note for current conversation continuity

These notes are internal prompt context. Ordinary user replies must not explain
session headers, recent history, context windows, token budgets, stateless
behavior, or timeline mechanics.

## Frontend Adapters

### WeChat

Existing WeChat buffering and media handling stay in place. After
`inboundMessageBuffer` merges media/text turns, WeChat now enters ChannelHub
instead of calling `replyBackend` directly.

### Feishu/Lark

`node_bridge/src/feishuBridge.mjs` uses `lark-cli event consume
im.message.receive_v1` as the first implementation and keeps the code boundary
replaceable for a future SDK. The bot needs message receive/send capability,
including `im.message.receive_v1` and receive-as-bot permissions.
The bridge runs lark-cli with bot identity by default:
`FEISHU_LARK_CLI_IDENTITY=bot`. This is required for event consume because
`im.message.receive_v1` does not support user identity.

### Desktop Proxy

`node_bridge/src/desktopProxyServer.mjs` exposes:

- `GET /v1/models`
- `POST /v1/chat/completions`

Desktop clients should use:

```text
base_url=http://127.0.0.1:8650/v1
model=ran-agent
```

Model names map to routing preference only. Capability routing still happens in
`hermesGatewayClient`, so normal chat stays on 8642 and debug/lark-cli work goes
to 8643.

## Security

Never commit runtime state, timeline files, identity maps, env files, tokens,
cookies, API keys, Lark credentials, OpenID/UserID values, or local archives.
Logs should print hashes and counts only.
