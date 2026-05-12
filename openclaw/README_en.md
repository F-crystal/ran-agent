# OpenClaw -- Frontend Agent Runtime Configuration

Status: CURRENT (2026-05-13)

This directory contains the runtime contract, configuration baseline, and security boundary definitions for the OpenClaw frontend agent. OpenClaw is the "brain" of the personal assistant system -- it receives messages, invokes tools, generates replies, and manages conversation context and memory.

## OpenClaw in the Architecture

```
Node Bridge (WeChat message bridge)
      |
      v
   OpenClaw (frontend agent runtime)  <-- this directory defines its behavior
      |
      +-- MCP tool calls (media reading, social parsing, media generation, deep analysis, etc.)
      +-- conversation context management (context pruning, memory injection, heartbeat)
      +-- natural language reply generation
      |
      v
   Node Bridge (WeChat message delivery)
```

OpenClaw uses the `claude_code` provider to access the `qwen3.5-plus` model, running in local gateway mode on `127.0.0.1:19123`. All frontend conversation traffic routes through `claude_code` only -- no other providers serve as frontend fallback.

## Directory Files

### Core Runtime Files

| File | Description |
|------|-------------|
| `AGENTS.md` | OpenClaw runtime contract. Defines persona evolution, frontline lock, companion reply quality, heartbeat behavior, todo/reminder rules, tool routing policy, media generation conventions, and more. Injected at startup via the `bootstrap-extra-files` hook. |
| `openclaw.personal-system.json` | OpenClaw gateway and agent configuration. Contains gateway port, model definitions, MCP servers, context pruning strategy, heartbeat parameters, and plugin settings. |
| `SECURITY_BOUNDARY.md` | Workspace boundary and permission policy. Defines allowed / cautious / denied operation levels, plus channel and command access control. |

### Reference Documents

| File | Description |
|------|-------------|
| `HERMES_MEMORY.md` | Hermes-style memory budget reference |
| `HERMES_RUNTIME.md` | Hermes-style runtime context budget reference |
| `HERMES_USER.md` | Hermes user profile reference |
| `calendar-reminder-workflow.md` | Calendar reminder workflow |
| `feishu-voice-message-workflow.md` | Feishu voice message workflow |
| `time-context-checklist.md` | Time context checklist |

## MCP Tools

OpenClaw can invoke the following MCP tools:

| MCP Server | Purpose |
|------------|---------|
| `media_reader` | Unified media reading facade -- image OCR, audio ASR, video analysis. Backed by PaddleOCR, DashScope qwen3-vl-flash / qwen3-asr-flash, and ffmpeg/ffprobe. |
| `social_reader` | Social media read-only facade -- Bilibili, Xiaohongshu, WeChat article content parsing. Does not control playback. Xiaohongshu reads prefer the generic parser fallback, while search results bridge to details through internal `read_ref` handles and token cache. |
| `media_generation` | Media generation -- image generation (DashScope qwen-image) and speech synthesis (DashScope qwen3-omni-flash). |
| `mimo_power` | Deep multimodal analysis -- heavy long-context tasks, complex screenshot/audio/video/document reasoning. Requires MiMo Token Plan. |
| `playwright` | Browser automation -- dynamic pages, login-state checks, SPA rendering, screenshots, and other interactive scenarios. |
| `time` | Timezone-aware time queries. Local timezone is `Asia/Shanghai`. |
| `obsidian_memory` | Obsidian vault memory integration. |
| `personal_memory` | Personal memory management. |

### Media Processing Pipeline

WeChat inbound media follows this pipeline:

```
Inbound media (image / audio / video / document)
      |
      v
  Media buffer (trusted inbound directories)
      |
      v
  Media artifact (conversation-level media context)
      |
      v
  Tool invocation (mimo_power / media_reader / social_reader)
      |
      v
  Analysis results incorporated into reply
```

Local `file_path` inputs are only accepted from trusted inbound media directories in the bridge layer; URL media assets must be remote `http(s)` addresses. Project files such as `.env`, state, and vault files must not be passed to tools as media assets.

## Configuration Notes

### Model and Provider

- Active model: `qwen3.5-plus`, routed through the `claude_code` provider
- Context window: 120,000 tokens
- Max output: 8,192 tokens
- Kimi and GLM are retired and not present in frontend routing config

### Context Management

- Context pruning mode: `cache-ttl`, TTL 10 minutes
- Soft trim ratio: 25%, hard clear ratio: 45%
- Retains last 3 assistant replies
- Compaction mode: `safeguard` with 12,000 token floor

### Heartbeat

- Interval: 90 minutes
- Active hours: 08:30 - 23:30 (Asia/Shanghai)
- Heartbeat behavior: check todos, track reminders; reply `HEARTBEAT_OK` when nothing needs attention

### Session Reset

- Automatic daily reset at 04:00
- `/new` and `/reset` commands trigger manual reset
- Session continuity is maintained through memory and daily context, not by replaying prior transcripts

## Deployment Notes

- Replace `REPLACE_WITH_OWNER_WECHAT_USER_ID` with the actual WeChat user ID before production use
- `OPENCLAW_STATE_DIR` must remain inside this repository checkout (default: `.openclaw_state/`)
- Do not relax `allowFrom` / `ownerAllowFrom` / `commands.allowFrom` beyond owner scope
- Gateway token is configured in `node_bridge/.env.local` -- do not commit to version control
- Keep OpenClaw configuration project-local; do not leak to other projects
