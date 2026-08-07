<p align="right"><b>中文</b> | <a href="README_en.md">English</a></p>

# Ran Agent

Status: CURRENT (2026-08-07)

生产运行统一 Hermes v0.20 + DeepSeek V4 Flash；精确代码 SHA、证据与回滚边界见 `docs/governance/current_runtime_status.md`。

**一个本地优先的个人 AI 助手运行时：微信、飞书/Lark 和桌面 OpenAI-compatible Proxy 统一进入 ChannelHub，Hermes 负责对话，Node bridge 负责多前端接入，Python 后端负责记忆、知识和调度，媒体与社交平台理解通过 MCP 工具完成。**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent 是一个个人 Agent 运行时，不是 SaaS。它把微信、飞书/Lark 和桌面客户端消息统一接入 ChannelHub，再经 Hermes Gateway 生成回复。生产统一 profile 使用 DeepSeek V4 Flash，并在最终 provider HTTP body 显式加入 `thinking: {"type":"disabled"}`；V4 Pro 只保留为显式 opt-in。`search_hub`、`media_reader`、`social_reader`、`sticker_catalog`、`personal_memory` 等 MCP 工具负责联网事实、媒体、社交内容、表情包目录、Vault 和个人记忆。状态、日志、Vault、Cookie 和密钥都留在你控制的机器上。

OpenClaw、Kimi、GLM 和 MiMo Power 当前 runtime 路线已经退休；生产前台和当前候选都使用 Hermes + DeepSeek V4 Flash non-thinking，Pro 仅显式启用。

---

## 当前主线

```text
WeChat / Feishu / Desktop Proxy
  -> ChannelHub
  -> replyBackend
  -> unified Hermes gateway
  -> DeepSeek V4 Flash
  -> reply

IdentityMap + GlobalTimeline
  -> explicit owner binding -> one global user identity
  -> platform conversation/session scopes remain isolated
  -> local recent history + cross-platform active topic

Python backend
  -> ingest / memory / knowledge / reflection / scheduler / reminders

MCP services
  -> search_hub / media_reader / social_reader / sticker_catalog / co_reading / media_generation
  -> personal_memory / time / playwright
```

### 统一 Hermes Gateway

生产部署使用一个 Hermes v0.20 gateway；当前 source candidate 只保留一个前台 URL 和一个 companion profile：

| Gateway | 端口 | Profile | 用途 |
|---------|------|---------|------|
| unified | `8642` | `ran-agent-companion` | 聊天、记忆、命令、Playwright、媒体与全部既有 MCP |

旧 Full 服务已停用；terminal/file/session search/Playwright 等能力并入统一 profile，而不是随 `8643` 一起删除。
Desktop Proxy 默认关闭；启用时仅应绑定 localhost 或受控私网，并配置
`DESKTOP_PROXY_API_KEY`。

### 可靠性底座

当前运行时已经具备 typed action request/receipt、durable outbox、外部活动的
activity/revision/lease 以及 immutable-SHA release transaction。它们提供可审计
的动作、投递和发布基础；完整边界与已知限制以 `docs/governance/` 为准。

---

## 能做什么

**多前端统一入口。** 微信、飞书/Lark 和桌面 OpenAI-compatible Proxy 都进入 `node_bridge/src/channelHub.mjs`，再走同一个 `replyBackend -> hermesGatewayClient -> Hermes` 主链路。`IdentityMap` 通过显式 owner binding，将已认证的多前端身份归并到同一全局用户身份；平台 conversation/session 仍保持隔离。`GlobalTimeline` 记录跨平台 turn。

**微信对话入口。** 微信消息进入 `node_bridge/src/wechatBridge.mjs`，经入站聚合、ChannelHub、媒体上下文处理、Hermes Gateway、DeepSeek V4 Flash 后回到微信。Python 后端会异步接收 `/ingest`，维护近期记忆和后续任务。

**飞书和桌面入口。** 飞书桥接通过 `lark-cli event consume im.message.receive_v1 --as bot` 消费消息，并通过 `im +messages-send` 回复；桌面客户端通过 ran-agent 的 OpenAI-compatible Proxy 接入，避免绕过 ChannelHub、统一身份/Timeline，以及 action/evidence gates。

**每日 AI 日报。** 可选启用 `AI_DAILY_DIGEST_ENABLED=true`，Python scheduler 每天 08:00 拉取 AIHOT 事实，作为合成的飞书私聊 turn 进入 `ChannelHub -> Hermes`，由 Hermes 按 `src/personal_agent/prompts/ai_daily_digest_report.md` 生成报道式日报，再通过现有飞书回复路径发回给你。它不打开旧 proactive check-in、reminder 或 life-loop 外发。

**联网搜索入口。** `search_hub` 是 Hermes 前台统一搜索入口，负责最新信息、新闻、普通网页事实、学术检索和平台搜索路由。统一 profile 保留旧 Full 的 Playwright fallback；OpenCLI browser-backed 默认关闭。不要让 Hermes 日常搜索直接面对 Tavily/OpenCLI/Playwright。

**社交媒体读取。** `social_reader` 负责 B 站、小红书、微信公众号、音乐分享等链接。社交平台“链接读取”仍优先 `social_reader`，不会被 `search_hub` 抢路。小红书固定走公开解析链路：`wanyi-watermark`、XHS-Downloader public sidecar、通用网页/OG 兜底，再把公开媒体 URL 交给 `media_reader` 做 OCR/VLM；不配置 `XHS_COOKIE`、扫码登录或账号态 MCP。公开解析失败时返回不可读/metadata-only，不会动用个人账号。

**多模态理解。** 微信图片、音频、视频和文档先经过可信路径校验，再交给 `media_reader` 做 OCR、ASR、VLM 或视频分析。视频采用字幕优先策略：字幕、音频 ASR、关键帧 VLM、元数据逐级降级。

**媒体上下文追问。** 入站媒体会生成会话级 artifact。用户说“刚才那张图”“分析一下刚才那张图”时，入站消息缓冲会把文本与最近媒体显式或软绑定。默认 Context Policy v1 每轮最多注入 3 个紧凑 artifact。

**记忆和知识。** 下一个 source candidate 以 `personal_memory` 作为统一的个人记忆入口：Python backend
组合本地 working/profile memory、免费的本地 FastEmbed 语义排序和 Ombre
长期关系语境。Ombre 是只读派生来源，不是技术事实或 Core 真源，也不再作为
独立 Hermes 工具暴露；生产在该 candidate apply 前仍保持历史工具面。`surface_relevant_context` 仍不代表自动检索整个 Vault；
长期写入、反思、夜间循环和知识维护留在 Python backend 与按需 skill 中。

**可发送媒体生成。** 统一 gateway 可调用 `media_generation` 生成微信可发送的图片或语音，并保留 `WECHAT_MEDIA` 标记供 Node bridge 消费。

**表情包目录。** `sticker_catalog` 在统一 profile 注册，用于按标签选择并通过 `RAN_MEDIA` 的 `stickerId` 发送本地表情包；保存入库只在 owner 明确要求时发生，资产留在 `.ran_agent_state/stickers/`。

---

## MCP 服务

| 服务 | 作用 | 默认入口 |
|------|------|----------|
| `search_hub` | 统一联网搜索入口：新闻、网页事实、学术检索、AI 热点、平台搜索路由 | unified |
| `co_reading` | 私有共享读书室：EPUB/TXT/Markdown/粘贴正文/HTML/URL/PDF 文本层导入、chunk 阅读、双语显示、进度、共享批注、Hermes 边栏回复、Vault 沉淀 | unified/Web |
| `time` | 时区感知时间查询，默认 `Asia/Shanghai` | unified |
| `media_reader` | OCR、ASR、VLM、视频分析、批量媒体分析 | unified |
| `social_reader` | B 站、小红书、微信公众号、音乐分享读取 | unified |
| `mimo_power` | RETIRED：历史 MiMo Token Plan 深度多模态分析，不属于当前 runtime profiles | historical |
| `sticker_catalog` | 本地表情包标签、选择、发送和 owner-only 入站保存 | unified |
| `personal_memory` | 个人记忆、Ombre 与受控 Vault 召回；backend 健康检查 | unified |
| `external_mcp_gateway` | 受治理的动态 External MCP broker | governed / source profiles disabled-by-default |
| `media_generation` | 图片和语音生成 | unified |
| `playwright` | 浏览器自动化和动态页面调试 | unified |
| `tavily` | 可选底层 provider，仅供 Search Hub 兼容使用 | 内部/兼容 |

DeepSeek V4 在本项目中按文本模型使用。原始图片、音频、视频和社交平台内容必须先交给 MCP 工具，Hermes 只接收结构化文本结果。

`co_reading` 另有可选 Tailscale 内网 Web reader：启用
`CO_READING_WEB_ENABLED=true` 后访问 `/reader`，HTTP API 位于
`/api/co-reading/*`。浏览器只使用 `CO_READING_WEB_ACCESS_TOKEN`；
`CO_READING_OWNER_TOKEN` 只留在服务器环境中。reader 支持原文 + 中文译文
双语显示，译文通过服务器端 provider 生成并缓存到本地，不把 provider
凭据交给浏览器。shared annotation 会自动邀请 Hermes 留下一条共读回应，
后续追问写入 `reading_threads`；用户可显式把 shared annotation 和 thread
沉淀到 `vault/inbox/co_reading/`。Hermes 默认只接收 quote、note、最近
thread 和批注附近上下文窗口，不接收整章正文。不要用公网 Funnel、WARP
全局模式或 B 站 SOCKS 代理暴露 reader。

---

## 快速开始

**前提：** Node.js >= 22，Python >= 3.10，ffmpeg，ffprobe，Hermes CLI >= 0.13.0。

```bash
git clone https://github.com/F-crystal/ran-agent.git
cd ran-agent

npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env.local
```

最少需要配置模型、Hermes gateway 和 Python backend 相关变量：

```bash
RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
NODE_BRIDGE_REPLY_BACKEND=hermes
HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_PROFILE=ran-agent-companion
PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
DEEPSEEK_API_KEY=...
```

开发机与生产都只需启动一个统一 gateway：

```bash
# 终端 1：Python backend
./start_python.sh

# 终端 2：Hermes gateway
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
export HERMES_HOME=/absolute/path/to/hermes-home
hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-agent-companion --force -y
hermes -p ran-agent-companion gateway run --replace --accept-hooks

# 终端 3：Node bridge
cd node_bridge
./start_node.sh
```

正式生产代码发布使用同一个已审核的 40 位 immutable SHA：

```bash
bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --dry-run
# 对同一 SHA 另行授权 apply 后：
bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --apply
```

Runtime 部署与回滚使用 `docs/governance/server_runtime_commands.md` 中的
exact-SHA unified controller。日常诊断使用：

```bash
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-hermes-tools.sh
```

`ran-agent-hermes.service` 是唯一生产 gateway；
`ran-agent-hermes-full.service` 仅保留为 inactive/disabled 的回滚状态。
不要手工修改 Hermes home 或 systemd/env；详细口径见
`docs/governance/server_runtime_commands.md`。

---

## 配置

所有密钥都放在本机 `.env.local`、`node_bridge/.env.local` 或机器本地 Hermes `.env`，不要提交。

| 模块 | 关键变量 | 说明 |
|------|----------|------|
| Hermes / DeepSeek | `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, `API_SERVER_KEY` | Hermes gateway 和模型 provider |
| Gateway routing | `HERMES_API_BASE_URL`, `HERMES_PROFILE` | 单一 companion profile 走统一 `8642` |
| Multi-frontend | `RAN_AGENT_DEFAULT_GLOBAL_USER_ID`, `RAN_AGENT_IDENTITY_MAP_PATH`, `RAN_AGENT_GLOBAL_TIMELINE_PATH` | 统一身份、跨平台 timeline |
| Timeline retention | `RAN_AGENT_TIMELINE_MAX_BYTES`, `RAN_AGENT_TIMELINE_MAX_TURNS`, `RAN_AGENT_TIMELINE_RETENTION_DAYS`, `RAN_AGENT_TIMELINE_COMPACT_ENABLED` | timeline 保留和压缩 |
| Feishu / Desktop | `FEISHU_BRIDGE_ENABLED`, `FEISHU_LARK_CLI_IDENTITY`, `DESKTOP_PROXY_ENABLED`, `DESKTOP_PROXY_PORT`, `DESKTOP_PROXY_API_KEY` | 多前端可选入口；开启 Desktop Proxy 时必须保持本机或内网受控 |
| AI 日报 | `AI_DAILY_DIGEST_ENABLED`, `AI_DAILY_DIGEST_HOUR`, `AI_DAILY_DIGEST_MINUTE` | 可选飞书私聊日报，默认关闭 |
| Python backend | `PYTHON_BACKEND_BASE_URL`, `PYTHON_BACKEND_INGEST_TIMEOUT_MS` | ingest 和记忆召回；MCP deadline 由服务端固定为 15 秒 |
| DashScope/Qwen | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | OCR/VLM/ASR 和媒体生成 |
| Knowledge agent runner | `PERSONAL_AGENT_KNOWLEDGE_AGENT_RUNNER`, `PERSONAL_AGENT_KNOWLEDGE_AGENT_COMMAND`, `PERSONAL_AGENT_KNOWLEDGE_AGENT_API_KEY_ENV`, `PERSONAL_AGENT_KNOWLEDGE_AGENT_TIMEOUT_SECONDS`, `PERSONAL_AGENT_KNOWLEDGE_BACKLOG_TRIGGER_COUNT`, `PERSONAL_AGENT_KNOWLEDGE_BACKLOG_TRIGGER_AGE_MINUTES` | provider-neutral vault 维护 runner；默认 Qwen-compatible，小步处理 inbox，默认超过 10 条或最老 120 分钟触发维护 |
| 社交平台 | `SESSDATA` | B 站认证可选；小红书为 public-only，不使用 `XHS_COOKIE` |
| 媒体上下文 | `RAN_AGENT_CONTEXT_POLICY`, `RAN_AGENT_MAX_MEDIA_ARTIFACTS` | 默认 compact，可回退 legacy |
| UV cache | `UV_CACHE_DIR`, `UV_TOOL_DIR`, `UV_LINK_MODE`, `UV_PYTHON_DOWNLOADS` | 固定 uv/uvx 缓存路径，防止磁盘膨胀 |
| XHS public parser | `XHS_GENERIC_FALLBACK_READY_PATH`, `XHS_PUBLIC_SIDECAR_URL`, `XHS_PUBLIC_SIDECAR_TIMEOUT_MS` | 小红书公开解析与 XHS-Downloader sidecar；不使用登录态 |

完整变量模板见 `.env.example`。服务器当前状态和最新部署口径见 `docs/governance/current_runtime_status.md`。

---

## 项目结构

```text
ran_agent/
├── hermes/                         # Hermes profile distribution
│   └── profile/                    # 单一 ran-agent-companion 配置
├── node_bridge/                    # 多前端 bridge、Hermes client、MCP facade
│   └── src/
│       ├── mediaReader/            # OCR、ASR、VLM、平台解析器、视频分析
│       ├── channelHub.mjs
│       ├── identityMap.mjs
│       ├── globalTimeline.mjs
│       ├── desktopProxyServer.mjs
│       ├── feishuBridge.mjs
│       ├── inboundMessageBuffer.mjs
│       ├── hermesGatewayClient.mjs
│       ├── mediaContextStore.mjs
│       ├── mediaReaderMcpServer.mjs
│       ├── socialReaderMcpServer.mjs
│       ├── stickerCatalogMcpServer.mjs
│       ├── coReading/
│       ├── mediaGenerationMcpServer.mjs
│       └── personalMemoryMcpServer.mjs
├── src/personal_agent/             # Python backend
│   ├── http_server.py
│   ├── service.py
│   ├── memory.py
│   ├── knowledge_agent.py
│   ├── scheduler.py
│   └── night_cycle.py
├── scripts/                        # MCP 启动器、诊断、部署辅助
├── skills/                         # 按需加载的项目技能
├── docs/governance/                # 当前运行时状态和治理口径
├── vault/                          # Obsidian vault 模板，不提交私有内容
└── local_archive/                  # 本地部署记录，忽略不入 Git
```

---

## 测试与诊断

```bash
PYTHONPATH=src pytest -q tests/
npm --prefix node_bridge test
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-multi-frontend.sh
bash scripts/compact-global-timeline.sh
bash scripts/diagnose-hermes-tools.sh
```

Hermes profile smoke：

```bash
hermes -p ran-agent-companion mcp list
hermes -p ran-agent-companion mcp test media_reader
HERMES_DEEPSEEK_THINKING_MODE=disabled hermes -p ran-agent-companion --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

---

## 文档入口

| 文档 | 内容 |
|------|------|
| `docs/governance/current_runtime_status.md` | 当前真实运行时主线 |
| `docs/governance/server_runtime_commands.md` | 脚本优先的服务器 runbook |
| `docs/governance/doc_status.md` | 公开文档索引和冲突规则 |
| `docs/governance/co-reading.md` | co_reading 存储、导入、MCP 和隐私边界 |
| `docs/governance/co-reading-web-reader.md` | Tailscale 内网 Web reader 部署和验收 |
| `docs/governance/multi_frontend_identity_strategy.md` | 多前端统一身份、timeline、session 策略 |
| `docs/governance/media-pipeline.md` | 微信媒体上下文和 Context Policy v1 |
| `docs/governance/phase_status.md` | Hermes 迁移和 OpenClaw 退休阶段状态 |
| `hermes/README.md` | Hermes profile distribution 中文说明 |
| `hermes/README_en.md` | Hermes profile distribution 英文说明 |

---

## 平台支持

| 平台 | 当前路径 | 认证 |
|------|----------|------|
| B 站 | `social_reader` + `media_reader`，字幕优先、ASR/关键帧兜底 | `SESSDATA` 可选 |
| 小红书 | `social_reader`，wanyi public parser + XHS-Downloader sidecar + HTML/OG 兜底；媒体交给 `media_reader` | 不支持登录态读取 |
| 微信公众号 | HTML 抓取、正文解析、验证码识别和结构化降级 | 通常无需登录 |
| 图片/音频/视频/文档 | `media_reader` | 本地可信路径或远程 URL |

---

## 安全与隐私

这是单用户个人系统。不要提交这些路径或内容：`.env.local`、`node_bridge/.env.local`、`.ran_agent_state/`、`data/`、`logs/`、`debug/`、`state/`、`local_archive/`、`vault/` 私有内容、Cookie、API key、代理 URL、平台登录态。

平台 resolver 凭据如 `SESSDATA` 和代理 URL 不能出现在日志、文档、工具输出或 Git 历史里；`XHS_COOKIE` 不属于当前 runtime 配置项。

---

## 许可证

PolyForm Noncommercial License 1.0.0。个人使用、研究和学习免费；商业使用需另行授权。详见 [LICENSE.md](LICENSE.md)。
