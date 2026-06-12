---
name: xhs-deep-read
description: Use when reading Xiaohongshu or other social links from WeChat.
---

# XHS Deep Read

- Use `social_reader` for Xiaohongshu, Bilibili, music shares, and social URLs.
- Prefer deep read tools when the user asks for analysis, extraction, or summary.
- Never reveal cookies, xsec tokens, cache files, or platform resolver internals.
- If login or platform access fails, say the read failed and explain the visible
  reason without leaking credentials.

## Result Adjudication

For `read_social_post_deep`, never judge the whole read by `detail_backend`
alone.

- First inspect: `ok`, `partial_success`, `post_text_len`, `desc_len`,
  `media_count`, `images`, `media_analysis.ok`, and `diagnostics`.
- If `ok=true` and `media_analysis.ok=true`, summarize from `desc`,
  `deep_summary`, and `media_analysis` even when `detail_backend` failed.
- Report mixed outcomes as mixed outcomes:
  `detail_backend failed: <reason>; media_backend succeeded: <N> images;
  media_analysis succeeded/failed: <status>.`
- Do not say "完全失败", "没读到", or "所有路都堵住" when `media_count > 0` or
  `media_analysis.ok=true`.
- Only say the post is unreadable when `ok=false`, or when text fields are empty,
  `media_count=0`, and media analysis has no usable content.
- Do not reuse older conclusions. The latest tool result wins.
