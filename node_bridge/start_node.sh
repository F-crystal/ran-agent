#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

# Load environment variables from .env.local if it exists
if [ -f ".env.local" ]; then
  echo "📄 Loading environment from .env.local..."
  set -a
  source ".env.local"
  set +a
fi

echo "🌉 Starting Node bridge (Hermes frontend mode)..."
export NODE_BRIDGE_REPLY_BACKEND="${NODE_BRIDGE_REPLY_BACKEND:-hermes}"
export NODE_BRIDGE_FALLBACK_TEXT="${NODE_BRIDGE_FALLBACK_TEXT:-暂时无法连接到 Hermes，请稍后再试。}"
export PERSONAL_AGENT_PROACTIVE_ENABLED="${PERSONAL_AGENT_PROACTIVE_ENABLED:-false}"
export PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED="${PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED:-false}"

# Optional backend capability ingest (timeline/session persistence only).
export PYTHON_BACKEND_INGEST_ENABLED="${PYTHON_BACKEND_INGEST_ENABLED:-true}"
export PYTHON_BACKEND_BASE_URL="${PYTHON_BACKEND_BASE_URL:-http://127.0.0.1:8787}"

# State directory
export RAN_AGENT_STATE_DIR="${RAN_AGENT_STATE_DIR:-$(cd .. && pwd)/.ran_agent_state}"
export WEIXIN_LOGIN_MAX_RETRIES="${WEIXIN_LOGIN_MAX_RETRIES:-5}"
export WEIXIN_LOGIN_RETRY_DELAY_MS="${WEIXIN_LOGIN_RETRY_DELAY_MS:-1500}"
export WEIXIN_FORCE_LOGIN="${WEIXIN_FORCE_LOGIN:-false}"
export WEIXIN_RESET_SYNC_ON_START="${WEIXIN_RESET_SYNC_ON_START:-true}"
export WEIXIN_PREFLIGHT_TIMEOUT_MS="${WEIXIN_PREFLIGHT_TIMEOUT_MS:-8000}"
export WEIXIN_SKIP_PREFLIGHT="${WEIXIN_SKIP_PREFLIGHT:-true}"
export WEIXIN_PREFLIGHT_REQUIRED="${WEIXIN_PREFLIGHT_REQUIRED:-false}"
export WEIXIN_START_MAX_RETRIES="${WEIXIN_START_MAX_RETRIES:-0}"
export WEIXIN_START_RETRY_DELAY_MS="${WEIXIN_START_RETRY_DELAY_MS:-5000}"

npm start
