# Hermes Runtime Budget

Status: CURRENT (2026-08-18)

Hermes is the single frontline speaker. Source and production use one unified
companion profile with `deepseek-v4-flash` and final provider-body
`thinking.type=disabled`. `deepseek-v4-pro` is explicit opt-in only.
Kimi, GLM, OpenClaw, and MiMo Power stay out of active automatic routing.

Budgets:
- continuity <= 1200 chars
- daily <= 600 chars
- reflection <= 600 chars
- vault recall <= 1 hit
- vault snippet <= 240 chars
- heartbeat = 90m

Success means lower live token use, not extra per-turn maintenance calls.
