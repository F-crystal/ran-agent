#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if [ "${NODE_ENV:-}" != "test" ] || [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" != "1" ]; then
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
fi

if [ "${NODE_ENV:-}" != "test" ] || [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" != "1" ]; then
  export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
fi

LOCAL_TIMEZONE="${LOCAL_TIMEZONE:-Asia/Shanghai}"
# TIME_MCP_PYTHON/MCP_SERVER_TIME_PYTHON can point at a preinstalled
# mcp-server-time environment; --prewarm or TIME_MCP_PREWARM=1 warms only.
PREWARM="${TIME_MCP_PREWARM:-}"
if [ "${1:-}" = "--prewarm" ]; then
  PREWARM="1"
fi

python_has_time_module() {
  "$1" -c "import mcp_server_time" >/dev/null 2>&1
}

select_time_mcp_python() {
  local configured_python="${TIME_MCP_PYTHON:-${MCP_SERVER_TIME_PYTHON:-}}"
  if [ -n "$configured_python" ]; then
    if [ ! -x "$configured_python" ]; then
      echo "$configured_python is not executable; check TIME_MCP_PYTHON or MCP_SERVER_TIME_PYTHON." >&2
      return 126
    fi
    if ! python_has_time_module "$configured_python"; then
      echo "$configured_python cannot import mcp_server_time; install mcp-server-time for that interpreter." >&2
      return 126
    fi
    printf '%s\n' "$configured_python"
    return 0
  fi

  local candidate
  local candidates=()
  if [ "${NODE_ENV:-}" != "test" ] || [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" != "1" ]; then
    candidates+=("$ROOT_DIR/.venv/bin/python")
  fi
  candidates+=("$(command -v python3 || true)" "$(command -v python || true)")
  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && python_has_time_module "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

set +e
TIME_MCP_PYTHON_BIN="$(select_time_mcp_python)"
TIME_MCP_PYTHON_STATUS=$?
set -e

if [ "$TIME_MCP_PYTHON_STATUS" -eq 0 ]; then
  if [ -n "$PREWARM" ]; then
    "$TIME_MCP_PYTHON_BIN" -c "import mcp_server_time" >/dev/null
    exit 0
  fi
  exec "$TIME_MCP_PYTHON_BIN" -m mcp_server_time --local-timezone "$LOCAL_TIMEZONE"
fi

if [ "$TIME_MCP_PYTHON_STATUS" -ne 1 ]; then
  exit "$TIME_MCP_PYTHON_STATUS"
fi

if ! UVX_BIN="$(command -v uvx)"; then
  echo "uvx is required to start mcp-server-time. Install uv from https://docs.astral.sh/uv/ first." >&2
  exit 127
fi

if [ -n "$PREWARM" ]; then
  "$UVX_BIN" mcp-server-time --help >/dev/null
  exit 0
fi

exec "$UVX_BIN" mcp-server-time --local-timezone "$LOCAL_TIMEZONE"
