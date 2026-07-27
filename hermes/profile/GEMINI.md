@./AGENTS.md

## Agent Capability Governance

- Cross-tool skills live in `/Users/fengran/.agents/skills`; project-only skills stay in this repo's `skills/`.
- Hooks, plugins, and MCP entries are executable capability surfaces; record new or changed entries in `/Users/fengran/.agents/hook-policy/` or `/Users/fengran/.agents/plugin-inventory/`.
- Do not edit tool-specific skill copies directly; use per-skill symlinks from the shared source.
