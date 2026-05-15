<p align="right"><a href="README.md">中文</a> | <b>English</b></p>

# Ran Agent

Status: CURRENT (2026-05-15)

**A local-first personal AI agent that lives in WeChat: Hermes handles conversation, Node bridge handles WeChat transport, the Python backend owns memory, knowledge, and scheduling, and MCP tools handle media and social-platform understanding.**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent is a personal runtime, not a SaaS product. It routes WeChat messages into Hermes Gateway, replies with DeepSeek V4 Flash, and uses MCP tools such as `media_reader`, `social_reader`, `mimo_power`, `personal_memory`, and `obsidian_memory` for media, social content, personal memory, and vault retrieval. State, logs, vault content, cookies, and secrets stay on infrastructure you control.

OpenClaw, Kimi, and GLM are retired as frontend paths. The current frontend mainline is Hermes + DeepSeek V4 Flash.

---

## Current Mainline

```text
WeChat
  -> Node bridge
  -> Hermes gateway lite/full
  -> DeepSeek V4 Flash
  -> reply

Python backend
  -> ingest / memory / knowledge / reflection / scheduler / reminders

MCP services
  -> media_reader / social_reader / mimo_power / media_generation
  -> personal_memory / obsidian_memory / time / playwright / tavily
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

**WeChat conversation entry.** Messages enter `node_bridge/src/wechatBridge.mjs`, pass through inbound aggregation, media context handling, Hermes Gateway, and DeepSeek V4 Flash, then return to WeChat. The Python backend receives `/ingest` asynchronously for recent memory and downstream tasks.

**Social media reading.** `social_reader` handles Bilibili, Xiaohongshu, WeChat articles, music shares, and related social links. Xiaohongshu uses the generic parser fallback as the primary read path, while search context stores `read_ref` handles without exposing platform tokens to the model or logs.

**Multimodal understanding.** WeChat images, audio, video, and documents first pass trusted-path validation. MiMo Power analyzes them first; `media_reader` is the fallback. Video analysis is subtitle-first: subtitles, audio ASR, keyframe VLM, then metadata fallback.

**Media follow-up context.** Inbound media becomes conversation-scoped artifacts. When the user says “that image from earlier” or “use MiMo to look at it,” the inbound message buffer binds the text to recent media explicitly or as a soft candidate. Context Policy v1 injects at most 3 compact artifacts per turn by default.

**Memory and knowledge.** `personal_memory` recalls personal memory through the Python backend. `obsidian_memory` searches the Obsidian vault through a semantic index. Long-term writes, reflection, night-cycle work, and knowledge maintenance stay in the Python backend and on-demand skills instead of always living in the main prompt.

**Sendable media generation.** The full gateway can call `media_generation` to generate images or speech for WeChat and preserve `WECHAT_MEDIA` markers for Node bridge delivery.

---

## MCP Services

| Service | Purpose | Default Entry |
|---------|---------|---------------|
| `time` | Timezone-aware time queries, default `Asia/Shanghai` | lite/full |
| `media_reader` | OCR, ASR, VLM, video analysis, batch media analysis | lite/full |
| `social_reader` | Bilibili, Xiaohongshu, WeChat articles, music shares | lite/full |
| `mimo_power` | Deep multimodal analysis through MiMo Token Plan | lite/full |
| `personal_memory` | Personal memory recall and backend health check | lite/full |
| `obsidian_memory` | Obsidian vault semantic search | lite/full |
| `media_generation` | Image and speech generation | full |
| `playwright` | Browser automation and dynamic-page debugging | full |
| `tavily` | Optional web search MCP, requires a local API key | lite/full |

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
```

Do not hand-edit systemd/env as the normal deployment path. See `docs/governance/server_runtime_commands.md` for the detailed runtime contract.

---

## Configuration

All secrets live in local `.env.local`, `node_bridge/.env.local`, or machine-local Hermes `.env` files. Do not commit them.

| Module | Key Variables | Notes |
|--------|---------------|-------|
| Hermes / DeepSeek | `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, `API_SERVER_KEY` | Hermes gateway and model provider |
| Gateway routing | `HERMES_LITE_API_BASE_URL`, `HERMES_FULL_API_BASE_URL`, `RAN_AGENT_CAPABILITY_MODE` | Node bridge lite/full auto-selection |
| Python backend | `PYTHON_BACKEND_BASE_URL`, `PYTHON_BACKEND_INGEST_TIMEOUT_MS`, `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS` | ingest and memory recall |
| MiMo | `MIMO_TOKEN_PLAN_API_KEY`, `MIMO_POWER_*` | Deep multimodal analysis |
| DashScope/Qwen | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | OCR/VLM/ASR and media generation |
| Social platforms | `XHS_COOKIE`, `SESSDATA` | Xiaohongshu and Bilibili auth |
| Obsidian memory | `OBSIDIAN_MEMORY_VAULT_DIR`, `OBSIDIAN_MEMORY_INDEX_PATH`, `OBSIDIAN_INDEX_DEVICE` | Vault retrieval and indexing |
| Media context | `RAN_AGENT_CONTEXT_POLICY`, `RAN_AGENT_MAX_MEDIA_ARTIFACTS` | compact by default, legacy fallback available |

The full template is `.env.example`. The authoritative current runtime state is `docs/governance/current_runtime_status.md`.

---

## Project Structure

```text
ran_agent/
├── hermes/                         # Hermes profile distribution
│   └── profile/                    # ran-assistant / ran-assistant-lite config
├── node_bridge/                    # WeChat bridge, Hermes client, MCP facades
│   └── src/
│       ├── mediaReader/            # OCR, ASR, VLM, platform resolvers, video analysis
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
| `docs/governance/server_runtime_commands.md` | Server runbook and recovery commands |
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
