# Ran Agent

**A local-first personal AI agent that lives in your WeChat, understands social media, and manages your knowledge — all on your own machine.**

Ran Agent is an end-to-end personal agent runtime. It connects WeChat messages to an LLM-powered conversation frontend, adds memory and reflection, and gives the agent eyes through a multi-provider media understanding pipeline that can watch Bilibili videos, read Xiaohongshu posts, and parse WeChat articles. Everything runs on a single server you control.

---

## What It Actually Does

- **WeChat Agent**: Messages flow WeChat → Node bridge → OpenClaw agent runtime → Claude/Qwen → reply back. Feels like texting a friend, not prompting a bot.

- **Social Media Understanding**: Share a Bilibili link, a Xiaohongshu post, or a WeChat article, and the agent actually reads it. It extracts subtitles from videos, runs vision-language models on frames, and transcribes audio — then tells you what the content is about in natural language.

- **Memory That Persists**: Remembers past conversations, evolves its persona over time, and maintains a knowledge vault without dumping everything into a giant prompt.

- **Proactive Check-ins**: A scheduler wakes the agent for morning briefings, evening reflections, and periodic knowledge maintenance. It learns when to reach out and when to stay quiet.

- **Media Generation**: Can create and send images and audio responses through WeChat when text isn't enough.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      WeChat                             │
└──────────┬──────────────────────────────────┬───────────┘
           │ incoming                         │ outgoing
           ▼                                  ▲
┌──────────────────────┐          ┌───────────────────────┐
│   Node Bridge         │          │   Node Bridge          │
│   wechatBridge.mjs    │          │   outboundServer.mjs   │
└──────────┬───────────┘          └───────────────────────┘
           │                                  ▲
           ▼                                  │
┌──────────────────────────────────────────────────────────┐
│                 OpenClaw Agent Runtime                    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ social_reader│  │ media_reader │  │ media_generation│  │
│  │ (platforms) │  │ (OCR/VLM/ASR)│  │ (image/audio)   │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│                  Python Backend                           │
│  memory │ knowledge │ reflection │ todo │ scheduler       │
│  ┌──────┐ ┌────────┐ ┌──────────┐ ┌────┐ ┌───────────┐  │
│  │SQLite│ │Obsidian│ │ persona  │ │CRUD│ │ cron jobs │  │
│  └──────┘ │ vault  │ │ evolution│ └────┘ └───────────┘  │
│           └────────┘ └──────────┘                        │
└──────────────────────────────────────────────────────────┘
```

**Key design choices:**

- **MCP Facade Pattern**: OpenClaw sees 6 clean tools (`social_reader__read_social_post_deep`, `media_reader__analyze_video`, etc.). Behind those facades are platform resolvers for Bilibili, Xiaohongshu, and WeChat; subtitle extraction via yt-dlp; vision-language analysis via DashScope Qwen-VL; and audio transcription via Qwen-ASR.

- **Subtitle-First Video Understanding**: Videos are analyzed through a three-tier strategy — prefer downloadable subtitles (2-5s), fall back to VLM frame analysis when subtitles aren't available, and degrade gracefully to metadata-only when needed. No blind frame dumping.

- **Local-First Everything**: State lives in SQLite. Knowledge lives in an Obsidian vault. Conversations stay on your machine. No cloud database, no hosted service, no telemetry.

- **Single-User, Owner-Only**: Designed from the ground up as a personal agent, not a multi-tenant platform. There's no user management, no RBAC, no API rate limiting — because there's only you.

---

## Media Understanding Pipeline

The `media_reader` MCP server is the agent's eyes and ears. It currently supports:

| Platform | Capability |
|----------|------------|
| **Bilibili** | Subtitle extraction (manual + AI-generated), cover image analysis, video frame VLM, audio ASR fallback |
| **Xiaohongshu** | Note content extraction, image VLM, video metadata, comment reading |
| **WeChat Articles** | Content extraction, captcha detection, structured error reporting |
| **Direct media** | Image OCR/VLM, audio transcription, video metadata + frame analysis |

Provider stack: yt-dlp (platform extraction), DashScope Qwen3-VL-Flash (vision), DashScope Qwen3-ASR-Flash (audio), PaddleOCR (local OCR fallback), ffmpeg (video processing).

---

## Quick Start

**Prerequisites**: Node.js ≥22, Python ≥3.10, ffmpeg/ffprobe, yt-dlp (optional, for Bilibili).

```bash
# Clone and install
git clone https://github.com/F-crystal/ran-agent.git
cd ran-agent
npm install
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Configure your model provider
cp .env.example .env.local
# Edit .env.local with your credentials (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, etc.)

# Start services (3 terminals)
./start_openclaw.sh       # Agent runtime
./start_python.sh          # Backend services
cd node_bridge && ./start_node.sh  # WeChat bridge
```

## Testing

```bash
PYTHONPATH=src pytest -q tests/
npm --prefix node_bridge test
```

## Project Structure

```
ran_agent/
├── openclaw/              # OpenClaw agent config and runtime
├── node_bridge/           # WeChat bridge + MCP facade servers
│   └── src/
│       ├── mediaReader/   # OCR, VLM, ASR, ffmpeg, platform resolvers
│       └── ...            # WeChat bridge, social reader, outbound
├── src/personal_agent/    # Python backend (memory, knowledge, scheduler)
├── skills/                # On-demand operational skills
├── scripts/               # Startup scripts, archive tooling
├── vault/                 # Obsidian knowledge vault (templates only)
└── docs/governance/       # Runtime constraints and status
```

## License

PolyForm Noncommercial License 1.0.0 — free for personal use, research, and learning. Commercial use requires permission.

See [LICENSE.md](LICENSE.md).

## Privacy

This is a personal agent. None of the following should ever enter version control: `.env.local`, chat logs, cookies, API keys, vault content, state databases. The repo is structured to keep these out by default via `.gitignore`, but always verify before making a repo public.
