#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-runtime-service-identity: %s\n' "$1" >&2
  exit 1
}
identity_user=''; identity_group=''
expected_user=''; expected_group=''
verify_process=1
services=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) [[ $# -ge 3 ]] || fail invalid_arguments; identity_user="$2"; identity_group="$3"; shift 3 ;;
    --service) [[ $# -ge 2 ]] || fail invalid_arguments; services+=("$2"); shift 2 ;;
    --expect) [[ $# -ge 3 ]] || fail invalid_arguments; expected_user="$2"; expected_group="$3"; shift 3 ;;
    --no-process) verify_process=0; shift ;;
    *) fail invalid_arguments ;;
  esac
done
[[ -z "$identity_user" || "${#services[@]}" -eq 0 ]] || fail mixed_modes
[[ -n "$identity_user" || "${#services[@]}" -gt 0 ]] || fail identity_required

resolve_identity() {
  local user="$1" group="$2" uid gid primary_group
  [[ "$user" =~ ^[a-z_][a-z0-9_-]*$ && "$group" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail invalid_identity_name
  uid="$(id -u "$user" 2>/dev/null)" || fail runtime_user_missing
  gid="$(id -g "$user" 2>/dev/null)" || fail runtime_group_missing
  primary_group="$(id -gn "$user" 2>/dev/null)" || fail runtime_group_missing
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || fail runtime_identity_invalid
  [[ "$uid" -ne 0 && "$gid" -ne 0 ]] || fail runtime_identity_must_be_non_root
  [[ "$primary_group" == "$group" ]] || fail runtime_primary_group_mismatch
  printf '%s\t%s\t%s\t%s\n' "$user" "$group" "$uid" "$gid"
}

if [[ -n "$identity_user" ]]; then
  resolve_identity "$identity_user" "$identity_group"
  exit 0
fi

proc_root="${RAN_AGENT_TEST_PROC_ROOT:-/proc}"
[[ "$proc_root" == /proc || "${RAN_AGENT_TEST_MODE:-0}" == 1 ]] || fail proc_root_override_forbidden
resolved_user=''
resolved_group=''
resolved_uid=''
resolved_gid=''
for unit in "${services[@]}"; do
  user="$(systemctl show "$unit" --property=User --value 2>/dev/null)" || fail unit_user_unavailable
  group="$(systemctl show "$unit" --property=Group --value 2>/dev/null)" || fail unit_group_unavailable
  [[ -n "$user" ]] || fail unit_user_empty
  [[ -n "$group" ]] || group="$(id -gn "$user" 2>/dev/null)" || fail unit_group_empty
  IFS=$'\t' read -r checked_user checked_group uid gid < <(resolve_identity "$user" "$group")
  if [[ -z "$resolved_user" ]]; then
    resolved_user="$checked_user"; resolved_group="$checked_group"; resolved_uid="$uid"; resolved_gid="$gid"
  else
    [[ "$checked_user" == "$resolved_user" && "$checked_group" == "$resolved_group" &&
      "$uid" == "$resolved_uid" && "$gid" == "$resolved_gid" ]] || fail service_identity_mismatch
  fi
  [[ -z "$expected_user" || "$checked_user" == "$expected_user" ]] || fail unexpected_runtime_user
  [[ -z "$expected_group" || "$checked_group" == "$expected_group" ]] || fail unexpected_runtime_group
  if [[ "$verify_process" -eq 1 ]]; then
    pid_before="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null)" || fail main_pid_unavailable
    [[ "$pid_before" =~ ^[1-9][0-9]*$ ]] || fail main_pid_invalid
    status="$(/bin/cat "$proc_root/$pid_before/status" 2>/dev/null)" || fail process_status_unavailable
    effective_uid="$(awk '$1 == "Uid:" { print $3 }' <<<"$status")"
    effective_gid="$(awk '$1 == "Gid:" { print $3 }' <<<"$status")"
    [[ "$effective_uid" == "$uid" && "$effective_gid" == "$gid" ]] || fail process_effective_identity_mismatch
    pid_after="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null)" || fail main_pid_recheck_unavailable
    [[ "$pid_after" == "$pid_before" ]] || fail main_pid_drift
  fi
done

printf '%s\t%s\t%s\t%s\n' "$resolved_user" "$resolved_group" "$resolved_uid" "$resolved_gid"
