# Hermes Runtime Budget

Status: CURRENT (2026-07-27)

Hermes is the single frontline speaker. The local integration candidate uses
`deepseek-v4-pro` for Lite and Full with final provider-body
`thinking.type=disabled`; production remains on the owner-supplied Flash line.
Kimi, GLM, and OpenClaw are retired as frontend primary/fallback candidates and stay out of active automatic routing config.

Budgets:
- continuity <= 1200 chars
- daily <= 600 chars
- reflection <= 600 chars
- vault recall <= 1 hit
- vault snippet <= 240 chars
- heartbeat = 90m

Success means lower live token use, not extra per-turn maintenance calls.
