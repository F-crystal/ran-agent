# Hermes Profile Distribution

This directory contains the repo-local Hermes profile distribution for `ran-agent`.
It is intentionally safe to commit: no secrets, sessions, memories, logs, or
machine-local state belong here.

## Local Install

Hermes CLI is installed locally at:

```bash
/Users/fengran/.local/bin/hermes
```

The verified local version is:

```text
Hermes Agent v0.13.0 (2026.5.7)
```

Install or update the profile distribution:

```bash
hermes profile install /Users/fengran/ran_agent/hermes/profile --name ran-assistant --force -y
```

Then set the active profile if desired:

```bash
hermes profile use ran-assistant
```

Machine-local files live outside the repo:

```text
/Users/fengran/.hermes/profiles/ran-assistant/
  config.yaml
  .env
  memories/
  sessions/
  logs/
  cron/
```

Do not copy secrets into this repository. Put `DEEPSEEK_API_KEY`,
`HERMES_API_KEY`, platform cookies, and provider tokens in the machine-local
Hermes `.env`, root `.env.local`, or `node_bridge/.env.local` as appropriate.

## Model Policy

`ran-assistant` defaults to:

```yaml
model:
  provider: deepseek
  default: deepseek-v4-flash
```

`deepseek-v4-pro` is available only through the explicit Pro template or a
manual model override. It is not the default daily chat model.

## Runtime Boundary

Hermes is the front personality shell. Node bridge, media artifact handling,
MCP tools, Python backend, memory, vault, night cycle, and persona evolution
remain separate runtime assets.

DeepSeek V4 is treated as text-only for this project. Raw images, audio, video,
and social-platform media must be handled first by `mimo_power`, `media_reader`,
`social_reader`, OCR, ASR, or other dedicated tools. Hermes receives compact
tool results, not raw media.

## Useful Commands

```bash
hermes --help
hermes profile --help
hermes profile show ran-assistant
hermes gateway run --replace --accept-hooks
hermes -p ran-assistant -z "ping"
hermes mcp list
hermes mcp test media_reader
```

Gateway foreground mode is:

```bash
hermes -p ran-assistant gateway run --replace --accept-hooks
```

One-shot smoke test is:

```bash
hermes -p ran-assistant --provider deepseek --model deepseek-v4-flash -z "用一句中文回复：Hermes online"
```
