#!/bin/bash
# Safe UV cache cleanup for ran-agent.
# Emergency tool: stops services, clears uv cache, restarts.
# Does NOT touch XHS cache/token, vault, data, or debug directories.
#
# Usage: bash scripts/clean-uv-cache-safe.sh [--yes]
# Without --yes, prompts for confirmation.

set -euo pipefail

UV_CACHE_DIR="${UV_CACHE_DIR:-/opt/ran_agent/.ran_agent_state/uv-cache}"
UV_TOOL_DIR="${UV_TOOL_DIR:-/opt/ran_agent/.ran_agent_state/uv-tools}"
HOME_UV_DIR="${HOME:-/home/ubuntu}/.cache/uv"

PROTECTED_DIRS=(
  "/opt/ran_agent/.ran_agent_state/social_reader"
  "/opt/ran_agent/node_bridge/.ran_agent_state/social_reader"
  "/opt/ran_agent/debug/wechat/xhs_notes"
  "/opt/ran_agent/vault"
  "/opt/ran_agent/data"
)

AUTO_YES=0
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  AUTO_YES=1
fi

echo "=== UV Cache Cleanup (Safe Mode) ==="
echo ""
echo "Protected directories (will NOT be deleted):"
for d in "${PROTECTED_DIRS[@]}"; do
  if [ -d "$d" ]; then
    echo "  PROTECTED: $d"
  fi
done
echo ""

echo "=== Pre-cleanup disk usage ==="
df -h / | tail -1
echo ""
if [ -d "$UV_CACHE_DIR" ]; then
  echo "UV cache: $(du -sh "$UV_CACHE_DIR" 2>/dev/null | cut -f1)"
else
  echo "UV cache: NOT FOUND at $UV_CACHE_DIR"
fi
if [ -d "$UV_TOOL_DIR" ]; then
  echo "UV tools: $(du -sh "$UV_TOOL_DIR" 2>/dev/null | cut -f1)"
else
  echo "UV tools: NOT FOUND at $UV_TOOL_DIR"
fi
if [ -e "$HOME_UV_DIR" ]; then
  if [ -L "$HOME_UV_DIR" ]; then
    echo "~/.cache/uv: symlink -> $(readlink "$HOME_UV_DIR")"
  else
    echo "~/.cache/uv: $(du -sh "$HOME_UV_DIR" 2>/dev/null | cut -f1) (NOT symlink)"
  fi
else
  echo "~/.cache/uv: NOT FOUND"
fi
echo ""

if [ "$AUTO_YES" -ne 1 ]; then
  read -r -p "Proceed with UV cache cleanup? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Stopping services..."
sudo systemctl stop ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service 2>/dev/null || true

echo "Killing stale uvx processes..."
pkill -f 'uvx.*obsidian' 2>/dev/null || true
pkill -f 'uvx.*xhs' 2>/dev/null || true
pkill -f 'uvx.*wanyi' 2>/dev/null || true
pkill -f 'start_obsidian_memory_mcp.sh' 2>/dev/null || true
pkill -f 'uv tool install iflow-mcp-tcsavage-obsidian-index' 2>/dev/null || true
pkill -f '/tmp/ran-agent-hermes-home-phase5' 2>/dev/null || true
sleep 2

echo "Cleaning UV cache: $UV_CACHE_DIR"
rm -rf "${UV_CACHE_DIR:?}"/*
mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"

# Remove generic fallback readiness marker (tool env may be gone)
MARKER_PATH="${XHS_GENERIC_FALLBACK_READY_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json}"
if [ -f "$MARKER_PATH" ]; then
  echo "Removing generic fallback readiness marker: $MARKER_PATH"
  rm -f "$MARKER_PATH"
fi
echo "NOTE: run scripts/prepare-xhs-generic-fallback.sh to re-enable XHS generic fallback"

# Ensure ~/.cache/uv is a symlink to the managed cache
if [ -e "$HOME_UV_DIR" ] && [ ! -L "$HOME_UV_DIR" ]; then
  echo "Replacing ~/.cache/uv with symlink to $UV_CACHE_DIR"
  rm -rf "$HOME_UV_DIR"
fi
mkdir -p "$(dirname "$HOME_UV_DIR")"
ln -sfn "$UV_CACHE_DIR" "$HOME_UV_DIR"

echo "Restarting services..."
sudo systemctl start ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-node.service 2>/dev/null || true

echo ""
echo "=== Post-cleanup disk usage ==="
df -h / | tail -1
if [ -d "$UV_CACHE_DIR" ]; then
  echo "UV cache: $(du -sh "$UV_CACHE_DIR" 2>/dev/null | cut -f1)"
fi
echo ""
echo "Done. Services restarted."
