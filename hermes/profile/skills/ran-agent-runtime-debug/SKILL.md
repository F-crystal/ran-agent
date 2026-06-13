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
- For server issues, remember the server may still have a legacy frontend
  service installed. Hermes should be the active foreground gateway.
