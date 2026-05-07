# Hermes Runtime Budget

Status: CURRENT (2026-05-01)

OpenClaw remains the single frontline speaker on `claude_code/qwen3.5-plus`.
Keep `qwen3.5-plus` as the bare Qwen alias, with no automatic fallbacks. Kimi and GLM are retired as frontend primary/fallback candidates and stay out of active automatic routing config.
Hermes is a budget discipline, not the runtime/provider.

Budgets:
- continuity <= 1200 chars
- daily <= 600 chars
- reflection <= 600 chars
- vault recall <= 1 hit
- vault snippet <= 240 chars
- heartbeat = 90m

Success means lower live token use, not extra per-turn maintenance calls.
