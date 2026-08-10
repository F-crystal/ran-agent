#!/usr/bin/env bash
# Resolve the exact managed Hermes launcher configured by a service.
set -euo pipefail

fail() { printf 'resolve-hermes-service-runtime: failed:%s\n' "$1" >&2; exit 1; }

[[ $# -eq 1 && "$1" == *.service ]] || fail service_required
unit="$1"
systemctl_bin="${RAN_AGENT_SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
[[ "$systemctl_bin" == /* && -x "$systemctl_bin" ]] || fail systemctl_unavailable

exec_start="$({ "$systemctl_bin" show "$unit" --property=ExecStart --value 2>/dev/null || true; "$systemctl_bin" cat "$unit" 2>/dev/null || true; })"
hermes_bin="$(printf '%s\n' "$exec_start" | sed -n -E "s#.*[=[:space:]](/[^[:space:]\"';]*/hermes)([[:space:]\"';]|$).*#\\1#p" | head -n 1)"
if [[ -z "$hermes_bin" ]]; then
  activate="$(printf '%s\n' "$exec_start" | sed -n -E "s#.*source[[:space:]]+([^[:space:]'\"]*/bin/activate).*#\1#p" | head -n 1)"
  [[ -z "$activate" ]] || hermes_bin="${activate%/activate}/hermes"
fi
[[ "$hermes_bin" == /* && -x "$hermes_bin" ]] || fail hermes_service_path_unavailable
printf '%s\n' "$hermes_bin"
