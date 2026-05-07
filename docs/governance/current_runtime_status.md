# Current Runtime Status

Status Date: 2026-05-06

## Frontend Path

- Active target path is:
  - `WeChat -> Node bridge -> OpenClaw Gateway -> Claude Code primary -> reply`
- OpenClaw frontend primary is `claude_code/qwen3.5-plus` through the local Claude-compatible provider path, with no configured automatic fallbacks.
- Kimi and GLM are retired as OpenClaw frontend primary/fallback candidates and stay out of active automatic routing config.
- Frontend positioning is personal assistant + chat companion (single front speaker: OpenClaw).
- Python frontend `/chat` path is retired (returns 410).

## OpenClaw Contract Location

- OpenClaw-specific runtime constraints live in `openclaw/AGENTS.md`.
- `openclaw/openclaw.personal-system.json` enables the bundled `bootstrap-extra-files` hook so `openclaw/AGENTS.md` is injected during `agent:bootstrap`.
- `openclaw/.trae/agents.md` is a non-runtime editor config artifact and should not be treated as the live contract.

## OpenClaw Startup Entry

- Standard command (repo root): `./start_openclaw.sh`
- Startup docs should reference this script entry only.
- Workspace heartbeat instruction file exists: `HEARTBEAT.md` (repo root).
- Workspace persona/bootstrap files for frontline behavior are: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, and `HEARTBEAT.md`.
- Hermes-style budget contracts live under `openclaw/HERMES_*.md` as repo references only. They are not injected by OpenClaw bootstrap, so they do not add fixed per-turn prompt tokens.
- `start_openclaw.sh` no longer rewrites `HOME`; this avoids `~/ran_agent/...` path expansion drift (for example skill file reads under `node_modules/openclaw/skills/*/SKILL.md`).
- `start_python.sh` and `start_openclaw.sh` prepend the local Qwen Code Node bin to `PATH` when available, so `vault_runner.sh` and OpenClaw subprocesses do not fall back to the system `node v16.17.0` in bash login shells.
- `start_openclaw.sh` also inherits Claude provider env from `~/.claude/settings.json` when the current shell has not exported `ANTHROPIC_*`, and the frontline now depends on that anthropic-compatible provider path instead of `claude-cli` text-only fallback mode.
- Manual OpenClaw CLI checks should use `scripts/openclaw_with_env.sh ...`; it loads project env files plus Claude settings using the same fallback order as `start_openclaw.sh`.
- Repro smoke for backend + gateway + knowledge + heartbeat:
  - `./scripts/connectivity_smoke.sh`
- Workspace overrides added for skill-path stability and online lookup coverage:
  - `skills/weather/SKILL.md` (overrides bundled weather skill path)
  - `skills/web-search-live/SKILL.md` (generic online lookup workflow)
- Repo MCP config now registers a Playwright MCP wrapper in `.mcp.json`:
  - `scripts/install_playwright_mcp.sh` installs official Playwright Chromium + Linux deps
  - `scripts/start_playwright_mcp.sh` starts `@playwright/mcp@latest` through `scripts/playwright_mcp_proxy.mjs` in stdio/headless/isolated mode by default; HTTP transport requires `PLAYWRIGHT_MCP_TRANSPORT=http` plus `PLAYWRIGHT_MCP_PORT`
  - the proxy normalizes every `tools/list` entry so model-visible browser tools always carry a valid MCP `inputSchema`
  - official Playwright MCP options are forwarded through env-backed wrapper args, including `PLAYWRIGHT_MCP_ISOLATED`, `PLAYWRIGHT_MCP_USER_DATA_DIR`, `PLAYWRIGHT_MCP_STORAGE_STATE`, `PLAYWRIGHT_MCP_CAPS`, and `PLAYWRIGHT_MCP_EXECUTABLE_PATH`
- Repo MCP config now also registers:
  - `time` via `scripts/start_time_mcp.sh`, using `mcp-server-time` with `LOCAL_TIMEZONE=Asia/Shanghai`
  - `media_generation` via `scripts/start_media_generation_mcp.sh`, exposing `generate_image` and `generate_speech`
  - `media_reader` via `scripts/start_media_reader_mcp.sh`, exposing a unified media-understanding facade for images, audio, video, OCR, ASR, and batch partial results.
  - `social_reader` via `scripts/start_social_reader_mcp.sh`, exposing a read-only social share facade and `read_social_post_deep` aggregation path.
- OpenClaw main config now registers `playwright`, `time`, `media_generation`, `media_reader`, and `social_reader` MCP:
  - `playwright` gives the OpenClaw agent runtime model-visible browser automation for dynamic, visual, or interactive pages.
  - ordinary text pages should still prefer `web_fetch`; browser MCP is reserved for cases where HTML extraction is insufficient.
  - the bundled OpenClaw `browser` plugin is explicitly disabled, so normal startup should not log `[browser] control listening ...`; browser automation should come from `playwright__browser_*` MCP tools.
  - `time` uses a launcher that prefers a preinstalled `mcp_server_time` Python module before falling back to `uvx`, reducing cold-start dependency downloads inside OpenClaw's MCP startup window.
  - `media_generation` remains OpenClaw-owned; Node bridge only converts trusted `WECHAT_MEDIA` markers from the media MCP result into WeChat `media` envelopes.
  - `media_reader` is the only OpenClaw-visible media understanding facade. It exposes `extract_media_assets`, `analyze_image`, `transcribe_audio`, `analyze_video`, and `analyze_media_batch`; lower-level OCR/ASR/VLM/ffmpeg providers stay behind adapters. The default adapters use local PaddleOCR for OCR, cost-focused DashScope `qwen3-vl-flash`, DashScope `qwen3-asr-flash`, and server `ffmpeg`/`ffprobe`; missing PaddleOCR, missing `DASHSCOPE_API_KEY` / `QWEN_API_KEY`, or missing ffmpeg binaries return structured errors.
  - `social_reader` is the preferred path for social media and music share links. It exposes `resolve_social_url`, `read_social_post`, `read_social_post_deep`, `read_music_share`, and `check_social_login`; internally it calls mature platform backends such as `jobson-xhs-mcp` for Xiaohongshu, `@wangshunnn/bilibili-mcp-server` for Bilibili public video metadata, `wanyi-watermark` for generic share parsing, and a NetEaseCloudMusicApi-compatible song detail endpoint for NetEase Music shares including `163cn.tv` short links.
- Normal WeChat text replies now enter OpenClaw through `openclaw agent --json`, not the OpenAI-compatible chat-completions shim, so the agent runtime sees its MCP tools. The chat-completions path remains a compatibility fallback and is still used when the inbound WeChat payload contains images or other structured media.
- `openclaw/openclaw.personal-system.json` web path hardening:
  - `tools.profile` set to `coding`
  - root `tools.allow` is an explicit non-empty list: `web_search`, `web_fetch`, `session_status`, `exec`, `process`
  - listed agent `agents.list[0].tools.allow` adds `read` on top of the root allowlist
  - native `todo-tools` plugin is disabled so live chat todo handling stays bridge-managed
  - bundled `bootstrap-extra-files` hook injects `openclaw/AGENTS.md` during bootstrap
  - shared defaults use `claude_code/qwen3.5-plus`
  - the listed frontline agent also uses `claude_code/qwen3.5-plus`
  - fallbacks are empty for both shared defaults and the listed frontline agent
  - Kimi and GLM are retired as automatic frontend candidates and are not part of the active routing registry
  - the same Claude-provider registry also carries `claude_code/qwen-image` and `claude_code/qwen3-omni-flash` for generation-side routing
  - natural-language image/speech generation is exposed through OpenClaw's `media_generation` MCP server in the OpenClaw agent runtime, not bridge-owned chat-completions tools by default
  - `/image ...` and `/speak ...` are no longer bridge direct generation commands; standalone slash commands are preserved for OpenClaw native handling
  - `models.providers.claude_code` is an anthropic-compatible provider sourced from `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  - `agents.defaults.cliBackends.claude-cli.command` remains configured for local diagnostics, but `claude-cli/*` is no longer the active frontline because OpenClaw CLI backends are text-only fallback mode
  - Node bridge ignores `OPENCLAW_BACKEND_MODEL` by default; override headers are only sent when `OPENCLAW_ALLOW_BACKEND_MODEL_OVERRIDE=true`
  - `tools.web.search.provider` is pinned to `tavily`
  - bundled Tavily config lives under `plugins.entries.tavily.config.webSearch.*`; this is the active intelligent web search path for OpenClaw `web_search`, not just a server-side Claude Code setting.
  - `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange = true` for fake-IP proxy environments (e.g. 198.18.0.0/15)
  - `agents.defaults.skills` restricted to `weather` and `web-search-live` for lookup-focused sessions
  - `agents.defaults.thinkingDefault = off`, `agents.defaults.typingMode = message`, `agents.list[0].reasoningDefault = off`
  - `agents.defaults.params.cacheRetention = short`
  - native `contextPruning` enabled in `cache-ttl` mode with `ttl = 10m`, `softTrimRatio = 0.25`, `hardClearRatio = 0.45`
  - native `compaction.mode = safeguard`, `reserveTokensFloor = 12000`, `notifyUser = false`
  - `blockStreamingDefault = on` to reduce noisy partial streaming overhead during bridge-mediated chat
  - active `claude_code/qwen3.5-plus` has a `120000` registry context window, matching the live `contextTokens` bound
  - manual heavy `claude_code/qwen3.6-plus` registry entry remains available
  - listed frontend heartbeat is reduced to `90m` to lower idle token spend while proactive outbound messaging remains frozen
  - `qwen3.5-plus` and `qwen3.6-plus` registry cost metadata is populated with China-mainland DashScope RMB pricing converted to USD estimates for OpenClaw usage display
  - `start_openclaw.sh` sets `OPENCLAW_DISABLE_MODEL_PRICING_REFRESH=true` and runtime patches skip optional OpenRouter pricing refresh, avoiding startup warnings on servers without direct OpenRouter access
  - Hermes-style budget files stay out of bootstrap; Python-side dynamic context budgets reduce recurring memory/vault/session injection for backend capability paths without adding fixed OpenClaw prompt tokens
  - after changing `tools.profile` or `tools.allow`, run `/new` or `/reset` before continuing in the same session

401 troubleshooting order:

1. `.env.local`: confirm the Claude provider env is present for frontend runs; confirm `QWEN_API_KEY` or `DASHSCOPE_API_KEY` for media generation, media understanding, and backend knowledge maintenance.
2. Startup command: run `./start_openclaw.sh` instead of raw `npx openclaw ...`.
3. Gateway logs: look for `401`, `Unauthorized`, `InvalidApiKey`.

## Frontline Model Chain

- OpenClaw remains the single front speaker.
- The shared `agents.defaults.model` resolution is:
  - primary: `claude_code/qwen3.5-plus`
  - fallbacks: none
- The active listed agent (`agents.list[0]`) uses:
  - primary: `claude_code/qwen3.5-plus`
  - fallbacks: none
- `claude_code/qwen3.6-plus` remains registered as a manual heavy model, not as the default frontline path.
- Kimi and GLM are retired as frontend primary/fallback candidates.
- This path is intentionally tool-capable. It uses Claude settings as the credential source for an anthropic-compatible provider, instead of relying on the OpenClaw `claude-cli` text-only fallback backend.
- Claude settings remain the source of truth for `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; OpenClaw consumes those env values at startup.

## 常见日志与处置

- `401` / `Unauthorized` / `InvalidApiKey`:
  confirm `.env.local` key values are real and start with `./start_openclaw.sh` (not raw `npx openclaw ...`).
- `HEARTBEAT ENOENT`:
  check `HEARTBEAT.md` exists in workspace root and startup cwd is the repository checkout.
- `skills path warning`:
  verify `skills/*/SKILL.md` files exist and commands are executed from repo root.
  ensure each workspace skill file resolves under the repository `skills/` directory (no symlink escape).
  If warning persists but workspace skills are available, prioritize workspace skills and avoid `~` path usage in tool calls.

### Backend Knowledge Executor (Qwen Code)

- `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault` remains the only supported Qwen path in this repo.
- `QWEN_API_KEY` / `DASHSCOPE_API_KEY` matter for media generation, media understanding, and knowledge maintenance runs, not for the OpenClaw frontend chat model provider chain.
- Frontline OpenClaw config should not reintroduce `qwen/*`, `modelstudio/qwen*`, or `qwen` auth profiles/providers.

## Backend Layer (Python)

- Python runtime is backend capabilities/tools only:
  - `/ingest`
  - `/tools/memory/recall`
  - `/tools/memory/update`
  - `/tools/session/support`
  - `/tools/knowledge/state`
  - `/tools/knowledge/run`
  - `/tools/reflection/run`
  - `/tools/life-loop/state`
  - `/tools/night-cycle/run`

## Runtime Sequence

WeChat chat mainline:

```text
WeChat inbound
  -> weixin-agent-sdk
  -> node_bridge/src/index.mjs buildAgent.chat(request)
  -> normalizeIncomingRequest()
  -> optional /checkin command short-circuit
  -> InboundMergeCoordinator.enqueue()
  -> mergeRequests()
  -> drainPendingOutboundMessages()
  -> handleWeChatTextMessage()
  -> mapWeChatMessageToBridgeRequest()
  -> createReplyBackend().getReply(payload)
  -> normal text with no inbound media:
     -> sendChatToOpenClawAgent(payload)
     -> npx openclaw agent --session-id <wechat-session> --message <bridge-context + user text> --json
     -> OpenClaw agent runtime sees configured MCP servers, including media_generation
     -> media_generation.generate_image / generate_speech returns WECHAT_MEDIA when used
  -> inbound image/media compatibility path:
     -> sendChatToOpenClawGateway(payload)
     -> build Shanghai time system prompt + multimodal user content
     -> POST OpenClaw Gateway /v1/chat/completions
  -> ingestExchangeToBackend()
  -> POST Python /ingest
  -> PersonalAgentService.record_external_exchange()
  -> trusted WECHAT_MEDIA marker extraction, if present
  -> sanitizeReplyText()
  -> reply returns to WeChat SDK
```

Scheduler-side paths:

```text
APScheduler
  -> brain_loop_job
  -> life_loop_job
  -> knowledge_agent_job
  -> self_reflection_job
  -> night_cycle_job
  -> reminder_check_job (every 5 minutes)

reminder_check_job
  -> TodoManager.check_reminders()
  -> message_service.send_proactive_message()
  -> outbound server /outbound/send
  -> Bot.sendMessage()
  -> database.mark_todo_reminded()
```

Code anchors:

- `node_bridge/src/index.mjs`
- `node_bridge/src/wechatBridge.mjs`
- `node_bridge/src/replyBackend.mjs`
- `node_bridge/src/openclawGatewayClient.mjs`
- `src/personal_agent/http_server.py`
- `src/personal_agent/service.py`
- `src/personal_agent/scheduler.py`
- `src/personal_agent/jobs.py`

## Skills

- Active on-demand skills:
  - memory-specialist
  - reflection-specialist
  - knowledge-state
  - life-loop
  - night-cycle
  - ombre-memory
  - weather
  - web-search-live

## Current Focus

- WeChat bridge monitor loop is now running on this machine (observed on 2026-04-13).
- Frontline now stays on the tool-capable Claude settings provider path instead of `claude-cli/*` or any Qwen fallback.
- Frontline persona is now expected to come from workspace bootstrap files rather than inline meta-instructions, with explicit prohibition on inner-monologue style outputs.
- Remaining Qwen auth risk is background-only: knowledge maintenance still depends on the Qwen path when `vault_runner.sh` runs.
- Standard startup entry is now `./start_openclaw.sh` (loads `.env.local`, exports Qwen env for knowledge work, and requires Claude provider env for the frontline).
- Knowledge maintenance now has a callable backend path (`POST /tools/knowledge/run`); the remaining work is runtime smoke on `plan` / `apply` / `auto`, not route plumbing.
- Knowledge maintenance is still a background/admin path, not an OpenClaw-visible write MCP:
  - `KnowledgeAgent` now records return code, timeout flag, duration, and output excerpt for each Qwen Code runner step.
  - timed-out Qwen Code subprocesses are killed by process group so scheduler jobs do not hang indefinitely.
  - `vault_runner.sh plan` is documented as prompt-enforced read-only planning, not a separate Qwen CLI approval mode.
- Frontline URL handling now prefers bridge-side structured extraction for inline links:
  - `node_bridge/src/webStructuredExtract.mjs`
  - for up to two URLs in the user text, the bridge fetches HTML, extracts title + excerpt + clean正文, and injects a compact structured context before the question
  - screenshot-heavy browsing should be reserved for pages that actually need visual evidence
  - if Playwright is enabled for the bridge, Ubuntu servers must provide a Chromium executable or Playwright-managed Chromium install; otherwise the bridge falls back to HTML extraction
- WeChat outbound flow now supports bounded segmented replies and delayed follow-ups:
  - multi-part text replies can be delivered as multiple messages
  - proactive or follow-up sends are queued with due-time gating instead of immediate burst sends
- Generated speech files are normalized to valid WAV output before handing to WeChat voice send, reducing `0:00` / unreadable audio artifacts for raw PCM-like model responses.
- Natural-language image and speech generation is model-visible:
  - normal WeChat text requests are routed through `openclaw agent --json`, which sees native MCP tools `generate_image` and `generate_speech` from `media_generation`
  - `generate_image` wraps DashScope `qwen-image`
  - `generate_speech` wraps DashScope-compatible `qwen3-omni-flash` audio generation
  - media MCP tool results include a trusted `WECHAT_MEDIA: {...}` marker
  - Node bridge extracts only that trusted marker and converts it into WeChat `media`
  - arbitrary markdown image URLs, including public services such as pollinations.ai, are not treated as generated WeChat media
- Time awareness now has two layers:
  - each non-standalone WeChat chat completion carries a compact bridge-side `Asia/Shanghai` current-time context in the current user content
  - OpenClaw MCP config registers the official time MCP wrapper for native tool access where supported
- Browser access now has two layers:
  - inline URLs still prefer bridge-side structured HTML extraction for low-cost text evidence
  - OpenClaw can call the registered Playwright MCP when a page needs interaction, rendered UI state, screenshots, login state, canvas, or SPA behavior
- Memory retrieval is now hybrid and lightweight:
  - `src/personal_agent/memory_retriever.py` ranks memory candidates by keyword overlap, importance, and recency
  - `src/personal_agent/memory_specialist.py` uses retrieval results instead of blunt full recall
- Ombre remains backend-owned rather than exposed as an unrestricted OpenClaw write MCP. Recall now logs per-action duration, success flag, item count, and basic error signal so memory health can be diagnosed without expanding the frontline tool surface.
- Personal vault recall is now available to backend reply/capability paths:
  - `src/personal_agent/knowledge_retriever.py` scans `vault/wiki/**/*.md`
  - `src/personal_agent/service.py` injects up to one relevant vault snippet by default when the current user text matches
- Hermes-style token budgets are enforced in Python-side context building:
  - memory context <= 600 chars
  - continuity context <= 1200 chars
  - daily context <= 600 chars
  - reflection context <= 600 chars
  - vault snippet <= 240 chars
  - recent user support <= 3 messages
  - working memory default <= 2 items
  - profile memory default <= 3 items
- Low-frequency `hermes_bounded_context` maintenance runs every 720 minutes by default and performs hygiene through the existing memory specialist without adding per-turn model calls.
- Manual `/compact` from the WeChat bridge now passes through to OpenClaw native slash command handling.
- Python backend still exposes `POST /tools/context/compact` for backend/admin use, but WeChat standalone `/compact` no longer short-circuits to that endpoint.
- Background frequency and memory pressure have been reduced:
  - `brain_loop_interval_minutes = 120`
  - `proactive_check_interval_minutes = 90`
  - `knowledge_check_interval_minutes = 360`
  - `self_reflection_interval_minutes = 720`
  - `reminder_check_interval_minutes = 5`
- See auth troubleshooting notes in this file and README.

## Waking Loop And Proactive Messaging (2026-04-19)

- Implemented via OpenClaw native heartbeat (`openclaw/openclaw.personal-system.json`), not custom scheduler code.
- Python-side proactive flow remains conservative:
  - `config.proactive_enabled = False` by default
  - proactive opportunity evaluation still exists, but random chatty nudges stay disabled unless explicitly re-enabled
- Node bridge outbound flow is allowed to send structured follow-ups and segmented replies when the frontline explicitly returns them.
- Contract:
  - `heartbeat.every = 90m`
  - `heartbeat.activeHours = 08:30-23:30 (Asia/Shanghai)`
  - `HEARTBEAT.md` uses `tasks:` for self-check, todo tracking, and proactive check-in
- Life loop may also emit low-priority `exploration` opportunities as background items.
  - This is allowed under current governance.
  - They must remain non-frontline and should not create aggressive proactive nudges.
- Todo/reminder contract:
  - live chat todo creation/listing is handled by the Node bridge tool path, not by the OpenClaw native plugin
  - reminder parsing now prefers Microsoft Recognizers-Text before local fallback rules
  - date/time ranges like `周四下午` must trigger a concise follow-up instead of silently collapsing to a guessed point time
  - user-declared tasks must be persisted to memory
  - explicit date/time should trigger native timed reminder (`cron` / system-event wake)
  - missing task details should trigger one concise follow-up question
  - due reminders are delivered from persisted SQLite todo rows by `reminder_check_job`, so they survive a service restart as long as the database file is intact
  - reminder sends are deduplicated by reminder delivery state plus recent proactive seed checks
  - reminder sweep frequency is reduced to every 5 minutes to lower idle background churn

## OpenClaw Time Context

- `node_bridge/src/openclawGatewayClient.mjs` now injects a compact absolute-time prefix:
  - absolute local time
  - `Asia/Shanghai`
  - a short instruction to compare mentioned time with current time before answering
- This is intended to reduce stale time phrasing without relying on large hard-coded reply filters.

### Verification Commands (MVP)

1. Validate config JSON:
   - `jq '.agents.defaults.heartbeat,.agents.list[0].heartbeat' openclaw/openclaw.personal-system.json`
2. Confirm heartbeat checklist content:
   - `sed -n '1,220p' HEARTBEAT.md`
3. Verify runtime sees heartbeat events:
   - `openclaw system heartbeat last`
4. Optional wake test:
   - `openclaw system event --text "heartbeat mvp smoke check" --mode now`
5. End-to-end local smoke:
   - `./scripts/connectivity_smoke.sh`

## Runtime Tuning (2026-04-13)

目标：稳定 OpenClaw 前台响应，同时保持聊天速度和上下文一致性。

已落地最小改动（`openclaw/openclaw.personal-system.json`）：

- `agents.defaults.timeoutSeconds = 180`
  - 给单轮执行更稳妥的总超时预算，减少慢响应时被提前中断。
- `agents.defaults.llm.idleTimeoutSeconds = 120`
  - 放宽 token 空闲超时，降低“流式短暂停顿即超时”的概率。
- `agents.defaults.contextTokens = 120000`
  - 限制有效上下文窗口，避免长会话导致请求过重并拖慢响应。
- `session.dmScope = per-channel-peer`（保持）
  - 继续使用隔离会话，避免跨对话污染上下文。
- `session.reset.mode = daily` + `atHour = 4`
  - 网关本地时间每天 `04:00` 后，下一条入站消息会启动新的 OpenClaw session。
- `session.resetByType.direct.mode = daily` + `atHour = 4`
  - 直接会话显式钉在“每日 04:00 后重开 session”，不再额外依赖 idle 次级切换。
- 连续性来源改为 memory / daily context
  - 每日重置后的首条消息不复用前一天 transcript window，而是让 OpenClaw 新 session + 本地 memory 重建上下文。
- `session.resetTriggers = ["/new", "/reset"]`
  - 手动上下文清理路径显式保留。

### 一致性策略（Memory / Window / Isolation）

- Memory：通过 memory/tool 层维持长期连续性，不依赖无限 transcript。
- Window：用 `contextTokens` 和 `maxTokens` 约束请求体与生成体，稳定延迟；午夜后由新 session 重新起窗。
- Isolation：`dmScope=per-channel-peer` + gateway-local daily reset（`04:00`），减少串话、跨天历史污染与旧 transcript 拖带。

### 验证命令（调优项）

1. 验证配置结构：
   - `jq '.agents.defaults.timeoutSeconds,.agents.defaults.llm,.agents.defaults.contextTokens,.session.dmScope,.session.reset,.session.resetByType,.session.resetTriggers' openclaw/openclaw.personal-system.json`
2. 启动并观察日志：
   - `./start_openclaw.sh`
3. 检查运行时是否使用新超时预算：
   - `npx openclaw logs tail --grep "timeout|idleTimeout|skills/weather/SKILL.md|Read from .*SKILL.md failed"`

## Tools Empty Array Incident (2026-04-13)

症状：

- `LLM request failed ... rawError=400 [] is too short - 'tools'`

结论：

- Qwen 的 OpenAI-compatible 路径会拒绝 `tools: []`。
- 规避方式是保证有效工具集非空，并在工具策略变更后重置会话。

已落地配置：

- `tools.profile = coding`
- `tools.allow = ["read","web_search","web_fetch","session_status","exec","process"]`
- Native `todo-tools` plugin remains disabled so live chat todo handling stays bridge-managed.
- After changing either field, use `/new` or `/reset` before continuing in the same session.

运行规约：

1. 改动 tools/profile/allow 后，先在会话执行 `/new`（或 `/reset`）再继续聊天。
2. 避免在“已有 tool 历史”的旧会话里切到空工具策略。

## Bridge Hardening (2026-04-13)

为覆盖“天气之外的联网检索”与微信链路稳定性，本轮新增 bridge 侧保护：

- 入站碎片消息合并：
  - 同一会话在短窗口（默认 1200ms）内多条消息先合并，再发起一次模型调用。
  - 非最终条返回合并提示，减少重复模型请求与 token 消耗。
- Meta 脏串/残片泄漏清洗：
  - 对包含工具调用残片（如 `recipient_name/functions.*`、`apply_patch`、`<analysis>`）的回复做最小清洗后再回给微信。
- 微信发送失败缓存：
  - 主动消息发送失败不再直接丢弃，进入本地待发队列；
  - 用户下次发言时，先合并回补历史未送达提醒，再返回当前回复。
- `/checkin` 命令入口：
  - 微信内发送 `/checkin <min> <max>` 可更新主动触达随机范围（分钟）。
  - 该范围用于 outbound 主动消息冷却窗口。

相关实现文件：

- `node_bridge/src/index.mjs`
- `node_bridge/src/wechatBridge.mjs`
- `node_bridge/src/outboundServer.mjs`
- `node_bridge/src/runtimeState.mjs`

### 验证命令（bridge）

1. Node bridge 测试：
   - `npm --prefix node_bridge test`
2. 查看缓存/轮询状态（运行后）：
   - `ls .openclaw_state/node-bridge-runtime/`
   - 重点文件：`checkin-range.json`、`proactive-dispatch.json`、`pending-outbound.json`
3. 观察日志：
   - `npx openclaw logs tail --grep "Read: from .*SKILL.md failed|Skipping skill path|timeout|queued|checkin"`
