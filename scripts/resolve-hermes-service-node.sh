#!/usr/bin/env bash

# Print the exact Node executable managed for ran-agent-node.service. An
# explicit bootstrap input wins; command -v and guessed install paths do not.
set -euo pipefail

fail() {
  printf 'resolve-hermes-service-node: failed:%s\n' "$1" >&2
  exit 1
}

validate_node_path() {
  [[ "$1" == /* && -x "$1" && "${1##*/}" == node ]] || return 1
  printf '%s\n' "$1"
}

explicit_node="${RAN_AGENT_NODE_BIN:-}"
[[ -z "$explicit_node" ]] || validate_node_path "$explicit_node" >/dev/null || fail node_binary_required

SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
if [[ "$SYSTEMCTL_BIN" != /* || ! -x "$SYSTEMCTL_BIN" ]]; then
  [[ -n "$explicit_node" ]] && { printf '%s\n' "$explicit_node"; exit 0; }
  fail node_service_path_unavailable
fi
[[ -x /usr/bin/python3 ]] || fail node_service_path_unavailable

parse_environment() {
  /usr/bin/python3 -I -c '
import shlex, sys
values = []
try:
    tokens = shlex.split(sys.stdin.read(), posix=True)
except ValueError:
    raise SystemExit(2)
for token in tokens:
    if token.startswith("RAN_AGENT_NODE_BIN="):
        values.append(token.split("=", 1)[1])
if len(values) > 1 or (values and (not values[0].startswith("/") or "\n" in values[0])):
    raise SystemExit(2)
if values:
    print(values[0])
'
}

environment_output="$($SYSTEMCTL_BIN show --property=Environment --value ran-agent-node.service 2>/dev/null || true)"
node_path="$(printf '%s' "$environment_output" | parse_environment)" || fail node_service_environment_invalid
if [[ -n "$explicit_node" && -n "$node_path" && \
  "$(/usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$explicit_node")" != \
  "$(/usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node_path")" ]]; then
  fail node_service_explicit_environment_mismatch
fi

main_pid="$($SYSTEMCTL_BIN show --property=MainPID --value ran-agent-node.service 2>/dev/null || true)"
if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
  proc_root=/proc
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_TEST_PROC_ROOT:-}" ]]; then
    proc_root="$RAN_AGENT_TEST_PROC_ROOT"
  fi
  process_node="$(/usr/bin/python3 -I -c '
import os, sys
root, initial = sys.argv[1], sys.argv[2]
pending, seen, nodes = [initial], set(), set()
while pending:
    pid = pending.pop()
    if pid in seen or not pid.isdigit():
        continue
    seen.add(pid)
    exe = os.path.realpath(os.path.join(root, pid, "exe"))
    if os.path.basename(exe) == "node" and os.access(exe, os.X_OK):
        nodes.add(exe)
    try:
        pending.extend(open(os.path.join(root, pid, "task", pid, "children"), encoding="ascii").read().split())
    except (FileNotFoundError, PermissionError):
        pass
if len(nodes) > 1:
    raise SystemExit(3)
if nodes:
    print(nodes.pop())
' "$proc_root" "$main_pid")" || fail node_service_process_ambiguous
  if [[ -n "$process_node" ]]; then
    for declared in "$explicit_node" "$node_path"; do
      [[ -z "$declared" || "$(/usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$declared")" == "$process_node" ]] ||
        fail node_service_process_environment_mismatch
    done
    printf '%s\n' "${explicit_node:-${node_path:-$process_node}}"
    exit 0
  fi
  fail node_service_process_unavailable
fi

if [[ -n "$explicit_node" ]]; then
  printf '%s\n' "$explicit_node"
  exit 0
fi
if [[ -n "$node_path" ]]; then
  validate_node_path "$node_path" || fail node_service_path_unavailable
  exit 0
fi

show_output="$($SYSTEMCTL_BIN show --property=ExecStart --value ran-agent-node.service 2>/dev/null || true)"
node_path="$(printf '%s\n' "$show_output" | sed -n 's/.*path=\([^ ;]*\/node\)[ ;].*/\1/p' | head -n 1)"
if [[ -z "$node_path" ]]; then
  cat_output="$($SYSTEMCTL_BIN cat ran-agent-node.service 2>/dev/null || true)"
  node_path="$(printf '%s\n' "$cat_output" | sed -n 's/^[[:space:]]*ExecStart=[@!:+-]*\([^[:space:]]*\/node\)[[:space:]].*$/\1/p' | head -n 1)"
  if [[ -z "$node_path" ]]; then
    node_path="$(printf '%s\n' "$cat_output" | sed -n 's/^[[:space:]]*Environment=RAN_AGENT_NODE_BIN=\([^[:space:]]*\).*$/\1/p' | head -n 1)"
  fi
fi
validate_node_path "$node_path" || fail node_service_path_unavailable
