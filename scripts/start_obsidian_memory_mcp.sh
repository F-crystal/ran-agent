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

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

export PATH="$ROOT_DIR/.venv/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

VAULT_DIR="${OBSIDIAN_MEMORY_VAULT_DIR:-$ROOT_DIR/vault}"
INDEX_PATH="${OBSIDIAN_MEMORY_INDEX_PATH:-$ROOT_DIR/data/obsidian-memory-index.duckdb}"
PROVIDER="${OBSIDIAN_MEMORY_MCP_PROVIDER:-obsidian-index}"
OBSIDIAN_INDEX_PACKAGE="${OBSIDIAN_MEMORY_OBSIDIAN_INDEX_PACKAGE:-iflow-mcp-tcsavage-obsidian-index}"
OBSIDIAN_INDEX_LAUNCHER="${OBSIDIAN_MEMORY_OBSIDIAN_INDEX_LAUNCHER:-$ROOT_DIR/scripts/obsidian_index_mcp_launcher.py}"
OBSIDIAN_MEMORY_REINDEX="${OBSIDIAN_MEMORY_REINDEX:-0}"
OBSIDIAN_MEMORY_WATCH="${OBSIDIAN_MEMORY_WATCH:-0}"
OBSIDIAN_MEMORY_UV_BIN="${OBSIDIAN_MEMORY_UV_BIN:-uv}"
export OBSIDIAN_INDEX_DEVICE="${OBSIDIAN_INDEX_DEVICE:-cpu}"

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
    if command -v "$OBSIDIAN_MEMORY_UV_BIN" >/dev/null 2>&1; then
      ARGS=(
        run --no-project
        --with "$OBSIDIAN_INDEX_PACKAGE"
        python "$OBSIDIAN_INDEX_LAUNCHER"
        mcp
        --vault "$VAULT_DIR"
        --database "$INDEX_PATH"
      )
      RUNNER=("$OBSIDIAN_MEMORY_UV_BIN")
    else
      ARGS=(
        --from "$OBSIDIAN_INDEX_PACKAGE"
        python "$OBSIDIAN_INDEX_LAUNCHER"
        mcp
        --vault "$VAULT_DIR"
        --database "$INDEX_PATH"
      )
      RUNNER=(uvx)
    fi
    if [ "$OBSIDIAN_MEMORY_REINDEX" = "1" ] || [ "$OBSIDIAN_MEMORY_REINDEX" = "true" ]; then
      ARGS+=(--reindex)
    fi
    if [ "$OBSIDIAN_MEMORY_WATCH" = "1" ] || [ "$OBSIDIAN_MEMORY_WATCH" = "true" ]; then
      ARGS+=(--watch)
    fi
    exec "${RUNNER[@]}" "${ARGS[@]}"
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
