# AGENTS.md

Status: CURRENT (2026-05-10)

## Scope

This is the repo-root workspace bootstrap file, loaded by both OpenClaw and Codex. It must be self-contained — do not reference `CLAUDE.md` or `openclaw/AGENTS.md` as required reading for rules defined here. OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`; this root file is also an official workspace bootstrap file.

## Execution Scope

- This repo is local-first and project-scoped.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.

## Live Lookup Rule

- For time-sensitive facts (news, prices, schedules, policy updates, product changes), perform web lookup first, then answer.
- Weather queries use `skills/weather/SKILL.md`.
- Non-weather online lookup uses `skills/web-search-live/SKILL.md`.
- For complex or unfamiliar problems, first search official documentation and mature prior art before designing or coding.
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

## Reflection And Persona Direction

- Reflection/persona evolution is not a purely manual skill flow: `self_reflection_job` and `night_cycle_job` run in Python backend; persona evolution may refresh managed `Auto Evolution` blocks in `IDENTITY.md`/`SOUL.md`.
- If asked whether reflection results are checked or docs updated, do not answer from memory; check scheduler/config/artifacts or state the known pipeline plus uncertainty.

## Security

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
- Never commit: `.env.local`, `.openclaw_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.
- Platform resolver credentials (SESSDATA, XHS_COOKIE, proxy URLs) must never appear in tool output, logs, docs, or git.

## Governance Docs

- Media pipeline: `docs/governance/media-pipeline.md`
- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
- Runtime status: `docs/governance/current_runtime_status.md`
