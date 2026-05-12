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

VAULT_DIR="${OBSIDIAN_MEMORY_VAULT_DIR:-$ROOT_DIR/vault}"
INDEX_PATH="${OBSIDIAN_MEMORY_INDEX_PATH:-$ROOT_DIR/data/obsidian-memory-index.sqlite}"
PROVIDER="${OBSIDIAN_MEMORY_MCP_PROVIDER:-obsidian-index}"

mkdir -p "$(dirname "$INDEX_PATH")"

if [ -n "${OBSIDIAN_MEMORY_MCP_COMMAND:-}" ]; then
  if [ -n "${OBSIDIAN_MEMORY_MCP_ARGS_JSON:-}" ]; then
    ARGS=()
    while IFS= read -r -d '' arg; do
      ARGS+=("$arg")
    done < <(node -e 'const args = JSON.parse(process.env.OBSIDIAN_MEMORY_MCP_ARGS_JSON || "[]"); for (const arg of args) process.stdout.write(String(arg) + "\u0000");')
    exec "$OBSIDIAN_MEMORY_MCP_COMMAND" "${ARGS[@]}"
  fi
  exec "$OBSIDIAN_MEMORY_MCP_COMMAND"
fi

case "$PROVIDER" in
  obsidian-index)
    exec uvx obsidian-index \
      --vault "$VAULT_DIR" \
      --database "$INDEX_PATH" \
      --watch
    ;;
  mcpvault)
    exec npx -y @bitbonsai/mcpvault@latest "$VAULT_DIR"
    ;;
  mcp-obsidian)
    exec mcp-obsidian
    ;;
  *)
    echo "unsupported OBSIDIAN_MEMORY_MCP_PROVIDER: $PROVIDER" >&2
    exit 2
    ;;
esac
