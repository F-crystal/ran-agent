<p align="right"><b>中文</b> | <a href="README_en.md">English</a></p>

# Hermes Profile Distribution

Status: CURRENT (2026-08-06)

`DEPLOYED_RUNTIME_ACCEPTANCE`（2026-08-06）：exact candidate `0b793e8` 已部署统一 Hermes v0.20 + DeepSeek V4 Flash；只有 `8642` gateway，旧 Full 服务 inactive/disabled。完整边界见 `docs/governance/current_runtime_status.md`。

unified-identity/O2 rollback 基线 `b5b4ff43f8c3d5706192cabefcece49408b73558` 已归档但尚未部署到生产；它保留 O2 并统一复用既有 runtime identity。O1/O2 候选仍未部署，Gate 5 未授权。

本目录是 ran-agent 的仓库内 Hermes profile distribution。它只保存可提交的 profile、人格文件、MCP 启动配置和技能说明；不保存 secrets、会话、记忆、日志、机器本地状态或平台登录态。

---

## 当前定位

- Hermes 是 ran-agent 的前台对话 shell。
- 当前统一生产 profile 使用 `deepseek-v4-flash`，provider policy
  在最终 HTTP body 显式加入 `thinking.type=disabled`；Pro 仅显式 opt-in。
- DeepSeek V4 在本项目中按文本模型使用，原始图片、音频、视频和社交平台内容必须先由 MCP 工具处理。
- Node bridge 的旧 lite/full 选择器都指向同一个 `8642` gateway；微信、飞书/Lark 和桌面 Proxy 都先进入 ChannelHub，再由统一主链路调用 Hermes。
- OpenClaw、Kimi、GLM 前台路线已经退休，不再作为运行时、部署目标或调试权威。

---

## 目录内容

| 文件或目录 | 作用 |
|------------|------|
| `profile/config.yaml` | `ran-assistant` full profile，包含完整 MCP 工具面 |
| `profile/config.lite.yaml` | `ran-assistant-lite` lite profile，低上下文日常入口 |
| `profile/config.pro.template.yaml` | Pro 模型显式模板 |
| `profile/distribution.yaml` | profile 元数据和所需环境变量说明 |
| `profile/AGENTS.md` | Hermes 运行时约束 |
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
| 服务器生产 | `/opt/ran_agent` | `/home/ubuntu/.hermes-ran-agent` |
| 服务器 lite | `/opt/ran_agent` | `/home/ubuntu/.hermes-ran-agent/lite` |

机器本地 Hermes home 才能保存 `.env`、sessions、logs、memories、cron 等运行态文件。不要把这些内容复制回仓库。

---

## 安装 Profile

本地验证不要切换全局 sticky profile。直接安装到临时或项目专用 `HERMES_HOME`：

```bash
export RAN_AGENT_REPO_ROOT=/Users/fengran/ran_agent
export HERMES_HOME=/private/tmp/ran-agent-hermes-home

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

服务器生产使用服务器路径：

```bash
export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

不要在验证过程中运行 `hermes profile use ran-assistant`。生产机器应由 systemd 或显式环境变量指定 profile 与 Hermes home。

---

## 统一 Hermes Gateway

生产部署只有一个 Hermes v0.20 gateway：

| 服务 | 端口 | Profile | Hermes home | 用途 |
|------|------|---------|-------------|------|
| `ran-agent-hermes.service` | `8642` | `ran-assistant-lite` 兼容 ID | `/home/ubuntu/.hermes-ran-agent/lite` | 旧 Lite/Full 能力并集 |

Node bridge 通过以下变量自动路由：

```bash
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8642/v1
RAN_AGENT_CAPABILITY_MODE=auto
HERMES_LITE_PROFILE=ran-assistant-lite
HERMES_FULL_PROFILE=ran-assistant-lite
```

terminal、file、session search、Playwright、媒体生成和既有 MCP 均由统一
profile 提供；`ran-agent-hermes-full.service` inactive/disabled，不是 fallback。

生产部署、profile 刷新与回滚按运行手册执行；诊断可运行：

```bash
bash scripts/diagnose-lite-full.sh
```

不要手工修改 systemd/env 作为常规路径。详细命令见 `docs/governance/server_runtime_commands.md`。

---

## MCP 工具边界

`profile/config.yaml` 和 `profile/config.lite.yaml` 都禁用 Hermes 内置媒体工具：

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
| `mimo_power` | 已退役：历史 MiMo Token Plan 深度多模态分析，不属于当前 runtime profiles |
| `personal_memory` | Python backend 个人记忆召回 |
| `obsidian_memory` | Optional Obsidian vault 语义检索；已注册但当前未 runtime-ready |
| `ombre_memory` | O1 候选的本地 recall-only 入口；不向 Hermes 暴露上游 registry |
| `media_generation` | 图片和语音生成，统一 profile 可用 |
| `playwright` | 浏览器自动化，统一 profile 可用 |
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
| `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | DashScope/Qwen 视觉、ASR、媒体生成 |
| `TAVILY_API_KEY` | Search Hub 的可选 Tavily provider |
| `SESSDATA` | B 站平台认证可选；小红书读取为 public-only，不配置 `XHS_COOKIE` |
| `CO_READING_ROOT_DIR`, `CO_READING_OWNER_TOKEN` | co_reading 本地状态目录和 owner-only 写入鉴权 |
| `CO_READING_WEB_ENABLED`, `CO_READING_WEB_ACCESS_TOKEN` | 可选 Tailscale Web reader 开关和浏览器访问 token |
| `CO_READING_ASK_CONTEXT_CHARS`, `CO_READING_ASK_THREAD_LIMIT` | Hermes 共读边注的上下文窗口和 thread 数量上限 |
| `CO_READING_VAULT_DIR` | shared annotation 显式沉淀到 Vault 的目标目录 |
| `OBSIDIAN_MEMORY_VAULT_DIR` | Obsidian vault 路径 |
| `OBSIDIAN_MEMORY_INDEX_PATH` | Obsidian semantic index DuckDB 路径 |
| `OBSIDIAN_INDEX_DEVICE` | Linux 服务器默认 `cpu` |
| `OBSIDIAN_MEMORY_REINDEX`, `OBSIDIAN_MEMORY_WATCH` | 只在显式维护时设为 `1` |
| `OMBRE_BRAIN_ENABLED`, `OMBRE_BRAIN_MCP_ENABLED` | 内部 Ombre Brain 服务开关；不授权 Hermes 直连 |
| `OMBRE_BRAIN_RUNNER` | O1 固定为 pinned `source`；`docker`、`external` 和未知 runner 均 fail-closed |
| `OMBRE_BRAIN_REPO_URL` | Ombre Brain canonical upstream，默认 `https://github.com/P0luz/Ombre-Brain` |
| `OMBRE_BRAIN_HOME`, `OMBRE_BRAIN_SOURCE_DIR`, `OMBRE_BRAIN_VENV`, `OMBRE_BUCKETS_DIR` | Ombre Brain runtime、source checkout、venv 和私有 buckets 路径 |
| `OMBRE_BIND_HOST`, `OMBRE_MCP_REQUIRE_AUTH`, `OMBRE_BRAIN_MCP_URL` | 内部上游的 loopback-only 网络契约；O1 未实现网络认证，故仅允许 `127.0.0.1` 与 `false` |
| `OMBRE_RECALL_MCP_URL` | Hermes/Python 使用的本地 recall-only 端点 |
| `PERSONAL_AGENT_OMBRE_BACKEND` | Python `personal_memory` 底层 Ombre 后端，O1 候选固定为 `recall_only` |

Secrets 必须放在机器本地 `.env`，例如：

```text
/home/ubuntu/.hermes-ran-agent/.env
/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
/home/ubuntu/.hermes-ran-agent/lite/.env
```

不要把 `DEEPSEEK_API_KEY`、`HERMES_API_KEY`、平台 Cookie、代理 URL 或登录态写入本仓库。

---

## Obsidian Memory MCP

`obsidian_memory` 设计为使用 `obsidian-index` 语义检索。当前生产继承的 uv tool 是畸形半安装，因此 surface 虽已注册但未 runtime-ready；补齐 Torch/Transformers 依赖前必须先做空间受限的独立安装计划。

服务器推荐值：

```bash
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/home/ubuntu/.hermes-ran-agent/hf-home
export TRANSFORMERS_CACHE=/home/ubuntu/.hermes-ran-agent/hf-home
export SENTENCE_TRANSFORMERS_HOME=/home/ubuntu/.hermes-ran-agent/sentence-transformers
export OBSIDIAN_MEMORY_VAULT_DIR=/opt/ran_agent/vault
export OBSIDIAN_MEMORY_INDEX_PATH=/opt/ran_agent/data/obsidian-memory-index.duckdb
export OBSIDIAN_INDEX_DEVICE=cpu
export OBSIDIAN_MEMORY_REINDEX=0
export OBSIDIAN_MEMORY_WATCH=0
```

`OBSIDIAN_MEMORY_INDEX_PATH` 是单写 DuckDB 文件。不要让多个 `obsidian_memory` MCP 实例同时写同一个数据库。

---

## 常用命令

```bash
hermes --help
hermes profile --help
hermes profile show ran-assistant
hermes -p ran-assistant mcp list
hermes -p ran-assistant mcp test media_reader
HERMES_DEEPSEEK_THINKING_MODE=disabled hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

前台启动 gateway：

```bash
hermes -p ran-assistant gateway run --replace --accept-hooks
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
