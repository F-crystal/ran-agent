#!/bin/bash
# Diagnose lite/full capability mode with dual-gateway isolation
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
for port in 8642 8643; do
  if bash -c ":</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    echo "port $port: LISTENING"
  else
    echo "port $port: NOT LISTENING"
  fi
done

echo ""
echo "=== 3. Systemd services ==="
for svc in ran-agent-hermes ran-agent-hermes-full; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  echo "$svc: $status"
done

echo ""
echo "=== 4. Lite gateway config (port 8642) ==="
LITE_CONFIG="$LITE_HOME/config.yaml"
if [ -f "$LITE_CONFIG" ]; then
  echo "EXISTS: $LITE_CONFIG"
  echo "--- platform_toolsets ---"
  grep -A20 'platform_toolsets' "$LITE_CONFIG" | head -15 || echo "NOT FOUND"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$LITE_CONFIG" | head -8 || echo "NOT FOUND"
  echo "--- has terminal? ---"
  if grep -A20 'platform_toolsets' "$LITE_CONFIG" | grep -q 'terminal'; then
    echo "WARNING: terminal in lite toolsets"
  else
    echo "terminal NOT in toolsets (OK)"
  fi
else
  echo "NOT FOUND"
fi

echo ""
echo "=== 5. Full gateway config (port 8643) ==="
FULL_CONFIG="$HERMES_HOME/config.yaml"
if [ -f "$FULL_CONFIG" ]; then
  echo "EXISTS: $FULL_CONFIG"
  echo "--- platform_toolsets (first 8) ---"
  grep -A20 'platform_toolsets' "$FULL_CONFIG" | head -10 || echo "NOT FOUND"
  echo "--- has terminal? ---"
  if grep -A20 'platform_toolsets' "$FULL_CONFIG" | grep -q 'terminal'; then
    echo "terminal in toolsets (OK for full)"
  else
    echo "WARNING: terminal NOT in full toolsets"
  fi
else
  echo "NOT FOUND"
fi

echo ""
echo "=== 6. Token comparison smoke test ==="
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
echo "=== 7. lark-cli availability ==="
if command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli: $(command -v lark-cli)"
else
  echo "lark-cli: NOT FOUND"
fi

echo ""
echo "=== 8. Recent capability mode logs ==="
sudo journalctl -u ran-agent-node.service --since "1 hour ago" --no-pager 2>/dev/null | grep 'hermes-capability-mode' | tail -5 || echo "No recent capability mode logs"

echo ""
echo "=== 9. Recent vision errors ==="
sudo journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service --since "1 hour ago" --no-pager 2>/dev/null | grep -i 'vision_analyze\|image_url.*BadRequest\|unknown variant.*image_url' | tail -3 || echo "No recent vision errors"
