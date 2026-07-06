# Runtime Constraints

Status: CURRENT (2026-07-02)

## Split Of Responsibility

- Repo-global constraints live here and in `AGENTS.md`.
- Hermes-specific runtime constraints live in `hermes/profile/AGENTS.md` and should not be duplicated here.

## Research Before Implementation

- For complex or unfamiliar changes, do not start implementation from scratch. First check official documentation, upstream references, and at least one mature tutorial or proven solution.
- Use prior art to shape the design before coding; if no reliable prior art exists, call that out explicitly.

## Real Mainlines

- Chat mainline: `WeChat -> Node bridge -> Hermes gateway -> DeepSeek V4 Flash -> reply`
- Media pipeline: `raw messages -> logical turn (inbound message buffer) -> media asset -> media artifact -> conversation media context -> Hermes reply`
- Scheduled digest mainline: `scheduler -> AIHOT facts -> synthetic Feishu turn -> Hermes -> Feishu reply`
- External MCP candidate mainline: `external_mcp_gateway -> admission/registry/executor/policy/session/evidence/activity -> optional ProactiveEvent synthetic Hermes turn`; source profiles fall back disabled, while standard server deploy enables the gateway, proactive event, and system queue env gates.
- Knowledge mainline: `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`
- OpenClaw, Kimi, GLM, and MiMo Power are retired. Hermes (DeepSeek V4) is the sole frontend.
- Life-loop and reflection remain backend/support layers. They are not an
  open-ended proactive outbound mainline. Explicit reminders may notify only as
  structured ProactiveEvents; the allowlisted AI daily digest keeps its separate
  scheduled Feishu/Hermes path.
- External MCP proactive is not a reopened life-loop. It may only be considered
  for explicit watchlist/关注 scopes, trusted external MCP evidence-log refs,
  rate budget, and a synthetic Hermes turn from `/external-mcp/system-queue`.
  Caller-supplied evidence strings or tier lists are not evidence; the evidence
  log entry must match the same user, server, non-empty watch scope, and
  server-derived safe tier. `silent`/`remember`/`draft`/malformed outputs do not
  send visible text; budget uses a short reservation lease that is released when
  Hermes stays silent or delivery fails.

## Specialist Boundaries

- Specialists are skillized and on-demand only.
- Do not keep all specialist blocks in default turn context.
- Memory, reflection, knowledge-state, life-loop, night-cycle, ombre-memory remain support layers.
- The scheduled AI daily digest is an explicit allowlist path and must not be
  generalized into open-ended proactive check-ins.
- `external_mcp_gateway` is a broker, not a replacement for `social_reader`,
  `media_reader`, `search_hub`, `sticker_catalog`, or `co_reading`. Untrusted
  external MCP descriptions, schemas, and results must be normalized and
  classified before Hermes sees them.
- Hermes may self-admit only safe remote HTTPS sandbox activity MCPs after
  probe/classify/SSRF checks. Local executable MCPs (`stdio`, command, `uvx`,
  `npx`), OAuth/account/file/local-command surfaces, high-risk tools, and write
  tools cannot be self-enabled and require owner handling or denial.
- Autonomous game/read activity must run inside a scoped activity grant with
  call/time/share budgets. T4/T5 side effects, forum/social/payment/delete/account
  writes, and `external_mcp_write` actions require pending action/待确认 or a
  trusted scoped grant plus real executor evidence. Hermes must not claim
  success from a planned, denied, or budget-exhausted external MCP call.

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
