<p align="right"><a href="README.md">中文</a> | <b>English</b></p>

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

**WeChat Agent.** Messages flow `WeChat → Node bridge → Hermes Gateway → Claude/Qwen → reply`. Natural conversation, not prompt-and-response. The agent remembers past conversations and evolves its persona over time.

**Social Media Understanding.** Drop a Bilibili video, a Xiaohongshu note, or a WeChat article link into chat. The agent resolves the platform, extracts content, and summarizes it for you:

- Bilibili: subtitle extraction (manual + AI-generated), cover image VLM, video frame analysis, ASR fallback
- Xiaohongshu: note text extraction, image understanding, video metadata, comment reading
- WeChat Articles: content parsing, captcha detection, structured degradation

**Knowledge Management.** An Obsidian vault stores structured knowledge. The Python backend runs periodic maintenance jobs — organizing notes, updating the knowledge index, and keeping the vault current. No dumping everything into a prompt window.

**Media Understanding Pipeline.** Send an image and follow up with "use mimo to look at it" — the system automatically merges the image and text into a single request. Media analysis results are persisted as conversation-level artifacts, so saying "that image from earlier" correctly resolves to the prior analysis. Supports deep multimodal analysis of images, audio, video, and documents.

**Context Compression Policy.** Context Policy v1 enabled by default: max 3 media artifacts injected per turn, each compact-rendered (≤180 chars), prioritizing explicit refs and current media. Fallback to full media context via `RAN_AGENT_CONTEXT_POLICY=legacy`. See `docs/governance/media-pipeline.md`.

**Memory and Reflection.** The agent builds a working memory across conversations. A nightly reflection cycle reviews the day's interactions and suggests persona refinements. You stay in control of what sticks and what fades.

---

## Architecture

```
WeChat ──┬── inbound ──► Inbound Aggregation ──► Node Bridge ──► Hermes Gateway Runtime ──► Claude/Qwen
         │                (image+text merge)          ▲                │    │    │
         │                                            │                │    │    └──► media_generation
         │                                            │                │    └───────► social_reader
         │                                            │                └────────────► media_reader + mimo_power
         │                                            │
         └── outbound ◄── Node Bridge ◄── reply ◄────┘
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

- **MCP Facade Pattern.** Hermes sees clean, stable tools (`media_reader__analyze_video`, `social_reader__read_social_post_deep`, etc.). Behind each facade are platform resolvers, provider adapters, and format converters. Tools don't leak internals to the agent.

- **Subtitle-First Video Understanding.** Four-tier progressive fallback: downloadable subtitles (~2s) → audio-only ASR transcription (~10s) → keyframe VLM analysis without OCR (~30s) → metadata as last resort (~1s). Long videos never blindly download full files.

- **Media Artifact Pipeline.** Inbound media is analyzed (MiMo first, media_reader fallback) and stored as conversation-scoped artifacts. Follow-up references like "that image from earlier" resolve to prior analysis results without reprocessing.

- **Local-First Everything.** State in SQLite. Knowledge in Obsidian vault. Conversations on your machine. No cloud database, no hosted service, no telemetry. Single-user by design — there is no user management, no RBAC, no API rate limiting, because there's only you.

---

## MCP Services

The agent's capabilities are organized as MCP (Model Context Protocol) services. Each service exposes a focused set of tools to Hermes.

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

**`mimo_power`** — Deep multimodal analysis service.

| Tool | Description |
|------|-------------|
| `analyze` | Deep multimodal analysis (image/audio/video/document) via MiMo Token Plan |

**`ombre_brain`** — Emotional memory system for long-term memory management.

| Tool | Description |
|------|-------------|
| `breath` | Recall memories by emotional relevance |
| `trace` | Trace memory associations and connections |
| `pulse` | Surface active/emotionally charged memories |
| `hold` | Store a long-term memory entry |
| `grow` | Store a core (identity-forming) memory |

Implements Russell's valence/arousal model, Ebbinghaus forgetting curve, and Obsidian-compatible Markdown storage.

<sub>Integrated from [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain), used directly as the memory management MCP.</sub>

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
hermes -p ran-assistant gateway run       # Agent runtime
./start_python.sh          # Backend services (memory, scheduler, knowledge)
cd node_bridge && ./start_node.sh  # WeChat bridge
```


---

## Configuration

All configuration lives in `.env.local` (never committed). Copy the template and fill in your values:

```bash
cp .env.example .env.local
```

Configuration by module:

| Module | Key Variables | Notes |
|--------|--------------|-------|
| Model Provider | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Claude-compatible API (required) |
| Vision | `PERSONAL_AGENT_VISION_PROVIDER`, `PERSONAL_AGENT_VISION_MODEL` | Default `dashscope-qwen-vl` / `qwen3-vl-flash` |
| ASR | `PERSONAL_AGENT_ASR_PROVIDER`, `PERSONAL_AGENT_ASR_MODEL` | Default `dashscope-asr` / `qwen3-asr-flash` |
| Web Search | `TAVILY_API_KEY` | Tavily search API |
| Bilibili | `PERSONAL_AGENT_BILIBILI_ENABLED`, `PERSONAL_AGENT_YTDLP_PATH` | yt-dlp path + proxy/auth |
| Xiaohongshu | `PERSONAL_AGENT_XHS_ENABLED`, `PERSONAL_AGENT_XHS_PROVIDER` | Backend MCP or social reader |
| Video Processing | `PERSONAL_AGENT_FFMPEG_PATH`, `PERSONAL_AGENT_FFPROBE_PATH` | ffmpeg/ffprobe paths |
| Cache/Concurrency | `PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY`, `PERSONAL_AGENT_MEDIA_CACHE_DIR` | Batch concurrency, cache dir |

Full variable list: see `.env.example`.

---

## Project Structure

```
ran_agent/
├── hermes/                      # Hermes Gateway config and runtime
├── node_bridge/                 # WeChat bridge + MCP facade servers
│   └── src/
│       ├── mediaReader/         # OCR, VLM, ASR, ffmpeg, platform resolvers
│       │   └── platformResolvers/  # Bilibili, XHS, WeChat resolvers
│       ├── inboundMessageBuffer.mjs  # Turn aggregation (image+text merge)
│       ├── mediaContextStore.mjs     # Media artifact persistence
│       ├── trustedMediaPaths.mjs     # Trusted media path validation
│       ├── mimoPowerMcpServer.mjs    # MiMo Power MCP service
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

This is a personal agent. None of these should ever enter version control: `.env.local`, `.ran_agent_state/`, chat logs, cookies, API keys, vault content, state databases. The `.gitignore` is configured to block these by default — always verify before making your fork public.
