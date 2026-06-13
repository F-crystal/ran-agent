#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PYTHON_BACKEND_BASE_URL="${PYTHON_BACKEND_BASE_URL:-http://127.0.0.1:8787}"
TARGET_DATE="${1:-$(date -d yesterday +%F)}"
INBOX_NOTE="$ROOT_DIR/vault/inbox/night_cycle_${TARGET_DATE}.md"
NIGHT_CYCLE_ARTIFACT="$ROOT_DIR/debug/night_cycles/${TARGET_DATE}.json"

log() {
  printf '[daily-carryover-preflight] %s\n' "$*"
}

if [ ! -f "$NIGHT_CYCLE_ARTIFACT" ]; then
  log "night-cycle artifact missing: $NIGHT_CYCLE_ARTIFACT"
  exit 1
fi

if [ ! -f "$INBOX_NOTE" ]; then
  log "daily carry-over already archived for $TARGET_DATE"
  exit 0
fi

log "daily carry-over still pending, triggering archive for $TARGET_DATE"
response="$(
  curl -sS --max-time "${DAILY_CARRYOVER_PREFLIGHT_TIMEOUT_SECONDS:-1500}" \
    -X POST "$PYTHON_BACKEND_BASE_URL/tools/knowledge/run" \
    -H 'Content-Type: application/json' \
    -d '{"action":"daily_carryover","trigger":"soft_reset_preflight"}'
)"
log "$response"

if [ -f "$INBOX_NOTE" ]; then
  log "daily carry-over note is still in inbox after retry: $INBOX_NOTE"
  exit 1
fi

log "daily carry-over archived for $TARGET_DATE"
