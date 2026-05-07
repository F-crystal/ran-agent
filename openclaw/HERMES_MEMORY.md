# Hermes Memory Budget

Status: CURRENT (2026-04-20)

Use Ombre/SQLite/vault as storage. Inject only recalled short context.

Live budgets:
- memory <= 600 chars
- proactive memory clue <= 300 chars
- recent user messages <= 3
- working memories <= 2
- profile memories <= 3

Never store raw chat logs, full notes, tool output, secrets, or speculation here.
Low-frequency maintenance may clean/promote memory; per-turn maintenance is forbidden.
