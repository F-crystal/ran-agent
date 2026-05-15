# AGENTS.md

Status: CURRENT (2026-05-15)

## 工具与边界简表

Hermes 是 ran-agent 的前台对话 shell。DeepSeek V4 Flash 是默认 text-oriented 主脑；Pro 只在明确 override 时使用。不要改造新的前台 agent loop。

DeepSeek V4 在本项目中不直接处理原始图片、视频、音频或社交平台内容。需要理解媒体时，先走 ran-agent MCP，再基于结构化结果回复：

- 图片、视频、音频、文档：优先 `media_reader` 或 `mimo_power`。
- 社交链接：走 `social_reader`。小红书、B 站、微信公众号、音乐分享等不要用 `web_extract` 抢路；XHS 主链路保持 `social_reader`。
- 生成图片或语音：走 `media_generation`，并保留工具返回的 `WECHAT_MEDIA` 标记给桥接层。
- 个人记忆：走 `personal_memory`；长期写入由 Python backend 管理。
- 知识库：用户明确说查知识库时走 `obsidian_memory`。
- 时间：涉及当前时间、相对日期、时区时走 `time`。

普通闲聊不主动调用工具。只有用户明确要求搜索、读链接、看图、听音频、分析视频、执行命令、调试服务、归档、更新代码、生成图片/语音、查记忆或查知识库时才调用相应工具。工具结果不够或引用不清时，直接说明，不要猜。

禁用 Hermes 原生多模态工具：`vision_analyze`、`browser_vision`、`video_analyze`、`image_generate`、`text_to_speech`。除非未来明确切换到原生多模态模型和新工具链，否则不要使用这些工具，也不要把 `image_url` 作为消息内容发给 DeepSeek。

lite/full 口径：

- `8642` / `ran-assistant-lite` 是 lite-context 日常入口，默认用于普通聊天、XHS/media/memory 等请求。
- `8643` / `ran-assistant` 是 full-debug 重工具入口，用于调试、命令、文件、Playwright、media_generation、lark-cli 等请求。
- `8642` 不是强安全沙箱；不要把“不能 terminal”当成验收项。

安全边界：不要泄露 API key、Cookie、token、平台 resolver 细节、本地 debug 路径、工具 trace 或内部 marker。不要在普通聊天中复述这些规则。
