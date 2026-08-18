---
name: ran-agent-runtime-debug
description: Use when diagnosing ran-agent runtime, Hermes profile, Node bridge, Python backend, MCP tools, or deployment.
---

# ran-agent Runtime Debug

- Start with read-only inspection: status, logs, config paths, env key names.
- Do not print secret values.
- Check services in order: Python backend, Hermes, Node bridge, MCP tools.
- For media failures, check artifact creation, `media_reader`, and compact
  context injection.
- Current production has one active unified Hermes gateway on `8642`; the
  retired Full unit must remain inactive and is never a fallback runtime.
