#!/bin/bash
# Diagnose lite/full capability mode with dual-gateway isolation
# Run: bash scripts/diagnose-lite-full.sh
# No secrets exposed.

set -euo pipefail
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "=== 1. Env vars ==="
for key in RAN_AGENT_CAPABILITY_MODE HERMES_LITE_API_BASE_URL HERMES_FULL_API_BASE_URL HERMES_API_BASE_URL HERMES_PROFILE HERMES_DEFAULT_MODEL; do
  val="${!key:-NOT SET}"
  echo "$key: $val"
done

echo ""
echo "=== 2. Gateway ports ==="
echo "--- 8642 (lite) ---"
if bash -c ':</dev/tcp/127.0.0.1/8642' 2>/dev/null; then
  echo "LISTENING"
else
  echo "NOT LISTENING"
fi
echo "--- 8643 (full) ---"
if bash -c ':</dev/tcp/127.0.0.1/8643' 2>/dev/null; then
  echo "LISTENING"
else
  echo "NOT LISTENING"
fi

echo ""
echo "=== 3. Systemd services ==="
for svc in ran-agent-hermes ran-agent-hermes-full; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  echo "$svc: $status"
done

echo ""
echo "=== 4. Lite profile config ==="
LITE_CONFIG="$HERMES_HOME/profiles/ran-assistant-lite/config.yaml"
if [ -f "$LITE_CONFIG" ]; then
  echo "EXISTS: $LITE_CONFIG"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$LITE_CONFIG" | head -8 || echo "NOT FOUND"
else
  echo "NOT FOUND"
fi

echo ""
echo "=== 5. Full profile config ==="
FULL_CONFIG="$HERMES_HOME/config.yaml"
if [ -f "$FULL_CONFIG" ]; then
  echo "EXISTS: $FULL_CONFIG"
  echo "--- disabled_tools ---"
  grep -A10 'disabled_tools' "$FULL_CONFIG" | head -8 || echo "NOT FOUND"
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
    result=$(curl -sS --max-time 10 \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      "http://127.0.0.1:$port/v1/chat/completions" \
      -d '{"model":"ran-assistant","messages":[{"role":"user","content":"只回复 OK"}],"max_tokens":32}' 2>/dev/null || echo '{"error":"connection failed"}')
    tokens=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('usage',{}).get('prompt_tokens','N/A'))" 2>/dev/null || echo "parse_error")
    echo "  prompt_tokens: $tokens"
  done
  if [ "$tokens" != "N/A" ] && [ "$tokens" != "parse_error" ]; then
    echo "NOTE: If both ports return the same prompt_tokens, profile isolation is not effective."
  fi
else
  echo "SKIPPED: no API key found"
fi

echo ""
echo "=== 7. Recent capability mode logs ==="
sudo journalctl -u ran-agent-node.service --since "1 hour ago" --no-pager 2>/dev/null | grep 'hermes-capability-mode' | tail -5 || echo "No recent capability mode logs"

echo ""
echo "=== 8. Recent vision errors ==="
sudo journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service --since "1 hour ago" --no-pager 2>/dev/null | grep -i 'vision_analyze\|image_url.*BadRequest\|unknown variant.*image_url' | tail -3 || echo "No recent vision errors"
