# WeChat Bridge Media Buffer

Status: CURRENT (2026-05-22)

The WeChat bridge buffers media and text into a logical user turn before the
request enters `ChannelHub`.

## Owner

- Code: `node_bridge/src/inboundMessageBuffer.mjs`
- Tests: `node_bridge/tests/inboundMessageBuffer.test.mjs`
- Broader media pipeline: `docs/governance/media-pipeline.md`

## Merge Semantics

| Path | Trigger | Relation | Confidence | Consumed |
|------|---------|----------|------------|----------|
| Explicit reference | User text clearly refers to pending media, such as "看看", "分析", "刚才那张图", "这个文件" | `explicit_ref` | `1.0` | `true` |
| Implicit candidate | Plain follow-up text arrives while recent media is still relevant | `recent_candidate` | starts at `0.5` and decays | `false` |
| Deferred merge | Text reference arrives before media; media arrives within the saved intent TTL | `explicit_ref` | `1.0` | `true` |

Explicit references bind strongly and consume media. Implicit candidates are
soft context only, so a later explicit reference can still bind the same media.

## Timing

| Env Var | Default | Meaning |
|---------|---------|---------|
| `WECHAT_TEXT_REF_WAIT_MS` | `30000` | Short wait window when text-reference arrives before media |
| `WECHAT_PENDING_TEXT_REF_TTL_MS` | `120000` | Saved text-reference intent TTL |
| `WECHAT_PENDING_MEDIA_TTL_MS` | `600000` | Pending media lifetime |
| `WECHAT_MEDIA_REPLY_GRACE_MS` | `12000` | Media-only reply grace window |

## Payload Contract

```javascript
payload.media_candidates = [
  {
    artifact_id: "artifact-xxx",
    file_path: "/path/to/file",
    type: "image",
    created_at: 1234567890,
    relation: "explicit_ref" | "recent_candidate",
    confidence: 1.0,
    source: "pending_media",
    consumed: true,
    soft_used: false
  }
]
```

Downstream agents should treat `recent_candidate` as optional context, not as a
command to analyze the media.

## Test Coverage

Coverage includes:

- Media-only messages are held without triggering immediate reply.
- Explicit references merge pending media and mark it consumed.
- Implicit candidates attach recent media without consuming it.
- Later explicit references can still consume previously soft-used media.
- Pending media expires after TTL.
- Text-reference first, media later works in both the short wait window and the
  longer saved-intent TTL.
- Intent shifts decay stale media context quickly.
