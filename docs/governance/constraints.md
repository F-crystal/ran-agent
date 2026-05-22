# Runtime Constraints

Status: CURRENT (2026-05-22)

## Split Of Responsibility

- Repo-global constraints live here and in `AGENTS.md`.
- Hermes-specific runtime constraints live in `hermes/profile/AGENTS.md` and should not be duplicated here.

## Research Before Implementation

- For complex or unfamiliar changes, do not start implementation from scratch. First check official documentation, upstream references, and at least one mature tutorial or proven solution.
- Use prior art to shape the design before coding; if no reliable prior art exists, call that out explicitly.

## Real Mainlines

- Chat mainline: `WeChat -> Node bridge -> Hermes gateway -> DeepSeek V4 Flash -> reply`
- Media pipeline: `raw messages -> logical turn (inbound message buffer) -> media asset -> media artifact -> conversation media context -> Hermes reply`
- Proactive mainline: `scheduler -> life-loop skill -> orchestrator judgment -> front speaker -> Node bridge`
- Knowledge mainline: `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`
- Kimi, GLM, and OpenClaw are retired. Hermes (DeepSeek V4) is the sole frontend.

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

## Hermes Local Contract

- For frontline lock, heartbeat cadence, and todo/reminder behavior, read `hermes/profile/AGENTS.md`.
- Keep the local Hermes config project-scoped in `hermes/profile/config.yaml`.

## Security Scope

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
