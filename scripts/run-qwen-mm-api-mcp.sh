#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${QWEN_MM_STATE_DIR:-$ROOT_DIR/.ran_agent_state/qwen-mm}"
MARKER_PATH="${QWEN_MM_READY_PATH:-$STATE_DIR/ready.json}"
BACKEND="$STATE_DIR/uv-tools/qwen-mm-plugins/bin/qwen-mm-plugins-api"

[[ -n "${TOKEN_PLAN_API_KEY:-}" ]] || { echo "QWEN_MM_NOT_CONFIGURED: TOKEN_PLAN_API_KEY is missing" >&2; exit 1; }
if ! grep -Fxq '{"release":"qwen-mm-plugins-api-v1.0.3"}' "$MARKER_PATH" 2>/dev/null \
  || [[ ! -x "$BACKEND" ]]; then
  echo "QWEN_MM_NOT_READY: run scripts/prepare-qwen-mm-api.sh" >&2
  exit 1
fi

export DASHSCOPE_API_KEY="$TOKEN_PLAN_API_KEY"
export DASHSCOPE_BASE_URL="${TOKEN_PLAN_BASE_URL:-https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1}"
exec "$BACKEND"
