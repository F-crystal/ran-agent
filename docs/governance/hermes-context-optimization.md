# Hermes Context Optimization

Status: current as of 2026-06-14.

## Why Not Hard Reset

Hermes context optimization must reduce repeated prompt input without deleting useful continuity. A hard reset would drop live task clues, break cross-platform handoff, and encourage reloading long-term memory into every prompt. The supported path is telemetry first, budgeted injection second, and lite-only soft reset last.

Long-term memory remains external and on demand through `personal_memory`, `obsidian_memory`, or other specialist tools. The soft reset digest is not a memory store.

## Continuity Layers

- Hermes session history: provider-side short-term continuity for the selected profile.
- Node continuity: `recent_local_history`, `global_recent_history`, `active_topic`, `continuity_note`, media compact, and current user message.
- Vault and long-term memory: `vault/`, `personal_memory`, and `obsidian_memory` are storage/recall sources. They must not be injected wholesale into lite prompts.
- Long-term memory: explicit tool recall only, not injected wholesale.

The optimization goal is to avoid stacking all layers on every lite request.

`vault/` may feed maintenance summaries or explicit recall, but only as short, sanitized excerpts. Follow the runtime budget: at most one vault recall hit and a small snippet, not raw daily chat logs. Soft reset digest generation may use already-summarized vault/wiki signals for `open_threads`, `pending_commitments`, `active_preferences`, and `recent_artifacts`; it must not copy `vault/inbox`, `vault/raw`, or `vault/wiki` content verbatim into `daily_digest`.

## Context Modes

`HERMES_CONTEXT_INJECTION_MODE=auto|rich|slim|resume`

- `rich`: closest to legacy behavior for complex work and debugging.
- `slim`: daily lightweight mode with smaller local/global/topic budgets.
- `resume`: short recovery mode for the first lite request after soft reset.
- `auto`: picks a budget using continuity signals and logs `context_decision_reason`.

`HERMES_CONTEXT_CACHE_STRATEGY=balanced|cache_first|token_first`

- `balanced`: default. Keeps A/B-package behavior conservative: cache telemetry is on, provider-visible append history is off unless explicitly enabled.
- `cache_first`: opts into provider-visible append history for lite daily continuity. This is the mode to test when DeepSeek prefix cache hit rate is the priority.
- `token_first`: disables provider-visible append history reads/writes and stays close to the legacy slim/auto trimming path when prompt cost and context size are the priority.

Provider usage telemetry should be observed with component telemetry:

- `input_tokens`
- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `cache_strategy`
- `cache_hit_ratio`
- `cache_friendly_history_turns`
- `cache_exact_history_turns`
- `cache_inexact_history_turns`
- `cache_prefix_broken_at_turn`
- `sanitized_changed`
- `cache_exact_ratio`
- `recent_local_history.chars`
- `global_recent_history.chars`
- `active_topic.chars`
- `continuity_note.chars`
- `daily_digest.chars`
- user perceived continuity

## Cache-Friendly Append History

DeepSeek prefix cache works best when the provider sees the same byte-identical prompt prefix across requests. The lite profile can use a bounded provider-visible append log so the next request can replay the previous user and assistant messages before the current user text:

```env
HERMES_CACHE_FRIENDLY_HISTORY=false
HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=6
HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=12000
HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=lite
HERMES_CACHE_TELEMETRY_ENABLED=true
```

The default remains safe: telemetry only, append history off. `cache_first` is an explicit opt-in and enables append history even when `HERMES_CACHE_FRIENDLY_HISTORY` is unset. `token_first` disables append history even if the boolean flag is true.

Append records are written only after a successful provider response. The stored content is sanitized before disk write and never keeps token-like values, cookies, or absolute paths. Every record stores exactness metadata instead of raw unsanitized text:

- `cache_exact`: true only when stored content exactly matches the provider-visible content.
- `sanitized_changed`: true when safety sanitization changed stored content.
- `sanitized_reason`: `token_like`, `absolute_path`, `multiple`, or `none`.
- `provider_content_hash` and `stored_content_hash`: SHA-256 hashes for comparison without logging raw content.

If sanitization changes a turn, the next request may still use the sanitized text for continuity, but telemetry marks the prefix as inexact. `cache_prefix_broken_at_turn` is 1-based within the selected append history and shows the first turn where exact prefix replay can no longer be assumed. Do not preserve tokens, cookies, session IDs, API keys, or absolute paths just to improve cache hit rate.

The prompt section order is cache-friendly but still correctness-first:

1. Stable routing and response-style constraints.
2. Stable tool and media instructions.
3. Reusable active topic and continuity.
4. One-shot soft-reset daily digest, when pending.
5. Dynamic time context.
6. Media context.
7. Current user text.

After a 05:00 lite soft reset, the digest is injected once near the back of the prompt and marked consumed only after provider success. The second successful turn can then recover the provider-visible prefix through append history when `cache_first` or `HERMES_CACHE_FRIENDLY_HISTORY=true` is active.

## Lite Soft Reset

Production lite soft reset is enabled for the deployed personal runtime. The
scheduled reset runs after the 04:00 knowledge/night-cycle window so vault and
memory maintenance have time to settle before the lite session key rotates.

```env
HERMES_LITE_SOFT_RESET_ENABLED=true
HERMES_LITE_SOFT_RESET_DRY_RUN=false
HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS=1200
HERMES_LITE_SOFT_RESET_KEEP_LAST_N=4
HERMES_LITE_SOFT_RESET_STATE_FILE=.ran_agent_state/hermes/session_maintenance.json
HERMES_LITE_SOFT_RESET_DIGEST_DIR=.ran_agent_state/hermes/digests/
```

All paths are resolved under `resolveStateDir()`. Do not point these variables outside the project runtime state directory.

## Commands

Manual maintenance commands do not restart services:

```bash
bash scripts/hermes-lite-soft-reset.sh --status
bash scripts/hermes-lite-soft-reset.sh --dry-run
bash scripts/hermes-lite-soft-reset.sh --apply
bash scripts/hermes-lite-soft-reset.sh --rollback-last
```

`--dry-run` reports the planned digest and session hash change without writing the session pointer. `--apply` writes the digest and rotates the lite session pointer only when `HERMES_LITE_SOFT_RESET_ENABLED=true` and dry-run is disabled. `--rollback-last` restores the previous lite session pointer without deleting digest files.

Install or update the daily systemd timer:

```bash
bash scripts/install-hermes-lite-soft-reset-timer.sh --install --time 05:00
bash scripts/install-hermes-lite-soft-reset-timer.sh --status
bash scripts/install-hermes-lite-soft-reset-timer.sh --disable
```

The installer writes `ran-agent-hermes-lite-soft-reset.service` and
`ran-agent-hermes-lite-soft-reset.timer`, enables the timer, and upserts
`HERMES_LITE_SOFT_RESET_ENABLED=true` plus
`HERMES_LITE_SOFT_RESET_DRY_RUN=false` into the Node env files. The service runs
`bash /opt/ran_agent/scripts/hermes-lite-soft-reset.sh --apply` at 05:00.

## Digest Format

Digest files are short JSON objects:

```json
{
  "date": "YYYY-MM-DD",
  "profile": "lite",
  "sourceSessionIdHash": "...",
  "digestId": "...",
  "open_threads": [],
  "pending_commitments": [],
  "active_preferences": [],
  "recent_artifacts": [],
  "do_not_carry": []
}
```

Each array is bounded to at most five short sanitized entries. The whole digest is bounded by `HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS`. It must not contain large user quotes, raw secrets, provider tokens, cookies, or sensitive paths.

The digest is injected only once as the `daily_digest` component on the next successful lite request, using resume mode. It is marked consumed only after the provider returns successfully. Full profile requests do not consume or inject the lite digest.

## Rollback

Use:

```bash
bash scripts/hermes-lite-soft-reset.sh --rollback-last
```

Rollback changes only the lite session pointer. Old session files and digest files are retained. To disable the whole mechanism, set:

```env
HERMES_LITE_SOFT_RESET_ENABLED=false
```

## Deployment Notes

The production runtime split script writes the conservative B-package Node defaults into `.env.local`:

```env
HERMES_CONTEXT_INJECTION_MODE=auto
HERMES_CONTEXT_CACHE_STRATEGY=balanced
HERMES_RECENT_TEXT_TURNS=4
HERMES_RECENT_TEXT_CHAR_BUDGET=2400
HERMES_GLOBAL_RECENT_TURNS=2
HERMES_GLOBAL_RECENT_CHAR_BUDGET=800
HERMES_ACTIVE_TOPIC_CHAR_BUDGET=400
HERMES_CACHE_FRIENDLY_HISTORY=false
HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=6
HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=12000
HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=lite
HERMES_CACHE_TELEMETRY_ENABLED=true
HERMES_LITE_SOFT_RESET_ENABLED=true
HERMES_LITE_SOFT_RESET_DRY_RUN=false
```

The script intentionally does not inherit existing `HERMES_*` values from the shell or an older `.env.local`, because that can preserve legacy rich budgets by accident. Operators who need to override deployment defaults should use the explicit deploy-time override namespace, for example:

```bash
RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_TURNS=6 \
RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_CHAR_BUDGET=3200 \
bash scripts/apply-hermes-runtime-split.sh
```

To test cache-first behavior during deployment:

```bash
RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY=cache_first \
bash scripts/apply-hermes-runtime-split.sh
```

To roll back cache-friendly append usage while keeping telemetry:

```bash
RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY=balanced \
RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY=false \
RAN_AGENT_DEPLOY_HERMES_CACHE_TELEMETRY_ENABLED=true \
bash scripts/apply-hermes-runtime-split.sh
```

Useful production observation command:

```bash
journalctl -u ran-agent-node.service --since 'today' --no-pager \
  | grep -E 'hermes-provider-usage|hermes-context-components'
```

To disable soft reset through deployment defaults:

```bash
RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_ENABLED=false \
RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_DRY_RUN=true \
bash scripts/apply-hermes-runtime-split.sh
```
