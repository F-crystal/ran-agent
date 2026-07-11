#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"
source "$ROOT_DIR/scripts/launcher_test_isolation.sh"

launcher_load_env_file "$ENV_FILE"
launcher_load_env_file "$NODE_BRIDGE_ENV_FILE"

DEFAULT_NODE_BIN="$(launcher_resolve_command node)"
launcher_prepend_path "/opt/nodejs/node-v22.22.2-linux-x64/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"
export CO_READING_ROOT_DIR="${CO_READING_ROOT_DIR:-$ROOT_DIR/.ran_agent_state/co_reading}"

NODE_BIN="${CO_READING_NODE_BIN:-$DEFAULT_NODE_BIN}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/coReading/mcpServer.mjs"
