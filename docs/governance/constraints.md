# Runtime Constraints

Status: CURRENT (2026-05-01)

## Split Of Responsibility

- Repo-global constraints live here and in `AGENTS.md`.
- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md` and should not be duplicated here.

## Research Before Implementation

- For complex or unfamiliar changes, do not start implementation from scratch. First check official documentation, upstream references, and at least one mature tutorial or proven solution.
- Use prior art to shape the design before coding; if no reliable prior art exists, call that out explicitly.

## Real Mainlines

- Chat mainline (target lock):
  - `WeChat -> Node bridge -> OpenClaw frontend -> Claude Code primary -> reply -> WeChat`
- Proactive mainline:
  - `scheduler -> life-loop skill -> orchestrator judgment -> front speaker -> Node bridge`
- Knowledge mainline:
  - `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`
- OpenClaw frontend must not use direct `qwen/*` provider paths. The active frontend primary is `claude_code/qwen3.5-plus` with empty fallbacks; Qwen Code belongs only to the knowledge mainline above.
- Kimi and GLM are retired as OpenClaw frontend primary/fallback candidates and should not be present in active automatic routing config.

## Specialist Boundaries

- Specialists are skillized and on-demand only.
- Do not keep all specialist blocks in default turn context.
- Memory, reflection, knowledge-state, life-loop, night-cycle, ombre-memory remain support layers.

## Companion Reply Quality

- OpenClaw frontline replies should fit 微信陪伴聊天: short, natural, warm, and not clingy.
- Persona/bootstrap text should prevent meta narration, analysis leakage, hidden tool routing, and unsolicited long reports.
- Ordinary casual chat should stay conversational; do not automatically convert it into advice, task management, diagnosis, or a structured status report.
- Command-like reset triggers such as `/new` and `/reset` should receive only a short confirmation unless the user asks for mechanics.

## Sub-Agent Boundaries

Allowed sub-agent candidates (heavy/background only):

- reflection
- knowledge maintenance
- exploration
- heavy inspect_more

Not allowed as peer front sub-agents:

- frontline chat
- memory main flow
- life loop

## Technical Limits

Unless explicitly requested, do not introduce:

- local LLM deployment
- vector DB / embeddings retrieval
- heavy agent frameworks
- browser automation
- voice input/output
- cloud database

## OpenClaw Local Contract

- For frontline lock, heartbeat cadence, and todo/reminder behavior, read `openclaw/AGENTS.md`.
- Keep the local OpenClaw config project-scoped in `openclaw/openclaw.personal-system.json`.
- `openclaw/openclaw.personal-system.json` enables the bundled `bootstrap-extra-files` hook so `openclaw/AGENTS.md` is loaded at bootstrap.
- Keep runtime changes in the OpenClaw subtree aligned with the local AGENTS file rather than duplicating constraints here.

## Security Scope

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
