# Media Pipeline

Status: CURRENT (2026-05-10)

## Full Pipeline

```text
WeChat inbound
  -> inboundMessageBuffer (turn aggregation)
     -> media-only: hold in pending queue
     -> text-ref: merge with pending media
  -> Node Bridge normalize payload
  -> preparePayloadMediaForAgent
     -> copy external files to trusted dirs
  -> ensureConversationMediaContext
     -> mimo_power__analyze (primary)
     -> media_reader (fallback)
     -> write artifact to debug/media_context/
  -> buildOpenClawAgentMessage
     -> inject media instruction + context
  -> OpenClaw agent reply
```

## Inbound Message Buffer

Module: `node_bridge/src/inboundMessageBuffer.mjs`

Turn aggregation layer before the media pipeline. Solves the problem of WeChat image/video/audio and text arriving as separate messages.

**Behavior:**
- Media-only messages: held in sender-level pending queue, no reply triggered
- Text-ref messages (e.g. "用 mimo 分析", "看看刚才那张图"): merge with pending media
- Plain text: passes through without delay or binding
- Two merge paths: immediate (within 30s wait window) and deferred (within 2 min intent TTL)

**Env vars (all optional, have defaults):**

| Variable | Default | Description |
|----------|---------|-------------|
| `WECHAT_TEXT_REF_WAIT_MS` | 30000 | Text-ref wait window for pending media |
| `WECHAT_PENDING_TEXT_REF_TTL_MS` | 120000 | Intent TTL after wait expires |
| `WECHAT_PENDING_MEDIA_TTL_MS` | 600000 | Pending media lifetime |
| `WECHAT_MEDIA_REPLY_GRACE_MS` | 12000 | Grace window (reserved) |
| `WECHAT_MEDIA_ONLY_IDLE_REPLY` | false | Reply hint on media-only |

## Trusted Media Directories

Module: `node_bridge/src/trustedMediaPaths.mjs`

Local `file_path` inputs accepted only from:
- `debug/wechat/inbound`
- `debug/mimo_inbound`
- `.openclaw_state/wechat/inbound`
- `.openclaw_state/openclaw-weixin/media`
- Custom: `NODE_BRIDGE_TRUSTED_MEDIA_DIRS` / `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`

External files (e.g. `/tmp/weixin-sdk`) are auto-copied to `debug/wechat/inbound/`. Project-internal files (`.env`, vault, data) are never promoted.

URL media assets must be remote `http(s)` URLs.

## Media Context Store

Module: `node_bridge/src/mediaContextStore.mjs`

Persists media analysis artifacts as conversation-scoped state:
- `debug/media_context/artifacts/<id>.json`
- `debug/media_context/conversations/<id>.json`

Analysis order: MiMo Power MCP (primary) -> media_reader (fallback). Artifacts include summary, OCR text, transcript, keyframes.

## MiMo Power MCP

Module: `node_bridge/src/mimoPowerMcpServer.mjs`

Deep multimodal analysis via MiMo Token Plan. Primary analyzer for WeChat inbound media.

Fallback triggers: `MIMO_TOKEN_PLAN_KEY_MISSING`, `MIMO_TOKEN_PLAN_EXPIRED`, `MIMO_REQUEST_FAILED`, `MIMO_REQUEST_TIMEOUT`.

## Media Reader MCP

Module: `node_bridge/src/mediaReaderMcpServer.mjs`

Unified facade for OCR, ASR, VLM, video analysis. Backed by PaddleOCR, DashScope qwen3-vl-flash/qwen3-asr-flash, ffmpeg/ffprobe.

Video analysis: subtitle-first strategy (yt-dlp subtitles -> audio ASR -> keyframe VLM -> metadata-only).

## Media Generation MCP

Module: `node_bridge/src/mediaGenerationMcpServer.mjs`

Image (`generate_image`) and speech (`generate_speech`) generation for WeChat replies. Backed by DashScope qwen-image and qwen3-omni-flash.

After success, preserve `WECHAT_MEDIA: {...}` line in reply for bridge consumption.

## Security

- Platform resolver credentials (SESSDATA, XHS_COOKIE, proxy URLs) must never appear in tool output, logs, docs, or git.
- PaddleOCR is best-effort on servers; timeouts expected on low-CPU instances.
- Frame extraction skips OCR by default (VLM reads burned-in subtitles).
