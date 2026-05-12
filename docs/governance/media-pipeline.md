# Media Pipeline

Status: CURRENT (2026-05-12)

## Full Pipeline

```text
WeChat inbound
  -> inboundMessageBuffer (turn aggregation + media context decay)
     -> media-only: hold in pending queue
     -> text-ref: merge with pending media (explicit_ref, confidence=1.0)
     -> plain text: attach recent media with decay (recent_candidate, confidence decays per turn)
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

### Three Merge Paths

| Path | Trigger | Relation | Confidence | Consumed |
|------|---------|----------|------------|----------|
| **Explicit ref** | Text matches `MEDIA_REF_PATTERNS` ("看看", "分析", "用 mimo") | `explicit_ref` | 1.0 | true |
| **Implicit candidate** | Plain text within TTL, no explicit ref | `recent_candidate` | 0.5 (decays) | false |
| **Deferred merge** | Text-ref arrives first, media arrives later (within 120s TTL) | `explicit_ref` | 1.0 | true |

### Media Context Decay

**Problem**: Without decay, implicit media candidates persist indefinitely, causing the agent to force-associate media with unrelated follow-up queries (e.g., vocabulary discussions like "忮忌是什么意思").

**Solution**: Apply turn-based exponential decay to `recent_candidate` media, with rapid decay on intent shift detection.

**Decay formula**:
```javascript
decayedConfidence = initialConfidence * (decayRate ^ roundsElapsed)
if (intentShifted) decayedConfidence *= 0.3
if (decayedConfidence < globalThreshold) candidate removed
```

**Default parameters**:
```javascript
{
  decayRate: 0.7,              // 30% decay per turn
  maxRetentionRounds: 5,       // Auto-remove after 5 turns
  globalThreshold: 0.25,       // Minimum confidence to retain
  rapidDecayOnIntentShift: true,
}
```

**Intent shift detection**: Query contains generic phrases like "是什么", "意思", "解释", "定义", "区别", "什么意思", "是什么意思", "何为".

**Example**:
| Turn | User Input | Media Confidence | Action |
|------|------------|------------------|--------|
| 1 | [sends image] | 1.0 (new) | Attached |
| 2 | "博主很有竞争意识" | 0.7 (decay) | Attached (relevant) |
| 3 | "我们不说妒忌，要说忮忌" | 0.105 (decay × intent shift) | **Removed** (< 0.25) |

### Behavior Summary

- **Media-only messages**: held in sender-level pending queue, no reply triggered
- **Text-ref messages**: merge with pending media (explicit_ref, consumed=true)
- **Plain text with pending media**: attach recent media with decay logic
- **Intent shift queries**: rapid decay removes media candidates
- **Deferred merge**: text-ref intent saved, media within 120s TTL triggers merge

### Env vars (all optional, have defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `WECHAT_TEXT_REF_WAIT_MS` | 30000 | Text-ref wait window for pending media |
| `WECHAT_PENDING_TEXT_REF_TTL_MS` | 120000 | Intent TTL after wait expires |
| `WECHAT_PENDING_MEDIA_TTL_MS` | 600000 | Pending media lifetime |
| `WECHAT_MEDIA_REPLY_GRACE_MS` | 12000 | Grace window (reserved) |
| `WECHAT_MEDIA_ONLY_IDLE_REPLY` | false | Reply hint on media-only |

### Test Coverage

21 test cases in `node_bridge/tests/inboundMessageBuffer.test.mjs`:
- ✅ Explicit ref binding and consumption
- ✅ Implicit ref soft attachment
- ✅ Subsequent explicit ref after implicit ref (media not consumed)
- ✅ Pending media expiry after TTL
- ✅ Text-ref first, media within wait window (immediate merge)
- ✅ Text-ref first, media after 60s (deferred merge via saved intent)
- ✅ Media context decay over turns
- ✅ Intent shift detection and rapid decay

## Trusted Media Directories

Module: `node_bridge/src/trustedMediaPaths.mjs`

Local `file_path` inputs accepted only from:
- `debug/wechat/inbound`
- `debug/mimo_inbound`
- `.openclaw_state/wechat/inbound`
- `.openclaw_state/openclaw-weixin/media`
- Custom: `NODE_BRIDGE_TRUSTED_MEDIA_DIRS` / `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`

External files (e.g. `/tmp/weixin-sdk`) are auto-copied to `debug/wechat/inbound`. Project-internal files (`.env`, vault, data) are never promoted.

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
