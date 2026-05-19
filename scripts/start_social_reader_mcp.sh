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

# Stabilize uv/uvx: fixed cache and tool dirs prevent repeated multi-G archive builds
export UV_CACHE_DIR="${UV_CACHE_DIR:-/opt/ran_agent/.ran_agent_state/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-/opt/ran_agent/.ran_agent_state/uv-tools}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"
export UV_PYTHON_DOWNLOADS="${UV_PYTHON_DOWNLOADS:-never}"

# XHS backend timeout: must override generic SOCIAL_READER_MCP_TIMEOUT_MS
export SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS="${SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS:-90000}"
export XHS_BACKEND_MCP_TIMEOUT_MS="${XHS_BACKEND_MCP_TIMEOUT_MS:-90000}"
NODE_BIN="${SOCIAL_READER_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/socialReaderMcpServer.mjs"
