# Media Pipeline

Status: CURRENT (2026-05-22)

This document owns the current media pipeline contract. Detailed WeChat buffer
semantics live in `docs/governance/wechat-bridge-media-buffer.md`; MiMo Power
configuration lives in `docs/governance/mimo-power-mcp.md`.

## Mainline

```text
frontend media
  -> inbound message buffer
  -> trusted local media path or remote http(s) asset
  -> media context artifact
  -> compact media context
  -> Hermes reply
```

## Owners

| Layer | Code |
|-------|------|
| WeChat turn aggregation | `node_bridge/src/inboundMessageBuffer.mjs` |
| Trusted file policy | `node_bridge/src/trustedMediaPaths.mjs` |
| Media artifacts | `node_bridge/src/mediaContextStore.mjs` |
| MiMo Power analyzer | `node_bridge/src/mimoPowerMcpServer.mjs` |
| Media reader facade | `node_bridge/src/mediaReaderMcpServer.mjs` |
| Media generation | `node_bridge/src/mediaGenerationMcpServer.mjs` |
| Compact prompt policy | `node_bridge/src/contextPolicy.mjs` |

## Buffer Contract

- Media-only messages are held in sender-level pending media.
- Explicit text references bind pending media with `relation=explicit_ref`,
  `confidence=1.0`, and `consumed=true`.
- Plain follow-up text can attach recent media as `recent_candidate`; this is
  soft context and does not consume media.
- Text-reference first, media later is supported through a saved intent TTL.
- Intent shifts decay stale recent media context quickly.

## Trusted Media

Default trusted local directories:

- `debug/wechat/inbound`
- `debug/mimo_inbound`
- `.ran_agent_state/wechat/inbound`
- `.ran_agent_state/ran-agent-weixin/media`

Custom trusted dirs may be supplied through
`NODE_BRIDGE_TRUSTED_MEDIA_DIRS` or `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`. Local
paths must stay inside the project root and inside a trusted media directory.
Project-internal secrets, vault, data, and env files are never promoted as
media inputs.

Remote assets must be `http(s)` URLs and pass provider-level safety checks.

## Analysis Order

1. `mimo_power` for deep multimodal analysis when configured.
2. `media_reader` fallback for OCR, ASR, VLM, video, and batch analysis.
3. Partial results are preserved when only one analyzer succeeds.

Video analysis is subtitle-first when available, then audio ASR, then keyframe
VLM, then metadata-only fallback.

## Context Policy

`RAN_AGENT_CONTEXT_POLICY=compact` is the default. It injects at most
`RAN_AGENT_MAX_MEDIA_ARTIFACTS` artifacts, ordered by:

```text
explicit_ref > current_media > recent_candidate > history
```

Consumed old media is filtered unless it is explicitly referenced in the
current turn. `RAN_AGENT_CONTEXT_SIZE_LOG=1` logs context-size information with
the unified request id.

Rollback: set `RAN_AGENT_CONTEXT_POLICY=legacy`.

## Security

- Platform resolver credentials such as `SESSDATA`, `XHS_COOKIE`, and proxy
  URLs must not appear in tool output, logs, docs, or Git.
- Runtime artifacts under `debug/`, `.ran_agent_state/`, and media task dirs
  are local state and must not be committed.
- PaddleOCR is best-effort on low-CPU servers; timeout or partial success is
  expected and should remain typed.
