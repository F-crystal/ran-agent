#!/bin/bash
# Diagnose lite/full capability mode
# Run: bash scripts/diagnose-lite-full.sh
# No secrets exposed.

set -euo pipefail
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "=== 1. Env vars ==="
for key in RAN_AGENT_CAPABILITY_MODE HERMES_LITE_PROFILE HERMES_PROFILE HERMES_DEFAULT_MODEL RAN_AGENT_CONTEXT_POLICY; do
  val="${!key:-NOT SET}"
  echo "$key: $val"
done

echo ""
echo "=== 2. Full profile config ==="
FULL_CONFIG="$HERMES_HOME/config.yaml"
if [ -f "$FULL_CONFIG" ]; then
  echo "EXISTS: $FULL_CONFIG"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$FULL_CONFIG" | head -8 || echo "NOT FOUND"
  echo "--- platform_toolsets (first 5) ---"
  grep -A20 'platform_toolsets' "$FULL_CONFIG" | head -8 || echo "NOT FOUND"
else
  echo "NOT FOUND"
fi

echo ""
echo "=== 3. Lite profile config ==="
LITE_CONFIG="$HERMES_HOME/profiles/ran-assistant-lite/config.yaml"
REPO_LITE="$REPO_ROOT/hermes/profile/config.lite.yaml"
if [ -f "$LITE_CONFIG" ]; then
  echo "EXISTS: $LITE_CONFIG"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$LITE_CONFIG" | head -8 || echo "NOT FOUND"
  echo "--- platform_toolsets (first 5) ---"
  grep -A20 'platform_toolsets' "$LITE_CONFIG" | head -8 || echo "NOT FOUND"
else
  echo "NOT FOUND at $LITE_CONFIG"
  if [ -f "$REPO_LITE" ]; then
    echo "REPO TEMPLATE EXISTS: $REPO_LITE (not installed)"
    echo "Install with: hermes profile install $REPO_ROOT/hermes/profile --name ran-assistant-lite --force -y"
  fi
fi

echo ""
echo "=== 4. Capability mode check ==="
MODE="${RAN_AGENT_CAPABILITY_MODE:-auto}"
echo "RAN_AGENT_CAPABILITY_MODE=$MODE"
case "$MODE" in
  lite) echo "  -> Always lite" ;;
  full) echo "  -> Always full" ;;
  auto) echo "  -> Auto: lite by default, full for debug/generation intents" ;;
  *) echo "  -> UNKNOWN: $MODE" ;;
esac

echo ""
echo "=== 5. MCP tools in lite vs full ==="
echo "Lite should have: time, social_reader, media_reader, mimo_power, personal_memory, obsidian_memory, tavily"
echo "Lite should NOT have: playwright, media_generation, terminal, file"
echo "Full should have: all of the above + playwright, media_generation"

echo ""
echo "=== 6. Recent capability mode logs ==="
sudo journalctl -u ran-agent-node.service --since "1 hour ago" --no-pager 2>/dev/null | grep 'hermes-capability-mode' | tail -5 || echo "No recent capability mode logs"

echo ""
echo "=== 7. Recent vision errors ==="
sudo journalctl -u ran-agent-hermes.service --since "1 hour ago" --no-pager 2>/dev/null | grep -i 'vision_analyze\|image_url.*BadRequest\|unknown variant.*image_url' | tail -3 || echo "No recent vision errors"
