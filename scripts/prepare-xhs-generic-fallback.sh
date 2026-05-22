#!/usr/bin/env bash
# Install wanyi-watermark into fixed UV_TOOL_DIR and write readiness marker.
# Uses flock to prevent concurrent installs.
# Usage: bash scripts/prepare-xhs-generic-fallback.sh [--force]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_DIR="/opt/ran_agent/.ran_agent_state/locks"
LOCK_FILE="$LOCK_DIR/xhs-generic-fallback.lock"
MARKER_PATH="${XHS_GENERIC_FALLBACK_READY_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json}"
PACKAGE="wanyi-watermark"
TOOL_NAME="parse_xhs_link"
WRAPPER="$ROOT_DIR/scripts/run_xhs_generic_fallback_mcp.sh"
PYTHON_SOURCE="/opt/ran_agent/.venv/bin/python"

export UV_CACHE_DIR="${UV_CACHE_DIR:-/opt/ran_agent/.ran_agent_state/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-/opt/ran_agent/.ran_agent_state/uv-tools}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"
export UV_PYTHON_DOWNLOADS="${UV_PYTHON_DOWNLOADS:-never}"

mkdir -p "$LOCK_DIR" "$(dirname "$MARKER_PATH")" "$UV_CACHE_DIR" "$UV_TOOL_DIR"

FORCE_FLAG=""
if [ "${1:-}" = "--force" ]; then
  FORCE_FLAG="--force"
fi

write_marker() {
  local ok="$1" backend_executable="$2" backend_args="$3" backend_python="$4" backend_module="$5" version="$6"
  local now tmp_marker
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp_marker="$(mktemp "${MARKER_PATH}.tmp.XXXXXX")"

  # All values via sys.argv. Entire python3 command (including heredoc redirect and > redirect)
  # must be on ONE line so shell correctly passes "$version" as the last argument.
  python3 - "$ok" "$PACKAGE" "$TOOL_NAME" "$WRAPPER" "$backend_executable" "$backend_args" "$backend_python" "$backend_module" "$now" "$version" > "$tmp_marker" <<'PYEOF'
import json, sys
ok_str, package, tool_name, command, backend_exec, backend_args_json, backend_py, backend_mod, prepared_at, ver = sys.argv[1:]
marker = {
    "ok": ok_str == "true",
    "package": package,
    "tool_name": tool_name,
    "command": command,
    "args": [],
    "backend_executable": backend_exec,
    "backend_args": json.loads(backend_args_json) if backend_args_json else [],
    "backend_python": backend_py,
    "backend_module": backend_mod,
    "prepared_at": prepared_at,
    "version": ver.splitlines()[0].strip() if ver else "unknown",
}
json.dump(marker, sys.stdout, ensure_ascii=False, indent=2)
PYEOF

  # Validate JSON before committing
  if python3 -m json.tool "$tmp_marker" > /dev/null 2>&1; then
    mv -f "$tmp_marker" "$MARKER_PATH"
  else
    echo "ERROR: generated marker is not valid JSON, discarding" >&2
    rm -f "$tmp_marker"
    return 1
  fi
}

marker_is_ready() {
  python3 - "$MARKER_PATH" "$WRAPPER" "$TOOL_NAME" <<'PYEOF'
import json
import os
import sys

marker_path, wrapper, tool_name = sys.argv[1:]
with open(marker_path, "r", encoding="utf-8") as fh:
    d = json.load(fh)

backend_executable = str(d.get('backend_executable') or '')
backend_python = str(d.get('backend_python') or '')
backend_module = str(d.get('backend_module') or '')

has_executable_backend = (
    bool(backend_executable)
    and backend_executable != wrapper
    and os.path.isfile(backend_executable)
    and os.access(backend_executable, os.X_OK)
)
has_python_backend = (
    bool(backend_python)
    and bool(backend_module)
    and os.path.isfile(backend_python)
    and os.access(backend_python, os.X_OK)
)

ok = (
    d.get('ok') is True
    and d.get('command') == wrapper
    and d.get('args') == []
    and d.get('tool_name') == tool_name
    and isinstance(d.get('backend_args'), list)
    and (has_executable_backend or has_python_backend)
)
sys.exit(0 if ok else 1)
PYEOF
}

(
  flock -n 200 || { echo "ERROR: another prepare is running; aborting." >&2; exit 1; }

  # Skip if already ready (unless --force)
  if [ -z "$FORCE_FLAG" ] && [ -f "$MARKER_PATH" ]; then
    if marker_is_ready 2>/dev/null; then
      echo "Already prepared. Use --force to reinstall." >&2
      cat "$MARKER_PATH" >&2
      exit 0
    else
      echo "Existing marker is missing required schema/backend readiness; preparing again." >&2
    fi
  fi

  echo "Installing $PACKAGE into $UV_TOOL_DIR..." >&2
  # shellcheck disable=SC2086
  uv tool install "$PACKAGE" --python "$PYTHON_SOURCE" $FORCE_FLAG

  TOOL_VENV="$UV_TOOL_DIR/$PACKAGE"
  VERSION=$(uv tool list 2>/dev/null | grep "$PACKAGE" | awk '{print $2}' || echo "unknown")

  # Discover backend entry: prefer console script, fallback to python -m module
  BACKEND_EXECUTABLE=""
  BACKEND_ARGS="[]"
  BACKEND_PYTHON=""
  BACKEND_MODULE=""

  # 1. Check for console script (installed by uv tool install)
  CONSOLE_SCRIPT="$TOOL_VENV/bin/wanyi-watermark"
  if [ -x "$CONSOLE_SCRIPT" ]; then
    BACKEND_EXECUTABLE="$CONSOLE_SCRIPT"
    BACKEND_ARGS="[]"
    echo "Found console script: $CONSOLE_SCRIPT" >&2
  fi

  # 2. Fallback: discover python -m module
  if [ -z "$BACKEND_EXECUTABLE" ]; then
    for candidate in "$TOOL_VENV/bin/python3" "$TOOL_VENV/bin/python"; do
      if [ -x "$candidate" ]; then
        BACKEND_PYTHON="$candidate"
        break
      fi
    done
    if [ -n "$BACKEND_PYTHON" ]; then
      for module_candidate in "douyin_mcp_server" "wanyi_watermark"; do
        if "$BACKEND_PYTHON" -c "import $module_candidate" 2>/dev/null; then
          BACKEND_MODULE="$module_candidate"
          echo "Found module: $module_candidate" >&2
          break
        fi
      done
    fi
  fi

  if [ -z "$BACKEND_EXECUTABLE" ] && [ -z "$BACKEND_MODULE" ]; then
    echo "ERROR: could not discover MCP server entry for $PACKAGE" >&2
    write_marker "false" "" "[]" "" "" "unknown"
    echo "GENERIC_FALLBACK_TOOL_UNCONFIRMED" >&2
    exit 1
  fi

  # Smoke test: real MCP tools/list (initialize + notifications/initialized + tools/list)
  echo "Smoke testing MCP tools/list (timeout 15s)..." >&2
  TOOL_CONFIRMED=false

  if [ -n "$BACKEND_EXECUTABLE" ]; then
    SMOKE_OUTPUT=$(timeout 15 "$BACKEND_EXECUTABLE" <<'MCP_EOF' 2>/dev/null || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
MCP_EOF
)
  elif [ -n "$BACKEND_PYTHON" ] && [ -n "$BACKEND_MODULE" ]; then
    SMOKE_OUTPUT=$(timeout 15 "$WRAPPER" --probe --python "$BACKEND_PYTHON" --module "$BACKEND_MODULE" <<'MCP_EOF' 2>/dev/null || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
MCP_EOF
)
  fi

  if echo "$SMOKE_OUTPUT" | grep -q "$TOOL_NAME"; then
    TOOL_CONFIRMED=true
    echo "parse_xhs_link: CONFIRMED" >&2
  else
    echo "WARNING: $TOOL_NAME not found in MCP tools/list response" >&2
    echo "GENERIC_FALLBACK_TOOL_UNCONFIRMED" >&2
  fi

  # Write marker
  if [ "$TOOL_CONFIRMED" = "true" ]; then
    write_marker "true" "$BACKEND_EXECUTABLE" "$BACKEND_ARGS" "$BACKEND_PYTHON" "$BACKEND_MODULE" "$VERSION"
    echo "Prepared successfully." >&2
  else
    write_marker "false" "$BACKEND_EXECUTABLE" "$BACKEND_ARGS" "$BACKEND_PYTHON" "$BACKEND_MODULE" "$VERSION"
  fi
  cat "$MARKER_PATH" >&2
) 200>"$LOCK_FILE"
