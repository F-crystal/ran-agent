#!/bin/bash
# Diagnostic script for media context decay and XHS issues
# Run on server: bash scripts/diagnose-media-xhs.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. social_reader MCP config in hermes profile ==="
grep -A5 'social_reader' /home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/config.yaml 2>/dev/null || echo "NOT FOUND"

echo ""
echo "=== 2. social_reader MCP script ==="
ls -la scripts/start_social_reader_mcp.sh 2>/dev/null || echo "NOT FOUND"

echo ""
echo "=== 3. Artifact count and ages ==="
python3 -c "
import json, os, glob
from datetime import datetime, timezone, timedelta

artifact_dir = 'debug/media_context/artifacts'
files = sorted(glob.glob(os.path.join(artifact_dir, '*.json')))
print(f'Total artifact files: {len(files)}')

now = datetime.now(timezone.utc)
for f in files[-10:]:
    try:
        data = json.loads(open(f).read())
        created = data.get('created_at', '')
        age = ''
        if created:
            try:
                ct = datetime.fromisoformat(created.replace('Z', '+00:00'))
                delta = now - ct
                hours = delta.total_seconds() / 3600
                age = f'{hours:.1f}h ago'
            except: pass
        print(f'  {os.path.basename(f)[:30]}  type={data.get(\"type\",\"?\")}  ok={data.get(\"ok\",\"?\")}  created={created[:19]}  age={age}')
    except Exception as e:
        print(f'  {os.path.basename(f)}: error={e}')
"

echo ""
echo "=== 4. Conversation context artifact count ==="
python3 -c "
import json, glob, os
conv_dir = 'debug/media_context/conversations'
files = sorted(glob.glob(os.path.join(conv_dir, '*.json')))
for f in files:
    try:
        data = json.loads(open(f).read())
        arts = data.get('artifacts', [])
        refs = data.get('refs', [])
        print(f'{os.path.basename(f)}:')
        print(f'  artifacts: {len(arts)}, refs: {len(refs)}')
        for a in arts[-5:]:
            created = a.get('created_at', '?')[:19]
            print(f'    {a.get(\"id\",\"?\")[:20]}  type={a.get(\"type\",\"?\")}  ok={a.get(\"ok\",\"?\")}  created={created}')
    except Exception as e:
        print(f'  {os.path.basename(f)}: error={e}')
"

echo ""
echo "=== 5. XHS note token cache ==="
python3 -c "
import json, os
cache_path = '.ran_agent_state/social_reader/xhs-note-token-cache.json'
if os.path.exists(cache_path):
    data = json.loads(open(cache_path).read())
    print(f'Cache entries: {len(data)}')
    for k, v in list(data.items())[:5]:
        print(f'  {k[:20]}... token_len={len(str(v.get(\"xsec_token\",\"\")))}')
else:
    print(f'Cache file not found: {cache_path}')
"

echo ""
echo "=== 6. Recent node-bridge media logs ==="
grep -i 'media_context\|decay\|artifact\|recent_candidate\|explicit_ref' logs/node-bridge.log 2>/dev/null | tail -10 || echo "No media logs found"

echo ""
echo "=== 7. Recent hermes social_reader / XHS logs ==="
sudo journalctl -u ran-agent-hermes.service --since "1 hour ago" --no-pager 2>/dev/null | grep -i 'social_reader\|xhs\|xhslink\|web_extract' | tail -10 || echo "No recent XHS logs"
