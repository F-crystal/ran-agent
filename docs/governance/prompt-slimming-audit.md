# Prompt Slimming Audit

Status: CURRENT (2026-05-15)

## Scope

Audited prompt/style duplication across:

- `hermes/profile/SOUL.md`
- `hermes/profile/AGENTS.md`
- `node_bridge/src/hermesGatewayClient.mjs`
- `src/personal_agent/reply_reviewer.py`
- `node_bridge/src/contextPolicy.mjs`
- `docs/governance/server_runtime_commands.md`
- `scripts/diagnose-lite-full.sh`

## Repeated Rule Types Found

### Persona Rules

- `SOUL.md` carried the long-term courtly attendant identity.
- `hermesGatewayClient.mjs` injected a courtly style anchor every turn.
- `courtly-attendant` skill also documents examples, but it is on-demand and not part of the default prompt.

Resolution: `SOUL.md` now owns long-term persona. Gateway keeps only a short per-turn style anchor: respond to the current topic, avoid mechanism talk, keep titles sparse, and give executable technical steps.

### Tool Rules

- `AGENTS.md` described DeepSeek text-only, media tools, social tools, and banned Hermes native tools.
- `hermesGatewayClient.mjs` repeated those rules in a long `MANDATORY RULES` system instruction.
- Social routing hint repeated media and vision bans.

Resolution: `AGENTS.md` owns the tool boundary. Gateway system instruction keeps only runtime-critical constraints. Social routing hint appears only for detected social links and stays short.

### Reply Style Rules

- `SOUL.md` described natural chat style, no reports, no self-analysis.
- `hermesGatewayClient.mjs` injected style every turn.
- `reply_reviewer.py` already checked some casual/advisory drift.

Resolution: `SOUL.md` owns style principles. Gateway uses one short style anchor. Reviewer now catches `mechanism_leak`, `over_courtly_template`, `unnatural_conversation_flow`, and `overlong_systemic_explanation`.

### Project Context Rules

- `README` and governance docs describe ran-agent architecture and lite/full design.
- `AGENTS.md` and gateway prompt also carried some runtime context.

Resolution: project architecture stays in governance docs. `AGENTS.md` keeps only the tool/routing boundary. `SOUL.md` does not mention XHS, lite/full, or tool internals.

## Layered Ownership

| Layer | Owns | Does Not Own |
|-------|------|--------------|
| `SOUL.md` | Long-term persona, relation tone, natural expression | Tool inventory, XHS details, lite/full details |
| `AGENTS.md` | Tool boundaries and runtime routing rules | Long-form persona manual |
| `hermesGatewayClient.mjs` | Short runtime system instruction and conditional hints | Long project background or duplicated tool manual |
| `reply_reviewer.py` | Post-generation style lint | Prompt assembly or tool routing |
| `server_runtime_commands.md` | Operational lite/full runbook | Persona rules |
