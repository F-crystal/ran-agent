# AGENTS.md

Status: CURRENT (2026-05-06)

## Scope

- Repo root: this checkout; keep runtime local-first and project-scoped.
- Keep runtime simple: backend services, state layer, bridge, MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.
- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`; this root file is also an official workspace bootstrap file.

## Lookup And Research

- Time-sensitive facts require live lookup first; weather uses `skills/weather/SKILL.md`.
- Non-weather online lookup uses `skills/web-search-live/SKILL.md` (`web_search` then `web_fetch`).
- For complex or unfamiliar problems, first search official documentation and mature prior art before designing or coding.
- For integration/debugging work, especially OpenClaw, WeChat, MCP, model tool-calling, media delivery, deployment, or third-party APIs, the first action must include official docs plus at least one mature GitHub project or real-world implementation unless the user explicitly forbids online lookup.
- Do not present a custom design as the answer until it is compared against official behavior and mature prior art; clearly state when the repo intentionally diverges from those references.
- Do not use `~` paths in tool/file operations; use absolute or workspace-relative paths.

## Skills And Sub-Agents

- Keep specialist capabilities skillized and load them on demand; active inventory is `docs/governance/skills.md`.
- Only heavy background tasks are sub-agent candidates; do not sub-agentize frontline chat, memory main flow, life loop, or todo/reminder main flow.
- Allowed background scope lives in `docs/governance/sub_agents.md`.

## Model And Memory Direction

- OpenClaw frontend and Python backend live chat/runtime traffic must stay on the `claude_code` provider pinned by `openclaw/openclaw.personal-system.json`; agent `model.primary` fields store bare model ids such as `qwen3.5-plus`.
- Do not enable direct `qwen/*` as OpenClaw frontend or Python backend primary/fallback.
- Qwen is allowed only behind the local Claude-compatible path and in the knowledge executor path (`knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`).
- Memory path keeps Ombre integration first; do not replace it without an explicit migration request.

## Reminder And Reflection Direction

- WeChat reminder delivery is off by default: keep `PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false` unless explicitly restoring it.
- Timed todo/reminder capture may still persist rows; outbound reminder delivery should prefer OpenClaw calling Lark/Feishu.
- Reflection/persona evolution is not a purely manual skill flow: `self_reflection_job` and `night_cycle_job` can run in Python backend, and persona evolution may refresh managed `Auto Evolution` blocks.
- If asked whether reflection results are checked or docs updated, do not answer from memory; check scheduler/config/artifacts or state the known pipeline plus uncertainty.

## Governance Docs

- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
