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
Usage: ./vault_runner.sh <plan|apply|cleanup|daily_carryover>

Commands:
  plan     Run one planning prompt over inbox; read-only is prompt-enforced, not a Qwen CLI approval mode
  apply    Run one small-step inbox ingest/apply pass
  cleanup  Run one cleanup-only pass for safe_to_cleanup inbox items
  daily_carryover
           Archive the latest night_cycle_YYYY-MM-DD.md carry-over note only
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

run_daily_carryover() {
  local target_note
  target_note="$(find "$VAULT_DIR/inbox" -maxdepth 1 -type f -name 'night_cycle_*.md' | sort | tail -n 1 || true)"
  if [ -z "$target_note" ]; then
    echo "No night_cycle carry-over note found in inbox."
    return 0
  fi

  local target_name
  target_name="$(basename "$target_note")"
  local prompt_file
  prompt_file="$(mktemp)"
  trap 'rm -f "$prompt_file"' RETURN
  cat > "$prompt_file" <<EOF
你是这个 vault 的知识网络整理者。严格遵守当前目录下的 AGENTS.md。

本次任务类型：daily_carryover

硬性范围：
- 只处理 inbox/$target_name。
- 不递归处理 inbox/ 下其它文件或目录。
- 不处理 chat/、images/、audio/、docs/、files/、co_reading/、schedule/ 等 backlog。

必须完成：
- 读取 inbox/$target_name。
- 将这份 daily carry-over 写入或更新合适的 wiki/source/daily 入口。
- 更新 wiki/log.md，使 5:00 session soft reset 前能从 wiki/log.md 找到前一天整理结果。
- 将原件归档到 raw/night_cycle/$target_name。
- 如果 raw/night_cycle/ 不存在，先创建它。
- 完成后 inbox/$target_name 必须不存在。

不得执行：
- 全量 apply。
- cleanup。
- knowledge-grow。
- 大范围重构。

输出保持简洁、结构化，并列出实际改动文件。
EOF

  run_task "$prompt_file"
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
  daily_carryover)
    run_daily_carryover
    ;;
  *)
    usage
    exit 1
    ;;
esac
