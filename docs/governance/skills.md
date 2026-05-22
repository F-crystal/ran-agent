# Skills Map

Status: CURRENT (2026-05-22)

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

## Loading Rule

- Default chat turn loads only what is needed for that turn.
- Do not preload all specialist skills into baseline prompt context.
- Heavy/background operations should be delegated via sub-agent candidates only.
- GitHub commit/push/archive requests must use `archive-and-push` so staging,
  commit, and push stay consistent and runtime/private files remain excluded.

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
