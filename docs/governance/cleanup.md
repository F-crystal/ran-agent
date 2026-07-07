# Cleanup Scope

Status: CURRENT (2026-07-06)

## Deleted (2026-04-13)

- `src/personal_agent/openclaw_front_shell.py` (retired compatibility shell)
- `src/personal_agent/conversation_agent.py` (retired compatibility shell)

## Deleted (2026-05-14, Phase 7-10 OpenClaw Retirement)

- `node_bridge/src/openclawGatewayClient.mjs` (2868 lines, OpenClaw gateway/agent client)
- `node_bridge/src/openclawContextPolicy.mjs` (legacy context policy wrapper)
- `start_openclaw.sh` (OpenClaw startup script)
- `scripts/apply_openclaw_runtime_patches.mjs` (patched openclaw npm dist)
- `scripts/normalize_openclaw_project_paths.py` (path normalization)
- `scripts/openclaw_with_env.sh` (npx openclaw wrapper)
- `scripts/patch_openclaw_personal_skills_warning.mjs` (patched openclaw dist)
- `scripts/connectivity_smoke.sh` (depended on npx openclaw)
- `openclaw/openclaw.personal-system.json` (main OpenClaw config)
- `openclaw/AGENTS.md`, `openclaw/README.md`, `openclaw/README_en.md`, `openclaw/SECURITY_BOUNDARY.md`
- `.openclaw/extensions/todo-tools/openclaw.plugin.json`
- `tests/test_normalize_openclaw_project_paths.py`
- `node_bridge/tests/openclawGatewayClient.test.mjs`
- `node_bridge/tests/openclawContextPolicy.test.mjs`
- `node_bridge/tests/openclawSessionStatusRegression.test.mjs`
- `node_bridge/tests/openclawToolUseWeatherRegression.test.mjs`
- `openclaw/` directory (fully removed)
- `.openclaw/` directory (fully removed)

## Deleted (2026-07-06, MiMo Power Retirement Cleanup)

- `node_bridge/src/mimoPowerMcpServer.mjs` (retired MiMo Token Plan MCP facade)
- `node_bridge/tests/mimoPowerMcpServer.test.mjs` (tests for removed facade)
- `scripts/start_mimo_power_mcp.sh` (retired MiMo startup wrapper)

## Archived (2026-05-14)

- `openclaw/calendar-reminder-workflow.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/feishu-voice-message-workflow.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/image-deduplication-design.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/time-context-checklist.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/xhs_browse_search_implementation_notes.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/xhs_browse_upgrade_review.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/xhs_browse_upgrade_review_v3.md` -> `local_archive/docs/design/openclaw/`
- `openclaw/xhs-browse-implementation-report.md` -> `local_archive/docs/design/openclaw/`

## Moved (2026-05-14)

- `openclaw/HERMES_MEMORY.md` -> `hermes/profile/HERMES_MEMORY.md`
- `openclaw/HERMES_RUNTIME.md` -> `hermes/profile/HERMES_RUNTIME.md`
- `openclaw/HERMES_USER.md` -> `hermes/profile/HERMES_USER.md`

## Keep

- backend services
- state layer
- MCP and knowledge interface layer
- required bridge (`node_bridge/`)
