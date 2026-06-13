---
name: wechat-media-context
description: Use when a WeChat turn includes compact media_context or media artifact refs.
---

# WeChat Media Context

- Treat compact `media_context` as the authoritative description of recent
  WeChat media.
- Respect priority: `explicit_ref > current_media > recent_candidate > history`.
- Use existing `media_reader` artifact results for image/audio/video content.
- If no artifact exists, ask for the media again or state that the media is no
  longer available. Do not guess raw image/audio/video content.
- Keep replies natural; do not expose artifact IDs unless the user is debugging.
