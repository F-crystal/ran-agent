# Prompt Slimming Audit

Status: CURRENT (2026-08-18)

This document records ownership boundaries after prompt slimming. It is not a
runtime prompt and should stay short.

## Ownership

| Layer | Owns | Does Not Own |
|-------|------|--------------|
| `hermes/profile/SOUL.md` | Long-term persona and relation tone | Tool inventory, XHS details, lite/full runtime facts |
| `hermes/profile/AGENTS.md` | Hermes runtime constraints and tool boundary | Long-form persona manual |
| `node_bridge/src/hermesGatewayClient.mjs` | Short system instruction, conditional routing hints, request logging | Long project background or duplicated tool manuals |
| `src/personal_agent/reply_reviewer.py` | Post-generation style lint | Prompt assembly or tool routing |
| `docs/governance/` | Architecture and operational facts | Per-turn prompt prose |

## Current Rules

- Gateway prompt stays compact and conditional.
- Social routing hints appear only when social links are detected.
- Tool and routing facts live in `AGENTS.md`, `hermes/profile/AGENTS.md`, and
  governance docs rather than in every user turn.
- Replies should not expose mechanism details such as continuity internals,
  fallback chains, or unavailable hidden tools unless the user is debugging.
- `request_id` is generated once per Hermes request and reused across
  context-size, routing, evidence, and gate logs.

## Regression Checks

- Keep `SOUL.md` free of XHS, lite/full, or tool inventory details.
- Keep `hermesGatewayClient.mjs` free of long static project manuals.
- Keep `server_runtime_commands.md` script-first; do not paste large repair
  transcripts into public docs.
