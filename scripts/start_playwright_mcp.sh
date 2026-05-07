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

HEADLESS="${PLAYWRIGHT_MCP_HEADLESS:-true}"
HOST="${PLAYWRIGHT_MCP_HOST:-127.0.0.1}"
PORT="${PLAYWRIGHT_MCP_PORT:-}"
TRANSPORT="${PLAYWRIGHT_MCP_TRANSPORT:-stdio}"
EXECUTABLE_PATH="${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}}"
ISOLATED="${PLAYWRIGHT_MCP_ISOLATED:-true}"
USER_DATA_DIR="${PLAYWRIGHT_MCP_USER_DATA_DIR:-}"
STORAGE_STATE="${PLAYWRIGHT_MCP_STORAGE_STATE:-}"
CAPS="${PLAYWRIGHT_MCP_CAPS:-}"

ARGS=()

if [ "$HEADLESS" = "true" ]; then
  ARGS+=("--headless")
fi

if [ "$ISOLATED" = "true" ]; then
  ARGS+=("--isolated")
fi

if [ -n "$USER_DATA_DIR" ]; then
  ARGS+=("--user-data-dir" "$USER_DATA_DIR")
fi

if [ -n "$STORAGE_STATE" ]; then
  ARGS+=("--storage-state" "$STORAGE_STATE")
fi

if [ -n "$CAPS" ]; then
  ARGS+=("--caps" "$CAPS")
fi

if [ -n "$EXECUTABLE_PATH" ]; then
  ARGS+=("--executable-path" "$EXECUTABLE_PATH")
fi

if [ "$TRANSPORT" = "http" ] && [ -n "$PORT" ]; then
  ARGS+=("--host" "$HOST" "--port" "$PORT")
else
  unset PLAYWRIGHT_MCP_HOST
  unset PLAYWRIGHT_MCP_PORT
fi

cd "$ROOT_DIR"
exec node scripts/playwright_mcp_proxy.mjs "${ARGS[@]}"
