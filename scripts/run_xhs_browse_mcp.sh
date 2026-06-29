#!/usr/bin/env bash
# Stdio bridge for the installed xiaohongshu-mcp HTTP backend.
# Runtime shape:
#   social_reader -> this wrapper -> mcporter serve --stdio -> http://127.0.0.1:18060/mcp
#
# This wrapper does not install packages and does not print secrets.

set -euo pipefail

MARKER_PATH="${XHS_BROWSE_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json}"

if [ ! -f "$MARKER_PATH" ]; then
  echo "XHS_BROWSE_NOT_READY: marker not found at $MARKER_PATH" >&2
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --write-env" >&2
  exit 1
fi

MARKER_OK=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "False")
if [ "$MARKER_OK" != "True" ]; then
  echo "XHS_BROWSE_NOT_READY: marker ok=false" >&2
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --force --write-env" >&2
  exit 1
fi

MCPORTER_CLI=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcporter_cli', ''))" 2>/dev/null)
MCPORTER_CONFIG=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcporter_config_path', ''))" 2>/dev/null)
SERVER_NAME=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('server_name', 'xiaohongshu'))" 2>/dev/null)

if [ -z "$MCPORTER_CLI" ] || [ ! -f "$MCPORTER_CLI" ]; then
  echo "XHS_BROWSE_NOT_READY: mcporter cli missing from marker" >&2
  exit 1
fi
if [ -z "$MCPORTER_CONFIG" ] || [ ! -f "$MCPORTER_CONFIG" ]; then
  echo "XHS_BROWSE_NOT_READY: mcporter config missing from marker" >&2
  exit 1
fi

exec node "$MCPORTER_CLI" --config "$MCPORTER_CONFIG" serve --servers "$SERVER_NAME" --stdio
