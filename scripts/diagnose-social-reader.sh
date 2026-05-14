#!/bin/bash
# Diagnose social_reader MCP startup without exposing secrets
# Run: bash scripts/diagnose-social-reader.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. Check RAN_AGENT_REPO_ROOT ==="
echo "RAN_AGENT_REPO_ROOT=${RAN_AGENT_REPO_ROOT:-NOT SET}"

echo ""
echo "=== 2. Check .env.local keys (redacted) ==="
for key in RAN_AGENT_REPO_ROOT XHS_COOKIE SESSDATA DASHSCOPE_API_KEY; do
  val="$(grep -E "^${key}=" .env.local 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ -n "$val" ]; then
    echo "$key: SET len=${#val}"
  else
    echo "$key: UNSET"
  fi
done

echo ""
echo "=== 3. Check node_bridge/.env.local keys (redacted) ==="
for key in RAN_AGENT_REPO_ROOT XHS_COOKIE; do
  val="$(grep -E "^${key}=" node_bridge/.env.local 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ -n "$val" ]; then
    echo "$key: SET len=${#val}"
  else
    echo "$key: UNSET"
  fi
done

echo ""
echo "=== 4. Trace social_reader startup (first 30 lines, -x mode) ==="
export RAN_AGENT_REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(pwd)}"
timeout 8 bash -x scripts/start_social_reader_mcp.sh 2>&1 | head -30 || echo "(exit after timeout)"

echo ""
echo "=== 5. Check if node can import social_reader module ==="
cd node_bridge
timeout 5 node -e "
try {
  await import('./src/socialReaderMcpServer.mjs');
  console.log('import OK');
} catch(e) {
  console.log('import FAILED:', e.message);
}
" 2>&1 || echo "(timeout)"
cd ..
