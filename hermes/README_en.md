<p align="right"><a href="README.md">中文</a> | <b>English</b></p>

# Hermes Profile Distribution

Status: CURRENT (2026-06-09)

This directory is the repo-local Hermes profile distribution for ran-agent. It stores commit-safe profiles, persona files, MCP launcher config, and skill instructions. It must not store secrets, sessions, memories, logs, machine-local state, or platform login state.

---

## Current Role

- Hermes is the frontend conversation shell for ran-agent.
- The default model is `deepseek-v4-flash`; `deepseek-v4-pro` is opt-in through an explicit template or manual override.
- DeepSeek V4 is treated as a text model in this project. Raw images, audio, video, and social-platform content must be processed by MCP tools first.
- In production, Node bridge automatically routes requests between lite and full gateways; WeChat, Feishu/Lark, and the desktop proxy all enter ChannelHub before the unified mainline calls Hermes.
- OpenClaw, Kimi, and GLM are retired as frontend paths and must not be used as runtime, deployment, or debugging authorities.

---

## Contents

| File or Directory | Purpose |
|-------------------|---------|
| `profile/config.yaml` | `ran-assistant` full profile with the complete MCP tool surface |
| `profile/config.lite.yaml` | `ran-assistant-lite` lite profile for low-context daily use |
| `profile/config.pro.template.yaml` | Explicit Pro model template |
| `profile/distribution.yaml` | Profile metadata and required environment variables |
| `profile/AGENTS.md` | Hermes runtime constraints |
| `profile/IDENTITY.md`, `profile/SOUL.md` | Persona and long-term expression baseline |
| `profile/HERMES_*.md` | Migrated Hermes budget reference files, repo reference only |
| `profile/skills/` | Hermes-local on-demand skills |

---

## Path Conventions

Do not hard-code the local checkout path into commit-safe runtime files. Pass paths through environment variables:

```bash
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran-agent
export HERMES_HOME=/absolute/path/to/hermes-home
```

Recommended conventions:

| Scenario | Repo root | Hermes home |
|----------|-----------|-------------|
| Local verification | `/Users/fengran/ran_agent` | `/private/tmp/ran-agent-hermes-home` or another temporary directory |
| Server production | `/opt/ran_agent` | `/home/ubuntu/.hermes-ran-agent` |
| Server lite | `/opt/ran_agent` | `/home/ubuntu/.hermes-ran-agent/lite` |

Only the machine-local Hermes home should contain `.env`, sessions, logs, memories, cron, and similar runtime files. Do not copy those files back into the repository.

---

## Install The Profile

For local verification, do not switch the global sticky profile. Install into a temporary or project-owned `HERMES_HOME`:

```bash
export RAN_AGENT_REPO_ROOT=/Users/fengran/ran_agent
export HERMES_HOME=/private/tmp/ran-agent-hermes-home

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

On the production server, use server paths:

```bash
export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent

hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

Do not run `hermes profile use ran-assistant` during verification. Production should set the profile and Hermes home through systemd or explicit environment variables.

---

## Lite / Full Gateway

Production runs two Hermes gateways:

| Service | Port | Profile | Hermes home | Purpose |
|---------|------|---------|-------------|---------|
| `ran-agent-hermes.service` | `8642` | `ran-assistant-lite` | `/home/ubuntu/.hermes-ran-agent/lite` | Daily low-context entry |
| `ran-agent-hermes-full.service` | `8643` | `ran-assistant` | `/home/ubuntu/.hermes-ran-agent` | Debugging, commands, Playwright, media generation |

Node bridge routes automatically with these variables:

```bash
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1
RAN_AGENT_CAPABILITY_MODE=auto
HERMES_LITE_PROFILE=ran-assistant-lite
HERMES_FULL_PROFILE=ran-assistant
```

Routing rules:

- Default chat, Xiaohongshu, memory, and image understanding use lite.
- Debugging, commands, logs, systemctl, journalctl, git, npm, Playwright, and media generation use full.
- User overrides such as “open full / all capabilities / debug mode” use full.
- If full is unavailable, requests fall back to lite with `fallback_reason=full_gateway_unavailable`.

`8642` is a low-context entry, not a security sandbox. Do not treat “lite cannot execute terminal” as a hard security guarantee.

Production deployment, profile refresh, and systemd/env drift repair use:

```bash
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
```

Do not hand-edit systemd/env as the normal path. When debugging, trust the merged `systemctl cat ran-agent-hermes.service` and `systemctl cat ran-agent-hermes-full.service` views.

---

## MCP Tool Boundary

Both `profile/config.yaml` and `profile/config.lite.yaml` disable Hermes built-in media tools:

```yaml
disabled_tools:
  - browser_vision
  - image_generate
  - text_to_speech
  - video_analyze
  - vision_analyze
```

ran-agent uses repo-owned MCP services:

| MCP | Purpose |
|-----|---------|
| `search_hub` | Unified online search entry for news, web facts, academic lookup, AI hot topics, and platform-search routing |
| `co_reading` | Private shared reading room: chunk reading, progress, shared annotations, and Hermes co-reading margin replies |
| `time` | `Asia/Shanghai` time queries |
| `media_reader` | OCR, ASR, VLM, video analysis, batch media analysis |
| `social_reader` | Bilibili, Xiaohongshu, WeChat articles, music shares |
| `mimo_power` | Deep multimodal analysis through MiMo Token Plan |
| `personal_memory` | Personal memory recall through the Python backend |
| `obsidian_memory` | Obsidian vault semantic search |
| `media_generation` | Image and speech generation, available on full by default |
| `playwright` | Browser automation, available on full by default |
| `tavily` | Optional lower-level web search provider for Search Hub compatibility |

Fresh web facts, news, academic lookup, and normal URL reads should use `search_hub` first. Social-platform links must use `social_reader`; do not use generic web extraction as a replacement for Xiaohongshu, Bilibili, or similar platform resolvers.

---

## Required And Common Environment Variables

| Variable | Purpose |
|----------|---------|
| `RAN_AGENT_REPO_ROOT` | Absolute path to the ran-agent checkout |
| `DEEPSEEK_API_KEY` | Hermes DeepSeek provider key |
| `API_SERVER_KEY`, `HERMES_API_KEY` | Hermes gateway and Node bridge API auth |
| `PYTHON_BACKEND_BASE_URL` | Python backend, default `http://127.0.0.1:8787` |
| `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | DashScope/Qwen vision, ASR, media generation |
| `MIMO_TOKEN_PLAN_API_KEY` | MiMo Power MCP |
| `TAVILY_API_KEY` | Optional Tavily provider for Search Hub |
| `XHS_COOKIE`, `SESSDATA` | Xiaohongshu and Bilibili auth |
| `CO_READING_ROOT_DIR`, `CO_READING_OWNER_TOKEN` | co_reading local state directory and owner-only write auth |
| `CO_READING_WEB_ENABLED`, `CO_READING_WEB_ACCESS_TOKEN` | Optional Tailscale Web reader switch and browser access token |
| `CO_READING_ASK_CONTEXT_CHARS`, `CO_READING_ASK_THREAD_LIMIT` | Context window and recent-thread limits for Hermes co-reading replies |
| `CO_READING_VAULT_DIR` | Target directory for explicit shared annotation deposits to Vault |
| `OBSIDIAN_MEMORY_VAULT_DIR` | Obsidian vault path |
| `OBSIDIAN_MEMORY_INDEX_PATH` | Obsidian semantic index DuckDB path |
| `OBSIDIAN_INDEX_DEVICE` | Default `cpu` on Linux servers |
| `OBSIDIAN_MEMORY_REINDEX`, `OBSIDIAN_MEMORY_WATCH` | Set to `1` only during explicit maintenance |

Secrets must live in machine-local `.env` files, for example:

```text
/home/ubuntu/.hermes-ran-agent/.env
/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
/home/ubuntu/.hermes-ran-agent/lite/.env
```

Do not write `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, platform cookies, proxy URLs, or login state into this repository.

---

## Obsidian Memory MCP

`obsidian_memory` uses `obsidian-index` semantic search. The repo launcher wraps the upstream package so Linux servers can run the embedding model on CPU and so index maintenance is explicit.

Recommended server values:

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

`OBSIDIAN_MEMORY_INDEX_PATH` is a single-writer DuckDB file. Do not run multiple `obsidian_memory` MCP instances against the same database.

---

## Useful Commands

```bash
hermes --help
hermes profile --help
hermes profile show ran-assistant
hermes -p ran-assistant mcp list
hermes -p ran-assistant mcp test media_reader
hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
```

Run a gateway in the foreground:

```bash
hermes -p ran-assistant gateway run --replace --accept-hooks
```

Diagnostics:

```bash
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-search-hub.sh
```

The complete server runbook is `docs/governance/server_runtime_commands.md`.

---

## Security Boundary

- This directory is safe to commit, but only as a profile distribution.
- Do not commit Hermes home, `.env`, sessions, memories, logs, cron, or platform login state.
- Do not print API keys, cookies, tokens, or proxy URLs in docs, logs, or tool output.
- Hermes is the frontend personality shell. Node bridge, media artifacts, MCP tools, Python backend, memory, vault, night cycle, and persona evolution remain separate runtime assets.
