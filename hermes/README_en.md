<p align="right"><a href="README.md">中文</a> | <b>English</b></p>

# Hermes Profile Distribution

Status: CURRENT (2026-08-06)

`DEPLOYED_RUNTIME_ACCEPTANCE` (2026-08-06): exact candidate `0b793e8` deployed one unified Hermes v0.20 gateway with DeepSeek V4 Flash on `8642`; the retired Full service is inactive/disabled. See `docs/governance/current_runtime_status.md` for the bounded evidence.

The unified-identity/O2 rollback baseline `b5b4ff43f8c3d5706192cabefcece49408b73558` is archived but not deployed to production. It preserves O2 and reuses the existing runtime identity. O1/O2 candidates remain undeployed and Gate 5 is not authorized.

This directory is the repo-local Hermes profile distribution for ran-agent. It stores commit-safe profiles, persona files, MCP launcher config, and skill instructions. It must not store secrets, sessions, memories, logs, machine-local state, or platform login state.

---

## Current Role

- Hermes is the frontend conversation shell for ran-agent.
- The unified production profile uses `deepseek-v4-flash`; the provider policy adds `thinking.type=disabled` to
  the final HTTP body. Pro is explicit opt-in only.
- DeepSeek V4 is treated as a text model in this project. Raw images, audio, video, and social-platform content must be processed by MCP tools first.
- In production, legacy Lite/Full selectors point to the same `8642` gateway; WeChat, Feishu/Lark, and the desktop proxy all enter ChannelHub before the unified mainline calls Hermes.
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

## Unified Hermes Gateway

Production runs one Hermes v0.20 gateway:

| Service | Port | Profile | Hermes home | Purpose |
|---------|------|---------|-------------|---------|
| `ran-agent-hermes.service` | `8642` | `ran-assistant-lite` compatibility ID | `/home/ubuntu/.hermes-ran-agent/lite` | Legacy Lite/Full capability union |

Node bridge routes automatically with these variables:

```bash
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8642/v1
RAN_AGENT_CAPABILITY_MODE=auto
HERMES_LITE_PROFILE=ran-assistant-lite
HERMES_FULL_PROFILE=ran-assistant-lite
```

Terminal, file, session search, Playwright, media generation, and existing MCPs
are available through the unified profile. `ran-agent-hermes-full.service` is
inactive/disabled, not a fallback.

Follow the runtime runbook for production deployment, profile refresh, and
rollback. Routine diagnostics may use:

```bash
bash scripts/diagnose-lite-full.sh
```

Do not hand-edit systemd/env as the normal path. See `docs/governance/server_runtime_commands.md`.

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
| `mimo_power` | Retired: historical MiMo Token Plan deep multimodal analysis, not part of current runtime profiles |
| `personal_memory` | Personal memory recall through the Python backend |
| `obsidian_memory` | Optional Obsidian vault semantic search; registered but not currently runtime-ready |
| `ombre_memory` | Local recall-only O1 candidate endpoint; the upstream registry is not exposed to Hermes |
| `media_generation` | Image and speech generation in the unified profile |
| `playwright` | Browser automation in the unified profile |
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
| `TAVILY_API_KEY` | Optional Tavily provider for Search Hub |
| `SESSDATA` | Optional Bilibili auth; Xiaohongshu reading is public-only and does not use `XHS_COOKIE` |
| `CO_READING_ROOT_DIR`, `CO_READING_OWNER_TOKEN` | co_reading local state directory and owner-only write auth |
| `CO_READING_WEB_ENABLED`, `CO_READING_WEB_ACCESS_TOKEN` | Optional Tailscale Web reader switch and browser access token |
| `CO_READING_ASK_CONTEXT_CHARS`, `CO_READING_ASK_THREAD_LIMIT` | Context window and recent-thread limits for Hermes co-reading replies |
| `CO_READING_VAULT_DIR` | Target directory for explicit shared annotation deposits to Vault |
| `OBSIDIAN_MEMORY_VAULT_DIR` | Obsidian vault path |
| `OBSIDIAN_MEMORY_INDEX_PATH` | Obsidian semantic index DuckDB path |
| `OBSIDIAN_INDEX_DEVICE` | Default `cpu` on Linux servers |
| `OBSIDIAN_MEMORY_REINDEX`, `OBSIDIAN_MEMORY_WATCH` | Set to `1` only during explicit maintenance |
| `OMBRE_BRAIN_ENABLED`, `OMBRE_BRAIN_MCP_ENABLED` | Internal Ombre Brain service switches; they do not authorize direct Hermes access |
| `OMBRE_BRAIN_RUNNER` | O1 is pinned to `source`; `docker`, `external`, and unknown runners fail closed |
| `OMBRE_BRAIN_REPO_URL` | Ombre Brain canonical upstream, default `https://github.com/P0luz/Ombre-Brain` |
| `OMBRE_BRAIN_HOME`, `OMBRE_BRAIN_SOURCE_DIR`, `OMBRE_BRAIN_VENV`, `OMBRE_BUCKETS_DIR` | Ombre Brain runtime, source checkout, venv, and private buckets paths |
| `OMBRE_BIND_HOST`, `OMBRE_MCP_REQUIRE_AUTH`, `OMBRE_BRAIN_MCP_URL` | Loopback-only contract for the internal upstream; O1 has no network authenticator, so only `127.0.0.1` and `false` are accepted |
| `OMBRE_RECALL_MCP_URL` | Local recall-only endpoint used by Hermes and Python |
| `PERSONAL_AGENT_OMBRE_BACKEND` | Python `personal_memory` Ombre backend, fixed to `recall_only` in the O1 candidate |

Secrets must live in machine-local `.env` files, for example:

```text
/home/ubuntu/.hermes-ran-agent/.env
/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
/home/ubuntu/.hermes-ran-agent/lite/.env
```

Do not write `DEEPSEEK_API_KEY`, `HERMES_API_KEY`, platform cookies, proxy URLs, or login state into this repository.

---

## Obsidian Memory MCP

`obsidian_memory` is designed around `obsidian-index` semantic search. Production inherited a malformed partial uv tool, so the surface is registered but not runtime-ready. Create a separate space-bounded plan before installing its Torch/Transformers dependency tree.

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
HERMES_DEEPSEEK_THINKING_MODE=disabled hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "只输出 OK"
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
bash scripts/diagnose-ombre-memory.sh
```

The complete server runbook is `docs/governance/server_runtime_commands.md`.

---

## Security Boundary

- This directory is safe to commit, but only as a profile distribution.
- Do not commit Hermes home, `.env`, sessions, memories, logs, cron, or platform login state.
- Do not print API keys, cookies, tokens, or proxy URLs in docs, logs, or tool output.
- Hermes is the frontend personality shell. Node bridge, media artifacts, MCP tools, Python backend, memory, vault, night cycle, and persona evolution remain separate runtime assets.
