# MiMo Power MCP

Status: CURRENT (2026-05-22)

MiMo Power is the deep multimodal analysis MCP used by the media pipeline for
image, audio, video, and text analysis.

## Owner

- Code: `node_bridge/src/mimoPowerMcpServer.mjs`
- Media pipeline: `docs/governance/media-pipeline.md`
- Task output: `debug/mimo/tasks/` (runtime/debug state, never commit)

## Required Env

| Env Var | Meaning |
|---------|---------|
| `MIMO_TOKEN_PLAN_API_KEY` | MiMo Token Plan API key |
| `MIMO_TOKEN_PLAN_OPENAI_BASE_URL` | OpenAI-compatible API base URL |
| `MIMO_TOKEN_PLAN_EXPIRES_AT` | Token expiry timestamp |

Do not print these values in docs, logs, or tool output.

## Endpoint And Model Routing

| Env Var | Default | Meaning |
|---------|---------|---------|
| `MIMO_POWER_ENDPOINT_STYLE` | `chat` | `chat` or `responses` endpoint style |
| `MIMO_POWER_TEXT_MODEL` | fallback to `MIMO_POWER_MODEL`, then `mimo-v2.5-pro` | Text tasks |
| `MIMO_POWER_VISION_MODEL` | none | Image/video tasks |
| `MIMO_POWER_AUDIO_MODEL` | none | Audio tasks |
| `MIMO_POWER_MULTIMODAL_MODEL` | none | Vision/audio fallback |
| `MIMO_POWER_MODEL` | `mimo-v2.5-pro` | Legacy text fallback |

Routing order:

1. Explicit `args.model`.
2. Vision task or image/video asset -> `MIMO_POWER_VISION_MODEL`, then
   `MIMO_POWER_MULTIMODAL_MODEL`.
3. Audio task or audio asset -> `MIMO_POWER_AUDIO_MODEL`, then
   `MIMO_POWER_MULTIMODAL_MODEL`.
4. Text task -> `MIMO_POWER_TEXT_MODEL`, then `MIMO_POWER_MODEL`, then
   `mimo-v2.5-pro`.

Vision/audio requests fail fast with `MIMO_VISION_MODEL_MISSING` or
`MIMO_AUDIO_MODEL_MISSING` when no suitable model is configured.

## Limits

| Env Var | Default | Meaning |
|---------|---------|---------|
| `MIMO_POWER_MAX_COMPLETION_TOKENS` | `8192` | Max output tokens |
| `MIMO_POWER_TIMEOUT_MS` | `600000` | Request timeout |
| `MIMO_POWER_MAX_LOCAL_FILE_BYTES` | `104857600` | Local file size cap |
| `MIMO_POWER_TASK_DIR` | `debug/mimo/tasks` | Runtime task result dir |
| `MIMO_POWER_ALLOWED_HOSTS` | empty | Optional comma-separated remote asset allowlist |

Local file assets are accepted only from trusted media directories. See
`docs/governance/media-pipeline.md`.

## Error Codes

| Code | Meaning |
|------|---------|
| `MIMO_TOKEN_PLAN_KEY_MISSING` | API key is absent |
| `MIMO_TOKEN_PLAN_EXPIRED` | Token plan has expired |
| `MIMO_VISION_MODEL_MISSING` | Vision task has no configured vision/multimodal model |
| `MIMO_AUDIO_MODEL_MISSING` | Audio task has no configured audio/multimodal model |
| `MIMO_REQUEST_FAILED` | Upstream request failed |
| `MIMO_REQUEST_TIMEOUT` | Upstream request timed out |
| `URL_BLOCKED` | Remote asset URL is not allowed |
