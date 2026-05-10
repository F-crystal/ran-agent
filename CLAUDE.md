# CLAUDE.md

Status: CURRENT (2026-05-10)

## Execution Scope

- This repo is local-first and project-scoped.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.

## OpenClaw Local Contract

- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`.
- The local OpenClaw config remains project-scoped in `openclaw/openclaw.personal-system.json`.
- If you are changing OpenClaw behavior, update the local AGENTS file rather than duplicating the contract here.

## Live Lookup Rule

- For time-sensitive facts (news, prices, schedules, policy updates, product changes), perform web lookup first, then answer.
- Weather queries use `skills/weather/SKILL.md`.
- Non-weather online lookup uses `skills/web-search-live/SKILL.md`.
- For integration/debugging work, first check official docs plus at least one mature GitHub reference before designing a solution.
- Do not use `~`-prefixed filesystem paths; use absolute paths or workspace-relative paths only.

## Skills-First Rule

Specialist capabilities must stay skillized and loaded on demand:

- `skills/memory-specialist/SKILL.md`
- `skills/reflection-specialist/SKILL.md`
- `skills/knowledge-state/SKILL.md`
- `skills/life-loop/SKILL.md`
- `skills/night-cycle/SKILL.md`
- `skills/ombre-memory/SKILL.md`
- `skills/weather/SKILL.md`
- `skills/web-search-live/SKILL.md`
- `skills/context-compact/SKILL.md`
- `skills/reminder/SKILL.md`
- `skills/archive-and-push/SKILL.md`
- `skills/doc-governance/SKILL.md`

Do not keep all specialist context always loaded in every turn.

## Sub-Agent Rule

Only heavy background tasks are sub-agent candidates: reflection, knowledge maintenance, exploration, heavy `inspect_more`. Do not sub-agentize: frontline chat, memory main flow, life loop, todo capture/reminder main flow.

## Media Pipeline

- MCP servers (`media_reader`, `social_reader`, `media_generation`, `mimo_power`) are the stable facade; do not expose internal tools to OpenClaw directly.
- Full pipeline: raw messages -> logical turn (inbound message buffer) -> media asset -> media artifact -> conversation media context -> OpenClaw reply. Details in `docs/governance/media-pipeline.md`.
- External media files (e.g. WeChat SDK /tmp files) are auto-copied to trusted dirs before processing.
- Platform resolver credentials must never appear in tool output, logs, docs, or git.

## Security

- Keep reads and writes inside the current repository checkout.
- Never commit: `.env.local`, `.openclaw_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.

## Governance Docs

- Media pipeline: `docs/governance/media-pipeline.md`
- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
- Runtime status: `docs/governance/current_runtime_status.md`
