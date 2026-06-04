<p align="right"><a href="README.md">中文</a> | <b>English</b></p>

# Ran Agent

Status: CURRENT (2026-05-28)

**A local-first personal AI agent runtime: WeChat, Feishu/Lark, and the desktop OpenAI-compatible proxy all enter ChannelHub; Hermes handles conversation, Node bridge handles multi-frontend transport, the Python backend owns memory, knowledge, and scheduling, and MCP tools handle media and social-platform understanding.**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent is a personal runtime, not a SaaS product. It routes WeChat, Feishu/Lark, and desktop-client messages into ChannelHub, replies through Hermes Gateway with DeepSeek V4 Flash, and uses MCP tools such as `media_reader`, `social_reader`, `mimo_power`, `personal_memory`, and `obsidian_memory` for media, social content, personal memory, and vault retrieval. State, logs, vault content, cookies, and secrets stay on infrastructure you control.

OpenClaw, Kimi, and GLM are retired as frontend paths. The current frontend mainline is Hermes + DeepSeek V4 Flash.

---

## Current Mainline

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

Production uses two Hermes gateway instances. Node bridge selects the gateway per request:

| Gateway | Port | Profile | Purpose |
|---------|------|---------|---------|
| lite | `8642` | `ran-assistant-lite` | Daily chat, Xiaohongshu, memory, image understanding |
| full | `8643` | `ran-assistant` | Debugging, commands, logs, Playwright, media generation |

`8642` is a low-context entry, not a security sandbox. If full is unavailable, Node bridge falls back to lite and logs the reason.

---

## What It Does

**Unified multi-frontend entry.** WeChat, Feishu/Lark, and the desktop OpenAI-compatible proxy all enter `node_bridge/src/channelHub.mjs`, then use the same `replyBackend -> hermesGatewayClient -> Hermes` mainline. In single-user mode, `IdentityMap` maps every frontend to `user:ran`; `GlobalTimeline` records cross-platform turns; Hermes `session_key` is shared across frontends while platform-specific `session_id` remains isolated.

**WeChat conversation entry.** Messages enter `node_bridge/src/wechatBridge.mjs`, pass through inbound aggregation, ChannelHub, media context handling, Hermes Gateway, and DeepSeek V4 Flash, then return to WeChat. The Python backend receives `/ingest` asynchronously for recent memory and downstream tasks.

**Feishu and desktop entries.** Feishu bridge consumes messages with `lark-cli event consume im.message.receive_v1 --as bot` and replies through `im +messages-send`; desktop clients connect to ran-agent's own OpenAI-compatible proxy so they do not bypass unified memory and reviewer.

**Daily AI digest.** Optionally enable `AI_DAILY_DIGEST_ENABLED=true`; the Python scheduler fetches AIHOT facts at 10:00, sends a synthetic Feishu DM turn through `ChannelHub -> Hermes`, lets Hermes write the short digest, and delivers it through the existing Feishu reply path. This does not re-enable old proactive check-ins, reminders, or life-loop outbound messages.

**Online search entry.** `search_hub` is the unified Hermes frontend entry for fresh facts, news, normal web facts, academic lookup, and platform-search routing. It is registered in both lite and full; lite uses lightweight providers such as Tavily, AIHOT, OpenCLI public-only, OpenAlex/arxiv/pubmed, while full may use Playwright fallback. OpenCLI browser-backed mode is disabled by default for the 2C4G/60G server and remains an optional Phase 11.2 enhancement. Do not let daily Hermes searches call Tavily, OpenCLI, or Playwright directly.

**Social media reading.** `social_reader` handles Bilibili, Xiaohongshu, WeChat articles, music shares, and related social links. Xiaohongshu uses the generic parser fallback as the primary read path, while search context stores `read_ref` handles without exposing platform tokens to the model or logs.

**Multimodal understanding.** WeChat images, audio, video, and documents first pass trusted-path validation. MiMo Power analyzes them first; `media_reader` is the fallback. Video analysis is subtitle-first: subtitles, audio ASR, keyframe VLM, then metadata fallback.

**Media follow-up context.** Inbound media becomes conversation-scoped artifacts. When the user says “that image from earlier” or “use MiMo to look at it,” the inbound message buffer binds the text to recent media explicitly or as a soft candidate. Context Policy v1 injects at most 3 compact artifacts per turn by default.

**Memory and knowledge.** `personal_memory` recalls personal memory through the Python backend. `obsidian_memory` searches the Obsidian vault through a semantic index. Long-term writes, reflection, night-cycle work, and knowledge maintenance stay in the Python backend and on-demand skills instead of always living in the main prompt.

**Sendable media generation.** The full gateway can call `media_generation` to generate images or speech for WeChat and preserve `WECHAT_MEDIA` markers for Node bridge delivery.

---

## MCP Services

| Service | Purpose | Default Entry |
|---------|---------|---------------|
| `search_hub` | Unified fresh web search entry: news, web facts, academic lookup, AI hot topics, platform-search routing | lite/full |
| `time` | Timezone-aware time queries, default `Asia/Shanghai` | lite/full |
| `media_reader` | OCR, ASR, VLM, video analysis, batch media analysis | lite/full |
| `social_reader` | Bilibili, Xiaohongshu, WeChat articles, music shares | lite/full |
| `mimo_power` | Deep multimodal analysis through MiMo Token Plan | lite/full |
| `personal_memory` | Personal memory recall and backend health check | lite/full |
| `obsidian_memory` | Obsidian vault semantic search | lite/full |
| `media_generation` | Image and speech generation | full |
| `playwright` | Browser automation and dynamic-page debugging | full |
| `tavily` | Optional lower-level provider, used only for Search Hub compatibility | internal/compat |

DeepSeek V4 is treated as a text model in this project. Raw images, audio, video, and social-platform content must go through MCP tools first. Hermes receives structured text results.

---

## Quick Start

**Prerequisites:** Node.js >= 22, Python >= 3.10, ffmpeg, ffprobe, Hermes CLI >= 0.13.0.

```bash
git clone https://github.com/F-crystal/ran-agent.git
cd ran-agent

npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env.local
```

At minimum, configure the model, Hermes gateway, and Python backend variables:

```bash
RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
NODE_BRIDGE_REPLY_BACKEND=hermes
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1
RAN_AGENT_CAPABILITY_MODE=auto
PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
DEEPSEEK_API_KEY=...
```

For local development, a single full gateway is enough. Production should run lite and full:

```bash
# Terminal 1: Python backend
./start_python.sh

# Terminal 2: Hermes gateway
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
export HERMES_HOME=/absolute/path/to/hermes-home
hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant gateway run --replace --accept-hooks

# Terminal 3: Node bridge
cd node_bridge
./start_node.sh
```

Production systemd, dual gateway setup, Hermes env sync, and drift repair use:

```bash
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-hermes-tools.sh
```

Do not hand-edit systemd/env as the normal deployment path. See `docs/governance/server_runtime_commands.md` for the detailed runtime contract.

---

## Configuration

All secrets live in local `.env.local`, `node_bridge/.env.local`, or machine-local Hermes `.env` files. Do not commit them.

| Module | Key Variables | Notes |
|--------|---------------|-------|
| Hermes / DeepSeek | `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, `API_SERVER_KEY` | Hermes gateway and model provider |
| Gateway routing | `HERMES_LITE_API_BASE_URL`, `HERMES_FULL_API_BASE_URL`, `RAN_AGENT_CAPABILITY_MODE` | Node bridge lite/full auto-selection |
| Multi-frontend | `RAN_AGENT_DEFAULT_GLOBAL_USER_ID`, `RAN_AGENT_IDENTITY_MAP_PATH`, `RAN_AGENT_GLOBAL_TIMELINE_PATH` | Unified identity and cross-platform timeline |
| Timeline retention | `RAN_AGENT_TIMELINE_MAX_BYTES`, `RAN_AGENT_TIMELINE_MAX_TURNS`, `RAN_AGENT_TIMELINE_RETENTION_DAYS`, `RAN_AGENT_TIMELINE_COMPACT_ENABLED` | Timeline retention and compaction |
| Feishu / Desktop | `FEISHU_BRIDGE_ENABLED`, `FEISHU_LARK_CLI_IDENTITY`, `DESKTOP_PROXY_ENABLED`, `DESKTOP_PROXY_PORT` | Optional multi-frontend entries |
| AI daily digest | `AI_DAILY_DIGEST_ENABLED`, `AI_DAILY_DIGEST_HOUR`, `AI_DAILY_DIGEST_MINUTE` | Optional Feishu DM digest, disabled by default |
| Python backend | `PYTHON_BACKEND_BASE_URL`, `PYTHON_BACKEND_INGEST_TIMEOUT_MS`, `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS` | ingest and memory recall |
| MiMo | `MIMO_TOKEN_PLAN_API_KEY`, `MIMO_POWER_*` | Deep multimodal analysis |
| DashScope/Qwen | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | OCR/VLM/ASR and media generation |
| Social platforms | `XHS_COOKIE`, `SESSDATA` | Xiaohongshu and Bilibili auth |
| Obsidian memory | `OBSIDIAN_MEMORY_VAULT_DIR`, `OBSIDIAN_MEMORY_INDEX_PATH`, `OBSIDIAN_INDEX_DEVICE` | Vault retrieval and indexing |
| Media context | `RAN_AGENT_CONTEXT_POLICY`, `RAN_AGENT_MAX_MEDIA_ARTIFACTS` | compact by default, legacy fallback available |
| UV cache | `UV_CACHE_DIR`, `UV_TOOL_DIR`, `UV_LINK_MODE`, `UV_PYTHON_DOWNLOADS` | Fixed uv/uvx cache paths to prevent disk growth |
| XHS timeout | `SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS`, `XHS_BACKEND_MCP_TIMEOUT_MS` | XHS backend timeout, independent from generic social reader timeout |

The full template is `.env.example`. The authoritative current runtime state is `docs/governance/current_runtime_status.md`.

---

## Project Structure

```text
ran_agent/
├── hermes/                         # Hermes profile distribution
│   └── profile/                    # ran-assistant / ran-assistant-lite config
├── node_bridge/                    # Multi-frontend bridges, Hermes client, MCP facades
│   └── src/
│       ├── mediaReader/            # OCR, ASR, VLM, platform resolvers, video analysis
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
├── scripts/                        # MCP launchers, diagnostics, deploy helpers
├── skills/                         # On-demand project skills
├── docs/governance/                # Current runtime status and governance
├── vault/                          # Obsidian vault template, no private content
└── local_archive/                  # Local deployment records, ignored by Git
```

---

## Testing And Diagnostics

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

Hermes profile smoke:

```bash
hermes -p ran-assistant mcp list
hermes -p ran-assistant mcp test media_reader
hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

---

## Documentation

| Document | Contents |
|----------|----------|
| `docs/governance/current_runtime_status.md` | Current runtime mainline |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/doc_status.md` | Public documentation index and conflict rule |
| `docs/governance/multi_frontend_identity_strategy.md` | Multi-frontend identity, timeline, and session strategy |
| `docs/governance/media-pipeline.md` | WeChat media context and Context Policy v1 |
| `docs/governance/phase_status.md` | Hermes migration and OpenClaw retirement status |
| `hermes/README.md` | Hermes profile distribution, Chinese |
| `hermes/README_en.md` | Hermes profile distribution, English |

---

## Platform Support

| Platform | Current Path | Auth |
|----------|--------------|------|
| Bilibili | `social_reader` + `media_reader`, subtitle-first with ASR/keyframe fallback | optional `SESSDATA` |
| Xiaohongshu | `social_reader`, generic parser fallback + token-aware compatibility path | optional but common `XHS_COOKIE` |
| WeChat articles | HTML fetch, body parsing, captcha detection, structured degradation | usually login-free |
| Images/audio/video/documents | `mimo_power` first, `media_reader` fallback | trusted local path or remote URL |

---

## Security And Privacy

This is a single-user personal system. Never commit these paths or values: `.env.local`, `node_bridge/.env.local`, `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, private `vault/` content, cookies, API keys, proxy URLs, or platform login state.

Platform resolver credentials such as `SESSDATA`, `XHS_COOKIE`, and proxy URLs must not appear in logs, docs, tool output, or Git history.

---

## License

PolyForm Noncommercial License 1.0.0. Free for personal use, research, and learning. Commercial use requires permission. See [LICENSE.md](LICENSE.md).
