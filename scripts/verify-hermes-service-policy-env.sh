#!/usr/bin/env bash
# Validate only the six non-secret model-policy keys inherited by MainPID.
set -euo pipefail

fail() { printf 'verify-hermes-service-policy-env: failed:%s unit=%s\n' "$1" "${unit:-unknown}" >&2; exit 1; }

emit=0
if [[ "${1:-}" == --emit ]]; then emit=1; shift; fi
[[ $# -eq 1 && "$1" == *.service ]] || fail service_required
unit="$1"
systemctl_bin="${RAN_AGENT_SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
proc_root="${RAN_AGENT_PROC_ROOT:-/proc}"
model="${RAN_AGENT_EXPECTED_HERMES_MODEL:-deepseek-v4-pro}"
case "$model" in deepseek-v4-pro|deepseek-v4-flash) ;; *) fail expected_model_invalid ;; esac
[[ "$systemctl_bin" == /* && -x "$systemctl_bin" ]] || fail systemctl_unavailable
pid="$("$systemctl_bin" show "$unit" --property=MainPID --value 2>/dev/null || true)"
[[ "$pid" =~ ^[1-9][0-9]*$ && -r "$proc_root/$pid/environ" ]] || fail main_pid_unavailable

expected=(
  HERMES_PROVIDER=deepseek
  HERMES_INFERENCE_PROVIDER=deepseek
  HERMES_DEFAULT_MODEL=$model
  HERMES_INFERENCE_MODEL=$model
  HERMES_PRO_MODEL=$model
  HERMES_DEEPSEEK_THINKING_MODE=disabled
)
policy_env="$(mktemp)"
trap 'rm -f "$policy_env"' EXIT INT TERM
tr '\0' '\n' < "$proc_root/$pid/environ" > "$policy_env"
for assignment in "${expected[@]}"; do
  grep -qxF "$assignment" "$policy_env" || fail "effective_policy_mismatch:${assignment%%=*}"
done
verified_pid="$("$systemctl_bin" show "$unit" --property=MainPID --value 2>/dev/null || true)"
[[ "$verified_pid" == "$pid" && -d "$proc_root/$pid" && -r "$proc_root/$pid/environ" ]] ||
  fail main_pid_changed
if [[ "$emit" -eq 1 ]]; then
  printf '%s\n' "${expected[@]}"
else
  printf 'verify-hermes-service-policy-env: policy-env-ok unit=%s pid=%s keys=6\n' "$unit" "$pid"
fi
