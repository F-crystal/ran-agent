#!/usr/bin/env bash
# Start the public-only XHS-Downloader API sidecar.
# The service binds to 127.0.0.1 and does not load or pass any XHS cookie.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NODE_BRIDGE_ENV_FILE"
  set +a
fi

# Public-only guard: never pass legacy account-backed XHS settings into the
# sidecar process, even if an old env file was not cleaned yet.
unset \
  XHS_COOKIE \
  XHS_MCP_COMMAND \
  XHS_MCP_ARGS_JSON \
  PERSONAL_AGENT_XHS_MCP_COMMAND \
  PERSONAL_AGENT_XHS_MCP_ARGS_JSON \
  XHS_BROWSE_ENABLED \
  SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS \
  XHS_BROWSE_MARKER_PATH \
  XHS_BROWSE_ROOT_DIR \
  XHS_BROWSE_MCP_URL \
  XHS_BROWSE_MCP_COMMAND \
  XHS_BROWSE_MCP_ARGS_JSON \
  XHS_BROWSE_MCP_COOKIE_ENV \
  XHS_BROWSE_MCP_COOKIE \
  XHS_BROWSE_MCP_TIMEOUT_MS \
  XHS_BROWSE_MAX_RESULTS \
  XHS_BROWSE_MAX_ITEMS \
  XHS_BROWSE_MIN_INTERVAL_MS \
  XHS_BROWSE_MAX_CALLS_PER_SESSION \
  XHS_BROWSE_SEARCH_ENABLED \
  XHS_BROWSE_NOTE_ENABLED \
  XHS_BROWSE_USER_ENABLED \
  XHS_BROWSE_FEED_ENABLED \
  XHS_NOTE_TOKEN_CACHE_PATH \
  XHS_NOTE_TOKEN_CACHE_DEBUG

MARKER_PATH="${XHS_PUBLIC_SIDECAR_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json}"
API_HOST="${XHS_PUBLIC_SIDECAR_HOST:-127.0.0.1}"
API_PORT="${XHS_PUBLIC_SIDECAR_PORT:-18061}"
LOG_LEVEL="${XHS_PUBLIC_SIDECAR_LOG_LEVEL:-info}"

if [ ! -f "$MARKER_PATH" ]; then
  echo "XHS_PUBLIC_SIDECAR_NOT_READY: marker not found at $MARKER_PATH" >&2
  echo "hint: run scripts/prepare-xhs-public-sidecar.sh" >&2
  exit 1
fi

MARKER_OK=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "False")
if [ "$MARKER_OK" != "True" ]; then
  echo "XHS_PUBLIC_SIDECAR_NOT_READY: marker ok=false" >&2
  echo "hint: run scripts/prepare-xhs-public-sidecar.sh --force" >&2
  exit 1
fi

SOURCE_DIR=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('source_dir', ''))" 2>/dev/null)
PYTHON_BIN=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('venv_python', ''))" 2>/dev/null)

if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/main.py" ]; then
  echo "XHS_PUBLIC_SIDECAR_NOT_READY: source checkout missing from marker" >&2
  exit 1
fi
if [ -z "$PYTHON_BIN" ] || [ ! -x "$PYTHON_BIN" ]; then
  echo "XHS_PUBLIC_SIDECAR_NOT_READY: venv python missing from marker" >&2
  exit 1
fi

export PYTHONUNBUFFERED=1
cd "$SOURCE_DIR"

exec "$PYTHON_BIN" -c '
from asyncio import run
import sys
from main import api_server

host = sys.argv[1]
port = int(sys.argv[2])
log_level = sys.argv[3]
run(api_server(host=host, port=port, log_level=log_level))
' "$API_HOST" "$API_PORT" "$LOG_LEVEL"
