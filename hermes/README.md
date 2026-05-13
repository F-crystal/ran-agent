# Hermes Profile Distribution

This directory contains the repo-local Hermes profile distribution for `ran-agent`.
It is intentionally safe to commit: no secrets, sessions, memories, logs, or
machine-local state belong here.

## Local And Server Paths

This distribution is portable. Do not hard-code the local checkout path into
server runtime files. Set paths through environment variables instead.

Recommended path conventions:

| Scope | Repo root | Verification `HERMES_HOME` | Runtime `HERMES_HOME` |
| --- | --- | --- | --- |
| Local dev | `/Users/fengran/ran_agent` | `/private/tmp/ran-agent-hermes-home` | operator-owned, not required for Phase 5 |
| Server | `/opt/ran_agent` or the deployed checkout path | `/tmp/ran-agent-hermes-home` | service-owned path such as `/home/ubuntu/.hermes-ran-agent` |

Required path variables:

```bash
export RAN_AGENT_REPO_ROOT=/absolute/path/to/ran_agent
export HERMES_HOME=/path/to/hermes-home
```

Secrets must live in machine-local env files, not in this repository.

## Project-Local Verification

On this local machine, Hermes CLI has been verified at:

```bash
/Users/fengran/.local/bin/hermes
```

The verified local version is:

```text
Hermes Agent v0.13.0 (2026.5.7)
```

Phase 5 MCP verification should not modify the operator's default Hermes
profile. Use a project-local or temporary `HERMES_HOME` when validating this
distribution:

```bash
export HERMES_HOME=/private/tmp/ran-agent-hermes-home
export RAN_AGENT_REPO_ROOT=/Users/fengran/ran_agent
hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

On the server, use the same pattern with server paths:

```bash
export HERMES_HOME=/tmp/ran-agent-hermes-home
export RAN_AGENT_REPO_ROOT=/opt/ran_agent
hermes profile install "$RAN_AGENT_REPO_ROOT/hermes/profile" --name ran-assistant --force -y
hermes -p ran-assistant mcp list
```

Do not run `hermes profile use ran-assistant` during project verification. Keep
the repo-local config in this directory and use the temporary/project-local
Hermes home for generated config, sessions, logs, memories, and MCP smoke
state.

For a real machine deployment, install the profile into that machine's
dedicated Hermes home and keep secrets in the machine-local `.env`:

```text
$HERMES_HOME/profiles/ran-assistant/
  config.yaml
  .env
  memories/
  sessions/
  logs/
  cron/
```

The previous default personal Hermes home layout is shown only as an example
of machine-local state, not as the Phase 5 verification target:

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

## Server Deployment Boundary

This README defines the portable profile distribution and verification pattern
for both local and server environments. Full server deployment details
including systemd units, restart order, log paths, health checks, and resource
baseline belong in the Phase 9 deployment document.

Until Phase 9, server validation should only prove that the profile can be
installed under a service-owned `HERMES_HOME` and that the MCP servers can be
listed/tested without relying on local absolute paths.

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
