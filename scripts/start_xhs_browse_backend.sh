#!/usr/bin/env bash
# Start the xiaohongshu-mcp HTTP backend installed by prepare-xhs-browse-backend.sh.
# Intended for systemd or a foreground diagnostic shell.

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

MARKER_PATH="${XHS_BROWSE_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json}"
ROOT_STATE="${XHS_BROWSE_ROOT_DIR:-/opt/ran_agent/.ran_agent_state/xhs-browse}"

if [ ! -f "$MARKER_PATH" ]; then
  echo "XHS_BROWSE_NOT_READY: marker not found at $MARKER_PATH" >&2
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --write-env" >&2
  exit 1
fi

MARKER_OK=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "False")
if [ "$MARKER_OK" != "True" ]; then
  echo "XHS_BROWSE_NOT_READY: marker ok=false" >&2
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --force --write-env" >&2
  exit 1
fi

BACKEND_EXECUTABLE=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcp_executable', ''))" 2>/dev/null)
if [ -z "$BACKEND_EXECUTABLE" ] || [ ! -x "$BACKEND_EXECUTABLE" ]; then
  echo "XHS_BROWSE_NOT_READY: backend executable missing or not executable" >&2
  exit 1
fi

mkdir -p "$ROOT_STATE/xdg-config" "$ROOT_STATE/xdg-cache" "$ROOT_STATE/xdg-data"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$ROOT_STATE/xdg-config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT_STATE/xdg-cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$ROOT_STATE/xdg-data}"

exec "$BACKEND_EXECUTABLE"
