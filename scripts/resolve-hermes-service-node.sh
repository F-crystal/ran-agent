#!/usr/bin/env bash

# Print the exact Node executable used by ran-agent-node.service.  An explicit
# operator path wins; command -v is deliberately not a deployment fallback.
set -euo pipefail

fail() {
  printf 'resolve-hermes-service-node: failed:%s\n' "$1" >&2
  exit 1
}

if [[ -n "${RAN_AGENT_NODE_BIN:-}" ]]; then
  [[ "$RAN_AGENT_NODE_BIN" == /* && -x "$RAN_AGENT_NODE_BIN" ]] || fail node_binary_required
  printf '%s\n' "$RAN_AGENT_NODE_BIN"
  exit 0
fi

SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
[[ "$SYSTEMCTL_BIN" == /* && -x "$SYSTEMCTL_BIN" ]] || fail node_service_path_unavailable

show_output="$($SYSTEMCTL_BIN show --property=ExecStart --value ran-agent-node.service 2>/dev/null || true)"
node_path="$(printf '%s\n' "$show_output" | sed -n 's/.*path=\([^ ;]*\/node\)[ ;].*/\1/p' | head -n 1)"
if [[ -z "$node_path" ]]; then
  cat_output="$($SYSTEMCTL_BIN cat ran-agent-node.service 2>/dev/null || true)"
  node_path="$(printf '%s\n' "$cat_output" | sed -n 's/^[[:space:]]*ExecStart=[@!:+-]*\([^[:space:]]*\/node\)[[:space:]].*$/\1/p' | head -n 1)"
fi
[[ "$node_path" == /* && -x "$node_path" ]] || fail node_service_path_unavailable
printf '%s\n' "$node_path"
