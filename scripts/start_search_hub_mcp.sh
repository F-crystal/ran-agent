#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"
source "$ROOT_DIR/scripts/launcher_test_isolation.sh"

launcher_load_env_file "$ENV_FILE"
launcher_load_env_file "$NODE_BRIDGE_ENV_FILE"
launcher_prepend_path "/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"
NODE_BIN="${SEARCH_HUB_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/searchHubMcpServer.mjs"
