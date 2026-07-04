#!/usr/bin/env bash
# Account-backed Xiaohongshu login is intentionally disabled.

set -euo pipefail

cat >&2 <<'EOF'
XHS_ACCOUNT_BACKED_DISABLED: Xiaohongshu reading is public-only.
Do not scan QR codes or configure XHS cookies for Hermes.
Use scripts/prepare-xhs-generic-fallback.sh and scripts/prepare-xhs-public-sidecar.sh instead.
EOF
exit 1
