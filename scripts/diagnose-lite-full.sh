#!/bin/bash
# Diagnose lite/full capability mode with dual-gateway context split.
# Run: bash scripts/diagnose-lite-full.sh
# No secrets exposed.

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="$HERMES_HOME/lite"
REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

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
