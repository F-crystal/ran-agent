#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  # shellcheck source=/dev/null
  . "$file"
  set +a
}

if [[ -z "${HERMES_LITE_SOFT_RESET_ENABLED+x}" && -z "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" ]]; then
  load_env_file "${RAN_AGENT_NODE_ENV_FILE:-$REPO_ROOT/.env.local}"
  load_env_file "${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-$REPO_ROOT/node_bridge/.env.local}"
fi

if [[ -n "${NODE_BIN:-}" ]]; then
  NODE_EXE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_EXE="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_EXE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo '{"ok":false,"error":"node_not_found","message":"Set NODE_BIN to a Node.js executable."}' >&2
  exit 127
fi

exec "$NODE_EXE" "$REPO_ROOT/scripts/hermes-lite-soft-reset.mjs" "$@"
