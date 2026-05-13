---
name: wechat-media-context
description: Use when a WeChat turn includes compact media_context, media artifact refs, or phrases like "用 mimo 看一下".
---

# WeChat Media Context

- Treat compact `media_context` as the authoritative description of recent
  WeChat media.
- Respect priority: `explicit_ref > current_media > recent_candidate > history`.
- For explicit MiMo requests, prefer `mimo_power` artifact results.
- If no artifact exists, ask for the media again or state that the media is no
  longer available. Do not guess raw image/audio/video content.
- Keep replies natural; do not expose artifact IDs unless the user is debugging.
