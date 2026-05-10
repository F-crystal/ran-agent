<p align="right"><b>中文</b> | <a href="README_en.md">English</a></p>

# Ran Agent

**一个运行在微信里的本地优先个人 AI 助手，能理解社交媒体内容、管理知识——所有数据都在你自己的服务器上。**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent 是一个端到端的个人 Agent 运行时。它把微信消息接入 LLM 对话引擎，加上记忆和反思能力，再通过多模态理解管线让 Agent"看见"内容——发给它一个 B站链接或小红书帖子，它真的会去看、去读、去总结。一切在你自己的服务器上运行。

---

## 目录

- [能做什么](#能做什么)
- [架构](#架构)
- [MCP 服务](#mcp-服务)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [项目结构](#项目结构)
- [测试](#测试)
- [平台支持](#平台支持)
- [许可证](#许可证)
- [隐私](#隐私)

---

## 能做什么

**微信 Agent。** 消息路径：`微信 → Node Bridge → OpenClaw Agent → Claude/Qwen → 回复`。像跟朋友聊天，不像在提示词框里打字。Agent 会记住你们的对话，并在长期交互中演化自己的性格。

**社交媒体理解。** 把 B站视频、小红书笔记、微信公众号文章链接发到对话框里，Agent 会解析内容并总结给你：

- B站：字幕提取（人工字幕 + AI 生成字幕）、封面图视觉理解、视频帧分析、语音转写兜底
- 小红书：笔记正文提取、图片内容理解、视频元数据、评论读取
- 微信公众号：正文解析、验证码识别、结构化降级

**知识管理。** Obsidian 知识库存储结构化知识，Python 后端定期运行维护任务——整理笔记、更新知识索引、保持知识库更新。不需要把全部内容塞进 prompt。

**媒体理解管线。** 发图片后说"用 mimo 看一下"，系统自动将图片和文字合并为一个请求处理。媒体分析结果在会话中持久化，后续说"刚才那张图"能正确指代之前的分析结果。支持图片、音频、视频、文档的深度多模态分析。

**记忆与反思。** Agent 在对话中构建工作记忆。每晚运行反思周期，回顾当天互动，提出性格微调建议。你始终控制哪些内容被记住、哪些被遗忘。

---

## 架构

```
微信 ──┬── 消息接入 ──► 入站消息聚合 ──► Node Bridge ──► OpenClaw Agent ──► Claude/Qwen
       │                  (图片+文字合并)       ▲               │    │    │
       │                                        │               │    │    └──► media_generation
       │                                        │               │    └───────► social_reader
       │                                        │               └────────────► media_reader + mimo_power
       │                                        │
       └── 消息发出 ◄── Node Bridge ◄── 回复 ◄──┘
                            ▲
                            │
                  Python 后端服务
                  ┌─────────┼─────────┐
                  │ 记忆    │ 调度器   │
                  │ 知识库  │ 待办     │
                  │ 反思              │
                  └────────────────────┘
```

**关键设计决策：**

- **MCP 门面模式。** OpenClaw 只看到 6 个干净稳定的工具（`media_reader__analyze_video` 等），背后是平台解析器、Provider 适配器、格式转换器。内部细节不泄露给 Agent。

- **字幕优先的视频理解。** 四层逐级降级：软字幕直接提取（~2s）→ 纯音频 ASR 转写（~10s，仅下载音频）→ 关键帧 VLM 分析（~30s，不含 OCR）→ 元数据兜底（~1s）。长视频不盲目下载全片。

- **媒体制品管线。** 入站媒体经 MiMo 分析（media_reader 兜底）后存为会话级制品。后续引用如"刚才那张图"自动解析到先前的分析结果，无需重复处理。

- **数据完全本地。** 状态存 SQLite，知识存 Obsidian Vault，聊天记录在你的机器上。没有云数据库、没有托管服务、没有遥测。单用户设计——没有用户管理、权限控制、API 限流，因为只有你一个人用。

---

## MCP 服务

Agent 的能力以 MCP（模型上下文协议）服务的形式组织，每个服务向 OpenClaw 暴露一组聚焦的工具。

### 自建服务

**`media_reader`** — Agent 的"眼睛和耳朵"。

| 工具 | 描述 |
|------|------|
| `extract_media_assets` | 从社交文本或消息中提取媒体 URL |
| `analyze_image` | 图片 OCR + 视觉语言模型分析 |
| `resolve_platform_media` | 解析 B站/小红书/微信链接为标准化媒体 |
| `transcribe_audio` | 语音转文字，支持语言检测 |
| `analyze_video` | 视频分析：元数据、字幕提取、帧 VLM、语音转写 |
| `analyze_media_batch` | 批量分析，支持部分失败容错 |

**`social_reader`** — 平台感知的社交内容阅读。

| 工具 | 描述 |
|------|------|
| `resolve_social_url` | 识别平台，从分享文案中提取规范 URL |
| `read_social_post` | 读取社交帖子，平台特定的内容提取 |
| `read_social_post_deep` | 深度读取：解析平台媒体 + 分析所有资源 |
| `read_music_share` | 解析音乐分享链接（网易云等） |
| `check_social_login` | 检查平台认证状态 |

**`media_generation`** — 为微信回复生成可发送的媒体。

| 工具 | 描述 |
|------|------|
| `generate_image` | 通过 Qwen 生成图片 |
| `generate_speech` | 文字转语音 |

**`mimo_power`** — 深度多模态分析服务。

| 工具 | 描述 |
|------|------|
| `analyze` | 深度多模态分析（图片/音频/视频/文档），使用 MiMo Token Plan |

**`ombre_brain`** — 情感记忆系统，用于长期记忆管理。

| 工具 | 描述 |
|------|------|
| `breath` | 按情感相关性召回记忆 |
| `trace` | 追踪记忆关联和连接 |
| `pulse` | 浮现活跃/高情感记忆 |
| `hold` | 存储长期记忆条目 |
| `grow` | 存储核心（身份形成性）记忆 |

实现 Russell 效价/唤醒度模型、Ebbinghaus 遗忘曲线、Obsidian 兼容 Markdown 存储。

<sub>集成自 [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain)，直接作为记忆管理 MCP 使用。</sub>

### 外部服务

| 服务 | 描述 |
|------|------|
| `playwright` | 浏览器自动化，用于网页交互 |
| `time` | 时区感知的时间和日期查询 |
| `tavily` | 通过 Tavily API 进行网页搜索 |

---

## 快速开始

**前提：** Node.js ≥22，Python ≥3.10，ffmpeg，ffprobe

```bash
git clone https://github.com/F-crystal/ran-agent.git
cd ran-agent

# 安装依赖
npm install
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# 配置凭据
cp .env.example .env.local
# 编辑 .env.local — 最少需要 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
```

三个终端分别启动：

```bash
./start_openclaw.sh       # Agent 运行时
./start_python.sh          # 后端服务（记忆、调度、知识库）
cd node_bridge && ./start_node.sh  # 微信 Bridge
```
三个终端分别启动。停止用 `Ctrl+C`。

---

## 配置说明

所有配置在 `.env.local` 中（不提交到 Git）。复制模板并根据需要填写：

```bash
cp .env.example .env.local
```

配置按模块分组：

| 模块 | 关键变量 | 说明 |
|------|----------|------|
| 模型 Provider | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Claude 兼容 API（必填） |
| 视觉理解 | `PERSONAL_AGENT_VISION_PROVIDER`, `PERSONAL_AGENT_VISION_MODEL` | 默认 `dashscope-qwen-vl` / `qwen3-vl-flash` |
| 语音识别 | `PERSONAL_AGENT_ASR_PROVIDER`, `PERSONAL_AGENT_ASR_MODEL` | 默认 `dashscope-asr` / `qwen3-asr-flash` |
| 网页搜索 | `TAVILY_API_KEY` | Tavily 搜索 API |
| B站 | `PERSONAL_AGENT_BILIBILI_ENABLED`, `PERSONAL_AGENT_YTDLP_PATH` | yt-dlp 路径 + 代理/认证 |
| 小红书 | `PERSONAL_AGENT_XHS_ENABLED`, `PERSONAL_AGENT_XHS_PROVIDER` | 后端 MCP 或 social reader |
| 视频处理 | `PERSONAL_AGENT_FFMPEG_PATH`, `PERSONAL_AGENT_FFPROBE_PATH` | ffmpeg/ffprobe 路径 |
| 缓存/并发 | `PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY`, `PERSONAL_AGENT_MEDIA_CACHE_DIR` | 批次并发数、缓存目录 |

完整变量列表见 `.env.example`。

---

## 项目结构

```
ran_agent/
├── openclaw/                    # OpenClaw Agent 配置和运行时
├── node_bridge/                 # 微信 Bridge + MCP 门面服务
│   └── src/
│       ├── mediaReader/         # OCR、VLM、ASR、ffmpeg、平台解析器
│       │   └── platformResolvers/  # B站、小红书、微信公众号解析器
│       ├── inboundMessageBuffer.mjs  # 入站消息聚合（图片+文字合并）
│       ├── mediaContextStore.mjs     # 媒体制品持久化
│       ├── trustedMediaPaths.mjs     # 可信媒体路径校验
│       ├── mimoPowerMcpServer.mjs    # MiMo Power MCP 服务
│       ├── socialReaderMcpServer.mjs
│       ├── mediaReaderMcpServer.mjs
│       ├── mediaGenerationMcpServer.mjs
│       └── wechatBridge.mjs     # 微信消息收发处理
├── src/personal_agent/          # Python 后端
│   ├── memory.py                # 对话记忆
│   ├── knowledge_agent.py       # 知识提取和 Vault 管理
│   ├── scheduler.py             # 定时任务调度
│   └── night_cycle.py           # 夜间反思和性格演化
├── skills/                      # 按需加载的专业技能
├── scripts/                     # 启动脚本、部署工具
├── vault/                       # Obsidian 知识库（仅模板）
├── docs/governance/             # 运行时约束和状态
└── local_archive/               # 部署指南（私有，不入 Git）
```

---

## 测试

```bash
# Python 测试
PYTHONPATH=src pytest -q tests/

# Node.js 测试
npm --prefix node_bridge test
```

---

## 平台支持

| 平台 | 解析方式 | 字幕 | 视频帧 | 认证支持 |
|------|----------|------|--------|----------|
| B站 | yt-dlp + MCP | 人工 + AI | VLM 逐帧分析 | SESSDATA Cookie |
| 小红书 | 后端 MCP | 笔记正文 | 封面图 VLM | Cookie 认证 |
| 微信公众号 | HTML 抓取 + 解析 | 文章正文 | — | 无需登录 |
| 直接媒体链接 | ffmpeg + DashScope | ASR 转写 | VLM 逐帧分析 | — |

---

## 许可证

PolyForm Noncommercial License 1.0.0 — 个人使用、研究和学习免费。商业使用需授权。详见 [LICENSE.md](LICENSE.md)。

---

## 隐私

这是一个个人 Agent。以下内容永远不应进入版本控制：`.env.local`、`.openclaw_state/`、聊天记录、Cookie、API 密钥、Vault 内容、状态数据库。`.gitignore` 已默认阻止这些文件——在公开你的 Fork 前务必再次确认。
