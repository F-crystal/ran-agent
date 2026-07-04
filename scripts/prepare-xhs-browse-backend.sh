#!/usr/bin/env bash
# Account-backed Xiaohongshu browse backend preparation is intentionally disabled.

set -euo pipefail

cat >&2 <<'EOF'
XHS_ACCOUNT_BACKED_DISABLED: xiaohongshu-mcp preparation is retired.
Run scripts/prepare-xhs-generic-fallback.sh and scripts/prepare-xhs-public-sidecar.sh for public-only XHS reading.
EOF
exit 1
