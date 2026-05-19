#!/usr/bin/env bash
# Install obsidian memory MCP tool into UV_TOOL_DIR.
# Uses flock to prevent concurrent installs (lite/full/retry).
#
# Usage: bash scripts/prepare-obsidian-memory-tool.sh [--force]
# Without --force, skips install if tool is already present.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_FILE="/tmp/ran-agent-obsidian-memory-install.lock"
PACKAGE="${OBSIDIAN_MEMORY_OBSIDIAN_INDEX_PACKAGE:-iflow-mcp-tcsavage-obsidian-index}"

export UV_CACHE_DIR="${UV_CACHE_DIR:-/opt/ran_agent/.ran_agent_state/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-/opt/ran_agent/.ran_agent_state/uv-tools}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"
export UV_PYTHON_DOWNLOADS="${UV_PYTHON_DOWNLOADS:-never}"

mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"

FORCE_FLAG=""
if [ "${1:-}" = "--force" ]; then
  FORCE_FLAG="--force"
fi

(
  flock -n 200 || { echo "ERROR: another install is running; aborting." >&2; exit 1; }

  if [ -z "$FORCE_FLAG" ]; then
    if uvx --from "$PACKAGE" python -c "pass" 2>/dev/null; then
      echo "$PACKAGE is already installed. Use --force to reinstall."
      echo "Tool dir: $(uv tool dir)"
      exit 0
    fi
  fi

  echo "Installing $PACKAGE..."
  # shellcheck disable=SC2086
  uv tool install "$PACKAGE" $FORCE_FLAG
  echo "Tool dir: $(uv tool dir)"
  echo "Done."
) 200>"$LOCK_FILE"
