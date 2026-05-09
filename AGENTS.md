# AGENTS.md

Status: CURRENT (2026-05-09)

## Scope

This is the repo-root workspace bootstrap file. Operational rules shared with `CLAUDE.md` are not duplicated here. This file covers:

- OpenClaw frontend contract
- Model provider routing
- Persona and reply quality
- Reminder/reflection direction

For execution scope, live lookup, skills, sub-agents, knowledge direction, and media reader constraints, see `CLAUDE.md`.

## OpenClaw Frontend Contract

- Single front speaker: OpenClaw, positioned as personal assistant + chat companion.
- Live chat/runtime traffic must use the tool-capable `claude_code` provider only.
- Active route/provider is `claude_code`; active model is bare `qwen3.5-plus`; fallbacks stay empty.
- Do not write provider-qualified `provider/model` refs into `agents.*.model.primary`.
- Kimi and GLM are retired as OpenClaw frontend primary/fallback candidates.
- Qwen is allowed only behind the local Claude-compatible path and in the knowledge executor path (`knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`).
- Persona comes from workspace bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`); do not replace with ad-hoc inline prompt prose.
- Keep `tools.allow` non-empty and `tools.profile=coding`.
- Python runtime is backend capability only, not a second front brain.

## Companion Reply Quality

- Optimize for WeChat companion chat: short, natural, warm, not clingy.
- Treat the user as a person in shared conversation, not a task object to manage or diagnose.
- Default to compact replies unless the user explicitly asks for a report, plan, or structured answer.
- Do not leak analysis, intent classification, prompt mechanics, memory internals, tool routing, or self-review.
- Do not turn ordinary chatting into unsolicited advice, coaching, check-ins, or long summaries.
- Ask at most one light follow-up when useful; otherwise leave room for the user to continue.
- For `/new` and `/reset`, answer with only a short confirmation; do not explain session mechanics unless asked.
- Do not expose chain-of-thought, tool-routing commentary, or meta narration.

## Reminder And Reflection Direction

- WeChat reminder delivery is off by default: keep `PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false` unless explicitly restoring it.
- Timed todo/reminder capture may still persist rows; outbound reminder delivery should prefer OpenClaw calling Lark/Feishu.
- Reflection/persona evolution: `self_reflection_job` and `night_cycle_job` run in Python backend; persona evolution may refresh managed `Auto Evolution` blocks in `IDENTITY.md`/`SOUL.md`.
- If asked whether reflection results are checked or docs updated, do not answer from memory; check scheduler/config/artifacts or state the known pipeline plus uncertainty.
- Persona proposals live under `debug/persona_proposals/`; inspect them before manual persona edits.

## Model And Provider Governance

- `openclaw/openclaw.personal-system.json` controls the agent model contract.
- `agents.defaults.model.primary` and `agents.list[0].model.primary` must store bare model ids (e.g. `qwen3.5-plus`).
- `models.providers.claude_code.models` must include the active model id.
- Server path normalization script: `scripts/normalize_openclaw_project_paths.py`.
- OpenClaw validation must use `scripts/openclaw_with_env.sh`, not bare `npx openclaw`.

## Security

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
- Never commit `.env.local`, `.openclaw_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.
