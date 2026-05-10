# CLAUDE.md

Status: CURRENT (2026-05-10)

## Execution Scope

- This repo is local-first and project-scoped.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.

## OpenClaw Local Contract

- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`.
- The local OpenClaw config remains project-scoped in `openclaw/openclaw.personal-system.json`.
- If you are changing OpenClaw behavior, update the local AGENTS file rather than duplicating the contract here.

## Live Lookup Rule

- For time-sensitive facts (news, prices, schedules, policy updates, product changes), perform web lookup first, then answer.
- Weather queries use `skills/weather/SKILL.md`.
- Non-weather online lookup uses `skills/web-search-live/SKILL.md` (`web_search` then `web_fetch`).
- For integration/debugging work (OpenClaw, WeChat, MCP, media delivery, deployment, third-party APIs), first check official docs plus at least one mature GitHub reference or real-world implementation before designing a solution.
- Do not use `~`-prefixed filesystem paths in tool/file operations; use absolute paths or workspace-relative paths only.

## Skills-First Rule

Specialist capabilities must stay skillized and loaded on demand:

- `skills/memory-specialist/SKILL.md`
- `skills/reflection-specialist/SKILL.md`
- `skills/knowledge-state/SKILL.md`
- `skills/life-loop/SKILL.md`
- `skills/night-cycle/SKILL.md`
- `skills/ombre-memory/SKILL.md`
- `skills/weather/SKILL.md`
- `skills/web-search-live/SKILL.md`
- `skills/context-compact/SKILL.md`
- `skills/reminder/SKILL.md`
- `skills/archive-and-push/SKILL.md`

Do not keep all specialist context always loaded in every turn.

## Sub-Agent Rule

Only heavy background tasks are sub-agent candidates:

- reflection
- knowledge maintenance
- exploration
- heavy `inspect_more`

Do not sub-agentize:

- frontline chat
- memory main flow
- life loop
- todo capture/reminder main flow

## Knowledge And Memory Direction

- Knowledge management stays on product path: `knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`.
- Memory path keeps current Ombre integration first; do not replace with new memory stack without explicit migration request.

## Media Reader Constraints

- `media_reader` MCP servers (`mediaReaderMcpServer.mjs`, `socialReaderMcpServer.mjs`) are the stable facade; do not expose internal provider/ffmpeg/platform-resolver tools to OpenClaw directly.
- WeChat inbound media uses the artifact mainline: raw messages -> logical turn (via `inboundMessageBuffer.mjs` turn aggregation) -> media asset -> media artifact -> conversation media context -> OpenClaw reply.
- The inbound message buffer holds media-only messages in a pending queue (TTL 10 min) and merges them with subsequent text-ref messages (e.g. "用 mimo 分析") within configurable timeouts (`WECHAT_TEXT_REF_WAIT_MS`, `WECHAT_PENDING_MEDIA_TTL_MS`, `WECHAT_PENDING_TEXT_REF_TTL_MS`). Plain text passes through without delay.
- External media files (e.g. WeChat SDK /tmp files) are auto-copied to trusted dirs before processing.
- Local media `file_path` inputs are accepted only from trusted inbound media directories (`debug/wechat/inbound`, `debug/mimo_inbound`, `.openclaw_state/wechat/inbound`, `.openclaw_state/openclaw-weixin/media`, or `NODE_BRIDGE_TRUSTED_MEDIA_DIRS` / `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`). URL media assets must be remote `http(s)` URLs. Project-local secrets, state, vault, and env files are not valid media assets.
- Video analysis uses subtitle-first strategy: prefer yt-dlp extracted subtitles, fall back to audio ASR, then VLM frame analysis if explicitly enabled, and finally degrade to metadata-only.
- Frame extraction mode skips OCR by default (VLM reads burned-in subtitles from frames).
- Platform resolver credentials (SESSDATA, XHS_COOKIE, proxy URLs) must never appear in tool output, logs, docs, or git.
- PaddleOCR is best-effort on servers; timeouts are expected on low-CPU instances.

## Governance Docs

- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
