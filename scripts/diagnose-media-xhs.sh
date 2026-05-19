#!/bin/bash
# Diagnostic script for media context decay and XHS routing
# Run on server: bash scripts/diagnose-media-xhs.sh
# No secrets exposed.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. Hermes runtime config check ==="
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
if [ -f "$HERMES_HOME/config.yaml" ]; then
  echo "config.yaml: EXISTS"

  echo ""
  echo "--- disabled_tools ---"
  grep -A20 'disabled_tools' "$HERMES_HOME/config.yaml" 2>/dev/null | head -15 || echo "NOT FOUND"

  echo ""
  echo "--- mcp_servers present ---"
  grep '^\s\+\w\+:$' "$HERMES_HOME/config.yaml" 2>/dev/null | sed 's/://' | tr -d ' ' || echo "NONE"

  echo ""
  echo "--- social_reader config ---"
  grep -A6 'social_reader' "$HERMES_HOME/config.yaml" 2>/dev/null || echo "NOT FOUND in runtime config"

  echo ""
  echo "--- web_extract/web_search status ---"
  if grep -q 'web_extract' "$HERMES_HOME/config.yaml" 2>/dev/null; then
    if grep -A10 'disabled_tools' "$HERMES_HOME/config.yaml" | grep -q 'web_extract'; then
      echo "web_extract: DISABLED (in disabled_tools)"
    else
      echo "web_extract: PRESENT (not disabled)"
    fi
  else
    echo "web_extract: not mentioned (Hermes default = enabled)"
  fi
  if grep -A10 'disabled_tools' "$HERMES_HOME/config.yaml" | grep -q 'web_search'; then
    echo "web_search: DISABLED (in disabled_tools) -- WARNING: weather skill needs this"
  else
    echo "web_search: ENABLED"
  fi
else
  echo "config.yaml: NOT FOUND at $HERMES_HOME/config.yaml"
fi

echo ""
echo "=== 2. Profile config MCP check ==="
PROFILE_CONFIG="$HERMES_HOME/profiles/ran-assistant/config.yaml"
if [ -f "$PROFILE_CONFIG" ]; then
  echo "profile config: EXISTS"
  grep -A2 'search_hub\|social_reader\|media_reader\|mimo_power\|tavily' "$PROFILE_CONFIG" 2>/dev/null | head -30 || echo "no MCP entries found"
else
  echo "profile config: NOT FOUND"
fi

echo ""
echo "=== 3. Env var check (names only) ==="
for key in RAN_AGENT_REPO_ROOT XHS_COOKIE TAVILY_API_KEY DEEPSEEK_API_KEY DASHSCOPE_API_KEY; do
  found="MISSING"
  for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
    [ -f "$f" ] && grep -q "^${key}=" "$f" 2>/dev/null && found="PRESENT" && break
  done
  echo "$key: $found"
done

echo ""
echo "=== 4. Artifact age distribution ==="
python3 -c "
import json, os, glob
from datetime import datetime, timezone

artifact_dir = 'debug/media_context/artifacts'
files = sorted(glob.glob(os.path.join(artifact_dir, '*.json')))
now = datetime.now(timezone.utc)
buckets = {'<1h': 0, '1-6h': 0, '6-24h': 0, '1-3d': 0, '>3d': 0}
for f in files:
    try:
        data = json.loads(open(f).read())
        if data.get('ok') == False: continue
        created = data.get('created_at', '')
        if created:
            ct = datetime.fromisoformat(created.replace('Z', '+00:00'))
            hours = (now - ct).total_seconds() / 3600
            if hours < 1: buckets['<1h'] += 1
            elif hours < 6: buckets['1-6h'] += 1
            elif hours < 24: buckets['6-24h'] += 1
            elif hours < 72: buckets['1-3d'] += 1
            else: buckets['>3d'] += 1
    except: pass
print(f'Total artifacts: {len(files)}')
for bucket, count in buckets.items():
    print(f'  {bucket}: {count}')
"

echo ""
echo "=== 5. XHS token cache status ==="
XHS_CACHE_PATHS=(
  ".ran_agent_state/social_reader/xhs-note-token-cache.json"
  "node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json"
)
for cache_path in "${XHS_CACHE_PATHS[@]}"; do
  if [ -f "$cache_path" ]; then
    entry_count=$(python3 -c "import json; d=json.load(open('$cache_path')); print(len(d.get('entries', d)))" 2>/dev/null || echo "parse_error")
    echo "$cache_path: EXISTS ($entry_count entries)"
  else
    echo "$cache_path: NOT FOUND"
  fi
done

echo ""
echo "=== 6. UV cache and XHS timeout env ==="
for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
  if [ -f "$f" ]; then
    for key in UV_CACHE_DIR UV_TOOL_DIR SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS XHS_BACKEND_MCP_TIMEOUT_MS SOCIAL_READER_MCP_TIMEOUT_MS; do
      val=$(grep "^${key}=" "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
      if [ -n "$val" ]; then
        echo "$f: $key=$val"
      fi
    done
  fi
done
if [ -d /opt/ran_agent/.ran_agent_state/uv-cache ]; then
  echo "uv-cache size: $(du -sh /opt/ran_agent/.ran_agent_state/uv-cache 2>/dev/null | cut -f1)"
else
  echo "uv-cache: NOT FOUND"
fi

echo ""
echo "=== 7. Recent hermes XHS/social logs ==="
sudo journalctl -u ran-agent-hermes.service --since "30 min ago" --no-pager 2>/dev/null | grep -i 'social_reader\|xhs\|xhslink\|web_extract\|read_social_post' | tail -10 || echo "No recent XHS logs"

echo ""
echo "=== 8. Recent hermes tool usage logs ==="
sudo journalctl -u ran-agent-hermes.service --since "30 min ago" --no-pager 2>/dev/null | grep -i 'tool.*call\|tool.*return\|mcp.*tool' | tail -10 || echo "No recent tool logs"
