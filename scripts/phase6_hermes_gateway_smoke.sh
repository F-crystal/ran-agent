#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

load_env_file() {
  local env_file="$1"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env.local"
load_env_file "$ROOT_DIR/node_bridge/.env.local"

PROFILE_NAME="${HERMES_PROFILE:-ran-assistant}"
HERMES_PORT="${HERMES_PORT:-8642}"
HERMES_HOST="${HERMES_HOST:-127.0.0.1}"
HERMES_HOME="${HERMES_HOME:-/tmp/ran-agent-hermes-home-phase5}"
PROFILE_ENV_FILE="$HERMES_HOME/profiles/$PROFILE_NAME/.env"
PHASE6_LOG_DIR="${PHASE6_LOG_DIR:-$ROOT_DIR/logs}"
PHASE6_RUN_ID="${PHASE6_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
PHASE6_OUTPUT_DIR="${PHASE6_OUTPUT_DIR:-$PHASE6_LOG_DIR/phase6-hermes-$PHASE6_RUN_ID}"
GATEWAY_LOG="$PHASE6_OUTPUT_DIR/hermes-gateway.log"
SMOKE_LOG="$PHASE6_OUTPUT_DIR/node-bridge-hermes-smoke.log"
PHASE6_REUSE_GATEWAY="${PHASE6_REUSE_GATEWAY:-0}"

tcp_ready() {
  local host="$1"
  local port="$2"
  bash -c ":</dev/tcp/$host/$port" >/dev/null 2>&1
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local attempts="$3"
  local attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if tcp_ready "$host" "$port"; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "phase6.fail: timed out waiting for Hermes gateway $host:$port" | tee "$PHASE6_OUTPUT_DIR/phase6-first-error.txt"
  echo "gateway_log=$GATEWAY_LOG" | tee -a "$PHASE6_OUTPUT_DIR/phase6-first-error.txt"
  exit 1
}

stop_pid_file_process() {
  local pid_file="$1"
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
}

stop_previous_phase6_processes() {
  local pid_file
  while IFS= read -r -d '' pid_file; do
    stop_pid_file_process "$pid_file"
  done < <(find "$PHASE6_LOG_DIR" -path '*/hermes-gateway.pid' -type f -print0 2>/dev/null || true)

  pkill -u "$(id -u)" -f 'scripts/start_obsidian_memory_mcp\.sh' >/dev/null 2>&1 || true
  pkill -u "$(id -u)" -f 'scripts/obsidian_index_mcp_launcher\.py' >/dev/null 2>&1 || true
  pkill -u "$(id -u)" -f 'obsidian-index mcp' >/dev/null 2>&1 || true
}

export RAN_AGENT_REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$ROOT_DIR}"
export HERMES_HOME
export HERMES_ACCEPT_HOOKS="${HERMES_ACCEPT_HOOKS:-1}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$HERMES_HOME/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$HERMES_HOME/uv-tools}"
export npm_config_cache="${npm_config_cache:-$HERMES_HOME/npm-cache}"
export TIME_MCP_PYTHON="${TIME_MCP_PYTHON:-$ROOT_DIR/.venv/bin/python}"
export MCP_SERVER_TIME_PYTHON="${MCP_SERVER_TIME_PYTHON:-$ROOT_DIR/.venv/bin/python}"
export PLAYWRIGHT_MCP_HEADLESS="${PLAYWRIGHT_MCP_HEADLESS:-true}"
export PLAYWRIGHT_MCP_ISOLATED="${PLAYWRIGHT_MCP_ISOLATED:-true}"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HF_HOME="${HF_HOME:-$HERMES_HOME/hf-home}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME}"
export SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME:-$HERMES_HOME/sentence-transformers}"
export OBSIDIAN_MEMORY_VAULT_DIR="${OBSIDIAN_MEMORY_VAULT_DIR:-$ROOT_DIR/vault}"
export OBSIDIAN_MEMORY_INDEX_PATH="${OBSIDIAN_MEMORY_INDEX_PATH:-$ROOT_DIR/data/obsidian-memory-index.duckdb}"
export OBSIDIAN_INDEX_DEVICE="${OBSIDIAN_INDEX_DEVICE:-cpu}"
export OBSIDIAN_MEMORY_REINDEX="${OBSIDIAN_MEMORY_REINDEX:-0}"
export OBSIDIAN_MEMORY_WATCH="${OBSIDIAN_MEMORY_WATCH:-0}"

export API_SERVER_ENABLED="${API_SERVER_ENABLED:-true}"
export API_SERVER_HOST="${API_SERVER_HOST:-$HERMES_HOST}"
export API_SERVER_PORT="${API_SERVER_PORT:-$HERMES_PORT}"
load_env_file "$PROFILE_ENV_FILE"
if [ -z "${HERMES_API_KEY:-}" ] && [ -n "${API_SERVER_KEY:-}" ]; then
  export HERMES_API_KEY="$API_SERVER_KEY"
fi
if [ -z "${API_SERVER_KEY:-}" ] && [ -n "${HERMES_API_KEY:-}" ]; then
  export API_SERVER_KEY="$HERMES_API_KEY"
fi
if [ -z "${API_SERVER_KEY:-}" ] && [ -z "${HERMES_API_KEY:-}" ]; then
  export API_SERVER_KEY="phase6-local-smoke"
  export HERMES_API_KEY="$API_SERVER_KEY"
fi
export HERMES_API_BASE_URL="${HERMES_API_BASE_URL:-http://$HERMES_HOST:$HERMES_PORT/v1}"
export HERMES_REPLY_MODE="${HERMES_REPLY_MODE:-api}"
export NODE_BRIDGE_REPLY_BACKEND="${NODE_BRIDGE_REPLY_BACKEND:-hermes}"
export HERMES_REPLY_TIMEOUT_SECONDS="${HERMES_REPLY_TIMEOUT_SECONDS:-300}"
export PHASE6_SMOKE_TIMEOUT_MS="${PHASE6_SMOKE_TIMEOUT_MS:-90000}"
export PHASE6_INCLUDE_OBSIDIAN="${PHASE6_INCLUDE_OBSIDIAN:-0}"
export PHASE6_SMOKE_OUTPUT_DIR="$PHASE6_OUTPUT_DIR"

mkdir -p "$PHASE6_OUTPUT_DIR" "$UV_CACHE_DIR" "$UV_TOOL_DIR" "$npm_config_cache" "$(dirname "$OBSIDIAN_MEMORY_INDEX_PATH")"

cd "$ROOT_DIR"

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  export VIRTUAL_ENV="${VIRTUAL_ENV:-$ROOT_DIR/.venv}"
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
fi

if [ -n "${HERMES_AGENT_DIR:-}" ]; then
  export PATH="$HERMES_AGENT_DIR:$PATH"
fi

if ! command -v hermes >/dev/null 2>&1; then
  echo "phase6.fail: hermes command not found. Set PATH or HERMES_AGENT_DIR before running." | tee "$PHASE6_OUTPUT_DIR/phase6-first-error.txt"
  exit 1
fi

if ! hermes profile show "$PROFILE_NAME" >/dev/null 2>&1; then
  hermes profile install "$ROOT_DIR/hermes/profile" --name "$PROFILE_NAME" --force -y
fi

gateway_started=0
if [ "$PHASE6_REUSE_GATEWAY" != "1" ]; then
  stop_previous_phase6_processes
fi

if [ "$PHASE6_REUSE_GATEWAY" = "1" ] && tcp_ready "$HERMES_HOST" "$HERMES_PORT"; then
  echo "phase6.gateway.reuse $HERMES_API_BASE_URL"
elif tcp_ready "$HERMES_HOST" "$HERMES_PORT"; then
  echo "phase6.fail: $HERMES_HOST:$HERMES_PORT is already in use; set PHASE6_REUSE_GATEWAY=1 to reuse it, or stop the old Hermes gateway." | tee "$PHASE6_OUTPUT_DIR/phase6-first-error.txt"
  exit 1
else
  echo "phase6.gateway.start $HERMES_API_BASE_URL"
  nohup hermes -p "$PROFILE_NAME" gateway run --replace --accept-hooks >"$GATEWAY_LOG" 2>&1 &
  echo "$!" >"$PHASE6_OUTPUT_DIR/hermes-gateway.pid"
  gateway_started=1
  wait_for_tcp "$HERMES_HOST" "$HERMES_PORT" 120
fi

{
  echo "phase6.env.profile=$PROFILE_NAME"
  echo "phase6.env.hermes_home=$HERMES_HOME"
  echo "phase6.env.api_base=$HERMES_API_BASE_URL"
  echo "phase6.env.obsidian_index=$OBSIDIAN_MEMORY_INDEX_PATH"
  echo "phase6.env.include_obsidian=$PHASE6_INCLUDE_OBSIDIAN"
  echo "phase6.env.gateway_started=$gateway_started"
  echo "phase6.env.gateway_log=$GATEWAY_LOG"
  echo "phase6.env.smoke_log=$SMOKE_LOG"
} | tee "$PHASE6_OUTPUT_DIR/phase6-summary.txt"

set +e
node "$ROOT_DIR/scripts/phase6_hermes_full_chain_smoke.mjs" 2>&1 | tee "$SMOKE_LOG"
smoke_status="${PIPESTATUS[0]}"
set -e

if [ "$smoke_status" -ne 0 ]; then
  {
    echo "phase6.fail: node bridge Hermes full-chain smoke failed"
    echo "first_error=$PHASE6_OUTPUT_DIR/phase6-first-error.json"
    echo "gateway_log=$GATEWAY_LOG"
    echo "smoke_log=$SMOKE_LOG"
  } | tee "$PHASE6_OUTPUT_DIR/phase6-first-error.txt"
  exit "$smoke_status"
fi

echo "phase6.ok: Hermes gateway/API server is running and Node bridge Hermes smoke passed"
echo "phase6.logs: $PHASE6_OUTPUT_DIR"
