#!/usr/bin/env bash

set -euo pipefail

echo "Starting OpenClaw gateway..."

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"
CONFIG_FILE="$ROOT_DIR/openclaw/openclaw.personal-system.json"
PATCH_SCRIPT="$ROOT_DIR/scripts/patch_openclaw_personal_skills_warning.mjs"
RUNTIME_PATCH_SCRIPT="$ROOT_DIR/scripts/apply_openclaw_runtime_patches.mjs"
select_claude_settings_file() {
  if [ -n "${CLAUDE_SETTINGS_FILE:-}" ] && [ -f "$CLAUDE_SETTINGS_FILE" ]; then
    printf '%s\n' "$CLAUDE_SETTINGS_FILE"
    return 0
  fi

  local candidates=()
  if [ -n "${HOME:-}" ]; then
    candidates+=("$HOME/.claude/settings.json")
  fi
  candidates+=(
    "/home/ubuntu/.claude/settings.json"
    "/usr/bin/.claude/settings.json"
  )

  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

CLAUDE_SETTINGS_FILE="$(select_claude_settings_file || true)"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if command -v claude >/dev/null 2>&1; then
  CLAUDE_COMMAND="$(command -v claude)"
  CLAUDE_NODE_DIR="$(cd "$(dirname "$(command -v claude)")" && pwd)"
  export PATH="$CLAUDE_NODE_DIR:$PATH"
fi

if command -v codex >/dev/null 2>&1; then
  CODEX_NODE_DIR="$(cd "$(dirname "$(command -v codex)")" && pwd)"
  export PATH="$CODEX_NODE_DIR:$PATH"
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NODE_BRIDGE_ENV_FILE"
  set +a
fi

extract_claude_setting() {
  local key="$1"
  if [ ! -f "$CLAUDE_SETTINGS_FILE" ]; then
    return 1
  fi
  python3 "$ROOT_DIR/scripts/read_claude_settings_env.py" "$CLAUDE_SETTINGS_FILE" "$key"
}

inherit_claude_env_from_settings() {
  local keys=(
    ANTHROPIC_BASE_URL
    ANTHROPIC_AUTH_TOKEN
    ANTHROPIC_MODEL
    ANTHROPIC_DEFAULT_HAIKU_MODEL
    ANTHROPIC_DEFAULT_SONNET_MODEL
    ANTHROPIC_DEFAULT_OPUS_MODEL
    API_TIMEOUT_MS
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  )
  local key=""
  local value=""
  for key in "${keys[@]}"; do
    if [ -n "${!key:-}" ]; then
      continue
    fi
    value="$(extract_claude_setting "$key" 2>/dev/null || true)"
    if [ -n "$value" ]; then
      export "$key=$value"
    fi
  done
}

inherit_claude_env_from_settings

normalize_openclaw_project_paths() {
  python3 "$ROOT_DIR/scripts/normalize_openclaw_project_paths.py" \
    "$CONFIG_FILE" \
    "$ROOT_DIR" \
    "${CLAUDE_COMMAND:-$(command -v claude || true)}"
}

normalize_openclaw_project_paths

if [ -f "$RUNTIME_PATCH_SCRIPT" ]; then
  node "$RUNTIME_PATCH_SCRIPT"
fi

anthropic_base_url="${ANTHROPIC_BASE_URL:-}"
anthropic_auth_token="${ANTHROPIC_AUTH_TOKEN:-}"

if [ -z "$anthropic_base_url" ] || [ -z "$anthropic_auth_token" ]; then
  echo "Missing tool-capable Claude provider settings."
  echo "OpenClaw frontline is configured to use the anthropic-compatible provider from Claude settings."
  echo "Set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in .env.local, CLAUDE_SETTINGS_FILE, /home/ubuntu/.claude/settings.json, or /usr/bin/.claude/settings.json before starting."
  exit 1
fi

export PYTHON_BACKEND_BASE_URL="${PYTHON_BACKEND_BASE_URL:-http://127.0.0.1:8787}"
export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$ROOT_DIR/.openclaw_state}"
export OPENCLAW_DISABLE_MODEL_PRICING_REFRESH="${OPENCLAW_DISABLE_MODEL_PRICING_REFRESH:-true}"

if [ -f "$PATCH_SCRIPT" ]; then
  node "$PATCH_SCRIPT" "$ROOT_DIR" || echo "Warning: failed to apply OpenClaw skills warning patch."
fi

cd "$ROOT_DIR"
exec npx openclaw gateway run
