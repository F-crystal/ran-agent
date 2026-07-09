#!/usr/bin/env bash
set -euo pipefail

ROOT="${RAN_AGENT_ROOT:-/opt/ran_agent}"
cd "$ROOT"

if [ -f "$ROOT/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT/.venv/bin/activate"
fi

echo "== managed env =="
grep -E '^(AI_DAILY_DIGEST|NODE_BRIDGE_OUTBOUND_BASE_URL|FEISHU_BRIDGE_ENABLED|FEISHU_LARK_CLI_IDENTITY|RAN_AGENT_STATE_DIR)=' \
  "$ROOT/.env.local" "$ROOT/node_bridge/.env.local" 2>/dev/null || true

echo
echo "== AIHot endpoint =="
getent hosts aihot.virxact.com || true
curl -I --max-time 20 https://aihot.virxact.com/api/public/daily || true

echo
echo "== Feishu DM target state =="
find "$ROOT/.ran_agent_state" -path '*/node-bridge-runtime/feishu-home-dm-target.json' -print 2>/dev/null | tail -20 || true

echo
echo "== recent Python digest logs =="
journalctl -u ran-agent-python.service --since '24 hours ago' --no-pager \
  | grep -E 'AI daily digest|ai_daily_digest|facts unavailable|Job "ai_daily_digest' || true
