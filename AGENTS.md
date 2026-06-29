# AGENTS.md

Status: CURRENT (2026-06-30)

## Scope

This is the canonical repo-root rule file for agents in this checkout. It must stay self-contained for repo-wide rules. Tool-specific mirrors, including `CLAUDE.md`, must point here instead of duplicating these rules. Hermes runtime constraints live in `hermes/profile/AGENTS.md`.

## Operating Rules

- Keep work local-first and project-scoped unless the user explicitly asks for global agent configuration.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces. Do not expand a custom front conversation runtime.
- OpenClaw, Kimi, GLM, and MiMo Power are retired as current runtime, deployment, or debugging authorities. Treat `openclaw-*` names and `.openclaw_state` only as legacy compatibility artifacts.
- For time-sensitive facts, perform live lookup before answering. Weather uses `skills/weather/SKILL.md`; other online lookup uses `skills/web-search-live/SKILL.md`.
- For unfamiliar integration/debugging work, check official docs and mature prior art before designing or coding.
- Use absolute paths or workspace-relative paths, not `~`-prefixed paths.

## Skills And Delegation

- Load specialist skills on demand; do not preload all specialist context.
- Skill map: `docs/governance/skills.md`.
- Archive, commit, push, or GitHub sync requests must use `skills/archive-and-push/SKILL.md`.
- Server deployment, lite/full runtime, systemd/env, or MCP exposure work must use `skills/server-runtime/SKILL.md`.
- Documentation governance work must use `skills/doc-governance/SKILL.md`.
- Use sub-agents only for heavy background tasks, exploration, or maintenance. Do not sub-agentize frontline chat, memory main flow, life loop, or todo/reminder main flow.

## Agent Capability Governance

- Cross-tool desktop skills live in `/Users/fengran/.agents/skills`; project-only skills stay in this repo's `skills/`.
- Hooks, plugins, and MCP entries are executable capability surfaces; record changes in `/Users/fengran/.agents/hook-policy/` or `/Users/fengran/.agents/plugin-inventory/`.
- Do not edit tool-specific skill copies directly; use per-skill symlinks from the shared source.
- These `/Users/fengran` paths govern the local desktop agent setup only. Server runtime under `/opt/ran_agent` is governed by `skills/server-runtime/SKILL.md` and `docs/governance/server_runtime_commands.md`.

## Security And Git

- Keep owner-only posture for high-permission actions.
- Never expose or commit credentials, cookies, tokens, session dumps, local caches, SQLite state, env files, raw private archives, or logs that contain secrets.
- Never commit: `.env.local`, `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.
- Before committing, stage only intentional source, tests, scripts, and public docs.
- Platform resolver credentials such as SESSDATA, XHS_COOKIE, or proxy URLs must never appear in tool output, logs, docs, or git.

## Governance References

- Documentation index and conflict rule: `docs/governance/doc_status.md`.
- Current runtime status: `docs/governance/current_runtime_status.md`.
- Server runbook: `docs/governance/server_runtime_commands.md`.
- Agent capability governance: `docs/governance/agent-capability-governance.md`.
