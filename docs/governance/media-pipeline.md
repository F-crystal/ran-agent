# Media Pipeline

Status: CURRENT (2026-08-18)

This document owns the current media pipeline contract. Detailed WeChat buffer
semantics live in `docs/governance/wechat-bridge-media-buffer.md`; retired
MiMo Power records live in `docs/governance/cleanup.md`.

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
- `debug/mimo_inbound` (legacy directory name; not a current MiMo runtime)
- `.ran_agent_state/wechat/inbound`
- `.ran_agent_state/feishu/inbound`
- `.ran_agent_state/ran-agent-weixin/media`

Custom trusted dirs may be supplied through
`NODE_BRIDGE_TRUSTED_MEDIA_DIRS` or `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`. Local
paths must stay inside the project root and inside a trusted media directory.
Project-internal secrets, vault, data, and env files are never promoted as
media inputs.

The vendored WeChat SDK writes downloaded inbound media to
`/tmp/weixin-agent/media/inbound` by default. The Node bridge treats that as a
source-only staging directory and copies those files into
`.ran_agent_state/wechat/inbound` before passing media to Hermes or
`media_reader`. Override the source staging roots with
`WEIXIN_SDK_INBOUND_MEDIA_DIRS` only when the SDK location changes. Deployment
via `scripts/apply-hermes-runtime-split.sh` creates the default trusted media
directories idempotently.

Remote assets must be `http(s)` URLs and pass provider-level safety checks.
The default remote media host allowlist includes common social/CDN hosts used
by supported resolvers, including XHS image CDN hosts under `xiaohongshu.com`
and `xhscdn.com`.

Sticker saving is a separate owner-only boundary. Inbound media becomes a
`sticker_save_from_inbox` candidate only after explicit user intent such as
"保存这个为表情包"; ordinary screenshots, photos, document images, and work
files are not saved automatically. Sticker assets live under
`.ran_agent_state/stickers/`, and model-visible `RAN_MEDIA` markers carry only
`stickerId`.

## Analysis Order

1. `media_reader` for OCR, ASR, VLM, video, and batch analysis.
2. Partial results are preserved when individual media assets fail.

For platform links, call `media_reader.resolve_platform_media` before direct
asset analysis when normalized resources are needed. XHS is public-only:
`wanyi-watermark`, the XHS-Downloader sidecar, and HTML/OG fallback may supply
post text and media URLs, but account-backed browse/cookie providers are not
part of the runtime. Known `image`/`video` types must be preserved before
forwarding assets to `analyze_media_batch` for OCR/VLM.
Resolvers must not claim image understanding by themselves: public XHS parsers
supply post text and media URLs, while `media_reader` performs the OCR/VLM
pass. Default deep reads keep up to 100 media assets and use long media-reader
budgets so all discovered images are attempted; failures remain per-asset
partial failures instead of silent truncation.
XHS missing `xsec_token` is a recoverable resolver condition: public parser
metadata and image URLs must still be forwarded to analysis when available.

Video analysis is subtitle-first when available, then audio ASR, then keyframe
VLM, then metadata-only fallback.

## Provider Boundary

`media_reader` remains the only Hermes-visible media facade. Its optional
`qwen-mm` provider delegates OCR and image/keyframe understanding to the pinned
`QwenLM/Qwen-MM-Plugins` API process; trusted paths, downloads, cache, batching,
partial results and public tool names remain owned by ran-agent. The backend is
prepared ahead of activation and runtime calls never install dependencies.

Token Plan activation uses `qwen3.6-flash` for Qwen-MM OCR/VLM and for the Qwen
knowledge runner. The current Token Plan model list does not include the
Qwen-MM Omni ASR model, so audio transcription deliberately stays on the
existing DashScope `qwen3-asr-flash` path. This is one explicit provider split,
not a silent fallback stack. `scripts/configure-qwen-token-plan.sh` validates
both visual chat and Responses API before atomically switching local config;
the key is read once from a hidden prompt and is never accepted on the command
line.

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

- Platform resolver credentials such as `SESSDATA` and proxy URLs must not
  appear in tool output, logs, docs, or Git; `XHS_COOKIE` is not a current
  runtime setting.
- Runtime artifacts under `debug/`, `.ran_agent_state/`, and media task dirs
  are local state and must not be committed.
- The default unconfigured OCR path remains DashScope Qwen-VL OCR. After the
  explicit Token Plan transaction, OCR/VLM use Qwen-MM with
  `qwen3.6-flash`; PaddleOCR remains an explicit local override. OCR timeout or
  partial success stays typed.
