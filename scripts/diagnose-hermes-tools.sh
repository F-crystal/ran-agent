#!/bin/bash
# Diagnose Hermes tool visibility configuration
# Run: bash scripts/diagnose-hermes-tools.sh
# No secrets exposed.

set -euo pipefail
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
CONFIG="$HERMES_HOME/config.yaml"

echo "=== 1. disabled_tools ==="
if [ -f "$CONFIG" ]; then
  grep -A20 'disabled_tools' "$CONFIG" | head -15 || echo "NOT FOUND"
else
  echo "config.yaml NOT FOUND at $CONFIG"
fi

echo ""
echo "=== 2. platform_toolsets ==="
if [ -f "$CONFIG" ]; then
  grep -A30 'platform_toolsets' "$CONFIG" | head -35 || echo "NOT FOUND (will rely on disabled_tools only)"
else
  echo "config.yaml NOT FOUND"
fi

echo ""
echo "=== 3. Check dangerous toolsets ==="
if [ -f "$CONFIG" ]; then
  for ts in vision image_gen tts browser_vision; do
    if grep -A30 'platform_toolsets' "$CONFIG" | grep -q "$ts"; then
      echo "WARNING: $ts found in platform_toolsets"
    else
      echo "$ts: not in platform_toolsets (OK)"
    fi
  done
fi

echo ""
echo "=== 4. Check disabled_tools and generic Web assembly ==="
if [ -f "$CONFIG" ]; then
  for tool in vision_analyze browser_vision video_analyze image_generate text_to_speech; do
    if grep -A10 'disabled_tools' "$CONFIG" | grep -q "$tool"; then
      echo "$tool: DISABLED (OK)"
    else
      echo "WARNING: $tool NOT in disabled_tools"
    fi
  done
  TOOLSETS="$(awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$CONFIG")"
  if printf '%s\n' "$TOOLSETS" | grep -Eq '^[[:space:]]+-[[:space:]]+web[[:space:]]*$'; then
    echo "FAIL: built-in web toolset competes with mcp-search_hub"
  else
    echo "built-in web toolset: ABSENT (OK)"
  fi
  if grep -q '^web:[[:space:]]*$' "$CONFIG"; then
    echo "FAIL: built-in web provider block remains in companion assembly"
  else
    echo "built-in web provider block: ABSENT (OK)"
  fi
fi

echo ""
echo "=== 5. Check MCP tools in toolsets ==="
if [ -f "$CONFIG" ]; then
  for mcp in mcp-search_hub mcp-social_reader mcp-media_reader mcp-media_generation mcp-personal_memory mcp-time; do
    if grep -A30 'platform_toolsets' "$CONFIG" | grep -q "$mcp"; then
      echo "$mcp: PRESENT (OK)"
    else
      echo "WARNING: $mcp NOT in platform_toolsets"
    fi
  done
fi

echo ""
echo "=== 6. Recent vision_analyze / image_url errors ==="
sudo journalctl -u ran-agent-hermes.service --since "1 hour ago" --no-pager 2>/dev/null | grep -i 'vision_analyze\|vision_tools\|image_url.*BadRequest\|unknown variant.*image_url' | tail -5 || echo "No recent vision errors"
