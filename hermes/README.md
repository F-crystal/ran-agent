<p align="right"><b>中文</b> | <a href="README_en.md">English</a></p>

# Hermes Profile Distribution

Status: CURRENT (2026-08-20)

生产运行统一 Hermes v0.20 + DeepSeek V4 Flash；只有 `8642` gateway，旧 Full
服务 inactive/disabled，不能作为 fallback。完整边界见
`docs/governance/current_runtime_status.md`。

历史迁移和已退休组件只在治理记录中保留。现役记忆路径是
`personal_memory → Python/Core → Ombre 18001`：公开召回只读，稳定后端负责受控投影。

本目录是 ran-agent 的仓库内 Hermes profile distribution。它只保存可提交的 profile、人格文件、MCP 启动配置和技能说明；不保存 secrets、会话、记忆、日志、机器本地状态或平台登录态。

---

## 当前定位

- Hermes 是 ran-agent 的聊天、情绪陪伴和游玩 shell；工作效果由 Codex 负责。
- 当前统一生产 profile 使用 `deepseek-v4-flash`，provider policy
  在最终 HTTP body 显式加入 `thinking.type=disabled`；Pro 仅显式 opt-in。
- DeepSeek V4 在本项目中按文本模型使用，原始图片、音频、视频和社交平台内容必须先由 MCP 工具处理。
- 当前 source candidate 只使用一个 `8642` gateway 和一个 companion profile；微信、飞书/Lark、桌面 Proxy 与默认关闭的 owner-only Telegram 文本入口都先进入 ChannelHub，再由统一主链路调用 Hermes。Telegram 不增加 Hermes profile 能力或媒体面。
- OpenClaw、Kimi、GLM 前台路线已经退休，不再作为运行时、部署目标或调试权威。

---

## 目录内容

| 文件或目录 | 作用 |
|------------|------|
| `profile/config.companion.yaml` | 当前 `ran-agent-companion` 活动源码 profile，仅暴露聊天/陪伴/游玩所需能力 |
| `profile/distribution.yaml` | profile 元数据和所需环境变量说明 |
| `profile/AGENTS.md` | 初始密封 Runtime 的 profile 约束参考；源码前进的产品边界见 `docs/governance/hermes-playground-boundary.md` |
| `profile/IDENTITY.md`, `profile/SOUL.md` | 人格和长期表达基线 |
| `profile/HERMES_*.md` | 迁移后的 Hermes 预算参考文件，仓库参考用 |
| `profile/skills/` | Hermes 内部按需技能 |

---

## 路径约定

不要把本地 checkout 绝对路径写死到可提交运行文件里。用环境变量传入路径：

```bash
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
export HERMES_HOME=/absolute/path/to/hermes-home
```

推荐约定：

| 场景 | Repo root | Hermes home |
|------|-----------|-------------|
| 本地验证 | `/Users/fengran/ran_agent` | `/private/tmp/ran-agent-hermes-home` 或其他临时目录 |
| 服务器生产 | `/opt/ran_agent` | `/home/ubuntu/.hermes-ran-agent/lite`（沿用物理目录，不代表 Lite 产品模式） |

机器本地 Hermes home 才能保存 `.env`、sessions、logs、memories、cron 等运行态文件。不要把这些内容复制回仓库。

---

## 安装 Profile

本地验证不要切换全局 sticky profile。直接安装到临时或项目专用 `HERMES_HOME`：

```bash
export RAN_AGENT_REPO_ROOT=/Users/fengran/ran_agent
export HERMES_HOME=/private/tmp/ran-agent-hermes-home

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-agent-companion --force -y
hermes -p ran-agent-companion mcp list
```

服务器生产使用服务器路径：

```bash
export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent/lite

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-agent-companion --force -y
hermes -p ran-agent-companion mcp list
```

不要在验证过程中运行 `hermes profile use ran-agent-companion`。生产机器应由 systemd 或显式环境变量指定 profile 与 Hermes home。

---

## 统一 Hermes Gateway

生产部署只有一个 Hermes v0.20 gateway：

| 服务 | 端口 | Profile | Hermes home | 用途 |
|------|------|---------|-------------|------|
| `ran-agent-hermes.service` | `8642` | `ran-agent-companion` | `/home/ubuntu/.hermes-ran-agent/lite` | 聊天、陪伴、记忆、媒体、搜索与外部 MCP 游玩 |

Node bridge 只消费以下前台变量：

```bash
HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_PROFILE=ran-agent-companion
```

terminal、file、session search 和直接 Playwright 不再由当前源码 profile
暴露；媒体生成、搜索和受治理 MCP 仍由统一 profile 提供。
`ran-agent-hermes-full.service` inactive/disabled，不是 fallback。

生产部署、profile 刷新与回滚按运行手册执行；诊断可运行：

```bash
bash scripts/diagnose-lite-full.sh
```

不要手工修改 systemd/env 作为常规路径。详细命令见 `docs/governance/server_runtime_commands.md`。

---

## MCP 工具边界

`profile/config.companion.yaml` 禁用 Hermes 内置媒体工具：

```yaml
disabled_tools:
  - browser_vision
  - image_generate
  - text_to_speech
  - video_analyze
  - vision_analyze
```

ran-agent 使用仓库内 MCP 服务：

| MCP | 作用 |
|-----|------|
| `search_hub` | 统一联网搜索入口：新闻、网页事实、学术检索、AI 热点、平台搜索路由 |
| `co_reading` | 私有共享读书室：chunk 阅读、进度、shared annotation、Hermes 共读边注 |
| `time` | `Asia/Shanghai` 时间查询 |
| `media_reader` | OCR、ASR、VLM、视频分析、批量媒体分析 |
| `social_reader` | B 站、小红书、微信公众号、音乐分享 |
| `personal_memory` | Python backend 的统一个人记忆入口，内部组合本地 memory、只读 Ombre 与受控 Vault 召回 |
| `external_mcp_gateway` | 默认可用的受治理外部 MCP broker；registry、grant、budget 与 confirmation 仍强制执行 |
| `media_generation` | 图片和语音生成，统一 profile 可用 |
| `tavily` | 可选底层网页搜索 provider，仅供 Search Hub 兼容使用 |

最新网页事实、新闻、学术检索和普通 URL 读取优先走 `search_hub`。社交平台链接必须走 `social_reader`；不要用普通网页抽取工具替代小红书、B 站等平台解析器。

---

## 必需和常用环境变量

| 变量 | 作用 |
|------|------|
| `RAN_AGENT_REPO_ROOT` | ran-agent checkout 绝对路径 |
| `DEEPSEEK_API_KEY` | Hermes DeepSeek provider key |
| `API_SERVER_KEY`, `HERMES_API_KEY` | Hermes gateway 与 Node bridge API 鉴权 |
| `PYTHON_BACKEND_BASE_URL` | Python backend，默认 `http://127.0.0.1:8787` |
| `DASHSCOPE_API_KEY`, `QWEN_API_KEY`, `DASHSCOPE_COMPAT_BASE_URL` | DashScope/Qwen 视觉、ASR、媒体生成及兼容接口地址 |
| `TOKEN_PLAN_API_KEY`, `TOKEN_PLAN_BASE_URL`, `QWEN_MM_API_VL_MODEL` | 可选 Qwen-MM OCR/VLM；使用 `qwen3.6-flash`，不接管 ASR |
| `TAVILY_API_KEY` | Search Hub 的可选 Tavily provider |
| `SESSDATA` | B 站平台认证可选；小红书读取为 public-only，不配置 `XHS_COOKIE` |
| `CO_READING_ROOT_DIR`, `CO_READING_OWNER_TOKEN` | co_reading 本地状态目录和 owner-only 写入鉴权 |
| `CO_READING_WEB_ENABLED`, `CO_READING_WEB_ACCESS_TOKEN` | 可选 Tailscale Web reader 开关和浏览器访问 token |
| `CO_READING_ASK_CONTEXT_CHARS`, `CO_READING_ASK_THREAD_LIMIT` | Hermes 共读边注的上下文窗口和 thread 数量上限 |
| `CO_READING_VAULT_DIR` | shared annotation 显式沉淀到 Vault 的目标目录 |
| `OMBRE_BRAIN_ENABLED`, `OMBRE_BRAIN_MCP_ENABLED` | 内部 Ombre Brain 服务开关；不授权 Hermes 直连 |
| `OMBRE_BRAIN_RUNNER` | Ombre Brain runner；生产使用 pinned `source` |
| `OMBRE_BRAIN_REPO_URL` | Ombre Brain canonical upstream，默认 `https://github.com/P0luz/Ombre-Brain` |
| `OMBRE_BRAIN_HOME`, `OMBRE_BRAIN_SOURCE_DIR`, `OMBRE_BRAIN_VENV`, `OMBRE_BUCKETS_DIR` | Ombre Brain runtime、source checkout、venv 和私有 buckets 路径 |
| `OMBRE_BIND_HOST`, `OMBRE_MCP_REQUIRE_AUTH`, `OMBRE_BRAIN_MCP_URL` | Python `personal_memory` 使用的 loopback-only Ombre 只读端点 |
| `PERSONAL_AGENT_VECTOR_MEMORY_ENABLED` | 本地 FastEmbed + HNSW 语义排序开关；运行时不联网 |

Secrets 必须放在机器本地 `.env`，例如：

```text
/home/ubuntu/.hermes-ran-agent/.env
/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-agent-companion/.env
/home/ubuntu/.hermes-ran-agent/lite/.env
```

不要把 `DEEPSEEK_API_KEY`、`HERMES_API_KEY`、平台 Cookie、代理 URL 或登录态写入本仓库。

---

## 常用命令

```bash
hermes --help
hermes profile --help
hermes profile show ran-agent-companion
hermes -p ran-agent-companion mcp list
hermes -p ran-agent-companion mcp test media_reader
HERMES_DEEPSEEK_THINKING_MODE=disabled hermes -p ran-agent-companion --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

前台启动 gateway：

```bash
hermes -p ran-agent-companion gateway run --replace --accept-hooks
```

诊断：

```bash
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-ombre-memory.sh
```

服务器完整 runbook 见 `docs/governance/server_runtime_commands.md`。

---

## 安全边界

- 本目录可提交，但只应包含 profile distribution。
- 不提交 Hermes home、`.env`、sessions、memories、logs、cron、平台登录态。
- 不在文档、日志或工具输出里打印 API key、Cookie、token、代理 URL。
- Hermes 是前台人格 shell；Node bridge、媒体 artifact、MCP 工具、Python backend、memory、vault、night cycle 和 persona evolution 仍是独立运行资产。
