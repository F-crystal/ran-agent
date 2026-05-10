# Runtime Constraints

Status: CURRENT (2026-05-10)

## Split Of Responsibility

- Repo-global constraints live here and in `AGENTS.md`.
- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md` and should not be duplicated here.

## Research Before Implementation

- For complex or unfamiliar changes, do not start implementation from scratch. First check official documentation, upstream references, and at least one mature tutorial or proven solution.
- Use prior art to shape the design before coding; if no reliable prior art exists, call that out explicitly.

## Real Mainlines

- Chat mainline: `WeChat -> Node bridge -> OpenClaw frontend -> Claude Code primary -> reply`
- Media pipeline: `raw messages -> logical turn (inbound message buffer) -> media asset -> media artifact -> conversation media context -> OpenClaw reply`
- Proactive mainline: `scheduler -> life-loop skill -> orchestrator judgment -> front speaker -> Node bridge`
- Knowledge mainline: `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`
- OpenClaw frontend must not use direct `qwen/*` provider paths. Active route/provider is `claude_code` with bare model `qwen3.5-plus` and empty fallbacks.
- Kimi and GLM are retired as OpenClaw frontend primary/fallback candidates.

## Specialist Boundaries

- Specialists are skillized and on-demand only.
- Do not keep all specialist blocks in default turn context.
- Memory, reflection, knowledge-state, life-loop, night-cycle, ombre-memory remain support layers.

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

## Security Scope

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
