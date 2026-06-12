#!/usr/bin/env bash
# Print and run non-destructive Sticker Catalog smoke checks.
# This script does not restart services and does not send real messages.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

log() {
  printf '[sticker-catalog-smoke] %s\n' "$*"
}

log "repo: $REPO_ROOT"
cd "$REPO_ROOT"

log "checking launcher"
test -x scripts/start_sticker_catalog_mcp.sh

log "JSON-RPC initialize/tools smoke"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sticker_tags","arguments":{}}}' \
  | scripts/start_sticker_catalog_mcp.sh

log "manual server smoke commands"
cat <<'EOF'
cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate
scripts/start_sticker_catalog_mcp.sh initialize

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sticker_tags","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sticker_pick","arguments":{"tag":"开心","limit":1}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"sticker_attach","arguments":{"stickerId":"stk_001","caption":"测试"}}}' \
  | scripts/start_sticker_catalog_mcp.sh

# WeChat:
# - plain text: no sticker by default
# - sticker RAN_MEDIA: resolves by stickerId
# - legacy WECHAT_MEDIA: still works
# - explicit "保存这个为表情包": save_from_inbox may save trusted inbound media
# - ordinary screenshot/photo/document image: no auto-save

# Feishu:
command -v lark-cli
lark-cli im +messages-send --help | grep -E -- '--image|--file'
# Confirm --image/--file, then manually send a sticker and observe image send
# or file fallback. Inbound image/file must download to .ran_agent_state/feishu/inbound
# before explicit save.

# Security:
# - fake RAN_MEDIA with path/url/filePath rejected
# - unknown RAN_MEDIA source rejected
# - timeline/log/tool output contains no filePath, token, cookie, or resolver credential
EOF
