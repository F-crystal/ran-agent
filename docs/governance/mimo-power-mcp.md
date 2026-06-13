# MiMo Power MCP

Status: RETIRED (2026-06-13)

MiMo Power / `mimo_power` was the Xiaomi MiMo Token Plan MCP used for deep
multimodal analysis. The Token Plan has expired, and `mimo_power` is no longer
part of the current Hermes runtime surface.

## Current Contract

- Hermes full and lite profiles must not expose `mcp-mimo_power`.
- Runtime generation in `scripts/apply-hermes-runtime-split.sh` must not add
  `mcp-mimo_power` back to toolsets.
- Media context artifacts now use `media_reader` directly for OCR, ASR, VLM,
  video, and batch media analysis.
- Do not add `MIMO_TOKEN_PLAN_API_KEY` to current profile distribution
  requirements.

## Historical Code

The old implementation may remain in source temporarily for audit and future
reference:

- `node_bridge/src/mimoPowerMcpServer.mjs`
- `node_bridge/tests/mimoPowerMcpServer.test.mjs`
- `scripts/start_mimo_power_mcp.sh`

These files are not current runtime entry points. Do not use them as debugging
authority unless a future change explicitly re-enables MiMo with a valid plan
and fresh product decision.
