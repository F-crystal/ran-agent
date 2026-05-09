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
export MIMO_TOKEN_PLAN_OPENAI_BASE_URL="${MIMO_TOKEN_PLAN_OPENAI_BASE_URL:-https://token-plan-cn.xiaomimimo.com/v1}"
export MIMO_TOKEN_PLAN_EXPIRES_AT="${MIMO_TOKEN_PLAN_EXPIRES_AT:-2026-06-09T23:59:00Z}"
export MIMO_POWER_MODEL="${MIMO_POWER_MODEL:-mimo-v2.5-pro}"
export MIMO_POWER_TIMEOUT_MS="${MIMO_POWER_TIMEOUT_MS:-600000}"
export MIMO_POWER_TASK_DIR="${MIMO_POWER_TASK_DIR:-$ROOT_DIR/debug/mimo_tasks}"
NODE_BIN="${MIMO_POWER_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/mimoPowerMcpServer.mjs"
