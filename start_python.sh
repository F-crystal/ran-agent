#!/usr/bin/env bash

set -euo pipefail

echo "Starting Python backend capabilities service..."

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if command -v qwen >/dev/null 2>&1; then
  QWEN_NODE_DIR="$(cd "$(dirname "$(command -v qwen)")" && pwd)"
  export PATH="$QWEN_NODE_DIR:$PATH"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NODE_BRIDGE_ENV_FILE"
  set +a
fi

cd "$ROOT_DIR"

if [ -f ".venv/bin/activate" ]; then
  # Activate local virtual environment when available.
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

export PERSONAL_AGENT_HTTP_HOST="127.0.0.1"
export PERSONAL_AGENT_HTTP_PORT="8787"
export PYTHONPATH="src"

export PERSONAL_AGENT_PROACTIVE_ENABLED="${PERSONAL_AGENT_PROACTIVE_ENABLED:-false}"
export PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED="${PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED:-false}"
export PERSONAL_AGENT_BACKEND_QWEN_ENABLED="${PERSONAL_AGENT_BACKEND_QWEN_ENABLED:-false}"
export PERSONAL_AGENT_QWEN_CHAT_MODEL="${PERSONAL_AGENT_QWEN_CHAT_MODEL:-qwen3.5-plus}"
export PERSONAL_AGENT_QWEN_TOOLS_MODEL="${PERSONAL_AGENT_QWEN_TOOLS_MODEL:-qwen3.5-plus}"
export PERSONAL_AGENT_QWEN_BASE_URL="${PERSONAL_AGENT_QWEN_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1/responses}"
export PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS="${PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS:-60}"

export PERSONAL_AGENT_REVIEWER_ENABLED="${PERSONAL_AGENT_REVIEWER_ENABLED:-true}"
export PERSONAL_AGENT_REVIEWER_BLACKLIST_ENABLED="${PERSONAL_AGENT_REVIEWER_BLACKLIST_ENABLED:-true}"
export PERSONAL_AGENT_OFF_TOPIC_CHECK_ENABLED="${PERSONAL_AGENT_OFF_TOPIC_CHECK_ENABLED:-true}"
export PERSONAL_AGENT_OMBRE_MCP_COMMAND="${PERSONAL_AGENT_OMBRE_MCP_COMMAND:-$ROOT_DIR/src/personal_agent/ombre_brain_mcp.py}"
export OMBRE_VAULT_PATH="${OMBRE_VAULT_PATH:-$ROOT_DIR/vault/ombre}"
export OMBRE_VAULT_LEGACY_PATH="${OMBRE_VAULT_LEGACY_PATH:-$ROOT_DIR/.openclaw_state/ombre_vault}"
export OMBRE_VAULT_FALLBACK_PATHS="${OMBRE_VAULT_FALLBACK_PATHS:-$OMBRE_VAULT_LEGACY_PATH}"

mkdir -p "$ROOT_DIR/vault"
mkdir -p "$OMBRE_VAULT_PATH"

python -m personal_agent.http_runner
