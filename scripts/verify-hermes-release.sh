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

resolve_direct_runtime() {
  [[ "${RAN_AGENT_RELEASE_STAGED_CANDIDATE:-0}" != 1 ]] || return
  if [[ -n "${RAN_AGENT_HERMES_TEST_BIN:-}" || -n "${RAN_AGENT_HERMES_TEST_PYTHON_BIN:-}" ]]; then
    [[ -n "${RAN_AGENT_HERMES_TEST_BIN:-}" && -n "${RAN_AGENT_HERMES_TEST_PYTHON_BIN:-}" ]] ||
      fail incomplete_hermes_test_runtime
    return
  fi
  local node_bin="${RAN_AGENT_NODE_BIN:-}" runtime_pair extra
  [[ "$node_bin" == /* && -x "$node_bin" ]] || fail node_binary_required
  runtime_pair="$("$node_bin" "$SOURCE_ROOT/scripts/resolve-hermes-gate-runtime.mjs" \
    /usr/bin/systemctl "${RAN_AGENT_RUNTIME_USER:-ubuntu}" \
    "${RAN_AGENT_RUNTIME_GROUP:-${RAN_AGENT_RUNTIME_USER:-ubuntu}}" /proc)" ||
    fail hermes_test_runtime_unavailable
  [[ "$runtime_pair" != *$'\n'* ]] || fail hermes_test_runtime_invalid
  IFS=$'\t' read -r RAN_AGENT_HERMES_TEST_BIN RAN_AGENT_HERMES_TEST_PYTHON_BIN extra <<<"$runtime_pair"
  [[ -n "$RAN_AGENT_HERMES_TEST_BIN" && -n "$RAN_AGENT_HERMES_TEST_PYTHON_BIN" && -z "$extra" ]] ||
    fail hermes_test_runtime_invalid
  export RAN_AGENT_HERMES_TEST_BIN RAN_AGENT_HERMES_TEST_PYTHON_BIN
}

blocking_acceptance() {
  resolve_direct_runtime
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
  for script in diagnose-external-mcp-gateway.sh; do
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
