<p align="right"><b>中文</b> | <a href="README_en.md">English</a></p>

# Ran Agent

Status: CURRENT (2026-05-17)

**一个本地优先的个人 AI 助手运行时：微信、飞书/Lark 和桌面 OpenAI-compatible Proxy 统一进入 ChannelHub，Hermes 负责对话，Node bridge 负责多前端接入，Python 后端负责记忆、知识和调度，媒体与社交平台理解通过 MCP 工具完成。**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent 是一个个人 Agent 运行时，不是 SaaS。它把微信、飞书/Lark 和桌面客户端消息统一接入 ChannelHub，再经 Hermes Gateway 用 DeepSeek V4 Flash 生成回复；同时通过 `media_reader`、`social_reader`、`mimo_power`、`personal_memory`、`obsidian_memory` 等 MCP 工具读取媒体、社交内容、个人记忆和知识库。状态、日志、Vault、Cookie 和密钥都留在你控制的机器上。

OpenClaw、Kimi 和 GLM 前台路线已经退休；当前前台主线只有 Hermes + DeepSeek V4 Flash。

---

## 当前主线

```text
WeChat / Feishu / Desktop Proxy
  -> ChannelHub
  -> replyBackend
  -> Hermes gateway lite/full
  -> DeepSeek V4 Flash
  -> reply

IdentityMap + GlobalTimeline
  -> global_user_id=user:ran
  -> shared Hermes session_key, platform-specific session_id
  -> local recent history + cross-platform active topic

Python backend
  -> ingest / memory / knowledge / reflection / scheduler / reminders

MCP services
  -> search_hub / media_reader / social_reader / mimo_power / media_generation
  -> personal_memory / obsidian_memory / time / playwright
```

### Lite / Full Gateway

生产部署使用两个 Hermes gateway，由 Node bridge 按请求自动选择：

| Gateway | 端口 | Profile | 用途 |
|---------|------|---------|------|
| lite | `8642` | `ran-assistant-lite` | 日常聊天、小红书、记忆、图片理解 |
| full | `8643` | `ran-assistant` | 调试、命令、日志、Playwright、媒体生成 |

`8642` 是低上下文入口，不是安全沙箱。full 不可用时，Node bridge 会回退到 lite 并记录原因。

---

## 能做什么

**多前端统一入口。** 微信、飞书/Lark 和桌面 OpenAI-compatible Proxy 都进入 `node_bridge/src/channelHub.mjs`，再走同一个 `replyBackend -> hermesGatewayClient -> Hermes` 主链路。`IdentityMap` 在单用户模式下把所有前端映射到 `user:ran`，`GlobalTimeline` 记录跨平台 turn，Hermes `session_key` 跨前端共享，平台级 `session_id` 保持隔离。

**微信对话入口。** 微信消息进入 `node_bridge/src/wechatBridge.mjs`，经入站聚合、ChannelHub、媒体上下文处理、Hermes Gateway、DeepSeek V4 Flash 后回到微信。Python 后端会异步接收 `/ingest`，维护近期记忆和后续任务。

**飞书和桌面入口。** 飞书桥接通过 `lark-cli event consume im.message.receive_v1 --as bot` 消费消息，并通过 `im +messages-send` 回复；桌面客户端通过 ran-agent 自己的 OpenAI-compatible Proxy 接入，避免绕过统一记忆和 reviewer。

**联网搜索入口。** `search_hub` 是 Hermes 前台统一搜索入口，负责最新信息、新闻、普通网页事实、学术检索和平台搜索路由。它同时注册到 lite/full；lite 使用 Tavily、AIHOT、OpenCLI public-only、OpenAlex/arxiv/pubmed 等轻量 provider，full 允许 OpenCLI browser-backed adapter 和 Playwright fallback。不要让 Hermes 日常搜索直接面对 Tavily/OpenCLI/Playwright。

**社交媒体读取。** `social_reader` 负责 B 站、小红书、微信公众号、音乐分享等链接。社交平台“链接读取”仍优先 `social_reader`，不会被 `search_hub` 抢路。小红书优先使用通用解析 fallback，搜索上下文会缓存 `read_ref`，避免把平台 token 暴露给模型或日志。

**多模态理解。** 微信图片、音频、视频和文档先经过可信路径校验，再由 MiMo Power 优先分析，失败时回退到 `media_reader`。视频采用字幕优先策略：字幕、音频 ASR、关键帧 VLM、元数据逐级降级。

**媒体上下文追问。** 入站媒体会生成会话级 artifact。用户说“刚才那张图”“用 mimo 看一下”时，入站消息缓冲会把文本与最近媒体显式或软绑定。默认 Context Policy v1 每轮最多注入 3 个紧凑 artifact。

**记忆和知识。** `personal_memory` 通过 Python backend 召回个人记忆；`obsidian_memory` 通过 Obsidian vault 语义索引检索知识。长期写入、反思、夜间循环和知识维护留在 Python 后端和按需 skill 中，不常驻主 prompt。

**可发送媒体生成。** full gateway 可调用 `media_generation` 生成微信可发送的图片或语音，并保留 `WECHAT_MEDIA` 标记供 Node bridge 消费。

---

## MCP 服务

| 服务 | 作用 | 默认入口 |
|------|------|----------|
| `search_hub` | 统一联网搜索入口：新闻、网页事实、学术检索、AI 热点、平台搜索路由 | lite/full |
| `time` | 时区感知时间查询，默认 `Asia/Shanghai` | lite/full |
| `media_reader` | OCR、ASR、VLM、视频分析、批量媒体分析 | lite/full |
| `social_reader` | B 站、小红书、微信公众号、音乐分享读取 | lite/full |
| `mimo_power` | MiMo Token Plan 深度多模态分析 | lite/full |
| `personal_memory` | 个人记忆召回与 backend 健康检查 | lite/full |
| `obsidian_memory` | Obsidian vault 语义检索 | lite/full |
| `media_generation` | 图片和语音生成 | full |
| `playwright` | 浏览器自动化和动态页面调试 | full |
| `tavily` | 可选底层 provider，仅供 Search Hub 兼容使用 | 内部/兼容 |

DeepSeek V4 在本项目中按文本模型使用。原始图片、音频、视频和社交平台内容必须先交给 MCP 工具，Hermes 只接收结构化文本结果。

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
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1
RAN_AGENT_CAPABILITY_MODE=auto
PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
DEEPSEEK_API_KEY=...
```

开发机可只启动一个 full gateway；生产口径建议同时启动 lite/full：

```bash
# 终端 1：Python backend
./start_python.sh

# 终端 2：Hermes gateway
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
export HERMES_HOME=/absolute/path/to/hermes-home
hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant gateway run --replace --accept-hooks

# 终端 3：Node bridge
cd node_bridge
./start_node.sh
```

生产 systemd、双 gateway、Hermes env 同步和漂移修复统一使用：

```bash
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-hermes-tools.sh
```

Phase 11.1 后，`ran-agent-hermes.service` 主 unit 直接表示 lite gateway
（8642 / `ran-assistant-lite`），`ran-agent-hermes-full.service` 主 unit
直接表示 full gateway（8643 / `ran-assistant`）；不再依赖
`90-lite-runtime.conf` 覆盖旧 full 配置。不要手工修改
`/home/ubuntu/.hermes-ran-agent` 或 systemd/env 作为常规部署路径。Hermes
runtime 配置变更必须从 repo 源配置进入，再通过
`scripts/apply-hermes-runtime-split.sh` 应用；详细口径见
`docs/governance/server_runtime_commands.md`。

---

## 配置

所有密钥都放在本机 `.env.local`、`node_bridge/.env.local` 或机器本地 Hermes `.env`，不要提交。

| 模块 | 关键变量 | 说明 |
|------|----------|------|
| Hermes / DeepSeek | `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, `API_SERVER_KEY` | Hermes gateway 和模型 provider |
| Gateway routing | `HERMES_LITE_API_BASE_URL`, `HERMES_FULL_API_BASE_URL`, `RAN_AGENT_CAPABILITY_MODE` | Node bridge 自动选择 lite/full |
| Multi-frontend | `RAN_AGENT_DEFAULT_GLOBAL_USER_ID`, `RAN_AGENT_IDENTITY_MAP_PATH`, `RAN_AGENT_GLOBAL_TIMELINE_PATH` | 统一身份、跨平台 timeline |
| Timeline retention | `RAN_AGENT_TIMELINE_MAX_BYTES`, `RAN_AGENT_TIMELINE_MAX_TURNS`, `RAN_AGENT_TIMELINE_RETENTION_DAYS`, `RAN_AGENT_TIMELINE_COMPACT_ENABLED` | timeline 保留和压缩 |
| Feishu / Desktop | `FEISHU_BRIDGE_ENABLED`, `FEISHU_LARK_CLI_IDENTITY`, `DESKTOP_PROXY_ENABLED`, `DESKTOP_PROXY_PORT` | 多前端可选入口 |
| Python backend | `PYTHON_BACKEND_BASE_URL`, `PYTHON_BACKEND_INGEST_TIMEOUT_MS`, `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS` | ingest 和记忆召回 |
| MiMo | `MIMO_TOKEN_PLAN_API_KEY`, `MIMO_POWER_*` | 深度多模态分析 |
| DashScope/Qwen | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | OCR/VLM/ASR 和媒体生成 |
| 社交平台 | `XHS_COOKIE`, `SESSDATA` | 小红书、B 站等平台认证 |
| Obsidian memory | `OBSIDIAN_MEMORY_VAULT_DIR`, `OBSIDIAN_MEMORY_INDEX_PATH`, `OBSIDIAN_INDEX_DEVICE` | Vault 检索与索引 |
| 媒体上下文 | `RAN_AGENT_CONTEXT_POLICY`, `RAN_AGENT_MAX_MEDIA_ARTIFACTS` | 默认 compact，可回退 legacy |

完整变量模板见 `.env.example`。服务器当前状态和最新部署口径见 `docs/governance/current_runtime_status.md`。

---

## 项目结构

```text
ran_agent/
├── hermes/                         # Hermes profile distribution
│   └── profile/                    # ran-assistant / ran-assistant-lite 配置
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
│       ├── mimoPowerMcpServer.mjs
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
hermes -p ran-assistant mcp list
hermes -p ran-assistant mcp test media_reader
hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

---

## 文档入口

| 文档 | 内容 |
|------|------|
| `docs/governance/current_runtime_status.md` | 当前真实运行时主线 |
| `docs/governance/server_runtime_commands.md` | 服务器 runbook 和恢复命令 |
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
| 小红书 | `social_reader`，generic parser fallback + token-aware compatibility path | `XHS_COOKIE` 可选但常用 |
| 微信公众号 | HTML 抓取、正文解析、验证码识别和结构化降级 | 通常无需登录 |
| 图片/音频/视频/文档 | `mimo_power` 优先，`media_reader` 兜底 | 本地可信路径或远程 URL |

---

## 安全与隐私

这是单用户个人系统。不要提交这些路径或内容：`.env.local`、`node_bridge/.env.local`、`.ran_agent_state/`、`data/`、`logs/`、`debug/`、`state/`、`local_archive/`、`vault/` 私有内容、Cookie、API key、代理 URL、平台登录态。

平台 resolver 凭据如 `SESSDATA`、`XHS_COOKIE` 和代理 URL 也不能出现在日志、文档、工具输出或 Git 历史里。

---

## 许可证

PolyForm Noncommercial License 1.0.0。个人使用、研究和学习免费；商业使用需另行授权。详见 [LICENSE.md](LICENSE.md)。
