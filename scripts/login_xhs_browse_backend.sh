#!/usr/bin/env bash
# Login helper for the installed xiaohongshu-mcp backend.
# Default: run the release login helper when present.
# With --qrcode: call get_login_qrcode through mcporter; requires backend service running.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NODE_BRIDGE_ENV_FILE"
  set +a
fi

MARKER_PATH="${XHS_BROWSE_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json}"

if [ ! -f "$MARKER_PATH" ]; then
  echo "XHS_BROWSE_NOT_READY: marker not found at $MARKER_PATH" >&2
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --write-env" >&2
  exit 1
fi

if [ "${1:-}" = "--qrcode" ]; then
  MCPORTER_CLI=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcporter_cli', ''))" 2>/dev/null)
  MCPORTER_CONFIG=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcporter_config_path', ''))" 2>/dev/null)
  if [ -z "$MCPORTER_CLI" ] || [ ! -f "$MCPORTER_CLI" ] || [ -z "$MCPORTER_CONFIG" ] || [ ! -f "$MCPORTER_CONFIG" ]; then
    echo "XHS_BROWSE_NOT_READY: mcporter config missing from marker" >&2
    exit 1
  fi
  QR_DIR="${XHS_BROWSE_QRCODE_DIR:-/tmp/xhs-browse-login-qrcode}"
  mkdir -p "$QR_DIR"
  echo "Saving XHS login QR image to $QR_DIR" >&2
  exec node "$MCPORTER_CLI" --config "$MCPORTER_CONFIG" call 'xiaohongshu.get_login_qrcode()' --timeout 120000 --save-images "$QR_DIR"
fi

LOGIN_EXECUTABLE=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('login_executable', ''))" 2>/dev/null)
if [ -n "$LOGIN_EXECUTABLE" ] && [ -x "$LOGIN_EXECUTABLE" ]; then
  exec "$LOGIN_EXECUTABLE"
fi

echo "XHS_BROWSE_LOGIN_HELPER_MISSING: release login helper was not found." >&2
echo "hint: start scripts/start_xhs_browse_backend.sh, then run scripts/login_xhs_browse_backend.sh --qrcode" >&2
exit 1
