#!/usr/bin/env bash

# One ordered release-verification entry point.  --release is blocking and is
# safe for the deployment transaction; optional diagnostics are intentionally
# non-blocking and their output is suppressed to avoid copying local config.
set -euo pipefail

fail() { printf 'verify-hermes-release: failed:%s\n' "$1" >&2; exit 1; }
SOURCE_ROOT="${RAN_AGENT_RELEASE_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
CONTROL_ROOT="${RAN_AGENT_RELEASE_CONTROL_ROOT:-$SOURCE_ROOT}"
MODE="${1:---release}"
[[ $# -eq 1 ]] || fail invalid_arguments
case "$MODE" in --release|--specialized|--all) ;; *) fail invalid_mode ;; esac

blocking_acceptance() {
  RAN_AGENT_RELEASE_SOURCE_ROOT="$SOURCE_ROOT" \
  RAN_AGENT_RELEASE_CONTROL_ROOT="$CONTROL_ROOT" \
  bash "$SOURCE_ROOT/scripts/accept-hermes-release.sh" --apply
  REPO_ROOT="$CONTROL_ROOT" NODE_BIN="${RAN_AGENT_NODE_BIN:-}" PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-}" \
  RAN_AGENT_PROACTIVE_DIAG_STRICT_ENV=1 \
  bash "$CONTROL_ROOT/scripts/diagnose-proactive-events.sh"
  printf 'verify-hermes-release: blocking-ok\n'
}

specialized_diagnostics() {
  local script
  for script in diagnose-lite-full.sh diagnose-external-mcp-gateway.sh diagnose-ombre-memory.sh; do
    if bash "$CONTROL_ROOT/scripts/$script" >/dev/null 2>&1; then
      printf 'verify-hermes-release: specialized-ok name=%s\n' "$script"
    else
      printf 'verify-hermes-release: specialized-warning name=%s\n' "$script" >&2
    fi
  done
}

case "$MODE" in
  --release) blocking_acceptance ;;
  --specialized) specialized_diagnostics ;;
  --all) blocking_acceptance; specialized_diagnostics ;;
esac
