# Cleanup Scope

Status: CURRENT (2026-08-17)

## Deleted (2026-08-17, Owner-Authorized Aggressive Cleanup)

Python dead code:

- `src/personal_agent/ombre_brain_mcp.py` + `tests/test_ombre_brain_mcp.py`
  (standalone reimplementation, self-test only)
- `src/personal_agent/proactive_support.py` (zero repo references)
- `scripts/read_claude_settings_env.py` + `tests/test_read_claude_settings_env.py`
  (orphan pair)

Node dead code:

- `node_bridge/src/desktopPresence.mjs` + test (uncomposed per R1F)
- `node_bridge/src/core/coreManagedWakeManifest.mjs` + test (live wake path
  reads `core_managed_wake.v1.json` directly)
- `node_bridge/src/externalMcp/experienceRanking.mjs` + test (zero importers)

Orphan scripts and stale root docs:

- `scripts/diagnose-social-reader.sh`, `scripts/diagnose-sticker-catalog.sh`
  (zero refs)
- `scripts/install_playwright_mcp.sh` (zero refs)
- `scripts/phase5_hermes_gateway_smoke.sh` + `scripts/phase5_hermes_full_chain_smoke.mjs`
  (Phase 5 closed)
- `scripts/tavily-search.sh` + `scripts/claude-deep-search.sh` + root `TOOLS.md`
  (only referenced each other; contradict the search_hub mainline)
- root `HEARTBEAT.md` (stale orphan; superseded by `hermes/profile/AGENTS.md`
  proactive boundary)

Governance docs:

- `docs/governance/s12-r1b-web-routing.md` (one-off completed; inbound refs updated)
- `docs/governance/sub_agents.md` (content duplicated in `AGENTS.md`)
- `docs/governance/mimo-power-mcp.md` (merged here; the 2026-07-06 retirement
  record above is the canonical MiMo Power note)

Local artifacts (untracked, irreversible):

- `debug/`: p1-production-inventory, p2-ombre-recall-contract,
  p3-runtime-comparison, post-p3-composed-gates, cron-core-v05,
  s6-draft-snapshot-20260808 (all completed phases; the retired-O2 draft bundle
  went with them)
- `local_archive/` 340MB -> ~4MB: `runtime/builder-inputs` + `runtime/artifacts`
  (rebuildable; digests pinned in governance JSONs; installed copy on server),
  100 old archive-and-push journals (2026-08-17 frontier kept), July
  workflow-evidence files, worktree-retirement, agent-governance-wip-park
  evidence, s10-migration-rehearsal, `recovery/` (two completed transactions),
  `debug/worktree-convergence-20260808`, `docs/design/*` except `openclaw/`
  (named retention), `docs/deployment/*` except the referenced cloudflare guide
- caches: `.pytest_cache`, `.playwright-mcp`, `node_bridge/.tmp-test-*`,
  `__pycache__`, `.DS_Store`

Kept deliberately (evidence overrode the deletion recommendation):

- `scripts/provision-fastembed-model.py` — `vector_memory_index.py` uses
  `local_files_only=True`; this script is the only offline model provisioning
  path for fresh deploys
- `node_bridge/src/core/ombreProjectionService.mjs` + test — dead in code
  today, but it is the owner-authorized S8 projector that H1/T4c plans to
  compose (`docs/governance/hermes-playground-boundary.md`)
- `node_bridge/src/ombreRecallMcpServer.mjs` + `ombreRecallPolicy.mjs` (retired
  18002 recall service) — deletion deferred: the release acceptance chain still
  probes its toolset (`accept-hermes-release.sh`,
  `apply-hermes-runtime-split.sh`); removal needs a scoped release-chain scrub
- `node_bridge/src/quickAck.mjs` — env keys entangled with release-chain
  script assertions; deferred
- S12 one-off transaction set (`scripts/s12-cutover.py`, `core-cutover.mjs`,
  `core-s12-acceptance.mjs`, `rehearse-core-schedule-migration.mjs`,
  `core/coreCutoverCommand.mjs`, `coreS12Acceptance.mjs`,
  `coreScheduleCutover.mjs`, `coreSystemSchedules.mjs` + paired tests) —
  deferred to S13, its owning stage
- `local_archive/vault-config/` (personal config snapshots),
  `local_archive/runtime/task-state/remove-ran-agent-linux-account` (blocked
  live task), `debug/persona_proposals/` (live runtime output)

## Deleted (2026-08-06, Unified Hermes Runtime Cleanup)

- Three terminal `rolled-back` Runtime snapshots from failed/superseded v0.20
  attempts (about 638 MiB total). The accepted `0b793e8` controller, candidate
  ref and snapshot remain the sole Runtime rollback authority set.
- Exact server `/tmp` candidate stages, duplicate artifact copy and transfer
  bundle used by the accepted Runtime transaction.

The retired Full unit is inactive, disabled and condition-blocked. Live v0.13
executables remain until the accepted rollback window closes; personal data,
shared runtimes and the unified Lite/Full capability surface were not deleted.

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
