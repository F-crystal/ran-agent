# Cleanup Scope

Status: CURRENT (2026-04-13)

## Deleted (2026-04-13)

- `src/personal_agent/openclaw_front_shell.py` (retired compatibility shell, no runtime import dependency)
- `src/personal_agent/conversation_agent.py` (retired compatibility shell, no runtime import dependency)

## Downgrade-To-Compatibility (keep temporary, then remove)

- `src/personal_agent/service.py` (frontend chat removed; explicit retired guard in `handle_incoming_message`)
- `src/personal_agent/orchestrator_agent.py` (frontend turn handling removed; explicit retired guard in `handle_turn`)
- `src/personal_agent/http_server.py` (explicit `/chat` retired response: HTTP 410 + migration message)

## Keep

- backend services
- state layer
- MCP and knowledge interface layer
- required bridge (`node_bridge/`)
