#!/bin/bash
# Diagnose lite/full capability mode with dual-gateway context split.
# Run: bash scripts/diagnose-lite-full.sh
# No secrets exposed.

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="$HERMES_HOME/lite"
REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

systemd_cat_has() {
  local service="$1"
  local pattern="$2"
  local output
  output=$(systemctl cat "$service" 2>/dev/null) || return 1
  printf '%s\n' "$output" | grep -qF "$pattern"
}

dropin_state() {
  local path="$1"
  if [ -e "$path" ]; then
    echo "PRESENT"
  else
    echo "ABSENT"
  fi
}

echo "=== 1. Env vars ==="
for key in RAN_AGENT_CAPABILITY_MODE HERMES_LITE_API_BASE_URL HERMES_FULL_API_BASE_URL HERMES_API_BASE_URL HERMES_PROFILE HERMES_DEFAULT_MODEL; do
  val="${!key:-NOT SET}"
  echo "$key: $val"
done

echo ""
echo "=== 2. Gateway ports ==="
missing_ports=0
for port in 8642 8643; do
  if bash -c ":</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    echo "port $port: LISTENING"
  else
    echo "port $port: NOT LISTENING"
    missing_ports=1
  fi
done
if [ "$missing_ports" -ne 0 ]; then
  echo "HINT: run bash scripts/apply-hermes-runtime-split.sh to re-apply the lite/full runtime split."
fi

echo ""
echo "=== 3. Systemd services ==="
for svc in ran-agent-hermes ran-agent-hermes-full; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  echo "$svc: $status"
done

echo ""
echo "=== Systemd compact status ==="
# Compact check uses fixed-string grep -F matching on systemctl cat output.
# 20-timeout.conf is allowed; only 90/30 legacy drop-ins are stale.
LITE_CAT=$(systemctl cat ran-agent-hermes.service 2>/dev/null) || LITE_CAT=""
FULL_CAT=$(systemctl cat ran-agent-hermes-full.service 2>/dev/null) || FULL_CAT=""

lite_compact_ok=1
for pat in 'Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent/lite' \
  'Environment=HERMES_PROFILE=ran-assistant-lite' \
  'Environment=API_SERVER_PORT=8642' \
  'Environment=API_SERVER_MODEL_NAME=ran-assistant-lite' \
  'hermes -p ran-assistant-lite gateway run'; do
  if ! printf '%s\n' "$LITE_CAT" | grep -qF "$pat"; then
    echo "lite unit compact: FAIL (missing: $pat)"
    lite_compact_ok=0
    break
  fi
done
if [ "$lite_compact_ok" -eq 1 ]; then
  echo "lite unit compact: OK"
fi

full_compact_ok=1
for pat in 'Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent' \
  'Environment=HERMES_PROFILE=ran-assistant' \
  'Environment=API_SERVER_PORT=8643' \
  'Environment=API_SERVER_MODEL_NAME=ran-assistant' \
  'hermes -p ran-assistant gateway run'; do
  if ! printf '%s\n' "$FULL_CAT" | grep -qF "$pat"; then
    echo "full unit compact: FAIL (missing: $pat)"
    full_compact_ok=0
    break
  fi
done
if [ "$full_compact_ok" -eq 1 ]; then
  echo "full unit compact: OK"
fi
dropin_90=$(dropin_state "$SYSTEMD_DIR/ran-agent-hermes.service.d/90-lite-runtime.conf")
dropin_30_runtime=$(dropin_state "$SYSTEMD_DIR/ran-agent-hermes.service.d/30-hermes-runtime.conf")
dropin_30_env=$(dropin_state "$SYSTEMD_DIR/ran-agent-hermes.service.d/30-hermes-env.conf")
echo "stale 90-lite-runtime.conf: $dropin_90"
echo "stale 30-hermes-runtime.conf: $dropin_30_runtime"
echo "stale 30-hermes-env.conf: $dropin_30_env"
lite_effective_profile=$(systemctl cat ran-agent-hermes.service 2>/dev/null | sed -n 's/^Environment=HERMES_PROFILE=//p' | tail -n 1)
full_effective_profile=$(systemctl cat ran-agent-hermes-full.service 2>/dev/null | sed -n 's/^Environment=HERMES_PROFILE=//p' | tail -n 1)
lite_effective_port=$(systemctl cat ran-agent-hermes.service 2>/dev/null | sed -n 's/^Environment=API_SERVER_PORT=//p' | tail -n 1)
full_effective_port=$(systemctl cat ran-agent-hermes-full.service 2>/dev/null | sed -n 's/^Environment=API_SERVER_PORT=//p' | tail -n 1)
echo "lite effective profile: ${lite_effective_profile:-UNKNOWN}"
echo "full effective profile: ${full_effective_profile:-UNKNOWN}"
echo "lite port: ${lite_effective_port:-UNKNOWN}"
echo "full port: ${full_effective_port:-UNKNOWN}"
if [ "$dropin_90" = "PRESENT" ] || [ "$dropin_30_runtime" = "PRESENT" ] || [ "$dropin_30_env" = "PRESENT" ]; then
  echo "WARNING: stale Hermes runtime drop-in remains; run scripts/apply-hermes-runtime-split.sh"
fi

echo ""
echo "=== UV cache status ==="
lite_uv_cache=$(systemctl cat ran-agent-hermes.service 2>/dev/null | sed -n 's/^Environment=UV_CACHE_DIR=//p' | tail -n 1)
full_uv_cache=$(systemctl cat ran-agent-hermes-full.service 2>/dev/null | sed -n 's/^Environment=UV_CACHE_DIR=//p' | tail -n 1)
lite_uv_tool=$(systemctl cat ran-agent-hermes.service 2>/dev/null | sed -n 's/^Environment=UV_TOOL_DIR=//p' | tail -n 1)
full_uv_tool=$(systemctl cat ran-agent-hermes-full.service 2>/dev/null | sed -n 's/^Environment=UV_TOOL_DIR=//p' | tail -n 1)
echo "lite UV_CACHE_DIR: ${lite_uv_cache:-NOT SET}"
echo "full UV_CACHE_DIR: ${full_uv_cache:-NOT SET}"
echo "lite UV_TOOL_DIR: ${lite_uv_tool:-NOT SET}"
echo "full UV_TOOL_DIR: ${full_uv_tool:-NOT SET}"
if [ -d /opt/ran_agent/.ran_agent_state/uv-cache ]; then
  uv_cache_size=$(du -sh /opt/ran_agent/.ran_agent_state/uv-cache 2>/dev/null | cut -f1)
  echo "uv-cache (/opt/ran_agent/.ran_agent_state/uv-cache): $uv_cache_size"
else
  echo "uv-cache (/opt/ran_agent/.ran_agent_state/uv-cache): NOT FOUND"
fi
if [ -d /opt/ran_agent/.ran_agent_state/uv-tools ]; then
  uv_tools_size=$(du -sh /opt/ran_agent/.ran_agent_state/uv-tools 2>/dev/null | cut -f1)
  echo "uv-tools (/opt/ran_agent/.ran_agent_state/uv-tools): $uv_tools_size"
else
  echo "uv-tools (/opt/ran_agent/.ran_agent_state/uv-tools): NOT FOUND"
fi
if [ -e ~/.cache/uv ]; then
  if [ -L ~/.cache/uv ]; then
    echo "~/.cache/uv: symlink -> $(readlink ~/.cache/uv)"
  else
    home_uv_size=$(du -sh ~/.cache/uv 2>/dev/null | cut -f1)
    echo "~/.cache/uv: $home_uv_size (NOT symlink)"
    home_uv_bytes=$(du -s ~/.cache/uv 2>/dev/null | awk '{print $1}')
    if [ "${home_uv_bytes:-0}" -gt 2097152 ]; then
      echo "WARNING: ~/.cache/uv is >2G and not a symlink; consider linking to /opt/ran_agent/.ran_agent_state/uv-cache"
    fi
  fi
else
  echo "~/.cache/uv: NOT FOUND"
fi
# Check uv-cache size warnings
if [ -d /opt/ran_agent/.ran_agent_state/uv-cache ]; then
  uv_cache_kb=$(du -s /opt/ran_agent/.ran_agent_state/uv-cache 2>/dev/null | awk '{print $1}')
  if [ "${uv_cache_kb:-0}" -gt 10485760 ]; then
    echo "ERROR: uv-cache >10G; stop services and run scripts/clean-uv-cache-safe.sh --yes"
  elif [ "${uv_cache_kb:-0}" -gt 6291456 ]; then
    echo "WARNING: uv-cache >6G; consider running scripts/clean-uv-cache-safe.sh"
  fi
fi

echo ""
echo "=== 3b. Effective systemd runtime snippets ==="
for svc in ran-agent-hermes.service ran-agent-hermes-full.service; do
  echo "--- $svc ---"
  systemctl cat "$svc" 2>/dev/null \
    | grep -E '^(# /etc/systemd/system/ran-agent-hermes|# /etc/systemd/system/ran-agent-hermes-full|Environment(File)?=|ExecStart=|WorkingDirectory=|User=)' \
    || echo "NOT FOUND"
done

echo ""
echo "=== 4. Prompt length estimates ==="
for file in "$REPO_ROOT/hermes/profile/SOUL.md" "$REPO_ROOT/hermes/profile/AGENTS.md"; do
  if [ -f "$file" ]; then
    chars=$(wc -m < "$file" | tr -d ' ')
    echo "$(basename "$file") chars: $chars"
  else
    echo "$(basename "$file") chars: MISSING"
  fi
done

python3 - "$REPO_ROOT/node_bridge/src/hermesGatewayClient.mjs" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
match = re.search(r"function buildHermesSystemInstruction\(\) \{(?P<body>.*?)\n\}", text, re.S)
if not match:
    print("hermesGatewayClient system instruction estimated chars: UNKNOWN")
    raise SystemExit(0)
strings = re.findall(r"'([^']*)'", match.group("body"))
rendered = " ".join(strings)
print(f"hermesGatewayClient system instruction estimated chars: {len(rendered)}")
print(f"system instruction length estimate: {len(rendered)}")
PY

echo ""
echo "=== 5. Lite gateway config (port 8642) ==="
LITE_CONFIG="$LITE_HOME/config.yaml"
if [ -f "$LITE_CONFIG" ]; then
  echo "EXISTS: $LITE_CONFIG"
  echo "--- platform_toolsets ---"
  grep -A20 'platform_toolsets' "$LITE_CONFIG" | head -15 || echo "NOT FOUND"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$LITE_CONFIG" | head -8 || echo "NOT FOUND"
  echo "WARNING: Hermes API Server is not treated as a security sandbox; terminal isolation is not guaranteed on lite-context."
else
  echo "NOT FOUND"
  echo "WARNING: Hermes API Server is not treated as a security sandbox; terminal isolation is not guaranteed on lite-context."
fi

echo ""
echo "=== 6. Full gateway config (port 8643) ==="
FULL_CONFIG="$HERMES_HOME/config.yaml"
if [ -f "$FULL_CONFIG" ]; then
  echo "EXISTS: $FULL_CONFIG"
  echo "--- platform_toolsets (first 8) ---"
  grep -A20 'platform_toolsets' "$FULL_CONFIG" | head -10 || echo "NOT FOUND"
  echo "--- has terminal? ---"
  if grep -A20 'platform_toolsets' "$FULL_CONFIG" | grep -q 'terminal'; then
    echo "terminal in toolsets (OK for full-debug)"
  else
    echo "WARNING: terminal NOT in full-debug toolsets"
  fi
else
  echo "NOT FOUND"
fi

echo ""
echo "=== 6b. Search Hub mode and lite/full toolsets ==="
if [ -f "$LITE_CONFIG" ]; then
  if awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$LITE_CONFIG" | grep -q 'mcp-search_hub'; then
    echo "lite mcp-search_hub: PRESENT"
  else
    echo "WARNING: lite mcp-search_hub missing"
  fi
  if awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$LITE_CONFIG" | grep -q 'mcp-playwright'; then
    echo "WARNING: lite exposes mcp-playwright"
  else
    echo "lite mcp-playwright: absent from toolsets (OK)"
  fi
  if awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$LITE_CONFIG" | grep -q 'mcp-media_generation'; then
    echo "WARNING: lite exposes mcp-media_generation"
  else
    echo "lite mcp-media_generation: absent from toolsets (OK)"
  fi
  lite_mode=$(grep -E '^SEARCH_HUB_PROFILE_MODE=' "$LITE_HOME/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
  echo "lite SEARCH_HUB_PROFILE_MODE: ${lite_mode:-NOT SET}"
fi
if [ -f "$FULL_CONFIG" ]; then
  for mcp in mcp-search_hub mcp-playwright mcp-media_generation; do
    if awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$FULL_CONFIG" | grep -q "$mcp"; then
      echo "full $mcp: PRESENT"
    else
      echo "WARNING: full $mcp missing"
    fi
  done
  full_mode=$(grep -E '^SEARCH_HUB_PROFILE_MODE=' "$HERMES_HOME/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
  echo "full SEARCH_HUB_PROFILE_MODE: ${full_mode:-NOT SET}"
fi

echo ""
echo "=== 6c. Obsidian memory MCP status ==="
obsidian_enabled=$(grep -E '^OBSIDIAN_MEMORY_MCP_ENABLED=' "$LITE_HOME/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
obsidian_enabled="${obsidian_enabled:-NOT SET}"
echo "OBSIDIAN_MEMORY_MCP_ENABLED: $obsidian_enabled"

for cfg_label in "lite" "full"; do
  if [ "$cfg_label" = "lite" ]; then cfg="$LITE_CONFIG"; else cfg="$FULL_CONFIG"; fi
  if [ -f "$cfg" ]; then
    if awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$cfg" | grep -q 'mcp-obsidian_memory'; then
      echo "$cfg_label mcp-obsidian_memory in toolsets: PRESENT"
    else
      echo "$cfg_label mcp-obsidian_memory in toolsets: absent"
    fi
    if grep -q '^  obsidian_memory:' "$cfg"; then
      echo "$cfg_label mcp_servers.obsidian_memory: PRESENT"
    else
      echo "$cfg_label mcp_servers.obsidian_memory: absent"
    fi
    if [ "$obsidian_enabled" = "false" ] && grep -q '^  obsidian_memory:' "$cfg"; then
      echo "ERROR: $cfg_label config has obsidian_memory but OBSIDIAN_MEMORY_MCP_ENABLED=false"
    fi
  fi
done

echo "--- stale processes ---"
for pat in 'start_obsidian_memory_mcp.sh' 'uv tool install iflow-mcp' '/tmp/ran-agent-hermes-home-phase5'; do
  count=$(pgrep -fc "$pat" 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    echo "ERROR: $count process(es) matching '$pat'"
  else
    echo "$pat: none"
  fi
done

echo ""
echo "=== 7. Token comparison smoke test ==="
PROFILE_ENV="$HERMES_HOME/profiles/ran-assistant/.env"
KEY="$(grep -E '^(HERMES_API_KEY|API_SERVER_KEY)=' "$PROFILE_ENV" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
if [ -n "$KEY" ]; then
  for port in 8642 8643; do
    echo "--- port $port ---"
    result=$(curl -sS --max-time 15 \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      "http://127.0.0.1:$port/v1/chat/completions" \
      -d '{"model":"ran-assistant","messages":[{"role":"user","content":"只回复 OK"}],"max_tokens":32}' 2>/dev/null || echo '{"error":"connection failed"}')
    tokens=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('usage',{}).get('prompt_tokens','N/A'))" 2>/dev/null || echo "parse_error")
    echo "  prompt_tokens: $tokens"
  done
else
  echo "SKIPPED: no API key found"
fi

echo ""
echo "=== 8. lark-cli availability ==="
if command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli: $(command -v lark-cli)"
else
  echo "lark-cli: NOT FOUND"
fi

echo ""
echo "=== 9. Recent capability mode logs ==="
sudo journalctl -u ran-agent-node.service --since "15 minutes ago" --no-pager 2>/dev/null | grep 'hermes-capability-mode' | tail -8 || echo "No recent capability mode logs"

echo ""
echo "=== 10. Recent vision errors (5 minutes) ==="
sudo journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service --since "5 minutes ago" --no-pager 2>/dev/null | grep -i 'vision_analyze\|image_url.*BadRequest\|unknown variant.*image_url' | tail -5 || echo "No recent vision errors"
