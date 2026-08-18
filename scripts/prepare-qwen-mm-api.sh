#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${QWEN_MM_STATE_DIR:-$ROOT_DIR/.ran_agent_state/qwen-mm}"
MARKER_PATH="${QWEN_MM_READY_PATH:-$STATE_DIR/ready.json}"
LOCK_FILE="$STATE_DIR/prepare.lock"
BACKEND="$STATE_DIR/uv-tools/qwen-mm-plugins/bin/qwen-mm-plugins-api"
PYTHON_BIN="${QWEN_MM_PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"
UV_BIN="${QWEN_MM_UV_BIN:-$ROOT_DIR/.venv/bin/uv}"
PACKAGE_SPEC='qwen-mm-plugins @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@ec9fbd1e11a30841685b949863e9d9d30cd7a4d8'

[[ -x "$PYTHON_BIN" ]] || { echo "ERROR: Python runtime not found: $PYTHON_BIN" >&2; exit 1; }
[[ -x "$UV_BIN" ]] || { echo "ERROR: uv not found: $UV_BIN" >&2; exit 1; }
command -v flock >/dev/null || { echo "ERROR: flock is required to prepare Qwen-MM" >&2; exit 1; }
command -v timeout >/dev/null || { echo "ERROR: timeout is required to probe Qwen-MM" >&2; exit 1; }
mkdir -p "$STATE_DIR" "$STATE_DIR/uv-cache" "$STATE_DIR/uv-tools"

export UV_CACHE_DIR="$STATE_DIR/uv-cache"
export UV_TOOL_DIR="$STATE_DIR/uv-tools"
export UV_LINK_MODE=copy
export UV_PYTHON_DOWNLOADS=never

(
  flock -n 200 || { echo "ERROR: another Qwen-MM prepare is running" >&2; exit 1; }
  if [[ -x "$BACKEND" ]] \
    && grep -Fxq '{"release":"qwen-mm-plugins-api-v1.0.3"}' "$MARKER_PATH" 2>/dev/null; then
    echo "Qwen-MM API backend is already ready." >&2
    exit 0
  fi
  echo "Preparing pinned Qwen-MM API backend..." >&2
  "$UV_BIN" tool install "$PACKAGE_SPEC" --with openai --python "$PYTHON_BIN" --force
  [[ -x "$BACKEND" ]] || { echo "ERROR: Qwen-MM API executable was not installed" >&2; exit 1; }

  smoke_output="$(timeout 20 "$BACKEND" <<'EOF' 2>/dev/null
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ran-agent-probe","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
)"
  for tool in ocr vision_chat; do
    grep -q "\"name\":\"$tool\"" <<<"$smoke_output" || {
      echo "ERROR: Qwen-MM tool missing: $tool" >&2
      exit 1
    }
  done

  tmp_marker="$(mktemp "$STATE_DIR/ready.tmp.XXXXXX")"
  printf '%s\n' '{"release":"qwen-mm-plugins-api-v1.0.3"}' >"$tmp_marker"
  mv -f "$tmp_marker" "$MARKER_PATH"
  echo "Qwen-MM API backend is ready." >&2
) 200>"$LOCK_FILE"
