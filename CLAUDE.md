# CLAUDE.md

Status: CURRENT (2026-04-15)

## Execution Scope

- This repo is local-first and project-scoped only.
- Keep runtime simple: backend services, state layer, bridge, and MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.

## OpenClaw Local Contract

- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`.
- The local OpenClaw config remains project-scoped in `openclaw/openclaw.personal-system.json`.
- If you are changing OpenClaw behavior, update the local AGENTS file rather than duplicating the contract here.

## Live Lookup Rule

- For time-sensitive facts (news, prices, schedules, policy updates, product changes), perform web lookup first, then answer.
- Weather queries should use workspace skill override: `skills/weather/SKILL.md`.
- For non-weather online lookup, use `skills/web-search-live/SKILL.md` flow (`web_search` then `web_fetch`).
- Do not use `~`-prefixed filesystem paths in tool/file operations; use absolute paths or workspace-relative paths only.

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

Do not keep all specialist context always loaded in every turn.

## Sub-Agent Rule

Only heavy background tasks are sub-agent candidates:

- reflection
- knowledge maintenance
- exploration
- heavy `inspect_more`

Do not sub-agentize:

- frontline chat
- memory main flow
- life loop
- todo capture/reminder main flow

## Knowledge And Memory Direction

- Knowledge management stays on product path: `knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`.
- Memory path keeps current Ombre integration first; do not replace with new memory stack without explicit migration request.

## Governance Docs

- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
