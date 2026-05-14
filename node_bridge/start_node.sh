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

export NODE_BRIDGE_REPLY_BACKEND="${NODE_BRIDGE_REPLY_BACKEND:-openclaw}"
if [ "$NODE_BRIDGE_REPLY_BACKEND" = "hermes" ]; then
  echo "🌉 Starting Node bridge (Hermes frontend mode)..."
  export NODE_BRIDGE_FALLBACK_TEXT="${NODE_BRIDGE_FALLBACK_TEXT:-暂时无法连接到 Hermes，请稍后再试。}"
else
  echo "🌉 Starting Node bridge (OpenClaw frontend mode)..."
  export NODE_BRIDGE_FALLBACK_TEXT="${NODE_BRIDGE_FALLBACK_TEXT:-暂时无法连接到 OpenClaw，请稍后再试。}"
fi
export OPENCLAW_GATEWAY_BASE_URL="${OPENCLAW_GATEWAY_BASE_URL:-http://127.0.0.1:19123}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
export OPENCLAW_GATEWAY_MODEL="${OPENCLAW_GATEWAY_MODEL:-openclaw/personal-system}"
export OPENCLAW_BACKEND_MODEL="${OPENCLAW_BACKEND_MODEL:-}"
export PERSONAL_AGENT_PROACTIVE_ENABLED="${PERSONAL_AGENT_PROACTIVE_ENABLED:-false}"
export PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED="${PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED:-false}"

# If token is still empty, try to read from config file for OpenClaw mode.
if [ "$NODE_BRIDGE_REPLY_BACKEND" != "hermes" ] && [ -z "${OPENCLAW_GATEWAY_TOKEN}" ]; then
  CONFIG_FILE="${OPENCLAW_CONFIG:-$(cd .. && pwd)/openclaw/openclaw.personal-system.json}"
  if [ -f "$CONFIG_FILE" ]; then
    echo "🔍 Reading token from config file: $CONFIG_FILE"
    # Extract token from JSON using grep/sed (works without jq)
    TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | head -1 | sed 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    if [ -n "$TOKEN" ] && [ "$TOKEN" != "CHANGE_ME_OPENCLAW_GATEWAY_TOKEN" ] && [[ ! "$TOKEN" =~ ^\$\{[A-Z_][A-Z0-9_]*\}$ ]]; then
      export OPENCLAW_GATEWAY_TOKEN="$TOKEN"
      echo "✅ Token loaded from config file"
    fi
  fi
fi

if [ "$NODE_BRIDGE_REPLY_BACKEND" != "hermes" ] && [ -z "${OPENCLAW_GATEWAY_TOKEN}" ]; then
  echo "❌ OPENCLAW_GATEWAY_TOKEN is required."
  echo "   Please either:"
  echo "   1. Set it in .env.local file"
  echo "   2. Set it as environment variable"
  echo "   3. Configure it in openclaw/openclaw.personal-system.json"
  exit 1
fi

# Optional backend capability ingest (timeline/session persistence only).
export PYTHON_BACKEND_INGEST_ENABLED="${PYTHON_BACKEND_INGEST_ENABLED:-true}"
export PYTHON_BACKEND_BASE_URL="${PYTHON_BACKEND_BASE_URL:-http://127.0.0.1:8787}"

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$(cd .. && pwd)/.openclaw_state}"
export OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$(cd .. && pwd)/openclaw/openclaw.personal-system.json}"
export WEIXIN_LOGIN_MAX_RETRIES="${WEIXIN_LOGIN_MAX_RETRIES:-5}"
export WEIXIN_LOGIN_RETRY_DELAY_MS="${WEIXIN_LOGIN_RETRY_DELAY_MS:-1500}"
export WEIXIN_FORCE_LOGIN="${WEIXIN_FORCE_LOGIN:-false}"
export WEIXIN_RESET_SYNC_ON_START="${WEIXIN_RESET_SYNC_ON_START:-true}"
export WEIXIN_PREFLIGHT_TIMEOUT_MS="${WEIXIN_PREFLIGHT_TIMEOUT_MS:-8000}"
export WEIXIN_SKIP_PREFLIGHT="${WEIXIN_SKIP_PREFLIGHT:-true}"
export WEIXIN_PREFLIGHT_REQUIRED="${WEIXIN_PREFLIGHT_REQUIRED:-false}"
export WEIXIN_START_MAX_RETRIES="${WEIXIN_START_MAX_RETRIES:-0}"
export WEIXIN_START_RETRY_DELAY_MS="${WEIXIN_START_RETRY_DELAY_MS:-5000}"
export OPENCLAW_GATEWAY_STARTUP_WAIT_ATTEMPTS="${OPENCLAW_GATEWAY_STARTUP_WAIT_ATTEMPTS:-30}"
export OPENCLAW_GATEWAY_STARTUP_WAIT_DELAY_SECONDS="${OPENCLAW_GATEWAY_STARTUP_WAIT_DELAY_SECONDS:-2}"

gateway_target="${OPENCLAW_GATEWAY_BASE_URL#http://}"
gateway_target="${gateway_target#https://}"
gateway_target="${gateway_target%%/*}"
gateway_host="${gateway_target%%:*}"
gateway_port="${gateway_target##*:}"

if [ "$NODE_BRIDGE_REPLY_BACKEND" != "hermes" ] && [ -n "$gateway_host" ] && [ -n "$gateway_port" ]; then
  echo "⏳ Waiting for OpenClaw gateway ${gateway_host}:${gateway_port}..."
  ready=false
  for (( attempt=1; attempt<=OPENCLAW_GATEWAY_STARTUP_WAIT_ATTEMPTS; attempt++ )); do
    if bash -c ":</dev/tcp/${gateway_host}/${gateway_port}" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep "$OPENCLAW_GATEWAY_STARTUP_WAIT_DELAY_SECONDS"
  done
  if [ "$ready" = false ]; then
    echo "⚠️ OpenClaw gateway port ${gateway_host}:${gateway_port} not ready after wait window; continuing anyway."
  fi
fi

npm start
