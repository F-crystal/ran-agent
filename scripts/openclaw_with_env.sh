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

CLAUDE_SETTINGS_RESOLVED="$(select_claude_settings_file || true)"

extract_claude_setting() {
  local key="$1"
  if [ -z "$CLAUDE_SETTINGS_RESOLVED" ]; then
    return 1
  fi
  python3 "$ROOT_DIR/scripts/read_claude_settings_env.py" "$CLAUDE_SETTINGS_RESOLVED" "$key"
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

export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$ROOT_DIR/openclaw/openclaw.personal-system.json}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$ROOT_DIR/.openclaw_state}"
export OPENCLAW_DISABLE_MODEL_PRICING_REFRESH="${OPENCLAW_DISABLE_MODEL_PRICING_REFRESH:-true}"

cd "$ROOT_DIR"
exec npx openclaw "$@"
