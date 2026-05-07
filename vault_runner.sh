#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_DIR="$ROOT_DIR/vault"
TASK_DIR="$VAULT_DIR/.qwen/tasks"
ENV_FILE="$ROOT_DIR/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

usage() {
  cat <<'EOF'
Usage: ./vault_runner.sh <plan|apply|cleanup>

Commands:
  plan     Run one planning prompt over inbox; read-only is prompt-enforced, not a Qwen CLI approval mode
  apply    Run one small-step inbox ingest/apply pass
  cleanup  Run one cleanup-only pass for safe_to_cleanup inbox items
EOF
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

COMMAND="$1"

if [ -z "${DASHSCOPE_API_KEY:-}" ]; then
  echo "DASHSCOPE_API_KEY is not set."
  echo "Please set it in $ENV_FILE."
  exit 1
fi

if [ "${DASHSCOPE_API_KEY:-}" = "REPLACE_WITH_YOUR_DASHSCOPE_API_KEY" ]; then
  echo "DASHSCOPE_API_KEY is still placeholder text in $ENV_FILE."
  exit 1
fi

if ! command -v qwen >/dev/null 2>&1; then
  echo "qwen command not found in PATH."
  exit 1
fi

if [ ! -d "$VAULT_DIR" ]; then
  echo "vault directory not found: $VAULT_DIR"
  exit 1
fi

if [ ! -d "$TASK_DIR" ]; then
  echo "task prompt directory not found: $TASK_DIR"
  exit 1
fi

run_task() {
  local prompt_file="$1"

  cd "$VAULT_DIR"
  qwen -p "$(cat "$prompt_file")" -y
}

case "$COMMAND" in
  plan)
    run_task "$TASK_DIR/plan_prompt.md"
    ;;
  apply)
    run_task "$TASK_DIR/apply_prompt.md"
    ;;
  cleanup)
    run_task "$TASK_DIR/cleanup_prompt.md"
    ;;
  *)
    usage
    exit 1
    ;;
esac
