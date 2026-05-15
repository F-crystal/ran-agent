#!/bin/bash
# Diagnose Hermes session continuity from the Node bridge side.
# No secrets are printed.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-/opt/ran_agent/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-/opt/ran_agent/node_bridge/.env.local}"

print_env_presence() {
  local key="$1"
  local found="NOT SET"
  for file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE" "$REPO_ROOT/.env.local" "$REPO_ROOT/node_bridge/.env.local"; do
    if [ -f "$file" ] && grep -Eq "^${key}=" "$file"; then
      found="SET in $file"
      break
    fi
  done
  if [ -n "${!key:-}" ]; then
    found="SET in process env"
  fi
  echo "$key: $found"
}

print_recent_journal_matches() {
  local pattern="$1"
  local empty_message="$2"
  local output=""
  if command -v journalctl >/dev/null 2>&1; then
    output="$(journalctl -u ran-agent-node.service --since "30 minutes ago" --no-pager 2>/dev/null || true)"
    if [ -z "$output" ] && command -v sudo >/dev/null 2>&1; then
      output="$(sudo -n journalctl -u ran-agent-node.service --since "30 minutes ago" --no-pager 2>/dev/null || true)"
    fi
  fi
  if [ -n "$output" ]; then
    printf '%s\n' "$output" | grep "$pattern" | tail -10 || echo "$empty_message"
  else
    echo "$empty_message"
  fi
}

echo "=== 1. Session continuity env ==="
for key in \
  HERMES_SESSION_CONTINUITY_ENABLED \
  HERMES_SESSION_ID_PREFIX \
  HERMES_SESSION_KEY_PREFIX \
  HERMES_RECENT_TEXT_TURNS \
  HERMES_RECENT_TEXT_CHAR_BUDGET \
  HERMES_RECENT_TEXT_MAX_USER_CHARS \
  HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS
do
  print_env_presence "$key"
done

echo ""
echo "=== 2. Recent Node continuity logs ==="
print_recent_journal_matches '\[hermes-session-continuity\]' "No recent [hermes-session-continuity] logs"

echo ""
echo "=== 3. Effective Node routing logs ==="
print_recent_journal_matches '\[hermes-capability-mode\]' "No recent [hermes-capability-mode] logs"

echo ""
echo "=== 4. Manual WeChat smoke ==="
cat <<'EOF'
Send these in the same WeChat conversation:
1. 我们继续聊内莉·布莱，她把自己送进疯人院这个故事
2. 我觉得她的故事特别令人感动

Expected:
- The second reply continues with Nellie Bly / 内莉·布莱.
- It should not ask “是谁的故事”.
- It should not explain session headers, recent history, context windows, or tokens.

For XHS fallback:
1. Send an XHS note link.
2. If images are incomplete, send: 图片的话，你应该用 fallback 逻辑去读取

Expected:
- The reply directly retries social/media reading or gives a user-facing media failure.
- It does not mention DeepSeek vision limits, vision_analyze, browser_vision, or pixel access.
EOF
