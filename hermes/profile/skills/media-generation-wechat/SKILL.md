---
name: media-generation-wechat
description: Use when the user asks Hermes to generate an image or speech for WeChat delivery.
---

# Media Generation WeChat

- Use `media_generation` for image or speech generation.
- Preserve trusted `WECHAT_MEDIA` markers exactly in the tool result path.
- Do not invent marker syntax manually.
- The Node bridge will convert trusted media payloads into WeChat messages.
- Keep any accompanying text short unless the user asks for details.
