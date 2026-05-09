<p align="right"><a href="README_zh.md">中文</a> | <b>English</b></p>

# Ran Agent

**A local-first personal AI agent that lives in WeChat, understands social media content, and manages knowledge — all on infrastructure you control.**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](requirements.txt)

Ran Agent connects WeChat to an LLM-powered conversation runtime with memory, reflection, and multi-modal understanding. Share a Bilibili link or a Xiaohongshu post, and the agent actually reads it — extracting subtitles from videos, running vision-language models on frames, and transcribing audio. Everything runs on a single server you own.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [MCP Services](#mcp-services)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Platform Support](#platform-support)
- [License](#license)
- [Privacy](#privacy)

---

## What It Does

**WeChat Agent.** Messages flow `WeChat → Node bridge → OpenClaw agent runtime → Claude/Qwen → reply`. Natural conversation, not prompt-and-response. The agent remembers past conversations and evolves its persona over time.

**Social Media Understanding.** Drop a Bilibili video, a Xiaohongshu note, or a WeChat article link into chat. The agent resolves the platform, extracts content, and summarizes it for you:

- Bilibili: subtitle extraction (manual + AI-generated), cover image VLM, video frame analysis, ASR fallback
- Xiaohongshu: note text extraction, image understanding, video metadata, comment reading
- WeChat Articles: content parsing, captcha detection, structured degradation

**Knowledge Management.** An Obsidian vault stores structured knowledge. The Python backend runs periodic maintenance jobs — organizing notes, updating the knowledge index, and keeping the vault current. No dumping everything into a prompt window.

**Memory and Reflection.** The agent builds a working memory across conversations. A nightly reflection cycle reviews the day's interactions and suggests persona refinements. You stay in control of what sticks and what fades.

---

## Architecture

```
WeChat ──┬── inbound ──► Node Bridge ──► OpenClaw Agent Runtime ──► Claude/Qwen
         │                    ▲                │    │    │
         │                    │                │    │    └──► media_generation
         │                    │                │    └───────► social_reader
         │                    │                └────────────► media_reader
         │                    │
         └── outbound ◄── Node Bridge ◄── reply ◄────────────┘
                              ▲
                              │
                    Python Backend
                    ┌─────────┼─────────┐
                    │ memory  │ scheduler│
                    │ knowledge│ todo    │
                    │ reflection         │
                    └────────────────────┘
```

**Key Design Decisions:**

- **MCP Facade Pattern.** OpenClaw sees clean, stable tools (`media_reader__analyze_video`, `social_reader__read_social_post_deep`, etc.). Behind each facade are platform resolvers, provider adapters, and format converters. Tools don't leak internals to the agent.

- **Subtitle-First Video Understanding.** Videos are analyzed through three tiers: downloadable subtitles (~2s), VLM frame analysis when subtitles aren't available (~15s), and metadata-only as a last resort (~1s). No blind frame dumping on long videos.

- **Local-First Everything.** State in SQLite. Knowledge in Obsidian vault. Conversations on your machine. No cloud database, no hosted service, no telemetry. Single-user by design — there is no user management, no RBAC, no API rate limiting, because there's only you.

---

## MCP Services

The agent's capabilities are organized as MCP (Model Context Protocol) services. Each service exposes a focused set of tools to OpenClaw.

### Built-in Services

**`media_reader`** — The agent's eyes and ears for media content.

| Tool | Description |
|------|-------------|
| `extract_media_assets` | Extract media URLs from social text or message content |
| `analyze_image` | OCR + vision-language model analysis of images |
| `resolve_platform_media` | Resolve Bilibili/XHS/WeChat links into normalized media |
| `transcribe_audio` | Speech-to-text transcription with language detection |
| `analyze_video` | Video analysis: metadata, subtitle extraction, frame VLM, ASR |
| `analyze_media_batch` | Batch analysis with partial-failure tolerance |

**`social_reader`** — Platform-aware social content reading.

| Tool | Description |
|------|-------------|
| `resolve_social_url` | Identify platform and extract canonical URL from share text |
| `read_social_post` | Read a social media post with platform-specific extraction |
| `read_social_post_deep` | Deep read: resolve platform media + analyze all assets |
| `read_music_share` | Parse shared music links (NetEase, etc.) |
| `check_social_login` | Check platform authentication status |

**`media_generation`** — Create sendable media for WeChat responses.

| Tool | Description |
|------|-------------|
| `generate_image` | Generate images via Qwen image generation |
| `generate_speech` | Text-to-speech audio generation |

**`ombre_brain`** — Emotional memory system for long-term memory management.

| Tool | Description |
|------|-------------|
| `breath` | Recall memories by emotional relevance |
| `trace` | Trace memory associations and connections |
| `pulse` | Surface active/emotionally charged memories |
| `hold` | Store a long-term memory entry |
| `grow` | Store a core (identity-forming) memory |

Implements Russell's valence/arousal model, Ebbinghaus forgetting curve, and Obsidian-compatible Markdown storage.

### External Services

| Service | Description |
|---------|-------------|
| `playwright` | Browser automation for web interaction |
| `time` | Timezone-aware time and date queries |
| `tavily` | Web search via Tavily API |

---

## Quick Start

**Prerequisites:** Node.js ≥22, Python ≥3.10, ffmpeg, ffprobe

```bash
git clone https://github.com/F-crystal/ran-agent.git
cd ran-agent

# Install dependencies
npm install
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Configure credentials
cp .env.example .env.local
# Edit .env.local — at minimum you need ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
```

Then start each service in its own terminal:

```bash
./start_openclaw.sh       # Agent runtime
./start_python.sh          # Backend services (memory, scheduler, knowledge)
cd node_bridge && ./start_node.sh  # WeChat bridge
```

For production deployment on a server, see `local_archive/docs/deployment/` for systemd unit files and server configuration guides.

---

## Configuration

All configuration lives in `.env.local` (never committed). Key variables:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | Claude-compatible API endpoint |
| `ANTHROPIC_AUTH_TOKEN` | API authentication token |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw gateway auth |
| `DASHSCOPE_API_KEY` | DashScope provider key (VLM, ASR, image generation) |
| `TAVILY_API_KEY` | Web search API key |
| `PERSONAL_AGENT_VISION_PROVIDER` | Vision model provider (default: `dashscope-qwen-vl`) |
| `PERSONAL_AGENT_VISION_MODEL` | Vision model (default: `qwen3-vl-flash`) |
| `PERSONAL_AGENT_ASR_PROVIDER` | ASR provider (default: `dashscope-asr`) |
| `PERSONAL_AGENT_BILIBILI_ENABLED` | Enable Bilibili platform resolver |
| `PERSONAL_AGENT_XHS_ENABLED` | Enable Xiaohongshu platform resolver |
| `PERSONAL_AGENT_YTDLP_PATH` | Path to yt-dlp binary (for Bilibili extraction) |
| `PERSONAL_AGENT_FFMPEG_PATH` | Path to ffmpeg (for video processing) |

For the full configuration reference, see `local_archive/docs/deployment/`.

---

## Project Structure

```
ran_agent/
├── openclaw/                    # OpenClaw agent config and runtime
├── node_bridge/                 # WeChat bridge + MCP facade servers
│   └── src/
│       ├── mediaReader/         # OCR, VLM, ASR, ffmpeg, platform resolvers
│       │   └── platformResolvers/  # Bilibili, XHS, WeChat resolvers
│       ├── socialReaderMcpServer.mjs
│       ├── mediaReaderMcpServer.mjs
│       ├── mediaGenerationMcpServer.mjs
│       └── wechatBridge.mjs     # WeChat inbound/outbound message handling
├── src/personal_agent/          # Python backend
│   ├── memory.py                # Conversation memory
│   ├── knowledge_agent.py       # Knowledge extraction and vault management
│   ├── scheduler.py             # Cron job scheduler
│   └── night_cycle.py           # Nightly reflection and persona evolution
├── skills/                      # On-demand operational skills
├── scripts/                     # Startup scripts, deploy tooling
├── vault/                       # Obsidian knowledge vault (templates only)
├── docs/governance/             # Runtime constraints and status
└── local_archive/               # Deployment guides (private, not in git)
```

---

## Testing

```bash
# Python tests
PYTHONPATH=src pytest -q tests/

# Node.js tests
npm --prefix node_bridge test
```

---

## Platform Support

| Platform | Resolver | Subtitles | Video Frames | Auth Support |
|----------|----------|-----------|--------------|--------------|
| Bilibili | yt-dlp + MCP | manual + AI-generated | VLM frame analysis | SESSDATA cookie |
| Xiaohongshu | Backend MCP | note text as content | cover image VLM | Cookie auth |
| WeChat Articles | HTML fetch + parser | article body | — | Login-free |
| Direct media URLs | ffmpeg + DashScope | ASR transcription | VLM frame analysis | — |

---

## License

PolyForm Noncommercial License 1.0.0 — free for personal use, research, and learning. Commercial use requires permission. See [LICENSE.md](LICENSE.md).

---

## Privacy

This is a personal agent. None of these should ever enter version control: `.env.local`, `.openclaw_state/`, chat logs, cookies, API keys, vault content, state databases. The `.gitignore` is configured to block these by default — always verify before making your fork public.
