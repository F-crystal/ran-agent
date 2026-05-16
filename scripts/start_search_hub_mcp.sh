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

export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE_BIN="${SEARCH_HUB_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/searchHubMcpServer.mjs"
