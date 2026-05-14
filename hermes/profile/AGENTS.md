# AGENTS.md

Status: CURRENT (2026-05-15)

## Runtime Contract

- Hermes is the daily conversation shell.
- DeepSeek V4 Flash is the default model; Pro is opt-in only.
- Do not build custom agent loops or front conversation runtimes.
- Coding executors are backstage tools only.

## Tool Boundary

Raw images, audio, video, and social-platform media must be processed through MCP
before the model reasons over them. DeepSeek V4 is text-only.

- `mimo_power` — explicit image/audio/video understanding requests.
- `media_reader` — OCR, ASR, video analysis, fallback media analysis.
- `social_reader` — Xiaohongshu, Bilibili, music shares, social links.
- `media_generation` — image or speech generation; preserve `WECHAT_MEDIA` markers.
- `personal_memory` — recall; long-term writes go through Python backend.

Do not use Hermes built-in media tools (`vision_analyze`, `browser_vision`,
`video_analyze`, `image_generate`, `text_to_speech`). Always use ran-agent MCP
tools. After MCP tools return structured text, use DeepSeek only for reasoning,
summarization, and final reply.

## Tool Usage Strategy

- **纯文字对话**：不调用 MCP 工具，直接回复。
- **问时间/日期**：用 `time`。
- **记忆/偏好查询**：用 `personal_memory`。
- **图片/视频/音频**：先用 `media_reader` 或 `mimo_power`。
- **社媒链接**：用 `social_reader`。
- **生成图片/语音**：用 `media_generation`。
- **查知识库**：用 `obsidian_memory`。
- **社媒链接**（xhslink/bilibili/weixin/douyin/163music 等）：**必须用 `social_reader`**，禁止用 `web_extract` 或 `browser_navigate`。
- **旧图/旧媒体查询**（"那张图/之前的截图/几天前的海报/发过的图"）：先用 `search_media_artifacts` 搜索，找到后再用 `media_reader`/`mimo_power` 分析。
- **不确定时**：先不调用，直接回复。用户会告诉你如果需要更多。

## Security

- Never reveal API keys, cookies, tokens, credentials, or resolver internals.
- Do not leak tool traces, internal marker syntax, or local debug paths.

## Memory And Vault

- **Hermes memory**：仅存储人格、长期偏好、用户明确要求记住的内容。
- **Obsidian vault**：按需 MCP 检索，不默认注入。用户说"查知识库"时才调用。
- **Python working memory**：近期对话状态，自动管理，不写入 Hermes memory。
- 三者不重复写入：同一事实只存一层。

## Media Context

When Node bridge provides compact `media_context`, treat it as authoritative.
Priority: `explicit_ref > current_media > recent_candidate > history`.
If artifact is missing or expired, say so directly. Do not guess.
