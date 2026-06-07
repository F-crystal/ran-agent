#!/usr/bin/env bash

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

DEFAULT_NODE_BIN="$(command -v node)"
export PATH="/opt/nodejs/node-v22.22.2-linux-x64/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export RAN_AGENT_REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$ROOT_DIR}"
export CO_READING_ROOT_DIR="${CO_READING_ROOT_DIR:-$ROOT_DIR/.ran_agent_state/co_reading}"
export CO_READING_WEB_ENABLED="${CO_READING_WEB_ENABLED:-true}"

NODE_BIN="${CO_READING_NODE_BIN:-$DEFAULT_NODE_BIN}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/coReading/webServer.mjs"
