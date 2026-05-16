# Phase Status

Status: CURRENT (2026-05-17)

## Phase 5: Hermes Profile And Gateway

Phase 5 is code-closed.

Scope:

- Repo-local Hermes profile distribution under `hermes/profile/`.
- Gateway wrapper and Node bridge Hermes reply path.
- Project-local Hermes home and cache defaults for install/run checks.

Phase 5 scripts:

- `scripts/phase5_hermes_gateway_smoke.sh`
- `scripts/phase5_hermes_full_chain_smoke.mjs`

Default Phase 5 behavior is intentionally minimal. It checks only the Hermes
gateway text-reply path by default. Python backend, memory bridge, Obsidian,
social platform readers, media generation, MiMo, and other external MCP tool
exercises are opt-in only and must not block Phase 5 closure.

The old `phase6_hermes_*` script names were incorrect and have been removed.
The Phase 6 name is reserved for Python backend and memory bridge work.

## Phase 6: Python Backend And Memory Bridge

Phase 6 is code-closed for the backend/memory bridge boundary.

Scope:

- Python backend readiness for memory-facing operations.
- `/ingest` and recall/update behavior used by the Node bridge.
- `personal_memory` MCP bridge behavior.
- Obsidian memory/index bridge boundaries and maintenance defaults.
- Documentation alignment for backend, memory, and bridge ownership.

Active code anchors:

- `src/personal_agent/http_server.py` owns `/ingest`, `/tools/memory/recall`,
  and `/tools/memory/update`.
- `src/personal_agent/service.py` owns memory recall/update orchestration and
  deferred post-reply memory extraction.
- `node_bridge/src/backendIngestClient.mjs` owns Node bridge `POST /ingest`.
- `node_bridge/src/personalMemoryMcpServer.mjs` owns the `personal_memory` MCP
  bridge to Python backend recall.
- `scripts/start_personal_memory_mcp.sh` owns process launch for the memory MCP
  bridge.
- `scripts/start_obsidian_memory_mcp.sh` owns Obsidian index MCP launch and
  must remain an explicit maintenance/runtime concern, not a Phase 5 blocker.

Completed boundary changes:

- Node bridge backend ingest now has an explicit timeout via
  `PYTHON_BACKEND_INGEST_TIMEOUT_MS` with a 5000 ms default.
- `personal_memory` MCP exposes `check_personal_memory_backend` for backend
  reachability without reading or writing memory.
- `personal_memory` recall calls now have an explicit timeout via
  `PERSONAL_MEMORY_BACKEND_TIMEOUT_MS` with a 5000 ms default.
- Obsidian memory remains outside Phase 5 closure and remains explicit
  runtime/maintenance scope.
- Hermes profile now carries the migrated companion identity and reply-quality
  contract from the OpenClaw-era foreground files.

Phase 6 must not re-open Phase 5 acceptance or require rerunning Phase 5
external MCP exercises unless the owner explicitly requests it.

## Phase 7: Remove OpenClaw Reply Path

Phase 7 is code-closed.

Scope:
- Remove `openclaw` branch from `replyBackend.mjs`.
- Delete `openclawGatewayClient.mjs` (2868 lines).
- Extract DashScope media functions to `dashscopeMediaClient.mjs`.
- Clean up `start_node.sh` to Hermes-only mode.

## Phase 8: Remove OpenClaw Infrastructure

Phase 8 is code-closed.

Scope:
- Delete OpenClaw scripts, config, npm dependency.
- Migrate `OPENCLAW_*` env vars to `RAN_AGENT_*`.
- Move HERMES_*.md budget files to `hermes/profile/`.

## Phase 9: State Directory Migration

Phase 9 is code-closed.

Scope:
- Rename `.openclaw_state/` references to `.ran_agent_state/`.
- Rename `openclaw-weixin` path segments to `ran-agent-weixin`.

## Phase 10: Python Backend Model Client Replacement

Phase 10 is code-closed.

Scope:
- Replace `OpenClawChatCompletionsModelClient` with `HermesChatCompletionsModelClient`.
- Python backend now calls Hermes gateway (DeepSeek V4) instead of OpenClaw gateway.

## Phase 11: Search Hub MCP

Phase 11 is code-closed for Search Hub source/runtime convergence.

Scope:
- Add `search_hub` MCP as the unified frontend entry for fresh web facts,
  news, academic search, AI hot topics, normal URL reading, and platform search
  routing.
- Register `mcp-search_hub` in both `ran-assistant-lite` and `ran-assistant`.
- Keep lite/full split inside Search Hub provider mode: lite uses lightweight
  public providers; full can enable OpenCLI browser-backed adapters and
  Playwright fallback.
- Keep social platform link reading on `social_reader`; Search Hub does not
  replace the XHS/Bilibili/Zhihu/WeChat link-read mainline.
- Wire Search Hub into `scripts/apply-hermes-runtime-split.sh` so git pull,
  profile reinstall, and service restart converge runtime config without
  hand-editing `/home/ubuntu/.hermes-ran-agent`.

## Migration Checklist

- [x] Close Hermes profile/gateway script naming under Phase 5.
- [x] Close Python backend and personal memory bridge boundary under Phase 6.
- [x] Move server runtime from temporary Hermes home to
  `/home/ubuntu/.hermes-ran-agent`.
- [x] Move Node bridge systemd routing from OpenClaw gateway to Hermes gateway.
- [x] Migrate OpenClaw companion tone into Hermes profile identity and soul.
- [x] Remove OpenClaw reply path from Node bridge (Phase 7).
- [x] Remove OpenClaw infrastructure and npm dependency (Phase 8).
- [x] Migrate state directory from `.openclaw_state` to `.ran_agent_state` (Phase 9).
- [x] Replace Python backend model client with Hermes (Phase 10).
- [x] Add Search Hub MCP and lite/full provider-mode runtime convergence (Phase 11).
- [x] Update all documentation to reflect OpenClaw-free state.
