#!/usr/bin/env bash
# Account-backed Xiaohongshu MCP bridge is intentionally disabled.

set -euo pipefail

cat >&2 <<'EOF'
XHS_ACCOUNT_BACKED_DISABLED: xhs_browse MCP bridge is retired.
Hermes no longer exposes xhs_browse_* tools or check_social_login.
EOF
exit 1
