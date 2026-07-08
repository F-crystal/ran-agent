#!/bin/bash
# Diagnose ran-agent multi-frontend unified entry.
# No secrets are printed.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-/opt/ran_agent/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-/opt/ran_agent/node_bridge/.env.local}"
IDENTITY_MAP_PATH="${RAN_AGENT_IDENTITY_MAP_PATH:-/opt/ran_agent/.ran_agent_state/identity-map.json}"
GLOBAL_TIMELINE_PATH="${RAN_AGENT_GLOBAL_TIMELINE_PATH:-/opt/ran_agent/.ran_agent_state/global-timeline.jsonl}"
TIMELINE_ARCHIVE_DIR="${RAN_AGENT_TIMELINE_ARCHIVE_DIR:-/opt/ran_agent/.ran_agent_state/timeline_archive}"
DESKTOP_PROXY_PORT="${DESKTOP_PROXY_PORT:-8650}"

env_value() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    echo "${!key}"
    return
  fi
  for file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE" "$REPO_ROOT/.env.local" "$REPO_ROOT/node_bridge/.env.local"; do
    if [ -f "$file" ]; then
      grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- && return
    fi
  done
  echo "NOT SET"
}

recent_journal() {
  local pattern="$1"
  local empty="$2"
  local output=""
  if command -v journalctl >/dev/null 2>&1; then
    output="$(journalctl -u ran-agent-node.service --since "30 minutes ago" --no-pager 2>/dev/null || true)"
    if [ -z "$output" ] && command -v sudo >/dev/null 2>&1; then
      output="$(sudo -n journalctl -u ran-agent-node.service --since "30 minutes ago" --no-pager 2>/dev/null || true)"
    fi
  fi
  if [ -n "$output" ]; then
    printf '%s\n' "$output" | grep "$pattern" | tail -10 || echo "$empty"
  else
    echo "$empty"
  fi
}

echo "=== 1. Multi-frontend env ==="
for key in \
  FEISHU_BRIDGE_ENABLED \
  FEISHU_LARK_CLI_IDENTITY \
  DESKTOP_PROXY_ENABLED \
  RAN_AGENT_DEFAULT_GLOBAL_USER_ID \
  RAN_AGENT_IDENTITY_MAP_PATH \
  RAN_AGENT_GLOBAL_TIMELINE_PATH \
  RAN_AGENT_TIMELINE_MAX_BYTES \
  RAN_AGENT_TIMELINE_MAX_TURNS \
  RAN_AGENT_TIMELINE_RETENTION_DAYS \
  RAN_AGENT_TIMELINE_COMPACT_ENABLED \
  RAN_AGENT_TIMELINE_ARCHIVE_DIR \
  HERMES_SESSION_CONTINUITY_ENABLED \
  HERMES_GLOBAL_RECENT_TURNS \
  HERMES_ACTIVE_TOPIC_CHAR_BUDGET \
  HERMES_REPLY_TIMEOUT_SECONDS \
  NODE_BRIDGE_QUICK_ACK_ENABLED \
  NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS \
  FEISHU_SEND_TIMEOUT_SECONDS \
  FEISHU_DOWNLOAD_TIMEOUT_SECONDS
do
  echo "$key: $(env_value "$key")"
done

echo ""
echo "=== 1b. Reply-window quick ack ==="
quick_ack_enabled="$(env_value NODE_BRIDGE_QUICK_ACK_ENABLED)"
quick_ack_timeout="$(env_value NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS)"
quick_ack_text_set="SET"
if [ "$(env_value NODE_BRIDGE_QUICK_ACK_TEXT)" = "NOT SET" ]; then
  quick_ack_text_set="NOT SET"
fi
echo "quick ack enabled: $quick_ack_enabled"
echo "quick ack timeout ms: $quick_ack_timeout"
echo "quick ack text: $quick_ack_text_set"
if [ "$quick_ack_enabled" = "true" ]; then
  echo "WARNING: quick ack is enabled; ordinary chats may receive an extra placeholder reply"
else
  echo "OK: quick ack is disabled by default; async proactive finals handle long authorized work"
fi

echo ""
echo "=== 2. lark-cli ==="
if command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli: $(command -v lark-cli)"
  lark-cli version 2>/dev/null || true
else
  echo "lark-cli: NOT FOUND"
fi

echo ""
echo "=== 3. Feishu bridge recent logs ==="
recent_journal '\[feishu-bridge\]' "No recent [feishu-bridge] logs"

echo ""
echo "=== 4. Desktop proxy port ==="
if bash -c ":</dev/tcp/127.0.0.1/$DESKTOP_PROXY_PORT" 2>/dev/null; then
  echo "desktop proxy port $DESKTOP_PROXY_PORT: LISTENING"
else
  echo "desktop proxy port $DESKTOP_PROXY_PORT: NOT LISTENING"
fi

echo ""
echo "=== 5. Identity map ==="
if [ -f "$IDENTITY_MAP_PATH" ]; then
  echo "identity map: EXISTS"
  python3 - "$IDENTITY_MAP_PATH" <<'PY'
import json, sys
data=json.load(open(sys.argv[1], encoding='utf-8'))
print("bindings:", len(data.get("bindings", {})))
print("default_global_user_id:", data.get("default_global_user_id", ""))
PY
else
  echo "identity map: NOT FOUND (single-user default still maps to user:ran)"
fi

echo ""
echo "=== 6. Global timeline retention ==="
if [ -f "$GLOBAL_TIMELINE_PATH" ]; then
  size_bytes="$(wc -c < "$GLOBAL_TIMELINE_PATH" | tr -d ' ')"
  turn_count="$(wc -l < "$GLOBAL_TIMELINE_PATH" | tr -d ' ')"
  echo "timeline path: $GLOBAL_TIMELINE_PATH"
  echo "timeline size bytes: $size_bytes"
  echo "timeline turn count: $turn_count"
  if [ -d "$TIMELINE_ARCHIVE_DIR" ]; then
    archive_count="$(find "$TIMELINE_ARCHIVE_DIR" -maxdepth 1 -name 'global-timeline-*.jsonl.gz' 2>/dev/null | wc -l | tr -d ' ')"
    echo "archive dir: $TIMELINE_ARCHIVE_DIR"
    echo "archive count: $archive_count"
    if [ -f "$TIMELINE_ARCHIVE_DIR/last_compact.json" ]; then
      python3 - "$TIMELINE_ARCHIVE_DIR/last_compact.json" <<'PY'
import json, sys
try:
    data=json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data={}
print("last compact time:", data.get("compacted_at", "UNKNOWN"))
print("last compact retained turns:", data.get("retained_turns", "UNKNOWN"))
print("last compact summary turns:", data.get("summary_turns", "UNKNOWN"))
PY
    else
      echo "last compact time: NONE"
    fi
  else
    echo "archive dir: NOT FOUND ($TIMELINE_ARCHIVE_DIR)"
    echo "archive count: 0"
    echo "last compact time: NONE"
  fi
else
  echo "global timeline: NOT FOUND"
fi

echo ""
echo "=== 7. Global timeline recent records ==="
if [ -f "$GLOBAL_TIMELINE_PATH" ]; then
  python3 - "$GLOBAL_TIMELINE_PATH" <<'PY'
import json, sys
path=sys.argv[1]
try:
    lines=open(path, encoding="utf-8").read().splitlines()[-10:]
except Exception:
    lines=[]
for line in lines:
    try:
        d=json.loads(line)
    except Exception:
        continue
    print(f"{d.get('platform')} {d.get('role')} {d.get('created_at')} {str(d.get('text',''))[:120]}")
PY
else
  echo "global timeline: NOT FOUND"
fi

echo ""
echo "=== 8. Hermes continuity / routing logs ==="
recent_journal '\[hermes-session-continuity\]' "No recent [hermes-session-continuity] logs"
recent_journal '\[hermes-capability-mode\]' "No recent [hermes-capability-mode] logs"
