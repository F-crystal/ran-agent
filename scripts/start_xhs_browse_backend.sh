#!/usr/bin/env bash
# Account-backed Xiaohongshu browse backend is intentionally disabled.

set -euo pipefail

cat >&2 <<'EOF'
XHS_ACCOUNT_BACKED_DISABLED: ran-agent-xhs-browse.service has been retired.
Hermes Xiaohongshu reads must use public parsers only.
Use scripts/start_xhs_public_sidecar.sh for the XHS-Downloader public API sidecar.
EOF
exit 1
