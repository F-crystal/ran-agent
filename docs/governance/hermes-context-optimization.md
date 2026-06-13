# Hermes Context Optimization

Status: current as of 2026-06-14.

## Why Not Hard Reset

Hermes context optimization must reduce repeated prompt input without deleting useful continuity. A hard reset would drop live task clues, break cross-platform handoff, and encourage reloading long-term memory into every prompt. The supported path is telemetry first, budgeted injection second, and lite-only soft reset last.

Long-term memory remains external and on demand through `personal_memory`, `obsidian_memory`, or other specialist tools. The soft reset digest is not a memory store.

## Continuity Layers

- Hermes session history: provider-side short-term continuity for the selected profile.
- Node continuity: `recent_local_history`, `global_recent_history`, `active_topic`, `continuity_note`, media compact, and current user message.
- Long-term memory: explicit tool recall only, not injected wholesale.

The optimization goal is to avoid stacking all layers on every lite request.

## Context Modes

`HERMES_CONTEXT_INJECTION_MODE=auto|rich|slim|resume`

- `rich`: closest to legacy behavior for complex work and debugging.
- `slim`: daily lightweight mode with smaller local/global/topic budgets.
- `resume`: short recovery mode for the first lite request after soft reset.
- `auto`: picks a budget using continuity signals and logs `context_decision_reason`.

Provider usage telemetry should be observed with component telemetry:

- `input_tokens`
- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `recent_local_history.chars`
- `global_recent_history.chars`
- `active_topic.chars`
- `continuity_note.chars`
- `daily_digest.chars`
- user perceived continuity

## Lite Soft Reset

Soft reset is disabled by default:

```env
HERMES_LITE_SOFT_RESET_ENABLED=false
HERMES_LITE_SOFT_RESET_DRY_RUN=true
HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS=1200
HERMES_LITE_SOFT_RESET_KEEP_LAST_N=4
HERMES_LITE_SOFT_RESET_STATE_FILE=.ran_agent_state/hermes/session_maintenance.json
HERMES_LITE_SOFT_RESET_DIGEST_DIR=.ran_agent_state/hermes/digests/
```

All paths are resolved under `resolveStateDir()`. Do not point these variables outside the project runtime state directory.

## Commands

No command restarts services, edits systemd, or installs cron.

```bash
bash scripts/hermes-lite-soft-reset.sh --status
bash scripts/hermes-lite-soft-reset.sh --dry-run
bash scripts/hermes-lite-soft-reset.sh --apply
bash scripts/hermes-lite-soft-reset.sh --rollback-last
```

`--dry-run` reports the planned digest and session hash change without writing the session pointer. `--apply` writes the digest and rotates the lite session pointer only when `HERMES_LITE_SOFT_RESET_ENABLED=true` and dry-run is disabled. `--rollback-last` restores the previous lite session pointer without deleting digest files.

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

Start with `--dry-run` and telemetry review. Enable apply only after confirming that `daily_digest.chars` is small, `input_tokens` trends down, prompt cache hit tokens do not regress materially, and daily chat still feels continuous.
