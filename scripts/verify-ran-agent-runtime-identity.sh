#!/usr/bin/env bash

set -euo pipefail

readonly STEWARD_USER=ran-agent
readonly STEWARD_GROUP=ran-agent
readonly STEWARD_HOME=/opt/ran_agent
readonly STEWARD_SHELL=/usr/sbin/nologin
PROC_ROOT=/proc
if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 ]]; then
  PROC_ROOT="${RAN_AGENT_TEST_PROC_ROOT:-$PROC_ROOT}"
fi

conflict() {
  printf 'RAN_AGENT_STEWARD_IDENTITY_CONFLICT:%s\n' "$1" >&2
  exit 1
}

decimal() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

verify_group() {
  local entry gid
  entry="$(getent group "$STEWARD_GROUP")" || conflict group_missing
  IFS=: read -r _ _ gid _ <<<"$entry"
  decimal "$gid" || conflict group_gid_invalid
  (( gid != 0 )) || conflict group_gid_root
}

verify_account() {
  local passwd_entry group_entry passwd_uid passwd_gid group_gid uid gid home shell
  passwd_entry="$(getent passwd "$STEWARD_USER")" || conflict user_missing
  group_entry="$(getent group "$STEWARD_GROUP")" || conflict group_missing
  IFS=: read -r _ _ passwd_uid passwd_gid _ home shell <<<"$passwd_entry"
  IFS=: read -r _ _ group_gid _ <<<"$group_entry"
  uid="$(id -u "$STEWARD_USER")" || conflict user_uid_unavailable
  gid="$(id -g "$STEWARD_USER")" || conflict user_gid_unavailable
  for value in "$passwd_uid" "$passwd_gid" "$group_gid" "$uid" "$gid"; do
    decimal "$value" || conflict account_numeric_identity_invalid
  done
  (( uid != 0 )) || conflict user_uid_root
  (( gid != 0 )) || conflict user_gid_root
  [[ "$uid" == "$passwd_uid" ]] || conflict passwd_uid_mismatch
  [[ "$gid" == "$passwd_gid" && "$gid" == "$group_gid" ]] ||
    conflict primary_gid_mismatch
  [[ "$home" == "$STEWARD_HOME" ]] || conflict user_home_mismatch
  [[ "$shell" == "$STEWARD_SHELL" ]] || conflict user_shell_mismatch
}

ensure_account() {
  if id "$STEWARD_USER" >/dev/null 2>&1 ||
    getent passwd "$STEWARD_USER" >/dev/null 2>&1; then
    verify_account
    return
  fi
  if ! getent group "$STEWARD_GROUP" >/dev/null 2>&1; then
    groupadd --system "$STEWARD_GROUP"
  fi
  verify_group
  useradd --system --gid "$STEWARD_GROUP" \
    --home-dir "$STEWARD_HOME" --shell "$STEWARD_SHELL" "$STEWARD_USER"
  verify_account
}

unit_property() {
  systemctl show "$1" "--property=$2" --value 2>/dev/null
}

verify_unit_names() {
  local unit="$1" user group
  user="$(unit_property "$unit" User)" || conflict "systemd_user_unavailable:$unit"
  group="$(unit_property "$unit" Group)" || conflict "systemd_group_unavailable:$unit"
  [[ "$user" == "$STEWARD_USER" ]] || conflict "systemd_user_mismatch:$unit"
  [[ "$group" == "$STEWARD_GROUP" ]] || conflict "systemd_group_mismatch:$unit"
}

verify_process() {
  local unit="$1" expected_uid expected_gid pid_before pid_after status
  local effective_uid effective_gid effective_uid_after effective_gid_after
  verify_account
  verify_unit_names "$unit"
  expected_uid="$(id -u "$STEWARD_USER")"
  expected_gid="$(id -g "$STEWARD_USER")"
  pid_before="$(unit_property "$unit" MainPID)" || conflict "main_pid_unavailable:$unit"
  decimal "$pid_before" && (( pid_before != 0 )) || conflict "main_pid_invalid:$unit"
  status="$PROC_ROOT/$pid_before/status"
  [[ -r "$status" && ! -L "$status" ]] || conflict "process_status_unavailable:$unit"
  effective_uid="$(awk '$1 == "Uid:" { print $3 }' "$status")" ||
    conflict "process_uid_unavailable:$unit"
  effective_gid="$(awk '$1 == "Gid:" { print $3 }' "$status")" ||
    conflict "process_gid_unavailable:$unit"
  decimal "$effective_uid" || conflict "process_uid_invalid:$unit"
  decimal "$effective_gid" || conflict "process_gid_invalid:$unit"
  (( effective_uid != 0 )) || conflict "process_uid_root:$unit"
  (( effective_gid != 0 )) || conflict "process_gid_root:$unit"
  [[ "$effective_uid" == "$expected_uid" ]] || conflict "process_uid_mismatch:$unit"
  [[ "$effective_gid" == "$expected_gid" ]] || conflict "process_gid_mismatch:$unit"
  pid_after="$(unit_property "$unit" MainPID)" || conflict "main_pid_recheck_unavailable:$unit"
  [[ "$pid_after" == "$pid_before" && -r "$status" ]] || conflict "main_pid_drift:$unit"
  effective_uid_after="$(awk '$1 == "Uid:" { print $3 }' "$status")" ||
    conflict "process_uid_recheck_unavailable:$unit"
  effective_gid_after="$(awk '$1 == "Gid:" { print $3 }' "$status")" ||
    conflict "process_gid_recheck_unavailable:$unit"
  [[ "$effective_uid_after" == "$effective_uid" && "$effective_gid_after" == "$effective_gid" ]] ||
    conflict "process_identity_drift:$unit"
}

case "${1:-}" in
  --ensure-account) [[ $# -eq 1 ]] || conflict invalid_arguments; ensure_account ;;
  --verify-group) [[ $# -eq 1 ]] || conflict invalid_arguments; verify_group ;;
  --verify-account) [[ $# -eq 1 ]] || conflict invalid_arguments; verify_account ;;
  --verify-unit) [[ $# -eq 2 ]] || conflict invalid_arguments; verify_unit_names "$2" ;;
  --verify-process) [[ $# -eq 2 ]] || conflict invalid_arguments; verify_process "$2" ;;
  *) conflict invalid_mode ;;
esac
