# Skills Map

Status: CURRENT (2026-08-08)

## Active Skills (On-Demand)

- `memory-specialist`
- `reflection-specialist`
- `knowledge-state`
- `life-loop`
- `night-cycle`
- `ombre-memory`
- `weather`
- `web-search-live`
- `archive-and-push`
- `code-simplifier`
- `context-compact`
- `aihot`
- `doc-governance`
- `server-runtime`
- `topology-work-planning`

## Loading Rule

- Default chat turn loads only what is needed for that turn.
- Do not preload all specialist skills into baseline prompt context.
- Heavy/background operations should be delegated via sub-agent candidates only.
- GitHub commit/push/archive requests must use `archive-and-push` so staging,
  commit, and push stay consistent and runtime/private files remain excluded.
- Server deployment, runtime drift, lite/full, systemd/env, MCP exposure, and
  one-command rollout requests must use `server-runtime`.
- Staged or parallel project work must use `topology-work-planning` so ready
  nodes, write ownership, integration order, and public state stay aligned with
  the canonical dependency topology.

## Delivery Evidence

- High-risk implementation and acceptance work follows
  [`delivery-evidence.md`](delivery-evidence.md).
- Use `scripts/workflow_guard.py verify` as the one-command high-risk completion
  entry point; use explicit snapshot/run commands for long validation windows.
  It is a project tool and instruction, not a host hook or plugin.
- Do not create a new feasibility or acceptance skill until real-task failures
  show that the existing project entry scan and independent review are
  insufficient.

## Skill Sources

- `skills/memory-specialist/SKILL.md`
- `skills/reflection-specialist/SKILL.md`
- `skills/knowledge-state/SKILL.md`
- `skills/life-loop/SKILL.md`
- `skills/night-cycle/SKILL.md`
- `skills/ombre-memory/SKILL.md`
- `skills/weather/SKILL.md`
- `skills/web-search-live/SKILL.md`
- `skills/archive-and-push/SKILL.md`
- `skills/code-simplifier/SKILL.md` (adapted from Anthropic `claude-plugins-official/plugins/code-simplifier`)
- `skills/context-compact/SKILL.md`
- `skills/aihot/SKILL.md`
- `skills/doc-governance/SKILL.md`
- `skills/server-runtime/SKILL.md`
- `skills/topology-work-planning/SKILL.md`
