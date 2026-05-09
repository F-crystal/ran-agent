# AGENTS.md

Status: CURRENT (2026-05-10)

## Scope

This is the repo-root workspace bootstrap file, loaded by both OpenClaw and Codex. It must be self-contained — do not reference `CLAUDE.md` or `openclaw/AGENTS.md` as required reading for rules defined here. OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`; this root file is also an official workspace bootstrap file.

## Execution Scope

- This repo is local-first and project-scoped.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces.
- Do not expand custom front conversation runtime.

## Live Lookup Rule

- For time-sensitive facts (news, prices, schedules, policy updates, product changes), perform web lookup first, then answer.
- Weather queries use `skills/weather/SKILL.md`.
- Non-weather online lookup uses `skills/web-search-live/SKILL.md` (`web_search` then `web_fetch`).
- For complex or unfamiliar problems, first search official documentation and mature prior art before designing or coding.
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

## OpenClaw Frontend Contract

- Single front speaker: OpenClaw, positioned as personal assistant + chat companion.
- Active route/provider is `claude_code`; active model is bare `qwen3.5-plus`; fallbacks stay empty.
- Do not write provider-qualified `provider/model` refs into `agents.*.model.primary`.
- Kimi and GLM are retired as OpenClaw frontend primary/fallback candidates.
- Qwen is allowed only behind the local Claude-compatible path and in the knowledge executor path (`knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`).
- Persona comes from workspace bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`); do not replace with ad-hoc inline prompt prose.
- Keep `tools.allow` non-empty and `tools.profile=coding`.
- Python runtime is backend capability only, not a second front brain.

## Companion Reply Quality

- Optimize for WeChat companion chat: short, natural, warm, not clingy.
- Treat the user as a person in shared conversation, not a task object to manage or diagnose.
- Default to compact replies unless the user explicitly asks for a report, plan, or structured answer.
- Do not leak analysis, intent classification, prompt mechanics, memory internals, tool routing, or self-review.
- Do not turn ordinary chatting into unsolicited advice, coaching, check-ins, or long summaries.
- Ask at most one light follow-up when useful; otherwise leave room for the user to continue.
- For `/new` and `/reset`, answer with only a short confirmation; do not explain session mechanics unless asked.
- Do not expose chain-of-thought, tool-routing commentary, or meta narration.

## Knowledge And Memory Direction

- Knowledge management stays on product path: `knowledge_agent.py + Qwen Code + vault_runner.sh + vault/`.
- Memory path keeps current Ombre integration first; do not replace with new memory stack without explicit migration request.

## Media Reader Constraints

- MCP servers (`media_reader`, `social_reader`, `media_generation`) are the stable facade; do not expose internal provider/ffmpeg/platform-resolver tools to OpenClaw directly.
- WeChat inbound media uses the artifact mainline: media asset -> media artifact -> conversation media context -> OpenClaw reply.
- Local media `file_path` inputs are accepted only from trusted inbound media directories (`debug/wechat/inbound`, `debug/mimo_inbound`, `.openclaw_state/wechat/inbound`, `.openclaw_state/openclaw-weixin/media`, or `NODE_BRIDGE_TRUSTED_MEDIA_DIRS` / `PERSONAL_AGENT_TRUSTED_MEDIA_DIRS`). URL media assets must be remote `http(s)` URLs. Project-local secrets, state, vault, and env files are not valid media assets.
- Video analysis uses subtitle-first strategy: prefer yt-dlp extracted subtitles, fall back to audio ASR, then VLM frame analysis if explicitly enabled, and finally degrade to metadata-only.
- Frame extraction mode skips OCR by default (VLM reads burned-in subtitles from frames).
- Platform resolver credentials (SESSDATA, XHS_COOKIE, proxy URLs) must never appear in tool output, logs, docs, or git.
- PaddleOCR is best-effort on servers; timeouts are expected on low-CPU instances.

## Reminder And Reflection Direction

- WeChat reminder delivery is off by default: keep `PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false` unless explicitly restoring it.
- Timed todo/reminder capture may still persist rows; outbound reminder delivery should prefer OpenClaw calling Lark/Feishu.
- Reflection/persona evolution is not a purely manual skill flow: `self_reflection_job` and `night_cycle_job` run in Python backend; persona evolution may refresh managed `Auto Evolution` blocks in `IDENTITY.md`/`SOUL.md`.
- If asked whether reflection results are checked or docs updated, do not answer from memory; check scheduler/config/artifacts or state the known pipeline plus uncertainty.

## Model And Provider Governance

- `openclaw/openclaw.personal-system.json` controls the agent model contract.
- `agents.defaults.model.primary` and `agents.list[0].model.primary` must store bare model ids (e.g. `qwen3.5-plus`).
- `models.providers.claude_code.models` must include the active model id.
- Server path normalization: `scripts/normalize_openclaw_project_paths.py`.
- OpenClaw validation must use `scripts/openclaw_with_env.sh`, not bare `npx openclaw`.

## Security

- Keep reads and writes inside the current repository checkout.
- Keep owner-only posture for high-permission actions.
- Never commit: `.env.local`, `.openclaw_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.

## Governance Docs

- Constraints: `docs/governance/constraints.md`
- Skills map: `docs/governance/skills.md`
- Sub-agent candidates: `docs/governance/sub_agents.md`
- Cleanup scope: `docs/governance/cleanup.md`
- Doc status: `docs/governance/doc_status.md`
