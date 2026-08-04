#!/usr/bin/env bash

# Server-local release transaction.  A branch is never an apply authority:
# callers resolve it to RAN_AGENT_RELEASE_CANDIDATE before entering here.
set -euo pipefail
umask 077

fail() {
  printf 'deploy-hermes-release: failed:%s\n' "$1" >&2
  exit 1
}

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO_ROOT="${RAN_AGENT_RELEASE_CONTROL_ROOT:-$SCRIPT_ROOT}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
SERVER_ROOT="/opt/ran_agent"
cd "$REPO_ROOT"
MODE="${1:---refuse-mutation}"
case "$MODE" in
  --dry-run|--apply) [[ $# -eq 1 ]] || fail invalid_arguments ;;
  --rollback) [[ $# -eq 2 ]] || fail rollback_snapshot_required ;;
  --refuse-mutation) fail explicit_apply_required ;;
  *) fail invalid_mode ;;
esac

if [[ "${EUID}" -eq 0 ]]; then SUDO=(); else command -v sudo >/dev/null 2>&1 || fail sudo_required; SUDO=(sudo); fi
STAGE_USE_SUDO=1

stage_run() {
  if [[ "$STAGE_USE_SUDO" == 1 ]]; then "${SUDO[@]}" "$@"; else "$@"; fi
}

PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-$REPO_ROOT/.venv/bin/python}"
OMBRE_PATCH_PYTHON_BIN=''
CANONICAL_LIVE_STATE_DIR="${RAN_AGENT_RELEASE_STATE_DIR:-/opt/ran_agent/.ran_agent_state}"
STATE_DIR="$CANONICAL_LIVE_STATE_DIR"
# Kept outside STATE_DIR: snapshots must never archive their own transaction.
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
SECRET_ROLLBACK_ROOT="${RAN_AGENT_RELEASE_SECRET_ROLLBACK_ROOT:-/run/ran-agent-release-secrets}"
SNAPSHOT_ROOT="$ARTIFACT_ROOT/snapshots"
SUCCESSFUL_SNAPSHOT_RETENTION=2
CURRENT_PRODUCTION_POINTER="$SNAPSHOT_ROOT/current-production.json"
STAGE_ROOT="$ARTIFACT_ROOT/stages"
ARCHIVE_ROOT="$ARTIFACT_ROOT/archives"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
OMBRE_INGRESS_DROPIN="$SYSTEMD_DIR/ran-agent-node.service.d/98-ombre-steward-rotation.conf"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
FULL_PROFILE="${HERMES_FULL_PROFILE:-ran-assistant}"
LITE_PROFILE="${HERMES_LITE_PROFILE:-ran-assistant-lite}"
CORE_RUNTIME_UNITS=(ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service)
ALL_RUNTIME_UNITS=("${CORE_RUNTIME_UNITS[@]}" ran-agent-ombre-brain.service ran-agent-ombre-recall.service ran-agent-xhs-browse.service ran-agent-xhs-public-sidecar.service)
SERVICE_TRANSACTION_UNITS=(ran-agent-python.service ran-agent-ombre-brain.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-ombre-recall.service ran-agent-xhs-browse.service ran-agent-xhs-public-sidecar.service)
SNAPSHOT_DIR=''
SNAPSHOT_BUILD_ACTIVE=0
SNAPSHOT_FINAL_DIR=''
SNAPSHOT_TRANSACTION_ID=''
STAGE_DIR=''
GATE_DIR=''
CANDIDATE_ARCHIVE=''
PRODUCTION_HEAD=''
DELTA_FILE=''
TRANSACTION_STARTED=0
TRANSACTION_ACCEPTED=0
EXPLICIT_ROLLBACK=0
ROLLBACK_METADATA_FINALIZE=0
SECRET_ROLLBACK_DIR=''
STEWARD_TOKEN_HAD_PRIOR=0
STEWARD_TOKEN_RESTORED=1
STEWARD_ROTATION_ACTIVE=0
OMBRE_INGRESS_BLOCKED=0
RETENTION_PRODUCTION_TRANSACTION=''
DEPLOY_MODEL='deepseek-v4-flash'
DEPLOY_OMBRE_COMPAT_ENABLED='true'
DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL='https://api.deepseek.com/v1'
DEPLOY_OMBRE_COMPAT_CURATOR_MODEL='deepseek-v4-flash'
DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL='https://api.deepseek.com/v1'
DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL='deepseek-v4-flash'
RELEASE_LOCK_HELPER_PID=''
RELEASE_LOCK_READY_FD_OPEN=0
RELEASE_LOCK_READY_DIR=''
RELEASE_LOCK_READY_FIFO=''
RELEASE_EPHEMERA_CLEANED=0
NODE_MODULES_ROLLBACK=''
NODE_MODULES_ABSENT_MARKER=''

stop_release_transaction_lock() {
  if [[ "$RELEASE_LOCK_READY_FD_OPEN" -eq 1 ]]; then
    exec 9<&-
    RELEASE_LOCK_READY_FD_OPEN=0
  fi
  [[ -z "$RELEASE_LOCK_READY_FIFO" ]] || rm -f -- "$RELEASE_LOCK_READY_FIFO" 2>/dev/null || true
  [[ -z "$RELEASE_LOCK_READY_DIR" ]] || rmdir -- "$RELEASE_LOCK_READY_DIR" 2>/dev/null || true
  RELEASE_LOCK_READY_FIFO=''
  RELEASE_LOCK_READY_DIR=''
  if [[ "$RELEASE_LOCK_HELPER_PID" =~ ^[1-9][0-9]*$ ]]; then
    # The helper releases flock when the caller-owned FIFO is unlinked.  Do
    # not signal a privileged PID from stale shell state.
    for _ in {1..25}; do
      kill -0 "$RELEASE_LOCK_HELPER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$RELEASE_LOCK_HELPER_PID" 2>/dev/null || wait "$RELEASE_LOCK_HELPER_PID" 2>/dev/null || true
  fi
  RELEASE_LOCK_HELPER_PID=''
}

acquire_release_transaction_lock() {
  local lock_required=0 lock_python=/usr/bin/python3 ready='' helper_status=0 canonical_artifact='' ready_received=0
  local -a lock_runner=("${SUDO[@]}" /usr/bin/env)
  if [[ "$REPO_ROOT" == "$SERVER_ROOT" && ( "$MODE" == --apply || "$MODE" == --rollback ) ]]; then
    lock_required=1
  elif [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && "${RAN_AGENT_TEST_RELEASE_LOCK:-0}" == 1 ]]; then
    lock_required=1
  fi
  [[ "$lock_required" -eq 1 ]] || return 0
  [[ "$ARTIFACT_ROOT" == /* && "$ARTIFACT_ROOT" != / && "$ARTIFACT_ROOT" != "$REPO_ROOT" && "$ARTIFACT_ROOT" != "$REPO_ROOT"/* ]] ||
    fail release_lock_artifact_root_invalid
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -d "$ARTIFACT_ROOT" && -w "$ARTIFACT_ROOT" ]]; then
    lock_runner=(/usr/bin/env)
    chmod 700 "$ARTIFACT_ROOT" || fail release_lock_artifact_root_unavailable
  else
    if ! "${lock_runner[@]}" test -e "$ARTIFACT_ROOT"; then
      "${lock_runner[@]}" install -d -o root -g root -m 700 "$ARTIFACT_ROOT" || fail release_lock_artifact_root_unavailable
    fi
  fi
  "${lock_runner[@]}" test ! -L "$ARTIFACT_ROOT" || fail release_lock_artifact_root_symlink
  canonical_artifact="$("${lock_runner[@]}" sh -c 'cd "$1" && pwd -P' sh "$ARTIFACT_ROOT")" ||
    fail release_lock_artifact_root_unavailable
  [[ "$canonical_artifact" == "$ARTIFACT_ROOT" ]] || fail release_lock_artifact_root_noncanonical
  [[ -x "$lock_python" ]] || lock_python="$PYTHON_BIN"
  [[ "$lock_python" == /* && -x "$lock_python" ]] || fail release_lock_python_unavailable
  "${lock_runner[@]}" "$lock_python" -I -c '
import os, stat, sys
value = os.lstat(sys.argv[1])
expected = os.geteuid()
if not stat.S_ISDIR(value.st_mode) or value.st_uid != expected or value.st_gid != os.getegid() or stat.S_IMODE(value.st_mode) != 0o700:
    raise SystemExit(1)
' "$ARTIFACT_ROOT" || fail release_lock_artifact_root_identity_invalid
  RELEASE_LOCK_READY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-release-lock.XXXXXX")" || fail release_lock_status_unavailable
  trap stop_release_transaction_lock EXIT
  chmod 700 "$RELEASE_LOCK_READY_DIR" || fail release_lock_status_unavailable
  RELEASE_LOCK_READY_FIFO="$RELEASE_LOCK_READY_DIR/ready"
  mkfifo -m 600 "$RELEASE_LOCK_READY_FIFO" || fail release_lock_status_unavailable
  exec 9<>"$RELEASE_LOCK_READY_FIFO"
  RELEASE_LOCK_READY_FD_OPEN=1
  "${lock_runner[@]}" "$lock_python" -I -c '
import fcntl, os, stat, sys, time
lock_path, parent_pid, ready_path, ready_uid = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
try:
    descriptor = os.open(lock_path, flags, 0o600)
except OSError:
    raise SystemExit(74)
value = os.fstat(descriptor)
if not stat.S_ISREG(value.st_mode):
    raise SystemExit(74)
if stat.S_IMODE(value.st_mode) != 0o600:
    raise SystemExit(74)
if os.geteuid() == 0 and (value.st_uid != 0 or value.st_gid != 0):
    raise SystemExit(74)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(73)
ready_flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
try:
    ready_descriptor = os.open(ready_path, ready_flags)
except OSError:
    raise SystemExit(75)
ready_value = os.fstat(ready_descriptor)
if not stat.S_ISFIFO(ready_value.st_mode) or ready_value.st_uid != ready_uid:
    raise SystemExit(75)
with os.fdopen(ready_descriptor, "w", encoding="utf-8") as handle:
    handle.write("locked\n")
    handle.flush()
while os.path.exists(ready_path):
    try:
        os.kill(parent_pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.2)
' "$ARTIFACT_ROOT/.release-transaction.lock" "$$" "$RELEASE_LOCK_READY_FIFO" "$EUID" &
  RELEASE_LOCK_HELPER_PID=$!
  for _ in {1..5}; do
    if IFS= read -r -t 1 -u 9 ready; then ready_received=1; break; fi
    if ! kill -0 "$RELEASE_LOCK_HELPER_PID" 2>/dev/null; then break; fi
  done
  exec 9<&-
  RELEASE_LOCK_READY_FD_OPEN=0
  if [[ "$ready_received" -ne 1 ]]; then
    if jobs -pr | grep -qx "$RELEASE_LOCK_HELPER_PID"; then
      rm -f -- "$RELEASE_LOCK_READY_FIFO" 2>/dev/null || true
      helper_status=76
    elif wait "$RELEASE_LOCK_HELPER_PID"; then helper_status=0; else helper_status=$?; fi
    RELEASE_LOCK_HELPER_PID=''
    rm -f -- "$RELEASE_LOCK_READY_FIFO"
    rmdir -- "$RELEASE_LOCK_READY_DIR" 2>/dev/null || true
    RELEASE_LOCK_READY_FIFO=''
    RELEASE_LOCK_READY_DIR=''
    case "$helper_status" in
      73) fail release_transaction_locked ;;
      74) fail release_lock_identity_invalid ;;
      75) fail release_lock_readiness_invalid ;;
      76) fail release_lock_timeout ;;
      *) fail release_lock_protocol_failed ;;
    esac
  fi
  [[ "$ready" == locked ]] || {
    stop_release_transaction_lock
    fail release_lock_protocol_failed
  }
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && "${RAN_AGENT_TEST_RELEASE_LOCK_HOLD_SECONDS:-0}" != 0 ]]; then
    sleep "$RAN_AGENT_TEST_RELEASE_LOCK_HOLD_SECONDS"
  fi
}

acquire_release_transaction_lock
NODE_BIN=''
CONTROLLER_CANDIDATE="${RAN_AGENT_RELEASE_CANDIDATE:-}"

[[ "$MODE" == --rollback ]] || {
  CANDIDATE="$CONTROLLER_CANDIDATE"
  [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid
  git -C "$REPO_ROOT" cat-file -e "${CANDIDATE}^{commit}" 2>/dev/null || fail candidate_object_missing
  DEPLOY_MODEL="${RAN_AGENT_DEPLOY_HERMES_MODEL:-deepseek-v4-flash}"
  case "$DEPLOY_MODEL" in
    deepseek-v4-pro|deepseek-v4-flash) ;;
    *) fail deploy_model_invalid ;;
  esac
  DEPLOY_OMBRE_COMPAT_ENABLED="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED:-true}"
  case "$DEPLOY_OMBRE_COMPAT_ENABLED" in true|false) ;; *) fail ombre_compat_enabled_invalid ;; esac
  DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL:-https://api.deepseek.com/v1}"
  DEPLOY_OMBRE_COMPAT_CURATOR_MODEL="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_MODEL:-$DEPLOY_MODEL}"
  DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL:-https://api.deepseek.com/v1}"
  DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL:-$DEPLOY_MODEL}"
  for model_endpoint in \
    "$DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL|$DEPLOY_OMBRE_COMPAT_CURATOR_MODEL" \
    "$DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL|$DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL"; do
    case "$model_endpoint" in
      'https://api.deepseek.com/v1|deepseek-v4-flash'|'https://api.deepseek.com/v1|deepseek-v4-pro') ;;
      *) fail ombre_compat_model_endpoint_invalid ;;
    esac
  done
  local_node_runner=(/usr/bin/env)
  [[ "$REPO_ROOT" != "$SERVER_ROOT" ]] || local_node_runner=("${SUDO[@]}" /usr/bin/env)
  NODE_BIN="$("${local_node_runner[@]}" RAN_AGENT_NODE_BIN="${RAN_AGENT_NODE_BIN:-}" \
    RAN_AGENT_SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-}" \
    bash "$SCRIPT_ROOT/scripts/resolve-hermes-service-node.sh")" || fail node_service_path_unavailable
}

cleanup_pretransaction_artifacts() {
  [[ "$RELEASE_EPHEMERA_CLEANED" -eq 0 ]] || return 0
  RELEASE_EPHEMERA_CLEANED=1
  if [[ -n "$STAGE_DIR" && "$STAGE_DIR" == "$STAGE_ROOT"/release-stage.* ]]; then
    "${SUDO[@]}" rm -rf -- "$STAGE_DIR" 2>/dev/null || true
  fi
  if [[ -n "$GATE_DIR" && "$GATE_DIR" == /tmp/ran-agent-release-runtime-gate.* ]]; then
    "${SUDO[@]}" chmod -R u+w "$GATE_DIR" 2>/dev/null || true
    "${SUDO[@]}" rm -rf -- "$GATE_DIR" 2>/dev/null || true
  fi
  if [[ -n "$CANDIDATE_ARCHIVE" && "$CANDIDATE_ARCHIVE" == "$ARCHIVE_ROOT"/release-candidate.*.tar ]]; then
    "${SUDO[@]}" rm -f -- "$CANDIDATE_ARCHIVE" 2>/dev/null || true
  fi
  if [[ -n "$DELTA_FILE" && "$DELTA_FILE" == "$ARCHIVE_ROOT"/release-delta.*.txt ]]; then
    "${SUDO[@]}" rm -f -- "$DELTA_FILE" 2>/dev/null || true
  fi
  if [[ "$TRANSACTION_STARTED" -eq 0 && "$TRANSACTION_ACCEPTED" -eq 0 && "$SNAPSHOT_BUILD_ACTIVE" -eq 1 && -n "$SNAPSHOT_DIR" &&
    "$SNAPSHOT_DIR" == "$SNAPSHOT_ROOT"/.release-incomplete.* ]]; then
    "${SUDO[@]}" rm -rf -- "$SNAPSHOT_DIR" 2>/dev/null || true
  fi
}

verify_in_progress_snapshot() {
  local contract_root="${STAGE_DIR:-$SCRIPT_ROOT}"
  "${SUDO[@]}" "$PYTHON_BIN" "$contract_root/scripts/ombre_o1_contract.py" \
    verify-in-progress-snapshot "$1" --candidate "$CANDIDATE" --require-root-owned >/dev/null
}

durable_acceptance_confirmed() {
  [[ -n "$SNAPSHOT_DIR" && -n "${CANDIDATE:-}" ]] || return 1
  local contract_root="${STAGE_DIR:-$SCRIPT_ROOT}" decision reason completed pointer_transaction pointer_candidate
  IFS=$'\t' read -r decision reason completed < <(
    "${SUDO[@]}" "$PYTHON_BIN" "$contract_root/scripts/ombre_o1_contract.py" \
      classify-snapshot "$SNAPSHOT_DIR" --format tsv
  ) || return 1
  [[ "$decision" == ELIGIBLE ]] || return 1
  IFS=$'\t' read -r pointer_transaction pointer_candidate < <(
    "${SUDO[@]}" "$PYTHON_BIN" "$contract_root/scripts/ombre_o1_contract.py" \
      read-production-pointer "$CURRENT_PRODUCTION_POINTER" --format tsv
  ) || return 1
  [[ "$pointer_transaction" == "$(basename "$SNAPSHOT_DIR")" && "$pointer_candidate" == "$CANDIDATE" ]]
}

release_exit() {
  local status="$1"
  trap - EXIT INT TERM
  if [[ "$TRANSACTION_STARTED" -eq 0 && "$TRANSACTION_ACCEPTED" -eq 0 && "$SNAPSHOT_BUILD_ACTIVE" -eq 1 &&
    -n "$SNAPSHOT_FINAL_DIR" && "$SNAPSHOT_FINAL_DIR" == "$SNAPSHOT_ROOT"/release-transaction.* ]] &&
    "${SUDO[@]}" test -d "$SNAPSHOT_FINAL_DIR" && verify_in_progress_snapshot "$SNAPSHOT_FINAL_DIR"; then
    SNAPSHOT_DIR="$SNAPSHOT_FINAL_DIR"
    TRANSACTION_STARTED=1
  fi
  if [[ "$TRANSACTION_STARTED" -eq 1 && "$TRANSACTION_ACCEPTED" -eq 0 ]] && durable_acceptance_confirmed; then
    TRANSACTION_ACCEPTED=1
    TRANSACTION_STARTED=0
  fi
  if [[ "$TRANSACTION_STARTED" -eq 1 ]]; then
    rollback_transaction "$status"
  fi
  [[ "$status" -eq 0 ]] || cleanup_pretransaction_artifacts
  stop_release_transaction_lock
  exit "$status"
}

trap 'release_exit $?' EXIT

require_node_sqlite() {
  [[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || fail node_binary_required
  local version major minor patch
  version="$($NODE_BIN -p 'process.versions.node' 2>/dev/null)" || fail node_version_probe
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || fail node_version_invalid
  (( major > 22 || (major == 22 && minor >= 19) )) || fail node_version_unsupported
  "$NODE_BIN" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1); db.close();' >/dev/null 2>&1 || fail node_sqlite_unavailable
}

require_python_runtime() {
  [[ "$PYTHON_BIN" == /* && -x "$PYTHON_BIN" ]] || fail python_runtime_required
  "$PYTHON_BIN" -I -c 'import sqlite3; import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1 || fail python_runtime_invalid
}

require_ombre_patch_python_runtime() {
  OMBRE_PATCH_PYTHON_BIN="${RAN_AGENT_OMBRE_PATCH_PYTHON_BIN:-}"
  if [[ -z "$OMBRE_PATCH_PYTHON_BIN" && -x /usr/bin/python3.12 ]]; then
    OMBRE_PATCH_PYTHON_BIN=/usr/bin/python3.12
  elif [[ -z "$OMBRE_PATCH_PYTHON_BIN" ]]; then
    OMBRE_PATCH_PYTHON_BIN="$(command -v python3.12 || true)"
  fi
  [[ "$OMBRE_PATCH_PYTHON_BIN" == /* && -x "$OMBRE_PATCH_PYTHON_BIN" ]] ||
    fail ombre_python_3_12_required
  "$OMBRE_PATCH_PYTHON_BIN" -I -c 'import sys; assert sys.version_info[:2] == (3, 12)' >/dev/null 2>&1 ||
    fail ombre_python_3_12_invalid
}

inside_path() {
  local child="$1" parent="$2"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

require_artifact_layout() {
  [[ "$ARTIFACT_ROOT" == /* && "$STATE_DIR" == /* && "$SECRET_ROLLBACK_ROOT" == /* ]] || fail artifact_root_absolute_required
  ! inside_path "$ARTIFACT_ROOT" "$REPO_ROOT" || fail artifact_root_inside_repo
  ! inside_path "$ARTIFACT_ROOT" "$STATE_DIR" || fail artifact_root_inside_state_dir
  ! inside_path "$STATE_DIR" "$ARTIFACT_ROOT" || fail state_dir_inside_artifact_root
  ! inside_path "$SECRET_ROLLBACK_ROOT" "$REPO_ROOT" || fail secret_rollback_inside_repo
  ! inside_path "$SECRET_ROLLBACK_ROOT" "$STATE_DIR" || fail secret_rollback_inside_state_dir
  ! inside_path "$SECRET_ROLLBACK_ROOT" "$ARTIFACT_ROOT" || fail secret_rollback_inside_artifact_root
  require_artifact_directory "$SNAPSHOT_ROOT" "$ARTIFACT_ROOT" || fail snapshot_root_identity_invalid
  require_artifact_directory "$STAGE_ROOT" "$ARTIFACT_ROOT" || fail stage_root_identity_invalid
  require_artifact_directory "$ARCHIVE_ROOT" "$ARTIFACT_ROOT" || fail archive_root_identity_invalid
  require_artifact_directory "$SECRET_ROLLBACK_ROOT" '' || fail secret_rollback_root_unavailable
  if "${SUDO[@]}" find "$SECRET_ROLLBACK_ROOT" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail secret_rollback_residue
  fi
}

require_artifact_directory() {
  local path="$1" same_filesystem_root="$2" expected_uid=0 expected_gid=0
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && "${#SUDO[@]}" -eq 0 ]]; then
    expected_uid="$EUID"
    expected_gid="$(id -g)"
  fi
  if ! "${SUDO[@]}" test -e "$path"; then
    if [[ "$expected_uid" -eq 0 ]]; then
      "${SUDO[@]}" install -d -o root -g root -m 700 "$path" || return 1
    else
      install -d -m 700 "$path" || return 1
    fi
  fi
  "${SUDO[@]}" /usr/bin/python3 -I -c '
import os, stat, sys
path, filesystem_root, expected_uid, expected_gid = sys.argv[1:]
expected_uid, expected_gid = int(expected_uid), int(expected_gid)
value = os.lstat(path)
if not stat.S_ISDIR(value.st_mode) or value.st_uid != expected_uid or value.st_gid != expected_gid or stat.S_IMODE(value.st_mode) != 0o700:
    raise SystemExit(1)
if filesystem_root and value.st_dev != os.lstat(filesystem_root).st_dev:
    raise SystemExit(1)
' "$path" "$same_filesystem_root" "$expected_uid" "$expected_gid"
}

# systemctl cat is the authority for the active service's EnvironmentFile
# directives. Values are consumed only by checks below and never printed.
service_env_files() {
  local unit="${1:-ran-agent-node.service}"
  "${SUDO[@]}" systemctl cat "$unit" 2>/dev/null \
    | sed -n 's/^[[:space:]]*EnvironmentFile=-\?\([^[:space:]]*\).*$/\1/p' \
    | while IFS= read -r file; do "${SUDO[@]}" test -r "$file" && printf '%s\n' "$file"; done
}

service_env_has_nonempty_key() {
  local key="$1" file found=1
  while IFS= read -r file; do
    if "${SUDO[@]}" awk -F= -v key="$key" '$1 == key && length(substr($0, length(key) + 2)) > 0 { ok=1 } END { exit !ok }' "$file"; then
      found=0
    fi
  done < <(service_env_files)
  return "$found"
}

service_env_value() {
  local key="$1" file value=''
  while IFS= read -r file; do
    value="$("${SUDO[@]}" awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$file")"
    [[ -z "$value" ]] || { printf '%s' "$value"; return 0; }
  done < <(service_env_files)
  return 1
}

require_service_environment() {
  local files
  files="$(service_env_files)"
  [[ -n "$files" ]] || fail service_env_source_unavailable
  service_env_has_nonempty_key RAN_AGENT_INTERNAL_CONTROL_SECRET || fail RAN_AGENT_INTERNAL_CONTROL_SECRET_required
}

candidate_stage_preflight() {
  local mode="$1" identity_map=''
  stage_run test -x "$STAGE_DIR/scripts/hermes-release-candidate-preflight.mjs" || fail candidate_preflight_missing
  stage_run env "$NODE_BIN" "$STAGE_DIR/scripts/hermes-release-candidate-preflight.mjs" --module-only >/dev/null \
    || fail candidate_preflight_incompatible
  [[ "$mode" == owner ]] || return 0
  identity_map="$(service_env_value RAN_AGENT_IDENTITY_MAP_PATH || true)"
  if [[ -n "$identity_map" ]]; then
    stage_run env RAN_AGENT_IDENTITY_MAP_PATH="$identity_map" "$NODE_BIN" "$STAGE_DIR/scripts/hermes-release-candidate-preflight.mjs" --owner-binding >/dev/null \
      || fail owner_binding_required
  else
    stage_run env "$NODE_BIN" "$STAGE_DIR/scripts/hermes-release-candidate-preflight.mjs" --owner-binding >/dev/null \
      || fail owner_binding_required
  fi
}

runtime_checkout_access() {
  local root="${1:-$REPO_ROOT}" mode="${2:-modules}" runuser_bin=/usr/sbin/runuser
  case "$mode" in files|modules) ;; *) fail runtime_access_mode_invalid ;; esac
  "${SUDO[@]}" test -x "$runuser_bin" || fail runtime_access_runuser_unavailable
  "${SUDO[@]}" "$runuser_bin" --user ran-agent --group ran-agent -- /usr/bin/env -i \
    PATH=/usr/bin:/bin "$NODE_BIN" --input-type=module -e '
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
for (const path of [root, `${root}/node_bridge`, `${root}/node_bridge/src`, `${root}/node_bridge/src/index.mjs`, `${root}/node_bridge/vendor/weixin-agent-sdk/dist/index.mjs`]) {
  accessSync(path, constants.R_OK);
}
if (process.argv[2] !== "modules") process.exit(0);
await import(pathToFileURL(`${root}/node_bridge/src/webStructuredExtract.mjs`));
await import(pathToFileURL(`${root}/node_bridge/src/index.mjs`));
const require = createRequire(`${root}/package.json`);
for (const name of ["playwright-core", "undici", "qrcode-terminal", "silk-wasm"]) {
  await import(pathToFileURL(require.resolve(name)));
}
' "$root" "$mode" >/dev/null || {
    [[ "$mode" == files ]] && fail runtime_checkout_access_invalid
    fail runtime_checkout_dependencies_invalid
  }
}

require_atomic_state() {
  # A root atomic probe would rename a root-owned file into live runtime state.
  # State creation and writes stay with the service user after the transaction.
  "${SUDO[@]}" test -d "$STATE_DIR" || fail state_dir_unavailable
}

require_plan_prerequisites() {
  require_node_sqlite
  local probe
  probe="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-release-plan.XXXXXX")" || fail candidate_plan_unavailable
  trap 'rm -rf "$probe"' RETURN
  git -C "$REPO_ROOT" archive --format=tar "$CANDIDATE" | tar -xf - -C "$probe" || fail candidate_plan_archive_failed
  [[ -f "$probe/node_bridge/package.json" && -f "$probe/src/personal_agent/service.py" ]] || fail candidate_plan_incomplete
  find "$probe" -type l -print -quit | grep -q . && fail candidate_plan_symlink
  STAGE_DIR="$probe"
  STAGE_USE_SUDO=0
  protected_manifest_digest "$probe" >/dev/null || fail candidate_protected_manifest_unavailable
  candidate_stage_preflight module
  if [[ "$REPO_ROOT" == "$SERVER_ROOT" ]]; then
    require_service_environment
    candidate_stage_preflight owner
  fi
  rm -rf "$probe"
  STAGE_DIR=''
  STAGE_USE_SUDO=1
  trap - RETURN
}

require_apply_prerequisites() {
  [[ "$REPO_ROOT" == "$SERVER_ROOT" ]] || fail server_root_required
  [[ "$EUID" -ne 0 ]] || fail checkout_operator_root_forbidden
  require_ombre_ingress_dropin_absent
  require_python_runtime
  require_candidate_bootstrap_authority
  project_checkout_permissions repair
  PRODUCTION_HEAD="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" || fail current_head_unavailable
  git -C "$REPO_ROOT" diff --quiet || fail worktree_dirty
  git -C "$REPO_ROOT" diff --cached --quiet || fail index_dirty
  [[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]] || fail worktree_untracked
  require_node_sqlite
  require_ombre_patch_python_runtime
  CANONICAL_LIVE_STATE_DIR="$("${SUDO[@]}" sh -c 'cd "$1" && pwd -P' sh "$CANONICAL_LIVE_STATE_DIR")" ||
    fail state_dir_unavailable
  STATE_DIR="$CANONICAL_LIVE_STATE_DIR"
  require_artifact_layout
  require_service_environment
  require_atomic_state
  runtime_checkout_access "$REPO_ROOT" files
}

require_candidate_bootstrap_authority() {
  local bootstrap_root="${RAN_AGENT_RELEASE_BOOTSTRAP_ROOT:-}"
  [[ -n "$bootstrap_root" && "$bootstrap_root" == "$SCRIPT_ROOT" && "$bootstrap_root" != "$REPO_ROOT" &&
    "$bootstrap_root" == "${TMPDIR:-/tmp}"/ran-agent-release-bootstrap.* ]] || fail candidate_bootstrap_required
  git -C "$REPO_ROOT" show "$CANDIDATE:docs/governance/hermes_release_bootstrap.v1.sha256" |
    cmp -s - "$bootstrap_root/manifest" || fail candidate_bootstrap_required
  "$PYTHON_BIN" -I -c '
import hashlib, os, stat, sys
root = os.path.realpath(sys.argv[1])
expected = set(sys.argv[2:])
value = os.lstat(root)
if value.st_uid != os.geteuid() or stat.S_IMODE(value.st_mode) != 0o700 or os.path.lexists(os.path.join(root, ".git")):
    raise SystemExit(1)
actual = set()
for directory, names, files in os.walk(root, followlinks=False):
    for name in names + files:
        path = os.path.join(directory, name)
        if stat.S_ISLNK(os.lstat(path).st_mode):
            raise SystemExit(1)
    for name in files:
        actual.add(os.path.relpath(os.path.join(directory, name), root))
if actual != expected | {"manifest"}:
    raise SystemExit(1)
entries = {}
for line in open(os.path.join(root, "manifest"), encoding="utf-8"):
    digest, path = line.rstrip("\n").split("  ", 1)
    if path in entries or len(digest) != 64:
        raise SystemExit(1)
    entries[path] = digest
if set(entries) != expected:
    raise SystemExit(1)
for path, digest in entries.items():
    target = os.path.join(root, path)
    if hashlib.sha256(open(target, "rb").read()).hexdigest() != digest:
        raise SystemExit(1)
' "$bootstrap_root" \
    scripts/bootstrap-hermes-release.sh \
    scripts/deploy-hermes-release.sh \
    scripts/resolve-hermes-service-node.sh \
    scripts/prune-hermes-release-artifacts.sh \
    scripts/check-hermes-snapshot-capacity.py \
    scripts/ombre_o1_contract.py || fail candidate_bootstrap_required
}

prune_release_artifacts() {
  local cleanup_root="${1:-$SCRIPT_ROOT}"
  "${SUDO[@]}" env RAN_AGENT_RELEASE_ARTIFACT_ROOT="$ARTIFACT_ROOT" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
    RAN_AGENT_RELEASE_TRANSACTION_CONTEXT=1 \
    bash "$cleanup_root/scripts/prune-hermes-release-artifacts.sh" --apply-under-transaction
}

candidate_stage_reserve() {
  local archive_bytes tree_usage
  archive_bytes="$(git -C "$REPO_ROOT" archive --format=tar "$CANDIDATE" | wc -c | tr -d '[:space:]')" ||
    fail candidate_size_unavailable
  tree_usage="$(git -C "$REPO_ROOT" ls-tree -rl "$CANDIDATE" | "$PYTHON_BIN" -I -c '
import sys

blob_bytes = 0
files = 0
directories = set()
for line in sys.stdin:
    metadata, path = line.rstrip("\n").split("\t", 1)
    mode, kind, _, size = metadata.split()
    if kind != "blob":
        continue
    blob_bytes += int(size)
    files += 1
    parts = path.split("/")[:-1]
    directories.update("/".join(parts[:index]) for index in range(1, len(parts) + 1))
print(blob_bytes, files + len(directories) + 1)
')" || fail candidate_size_unavailable
  local tree_bytes tree_inodes
  read -r tree_bytes tree_inodes <<<"$tree_usage"
  [[ "$archive_bytes" =~ ^[0-9]+$ && "$tree_bytes" =~ ^[0-9]+$ && "$tree_inodes" =~ ^[0-9]+$ ]] ||
    fail candidate_size_invalid
  # Callers combine one tar plus extracted trees into per-filesystem budgets;
  # per-entry blocks cover tiny files.
  printf '%s\t%s\t%s\n' "$archive_bytes" "$tree_bytes" "$tree_inodes"
}

# The gate copy and the node_modules projection live on the /tmp filesystem,
# outside the artifact store; budget that filesystem before creating large
# copies so a full disk stops the transaction before, not during, a copy.
require_gate_copy_capacity() {
  local mode="$1" helper_root="$2" tree_bytes="${3:-0}" tree_inodes="${4:-0}"
  local output status check_root helper
  case "$mode" in estimate|measured) ;; *) fail gate_copy_capacity_mode_invalid ;; esac
  check_root="$(cd /tmp && pwd -P)" || fail gate_copy_capacity_probe_failed
  helper="$helper_root/scripts/check-hermes-snapshot-capacity.py"
  [[ -x /usr/bin/python3 ]] || fail snapshot_capacity_python_unavailable
  "${SUDO[@]}" test -f "$helper" || fail snapshot_capacity_probe_missing
  local -a arguments=(--artifact-root "$check_root")
  if [[ "$mode" == estimate ]]; then
    # The live checkout's node_modules approximates the coming projection;
    # the candidate tree copy is fixed from the verified archive shape.
    arguments+=(--source "$REPO_ROOT/node_modules" --fixed-bytes "$((tree_bytes + tree_inodes * 4096))" --fixed-inodes "$((tree_inodes + 1))")
  else
    arguments+=(--source "$STAGE_DIR/node_modules")
  fi
  if output="$("${SUDO[@]}" /usr/bin/python3 -I "$helper" "${arguments[@]}")"; then
    printf 'deploy-hermes-release: gate-copy-capacity %s\n' "$output"
    return 0
  else
    status=$?
  fi
  [[ -z "$output" ]] || printf 'deploy-hermes-release: gate-copy-capacity %s\n' "$output" >&2
  [[ "$status" -ne 3 ]] || fail gate_copy_capacity_insufficient
  fail gate_copy_capacity_probe_failed
}

require_ombre_ingress_dropin_absent() {
  if "${SUDO[@]}" test -e "$OMBRE_INGRESS_DROPIN" || "${SUDO[@]}" test -L "$OMBRE_INGRESS_DROPIN"; then
    fail ombre_ingress_dropin_residue
  fi
}

# Compare the actual production commit to the candidate.  Never use
# candidate^: a candidate can be rebased or skip commits before release.
report_release_delta() {
  DELTA_FILE="$ARCHIVE_ROOT/release-delta.${PRODUCTION_HEAD}..${CANDIDATE}.txt"
  {
    printf 'production=%s\ncandidate=%s\n' "$PRODUCTION_HEAD" "$CANDIDATE"
    printf '\n[dependency-config-systemd-database-paths]\n'
    git -C "$REPO_ROOT" diff --name-status "$PRODUCTION_HEAD" "$CANDIDATE" -- \
      package.json package-lock.json npm-shrinkwrap.json pyproject.toml poetry.lock requirements.txt requirements \
      node_bridge/package.json node_bridge/package-lock.json hermes/profile scripts src/personal_agent data migrations \
      .env.example node_bridge/.env.example
  } | "${SUDO[@]}" tee "$DELTA_FILE" >/dev/null || fail release_delta_failed
  "${SUDO[@]}" chmod 600 "$DELTA_FILE"
}

stage_candidate() {
  STAGE_DIR="$("${SUDO[@]}" mktemp -d "$STAGE_ROOT/release-stage.${CANDIDATE:0:12}.XXXXXX")" || fail candidate_stage_unavailable
  "${SUDO[@]}" chmod 700 "$STAGE_DIR"
  CANDIDATE_ARCHIVE="$ARCHIVE_ROOT/release-candidate.${CANDIDATE}.tar"
  git -C "$REPO_ROOT" archive --format=tar "$CANDIDATE" | "${SUDO[@]}" tee "$CANDIDATE_ARCHIVE" >/dev/null || fail candidate_stage_failed
  "${SUDO[@]}" chmod 600 "$CANDIDATE_ARCHIVE"
  "${SUDO[@]}" tar -xf "$CANDIDATE_ARCHIVE" -C "$STAGE_DIR" || fail candidate_stage_failed
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/apply-hermes-runtime-split.sh" || fail candidate_stage_incomplete
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/verify-hermes-release.sh" || fail candidate_stage_incomplete
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/hermes-release-candidate-preflight.mjs" || fail candidate_stage_incomplete
  [[ "$MODE" == --rollback ]] || "${SUDO[@]}" test -f "$STAGE_DIR/scripts/check-hermes-snapshot-capacity.py" || fail candidate_stage_incomplete
  for helper in prune-hermes-release-artifacts.sh ombre_o1_contract.py install-ombre-steward-token.py verify-ran-agent-runtime-identity.sh apply_ombre_steward_patch.py; do
    "${SUDO[@]}" test -f "$STAGE_DIR/scripts/$helper" || fail candidate_stage_incomplete
  done
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/verify-ombre-steward-real-process.sh" || fail candidate_stage_incomplete
  "${SUDO[@]}" test -f "$STAGE_DIR/node_bridge/tests/ombreCompatPatchedProcess.test.mjs" || fail candidate_stage_incomplete
  local digest
  digest="$("${SUDO[@]}" sha256sum "$CANDIDATE_ARCHIVE" | awk '{ print $1 }')" || fail candidate_stage_digest_unavailable
  printf '%s %s\n' "$CANDIDATE" "$digest" | "${SUDO[@]}" tee "$STAGE_DIR/candidate" >/dev/null
  "${SUDO[@]}" chmod 444 "$STAGE_DIR/candidate"
  "${SUDO[@]}" chmod -R a-w "$STAGE_DIR"
  # The immutable candidate contains no secrets and acceptance executes its
  # probes as ran-agent; keep the root-owned stage readable but never writable.
  "${SUDO[@]}" chmod 755 "$STAGE_DIR"
}

verify_stage_candidate() {
  local expected_candidate expected_digest actual_digest
  read -r expected_candidate expected_digest < <("${SUDO[@]}" cat "$STAGE_DIR/candidate") || fail candidate_stage_manifest_invalid
  actual_digest="$("${SUDO[@]}" sha256sum "$CANDIDATE_ARCHIVE" | awk '{ print $1 }')" || fail candidate_stage_digest_unavailable
  [[ "$expected_candidate" == "$CANDIDATE" && "$expected_digest" == "$actual_digest" ]] || fail candidate_stage_digest_mismatch
}

# The artifact store stays root-private (0700), so the ran-agent acceptance
# identity cannot traverse into the immutable stage.  Both acceptance gates
# therefore execute an identical root-owned, read-only copy of the verified
# candidate placed under a traversable parent.  The copy contains only git
# archive payload (no secrets), carries the verified candidate manifest, and
# is removed by cleanup_pretransaction_artifacts on every outcome.
stage_gate_copy() {
  GATE_DIR="$("${SUDO[@]}" mktemp -d /tmp/ran-agent-release-runtime-gate.XXXXXX)" ||
    fail candidate_gate_copy_unavailable
  "${SUDO[@]}" tar -xf "$CANDIDATE_ARCHIVE" -C "$GATE_DIR" || fail candidate_gate_copy_failed
  "${SUDO[@]}" cp "$STAGE_DIR/candidate" "$GATE_DIR/candidate" || fail candidate_gate_copy_failed
  if "${SUDO[@]}" find -P "$GATE_DIR" -type l -print -quit | grep -q .; then
    fail candidate_gate_copy_symlink
  fi
  "${SUDO[@]}" chmod -R a=rX "$GATE_DIR" || fail candidate_gate_copy_failed
  "${SUDO[@]}" test -x "$GATE_DIR/scripts/hermes-release-gate.sh" || fail candidate_gate_copy_incomplete
  "${SUDO[@]}" diff -r "$STAGE_DIR" "$GATE_DIR" >/dev/null || fail candidate_gate_copy_mismatch
}

# Gates execute the same read-only copy as root and as the ran-agent runtime
# identity before any snapshot, checkout, service, or runtime mutation.
run_candidate_gates() {
  [[ -n "$GATE_DIR" && -d "$GATE_DIR" ]] || fail candidate_gate_copy_missing
  # Prove the traversable read-only contract with the real acceptance identity
  # before spending the expensive root gate.
  "${SUDO[@]}" /usr/sbin/runuser --user ran-agent --group ran-agent -- \
    /usr/bin/test -r "$GATE_DIR/scripts/hermes-release-gate.sh" ||
    fail candidate_gate_copy_unreadable
  if "${SUDO[@]}" /usr/sbin/runuser --user ran-agent --group ran-agent -- \
    /usr/bin/test -w "$GATE_DIR/scripts/hermes-release-gate.sh"; then
    fail candidate_gate_copy_writable
  fi
  "${SUDO[@]}" env RAN_AGENT_RELEASE_SOURCE_ROOT="$GATE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_NODE_BIN="$NODE_BIN" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" RAN_AGENT_OMBRE_REAL_PROCESS_GATE_PHASE=code-only RAN_AGENT_GATE_SKIP_PRIVILEGED_TESTS=0 bash "$GATE_DIR/scripts/hermes-release-gate.sh" --all
  "${SUDO[@]}" bash "$STAGE_DIR/scripts/verify-ran-agent-runtime-identity.sh" --verify-account || fail steward_identity_conflict
  "${SUDO[@]}" /usr/sbin/runuser --user ran-agent --group ran-agent -- /usr/bin/env -i \
    PATH=/usr/bin:/bin HOME=/nonexistent \
    RAN_AGENT_RELEASE_SOURCE_ROOT="$GATE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 \
    RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_NODE_BIN="$NODE_BIN" \
    RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" RAN_AGENT_OMBRE_REAL_PROCESS_GATE_PHASE=code-only \
    RAN_AGENT_GATE_SKIP_PRIVILEGED_TESTS=1 \
    bash "$GATE_DIR/scripts/hermes-release-gate.sh" --all
}

# Staged node_modules stay in the root-private store for same-filesystem
# activation; the pre-mutation ran-agent loadability probe runs against a
# read-only projection in the traversable gate copy.
project_gate_copy_node_modules() {
  [[ -n "$GATE_DIR" && -d "$GATE_DIR" ]] || fail candidate_gate_copy_missing
  "${SUDO[@]}" cp -a "$STAGE_DIR/node_modules" "$GATE_DIR/node_modules" ||
    fail candidate_gate_modules_projection_failed
  "${SUDO[@]}" chmod -R a-w,go+rX "$GATE_DIR/node_modules" ||
    fail candidate_gate_modules_projection_failed
}

prepare_candidate_node_dependencies() {
  local node_dir npm_bin npm_cli cache
  node_dir="$(dirname "$NODE_BIN")"
  npm_bin="$node_dir/npm"
  npm_cli="$node_dir/../lib/node_modules/npm/bin/npm-cli.js"
  cache="$STAGE_DIR/.npm-cache"
  stage_run test -f "$STAGE_DIR/package.json" || fail candidate_node_manifest_missing
  stage_run test -f "$STAGE_DIR/package-lock.json" || fail candidate_node_lock_missing
  stage_run chmod u+w "$STAGE_DIR" || fail candidate_node_stage_unavailable
  if stage_run test -x "$npm_bin"; then
    stage_run /usr/bin/env HOME=/nonexistent PATH="$node_dir:/usr/bin:/bin" \
      npm_config_cache="$cache" npm_config_audit=false npm_config_engine_strict=true npm_config_fund=false npm_config_update_notifier=false \
      "$npm_bin" ci --omit=dev --ignore-scripts --prefix "$STAGE_DIR" >/dev/null || fail candidate_node_install_failed
  elif stage_run test -f "$npm_cli"; then
    stage_run /usr/bin/env HOME=/nonexistent PATH="$node_dir:/usr/bin:/bin" \
      npm_config_cache="$cache" npm_config_audit=false npm_config_engine_strict=true npm_config_fund=false npm_config_update_notifier=false \
      "$NODE_BIN" "$npm_cli" ci --omit=dev --ignore-scripts --prefix "$STAGE_DIR" >/dev/null || fail candidate_node_install_failed
  else
    fail node_service_npm_unavailable
  fi
  stage_run rm -rf -- "$cache"
  stage_run test -d "$STAGE_DIR/node_modules" || fail candidate_node_install_incomplete
  stage_run chmod -R a-w "$STAGE_DIR"
  stage_run chmod 755 "$STAGE_DIR"
}

protected_manifest_digest() {
  local root manifest
  root="$1"
  manifest="$root/docs/governance/hermes_protected_capabilities.v1.json"
  if ! stage_run test -f "$manifest"; then printf 'absent\n'; return 0; fi
  if command -v sha256sum >/dev/null 2>&1; then
    stage_run sha256sum "$manifest" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    stage_run shasum -a 256 "$manifest" | awk '{ print $1 }'
  else
    return 1
  fi
}

record_protected_capability_evidence() {
  local phase="$1" active staged=not_applicable
  [[ -n "$SNAPSHOT_DIR" ]] || return 0
  active="$(protected_manifest_digest "$REPO_ROOT")" || return 1
  [[ -z "$STAGE_DIR" ]] || staged="$(protected_manifest_digest "$STAGE_DIR")" || return 1
  printf 'phase=%s candidate=%s active_manifest_sha256=%s staged_manifest_sha256=%s\n' "$phase" "${CANDIDATE:0:12}" "$active" "$staged" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/protected-capabilities.evidence" >/dev/null
  "${SUDO[@]}" chmod 600 "$SNAPSHOT_DIR/protected-capabilities.evidence"
}

snapshot_path() {
  local path="$1" index="$2" kind="${3:-present}"
  local target="$SNAPSHOT_DIR/files/$index" temporary="$SNAPSHOT_DIR/files/.${index}.incomplete"
  [[ "$kind" == present || "$kind" == migration-present ]] || fail snapshot_kind_invalid
  if "${SUDO[@]}" test -e "$path" || "${SUDO[@]}" test -L "$path"; then
    if ! "${SUDO[@]}" cp -a -- "$path" "$temporary" || ! "${SUDO[@]}" mv -- "$temporary" "$target"; then
      "${SUDO[@]}" rm -rf -- "$temporary"
      return 1
    fi
    printf '%s\t%s\t%s\n' "$kind" "$index" "$path" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
  else
    [[ "$kind" == present ]] || return 1
    printf 'absent\t%s\t%s\n' "$index" "$path" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
  fi
}

service_load_state() {
  local unit="$1" load_state
  load_state="$("${SUDO[@]}" systemctl show "$unit" --property=LoadState --value 2>/dev/null)" || return 1
  [[ -n "$load_state" ]] || return 1
  printf '%s' "$load_state"
}

optional_runtime_unit() {
  case "$1" in
    ran-agent-ombre-brain.service|ran-agent-ombre-recall.service|ran-agent-xhs-browse.service|ran-agent-xhs-public-sidecar.service) return 0 ;;
    *) return 1 ;;
  esac
}

optional_unit_absent() {
  printf 'deploy-hermes-release: optional unit absent; %s skipped unit=%s\n' "${2:-restore}" "$1" >&2
}

snapshot_service_state() {
  local unit="$1" active enabled load_state
  load_state="$(service_load_state "$unit")" || fail service_load_state_unavailable
  if "${SUDO[@]}" systemctl is-active --quiet "$unit"; then active=active; else active=inactive; fi
  enabled="$("${SUDO[@]}" systemctl is-enabled "$unit" 2>/dev/null || true)"
  printf '%s\t%s\t%s\t%s\n' "$unit" "$active" "$enabled" "$load_state" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/services" >/dev/null
}

snapshot_code_revision() {
  git -C "$REPO_ROOT" rev-parse --verify HEAD | "${SUDO[@]}" tee "$SNAPSHOT_DIR/prior-head" >/dev/null || fail prior_code_revision_unavailable
  git -C "$REPO_ROOT" symbolic-ref -q HEAD | "${SUDO[@]}" tee "$SNAPSHOT_DIR/prior-ref" >/dev/null || true
}

snapshot_runtime_paths() {
  {
    printf '%s\n' \
      "$FULL_HOME/config.yaml" "$FULL_HOME/.env" "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml" "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
      "$LITE_HOME/config.yaml" "$LITE_HOME/.env" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/.env" \
      "$FULL_HOME/plugins/model-providers/deepseek" "$LITE_HOME/plugins/model-providers/deepseek" \
      "$SYSTEMD_DIR/ran-agent-hermes.service" "$SYSTEMD_DIR/ran-agent-hermes-full.service" "$SYSTEMD_DIR/ran-agent-node.service" "$SYSTEMD_DIR/ran-agent-python.service" \
      "$SYSTEMD_DIR/ran-agent-ombre-brain.service" "$SYSTEMD_DIR/ran-agent-ombre-recall.service" "$SYSTEMD_DIR/ran-agent-xhs-browse.service" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service" \
      "$SYSTEMD_DIR/ran-agent-hermes.service.d" "$SYSTEMD_DIR/ran-agent-hermes-full.service.d" "$SYSTEMD_DIR/ran-agent-node.service.d" "$SYSTEMD_DIR/ran-agent-python.service.d" \
      "$SYSTEMD_DIR/ran-agent-ombre-brain.service.d" "$SYSTEMD_DIR/ran-agent-ombre-recall.service.d" "$SYSTEMD_DIR/ran-agent-xhs-browse.service.d" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service.d" \
      "$FULL_HOME/profiles/$FULL_PROFILE/IDENTITY.md" "$FULL_HOME/profiles/$FULL_PROFILE/SOUL.md" "$FULL_HOME/profiles/$FULL_PROFILE/AGENTS.md" \
      "$LITE_HOME/profiles/$LITE_PROFILE/IDENTITY.md" "$LITE_HOME/profiles/$LITE_PROFILE/SOUL.md" "$LITE_HOME/profiles/$LITE_PROFILE/AGENTS.md"
    for unit in "${ALL_RUNTIME_UNITS[@]}"; do service_env_files "$unit"; done
  } | sort -u
}

snapshot_capacity_gate() {
  local helper_root="${1:-$STAGE_DIR}" fixed_bytes="${2:-0}" fixed_inodes="${3:-0}" output status path
  local helper="$helper_root/scripts/check-hermes-snapshot-capacity.py"
  local -a arguments=(--artifact-root "$ARTIFACT_ROOT" --source "$STATE_DIR" --source "$REPO_ROOT/data" --migration-root "$REPO_ROOT/data" --fixed-bytes "$fixed_bytes" --fixed-inodes "$fixed_inodes")
  [[ -x /usr/bin/python3 ]] || fail snapshot_capacity_python_unavailable
  "${SUDO[@]}" test -f "$helper" || fail snapshot_capacity_probe_missing
  while IFS= read -r path; do arguments+=(--source "$path"); done < <(snapshot_runtime_paths)
  if output="$("${SUDO[@]}" /usr/bin/python3 -I "$helper" "${arguments[@]}")"; then
    printf 'deploy-hermes-release: snapshot-capacity %s\n' "$output"
    return 0
  else
    status=$?
  fi
  [[ -z "$output" ]] || printf 'deploy-hermes-release: snapshot-capacity %s\n' "$output" >&2
  [[ "$status" -ne 3 ]] || fail snapshot_capacity_insufficient
  fail snapshot_capacity_probe_failed
}

snapshot_runtime_state() {
  SNAPSHOT_DIR="$("${SUDO[@]}" mktemp -d "$SNAPSHOT_ROOT/.release-incomplete.${CANDIDATE:0:12}.XXXXXX")" || fail snapshot_create_failed
  SNAPSHOT_BUILD_ACTIVE=1
  SNAPSHOT_TRANSACTION_ID="release-transaction.${CANDIDATE:0:12}.${SNAPSHOT_DIR##*.}"
  SNAPSHOT_FINAL_DIR="$SNAPSHOT_ROOT/$SNAPSHOT_TRANSACTION_ID"
  "${SUDO[@]}" chmod 700 "$SNAPSHOT_DIR"
  "${SUDO[@]}" mkdir -p "$SNAPSHOT_DIR/files"
  printf '%s\n' "$CANDIDATE" | "${SUDO[@]}" tee "$SNAPSHOT_DIR/candidate" >/dev/null
  snapshot_code_revision
  [[ -z "$DELTA_FILE" ]] || "${SUDO[@]}" cp -a -- "$DELTA_FILE" "$SNAPSHOT_DIR/deployment-delta"
  local -a paths=()
  local index=0 path unit
  while IFS= read -r path; do paths+=("$path"); done < <(snapshot_runtime_paths)
  for path in "${paths[@]}"; do snapshot_path "$path" "$index"; index=$((index + 1)); done
  for unit in "${SERVICE_TRANSACTION_UNITS[@]}"; do snapshot_service_state "$unit"; done
  write_transaction_state snapshot-created false
  "${SUDO[@]}" "$PYTHON_BIN" -I -c '
import os, sys
source, target = sys.argv[1:]
os.rename(source, target)
directory = os.open(os.path.dirname(target), os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
' "$SNAPSHOT_DIR" "$SNAPSHOT_FINAL_DIR" || fail snapshot_publish_failed
  SNAPSHOT_DIR="$SNAPSHOT_FINAL_DIR"
  verify_in_progress_snapshot "$SNAPSHOT_DIR" || fail snapshot_authority_invalid
  TRANSACTION_STARTED=1
  SNAPSHOT_BUILD_ACTIVE=0
}

write_transaction_state() {
  local requested_status="$1" rollbackable="${2:-false}" completed_marker="${3:-}"
  local status acceptance_state rollback_state completed_at transaction_id base_sha manifest_digest service_state_digest production_identity
  case "$requested_status" in
    snapshot-created) status=in_progress; acceptance_state=not_accepted; rollback_state=not_used ;;
    accepted) status=accepted; acceptance_state=accepted; rollback_state=not_used ;;
    rollback-in-progress) status=rollback_in_progress; acceptance_state=not_accepted; rollback_state=in_progress ;;
    rollback-incomplete) status=rollback_failed; acceptance_state=not_accepted; rollback_state=rollback_failed ;;
    rolled-back) status=rollback_used; acceptance_state=not_accepted; rollback_state=rollback_used ;;
    *) fail transaction_state_status_invalid ;;
  esac
  transaction_id="${SNAPSHOT_TRANSACTION_ID:-$(basename "$SNAPSHOT_DIR")}"
  base_sha="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-head")"
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || fail transaction_state_base_invalid
  manifest_digest="$("${SUDO[@]}" sha256sum "$SNAPSHOT_DIR/manifest" | awk '{print $1}')"
  service_state_digest="$("${SUDO[@]}" sha256sum "$SNAPSHOT_DIR/services" | awk '{print $1}')"
  production_identity=unknown
  if "${SUDO[@]}" test -s "$CURRENT_PRODUCTION_POINTER"; then
    production_identity="$("${SUDO[@]}" "$PYTHON_BIN" -c 'import json,sys; print("transaction:"+json.load(open(sys.argv[1], encoding="utf-8"))["transaction_id"])' "$CURRENT_PRODUCTION_POINTER" 2>/dev/null || printf unknown)"
  fi
  [[ "$status" != accepted ]] || production_identity="transaction:$transaction_id"
  completed_at=''
  [[ -z "$completed_marker" ]] || completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  "${SUDO[@]}" env \
    TX_TARGET="$SNAPSHOT_DIR/transaction-state.json" \
    TX_ID="$transaction_id" TX_CANDIDATE="$CANDIDATE" TX_BASE="$base_sha" \
    TX_STATUS="$status" TX_ACCEPTANCE="$acceptance_state" TX_ROLLBACK="$rollback_state" \
    TX_ROLLBACKABLE="$rollbackable" TX_PRODUCTION="$production_identity" \
    TX_COMPLETED="$completed_at" TX_MANIFEST="$manifest_digest" TX_SERVICES="$service_state_digest" \
    "$PYTHON_BIN" -c '
import json, os, tempfile
from pathlib import Path
target = Path(os.environ["TX_TARGET"])
value = {
  "schema_version": 1,
  "transaction_id": os.environ["TX_ID"],
  "candidate_sha": os.environ["TX_CANDIDATE"],
  "base_sha": os.environ["TX_BASE"],
  "status": os.environ["TX_STATUS"],
  "acceptance_state": os.environ["TX_ACCEPTANCE"],
  "rollback_state": os.environ["TX_ROLLBACK"],
  "rollbackable": os.environ["TX_ROLLBACKABLE"] == "true",
  "current_production_identity": os.environ["TX_PRODUCTION"],
  "completed_at": os.environ["TX_COMPLETED"],
  "manifest_digest": os.environ["TX_MANIFEST"],
  "service_state_digest": os.environ["TX_SERVICES"],
}
descriptor, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
directory = os.open(target.parent, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
'
}

mark_snapshot_accepted() {
  write_transaction_state accepted true "$(date -u +%s)"
  local transaction_id
  transaction_id="$(basename "$SNAPSHOT_DIR")"
  "${SUDO[@]}" env TX_POINTER="$CURRENT_PRODUCTION_POINTER" TX_ID="$transaction_id" TX_CANDIDATE="$CANDIDATE" \
    "$PYTHON_BIN" -c '
import json, os, tempfile
from pathlib import Path
target = Path(os.environ["TX_POINTER"])
descriptor, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"schema_version": 1, "transaction_id": os.environ["TX_ID"], "candidate_sha": os.environ["TX_CANDIDATE"]}, handle, sort_keys=True)
        handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, target)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
directory = os.open(target.parent, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
'
}

classify_snapshot() {
  local directory="$1" current_transaction='' production_transaction="$RETENTION_PRODUCTION_TRANSACTION"
  local contract_root="${STAGE_DIR:-$SCRIPT_ROOT}"
  [[ "$TRANSACTION_STARTED" -eq 1 && -n "$SNAPSHOT_DIR" ]] && current_transaction="$(basename "$SNAPSHOT_DIR")"
  "${SUDO[@]}" "$PYTHON_BIN" "$contract_root/scripts/ombre_o1_contract.py" classify-snapshot \
    "$directory" --current-transaction "$current_transaction" \
    --production-transaction "$production_transaction" --format tsv
}

prune_accepted_snapshots() {
  local directory decision reason completed index=0 retained_slots=0
  local contract_root="${STAGE_DIR:-$SCRIPT_ROOT}"
  local -a eligible=()
  if "${SUDO[@]}" test -e "$CURRENT_PRODUCTION_POINTER"; then
    RETENTION_PRODUCTION_TRANSACTION="$("${SUDO[@]}" "$PYTHON_BIN" \
      "$contract_root/scripts/ombre_o1_contract.py" read-production-pointer \
      "$CURRENT_PRODUCTION_POINTER" --format transaction-id 2>/dev/null)" || {
        printf 'deploy-hermes-release: retention=SKIP_UNCERTAIN snapshot=%s reason=production-pointer-invalid\n' "$SNAPSHOT_ROOT" >&2
        return 0
      }
  else
    printf 'deploy-hermes-release: retention=SKIP_UNCERTAIN snapshot=%s reason=production-pointer-missing\n' "$SNAPSHOT_ROOT" >&2
    return 0
  fi
  while IFS= read -r directory; do
    IFS=$'\t' read -r decision reason completed < <(classify_snapshot "$directory")
    if [[ "$decision" == ELIGIBLE ]]; then
      eligible+=("$completed"$'\t'"$directory")
    else
      printf 'deploy-hermes-release: retention=%s snapshot=%s reason=%s\n' "$decision" "$directory" "$reason"
      [[ "$decision" == KEEP && "$reason" == current_production_rollback_point ]] && retained_slots=1
    fi
  done < <("${SUDO[@]}" find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)

  while IFS=$'\t' read -r completed directory; do
    [[ -n "$directory" ]] || continue
    if (( index < SUCCESSFUL_SNAPSHOT_RETENTION - retained_slots )); then
      printf 'deploy-hermes-release: retention=KEEP snapshot=%s reason=recent-accepted-rollbackable\n' "$directory"
    else
      printf 'deploy-hermes-release: retention=DELETE snapshot=%s reason=older-accepted-rollbackable\n' "$directory"
      [[ "$directory" == "$SNAPSHOT_ROOT"/release-transaction.* ]] || {
        printf 'deploy-hermes-release: retention=SKIP_UNCERTAIN snapshot=%s reason=path-invalid\n' "$directory" >&2
        index=$((index + 1))
        continue
      }
      "${SUDO[@]}" rm -rf -- "$directory" ||
        printf 'deploy-hermes-release: retention-warning snapshot=%s reason=delete-failed\n' "$directory" >&2
    fi
    index=$((index + 1))
  done < <(printf '%s\n' "${eligible[@]}" | sort -r)
}

quiesce_runtime_services() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 0
  local unit active enabled snapshot_load_state current_load_state
  while IFS=$'\t' read -r unit active enabled snapshot_load_state; do
    [[ "$active" == active ]] || continue
    if [[ "$snapshot_load_state" == not-found ]]; then
      optional_runtime_unit "$unit" && { optional_unit_absent "$unit" quiesce; continue; }
      return 1
    fi
    if [[ -z "$snapshot_load_state" ]]; then
      current_load_state="$(service_load_state "$unit")" || return 1
      if [[ "$current_load_state" == not-found ]]; then
        optional_runtime_unit "$unit" && { optional_unit_absent "$unit" quiesce; continue; }
        return 1
      fi
    fi
    "${SUDO[@]}" systemctl stop "$unit" || return 1
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/services")
}

# Node uses JSON/JSONL durable files under state. Steward secrets are never
# copied into the ordinary retained snapshot.
snapshot_node_durable_state() {
  local target="$SNAPSHOT_DIR/files/900" temporary="$SNAPSHOT_DIR/files/.900.incomplete"
  "${SUDO[@]}" mkdir "$temporary"
  if ! "${SUDO[@]}" tar -C "$STATE_DIR" \
    --exclude='./ombre-compat/secrets' \
    --exclude='./ombre-compat/secrets/*' \
    -cpf - . | "${SUDO[@]}" tar -C "$temporary" -xpf -; then
    "${SUDO[@]}" rm -rf -- "$temporary"
    return 1
  fi
  if "${SUDO[@]}" find "$temporary" -path '*/ombre-compat/secrets*' -print -quit | grep -q .; then
    "${SUDO[@]}" rm -rf -- "$temporary"
    fail steward_secret_entered_snapshot
  fi
  if ! "${SUDO[@]}" mv -- "$temporary" "$target"; then
    "${SUDO[@]}" rm -rf -- "$temporary"
    return 1
  fi
  printf 'present\t900\t%s\n' "$STATE_DIR" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
}

snapshot_state_migrations() {
  local path index=1000
  # Directory-level snapshot also removes a database first created by a failed
  # candidate; individual files retain explicit SQLite/WAL evidence in manifest.
  snapshot_path "$REPO_ROOT/data" 901
  "${SUDO[@]}" test -d "$REPO_ROOT/data" || return 0
  while IFS= read -r -d '' path; do
    snapshot_path "$path" "$index" migration-present
    index=$((index + 1))
  done < <("${SUDO[@]}" find "$REPO_ROOT/data" -type f \( -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.db' -o -name '*.db-*' \) -print0)
}

block_ombre_ingress() {
  "${SUDO[@]}" install -d -m 755 "$(dirname "$OMBRE_INGRESS_DROPIN")"
  printf '%s\n' '[Service]' 'Environment=OMBRE_COMPAT_ENABLED=false' |
    "${SUDO[@]}" tee "$OMBRE_INGRESS_DROPIN" >/dev/null
  "${SUDO[@]}" chmod 644 "$OMBRE_INGRESS_DROPIN"
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl stop ran-agent-node.service
  OMBRE_INGRESS_BLOCKED=1
}

restore_ombre_ingress() {
  clear_ombre_ingress_block
  "${SUDO[@]}" systemctl restart ran-agent-node.service
  "${SUDO[@]}" systemctl is-active --quiet ran-agent-node.service
}

clear_ombre_ingress_block() {
  "${SUDO[@]}" rm -f -- "$OMBRE_INGRESS_DROPIN"
  "${SUDO[@]}" systemctl daemon-reload
  OMBRE_INGRESS_BLOCKED=0
}

verify_restored_steward_service() {
  local unit="$1" pid_before pid_after token_path process_env
  "${SUDO[@]}" bash "$STAGE_DIR/scripts/verify-ran-agent-runtime-identity.sh" \
    --verify-process "$unit" || return 1
  pid_before="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" || return 1
  [[ "$pid_before" =~ ^[1-9][0-9]*$ ]] || return 1
  process_env="$("${SUDO[@]}" cat "/proc/$pid_before/environ" 2>/dev/null | tr '\0' '\n')" || return 1
  pid_after="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" || return 1
  [[ "$pid_after" == "$pid_before" ]] || return 1
  token_path="$STATE_DIR/ombre-compat/secrets/steward-api-token"
  grep -qxF "RAN_AGENT_STEWARD_TOKEN_FILE=$token_path" <<<"$process_env"
}

backup_steward_token() {
  SECRET_ROLLBACK_DIR="$("${SUDO[@]}" mktemp -d "$SECRET_ROLLBACK_ROOT/steward-token.XXXXXX")" ||
    fail secret_rollback_create_failed
  "${SUDO[@]}" chmod 700 "$SECRET_ROLLBACK_DIR"
  STEWARD_TOKEN_HAD_PRIOR=0
  if "${SUDO[@]}" "$PYTHON_BIN" "$STAGE_DIR/scripts/install-ombre-steward-token.py" \
    --state-dir "$STATE_DIR" --backup-to "$SECRET_ROLLBACK_DIR"; then
    STEWARD_TOKEN_HAD_PRIOR=1
  else
    local code=$?
    [[ "$code" -eq 2 ]] || fail steward_token_backup_failed
  fi
  STEWARD_TOKEN_RESTORED=0
}

restore_steward_token() {
  if [[ -z "$SECRET_ROLLBACK_DIR" ]]; then
    STEWARD_TOKEN_RESTORED=1
    return 0
  fi
  if [[ "$STEWARD_TOKEN_HAD_PRIOR" -eq 1 ]]; then
    "${SUDO[@]}" "$PYTHON_BIN" "$STAGE_DIR/scripts/install-ombre-steward-token.py" \
      --state-dir "$STATE_DIR" --restore-from "$SECRET_ROLLBACK_DIR" || return 1
  else
    "${SUDO[@]}" rm -f -- "$STATE_DIR/ombre-compat/secrets/steward-api-token" || return 1
  fi
  STEWARD_TOKEN_RESTORED=1
}

destroy_secret_rollback() {
  [[ -n "$SECRET_ROLLBACK_DIR" ]] || return 0
  "${SUDO[@]}" "$PYTHON_BIN" "$STAGE_DIR/scripts/install-ombre-steward-token.py" \
    --state-dir "$STATE_DIR" --destroy-rollback "$SECRET_ROLLBACK_DIR" || return 1
  SECRET_ROLLBACK_DIR=''
  ! "${SUDO[@]}" find "$SECRET_ROLLBACK_ROOT" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

project_checkout_permissions() {
  local mode="$1" repo_gid
  local -a permission_runner=("$PYTHON_BIN")
  case "$mode" in repair|verify) ;; *) fail checkout_permission_mode_invalid ;; esac
  repo_gid="$("$PYTHON_BIN" -I -c 'import os,sys; print(os.lstat(sys.argv[1]).st_gid)' "$REPO_ROOT")" ||
    fail checkout_permission_contract
  if [[ "$mode" == repair ]]; then
    if [[ "${#SUDO[@]}" -eq 0 ]]; then permission_runner=(/usr/bin/python3)
    else permission_runner=("${SUDO[@]}" /usr/bin/python3)
    fi
  fi
  git -C "$REPO_ROOT" ls-files --stage -z |
    "${permission_runner[@]}" -I -c '
import os, stat, sys

root = os.path.realpath(sys.argv[1])
operation = sys.argv[2]
expected = (int(sys.argv[3]), int(sys.argv[4]))
root_value = os.lstat(root)
if not stat.S_ISDIR(root_value.st_mode) or root_value.st_uid == 0 or (root_value.st_uid, root_value.st_gid) != expected:
    raise SystemExit(1)
directories = {root}
files = []
for record in sys.stdin.buffer.read().split(b"\0"):
    if not record:
        continue
    metadata, encoded = record.split(b"\t", 1)
    git_mode, _, stage = metadata.split()
    if stage != b"0" or git_mode not in (b"100644", b"100755"):
        raise SystemExit(1)
    target = os.path.abspath(os.path.join(root, os.fsdecode(encoded)))
    if os.path.commonpath((root, target)) != root:
        raise SystemExit(1)
    value = os.lstat(target)
    owner = (value.st_uid, value.st_gid)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or (owner != expected and not (operation == "repair" and value.st_uid == 0)):
        raise SystemExit(1)
    files.append((target, 0o755 if git_mode == b"100755" else 0o644))
    parent = os.path.dirname(target)
    while parent != root:
        directories.add(parent)
        parent = os.path.dirname(parent)
for directory in directories:
    value = os.lstat(directory)
    owner = (value.st_uid, value.st_gid)
    if not stat.S_ISDIR(value.st_mode) or (owner != expected and not (operation == "repair" and value.st_uid == 0)):
        raise SystemExit(1)
if operation == "repair":
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    root_fd = os.open(root, os.O_RDONLY | nofollow | directory_flag)
    def open_beneath(path, is_directory):
        relative = os.path.relpath(path, root)
        descriptor = os.dup(root_fd)
        if relative == ".":
            return descriptor
        try:
            parts = relative.split(os.sep)
            for index, part in enumerate(parts):
                flags = os.O_RDONLY | nofollow
                if index < len(parts) - 1 or is_directory:
                    flags |= directory_flag
                next_descriptor = os.open(part, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = next_descriptor
            return descriptor
        except Exception:
            os.close(descriptor)
            raise
    try:
        for path, expected_mode, is_directory in [
            *((path, 0o755, True) for path in sorted(directories, key=lambda item: (len(item.split(os.sep)), item))),
            *((path, mode, False) for path, mode in files),
        ]:
            descriptor = open_beneath(path, is_directory)
            try:
                value = os.fstat(descriptor)
                valid_type = stat.S_ISDIR(value.st_mode) if is_directory else stat.S_ISREG(value.st_mode) and value.st_nlink == 1
                if not valid_type or ((value.st_uid, value.st_gid) != expected and value.st_uid != 0):
                    raise SystemExit(1)
                os.fchmod(descriptor, expected_mode)
                if value.st_uid == 0:
                    os.fchown(descriptor, *expected)
                value = os.fstat(descriptor)
                if (value.st_uid, value.st_gid) != expected or stat.S_IMODE(value.st_mode) != expected_mode:
                    raise SystemExit(1)
            finally:
                os.close(descriptor)
    finally:
        os.close(root_fd)
elif operation == "verify":
    if any(stat.S_IMODE(os.lstat(directory).st_mode) != 0o755 for directory in directories):
        raise SystemExit(1)
    if any(stat.S_IMODE(os.lstat(target).st_mode) != expected for target, expected in files):
        raise SystemExit(1)
' "$REPO_ROOT" "$mode" "$EUID" "$repo_gid" || fail checkout_permission_contract
}

activate_candidate_checkout() {
  (umask 022; git -C "$REPO_ROOT" checkout --detach "$CANDIDATE" >/dev/null 2>&1) || fail candidate_checkout_failed
  [[ "$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" == "$CANDIDATE" ]] || fail candidate_checkout_mismatch
  project_checkout_permissions repair
  project_checkout_permissions verify
}

activate_candidate_node_dependencies() {
  local candidate_modules="$STAGE_DIR/node_modules" live_modules="$REPO_ROOT/node_modules"
  NODE_MODULES_ROLLBACK="$SNAPSHOT_DIR/node_modules.rollback"
  NODE_MODULES_ABSENT_MARKER="$SNAPSHOT_DIR/node-modules.absent"
  "${SUDO[@]}" test -d "$candidate_modules" || fail candidate_node_install_incomplete
  "${SUDO[@]}" "$PYTHON_BIN" -I -c '
import os, sys
values = [os.lstat(path).st_dev for path in sys.argv[1:]]
raise SystemExit(0 if len(set(values)) == 1 else 1)
' "$candidate_modules" "$REPO_ROOT" "$SNAPSHOT_DIR" || fail node_modules_filesystem_mismatch
  if "${SUDO[@]}" test -L "$live_modules" || { "${SUDO[@]}" test -e "$live_modules" && ! "${SUDO[@]}" test -d "$live_modules"; }; then
    fail node_modules_type_invalid
  fi
  if "${SUDO[@]}" test -d "$live_modules"; then
    "${SUDO[@]}" mv -- "$live_modules" "$NODE_MODULES_ROLLBACK" || fail node_modules_backup_failed
  else
    "${SUDO[@]}" touch "$NODE_MODULES_ABSENT_MARKER" || fail node_modules_backup_failed
    "${SUDO[@]}" chmod 600 "$NODE_MODULES_ABSENT_MARKER"
  fi
  if ! "${SUDO[@]}" mv -- "$candidate_modules" "$live_modules"; then
    restore_node_dependencies || fail node_modules_restore_failed
    fail node_modules_activate_failed
  fi
  if ! "${SUDO[@]}" chown -R --reference="$REPO_ROOT" "$live_modules" ||
    ! "${SUDO[@]}" chmod -R u+rwX,go+rX "$live_modules"; then
    restore_node_dependencies || fail node_modules_restore_failed
    fail node_modules_projection_failed
  fi
}

restore_node_dependencies() {
  local live_modules="$REPO_ROOT/node_modules"
  [[ -n "$NODE_MODULES_ROLLBACK" ]] || NODE_MODULES_ROLLBACK="$SNAPSHOT_DIR/node_modules.rollback"
  [[ -n "$NODE_MODULES_ABSENT_MARKER" ]] || NODE_MODULES_ABSENT_MARKER="$SNAPSHOT_DIR/node-modules.absent"
  if "${SUDO[@]}" test -d "$NODE_MODULES_ROLLBACK"; then
    "${SUDO[@]}" rm -rf -- "$live_modules" && "${SUDO[@]}" mv -- "$NODE_MODULES_ROLLBACK" "$live_modules"
  elif "${SUDO[@]}" test -f "$NODE_MODULES_ABSENT_MARKER"; then
    "${SUDO[@]}" rm -rf -- "$live_modules" && "${SUDO[@]}" rm -f -- "$NODE_MODULES_ABSENT_MARKER"
  else
    return 0
  fi
}

restore_code_revision() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -s "$SNAPSHOT_DIR/prior-head" || return 1
  local prior_head prior_ref current_ref
  prior_head="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-head")"
  prior_ref="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-ref" 2>/dev/null || true)"
  git -C "$REPO_ROOT" cat-file -e "${prior_head}^{commit}" || return 1
  if [[ "$prior_ref" == refs/heads/* ]]; then
    current_ref="$(git -C "$REPO_ROOT" rev-parse --verify "$prior_ref" 2>/dev/null || true)"
    [[ "$current_ref" == "$prior_head" ]] || return 1
  fi
  (umask 022; git -C "$REPO_ROOT" checkout --detach "$prior_head" >/dev/null 2>&1) || return 1
  [[ "$prior_ref" != refs/heads/* ]] || (umask 022; git -C "$REPO_ROOT" checkout "${prior_ref#refs/heads/}" >/dev/null 2>&1) || return 1
  project_checkout_permissions repair || return 1
  project_checkout_permissions verify
}

restore_runtime_files() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || return 1
  local kind index path failed=0
  while IFS=$'\t' read -r kind index path; do
    [[ "$kind" == present || "$kind" == absent ]] || continue
    if [[ "$kind" == present ]]; then
      if ! "${SUDO[@]}" rm -rf -- "$path" ||
        ! "${SUDO[@]}" mkdir -p "$(dirname "$path")" ||
        ! "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"; then
        printf 'deploy-hermes-release: rollback-stage=runtime-file result=failed path=%s\n' "$path" >&2
        failed=1
      fi
    else
      "${SUDO[@]}" rm -rf -- "$path" || failed=1
    fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
  return "$failed"
}

restore_state_migrations() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || return 1
  local kind index path failed=0
  while IFS=$'\t' read -r kind index path; do
    [[ "$kind" == migration-present ]] || continue
    if ! "${SUDO[@]}" rm -f -- "$path" ||
      ! "${SUDO[@]}" mkdir -p "$(dirname "$path")" ||
      ! "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"; then
      printf 'deploy-hermes-release: rollback-stage=state-file result=failed path=%s\n' "$path" >&2
      failed=1
    fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
  return "$failed"
}

restore_service_state() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 1
  [[ "$STEWARD_TOKEN_RESTORED" -eq 1 ]] || {
    printf 'deploy-hermes-release: rollback-stage=service result=blocked reason=steward-token-not-restored\n' >&2
    return 1
  }
  local failed=0
  "${SUDO[@]}" systemctl daemon-reload || failed=1
  local unit active enabled snapshot_load_state current_load_state unit_failed
  while IFS=$'\t' read -r unit active enabled snapshot_load_state; do
    unit_failed=0
    if [[ "$snapshot_load_state" == not-found ]]; then
      optional_runtime_unit "$unit" && { optional_unit_absent "$unit"; continue; }
      unit_failed=1
    else
      current_load_state="$(service_load_state "$unit")" || unit_failed=1
      if [[ "$unit_failed" -eq 0 && "$current_load_state" == not-found ]]; then
        optional_runtime_unit "$unit" && { optional_unit_absent "$unit"; continue; }
        unit_failed=1
      fi
    fi
    if [[ "$unit_failed" -eq 0 && "$enabled" == masked ]]; then
      "${SUDO[@]}" systemctl stop "$unit" || unit_failed=1
      "${SUDO[@]}" systemctl mask "$unit" >/dev/null || unit_failed=1
    elif [[ "$unit_failed" -eq 0 ]]; then
      "${SUDO[@]}" systemctl unmask "$unit" >/dev/null 2>&1 || unit_failed=1
      if [[ "$unit_failed" -eq 0 ]]; then
        case "$enabled" in
          enabled) "${SUDO[@]}" systemctl enable "$unit" >/dev/null || unit_failed=1 ;;
          enabled-runtime) "${SUDO[@]}" systemctl enable --runtime "$unit" >/dev/null || unit_failed=1 ;;
          disabled) "${SUDO[@]}" systemctl disable "$unit" >/dev/null || unit_failed=1 ;;
        esac
      fi
      if [[ "$unit_failed" -eq 0 ]]; then
        if [[ "$active" == active ]]; then
          "${SUDO[@]}" systemctl restart "$unit" || unit_failed=1
          if [[ "$unit_failed" -eq 0 && "$STEWARD_ROTATION_ACTIVE" -eq 1 && "$STEWARD_TOKEN_HAD_PRIOR" -eq 1 && "$unit" == ran-agent-ombre-brain.service ]]; then
            verify_restored_steward_service "$unit" || unit_failed=1
          fi
          if [[ "$unit_failed" -eq 0 && "$STEWARD_ROTATION_ACTIVE" -eq 1 && "$STEWARD_TOKEN_HAD_PRIOR" -eq 1 && "$unit" == ran-agent-ombre-brain.service ]]; then
            "${SUDO[@]}" "$PYTHON_BIN" "$STAGE_DIR/scripts/verify-ombre-steward-runtime.py" \
              --state-dir "$STATE_DIR" \
              --identity-file "$STATE_DIR/ombre-brain/steward-identity.v1.json" >/dev/null ||
              unit_failed=1
          fi
          if [[ "$unit_failed" -eq 0 && "$STEWARD_ROTATION_ACTIVE" -eq 1 && "$STEWARD_TOKEN_HAD_PRIOR" -eq 1 && "$unit" == ran-agent-node.service ]]; then
            verify_restored_steward_service "$unit" || unit_failed=1
          fi
        else
          "${SUDO[@]}" systemctl stop "$unit" || unit_failed=1
        fi
      fi
    fi
    if [[ "$unit_failed" -ne 0 ]]; then
      printf 'deploy-hermes-release: rollback-stage=service result=failed unit=%s\n' "$unit" >&2
      failed=1
    fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/services")
  return "$failed"
}

rollback_transaction() {
  local deployment_status="$1" rollback_failed=0
  trap - EXIT INT TERM
  trap 'rollback_failed=1' INT TERM
  set +e
  if [[ "$TRANSACTION_STARTED" -eq 1 ]]; then
    if [[ "$EXPLICIT_ROLLBACK" -eq 0 ]]; then
      write_transaction_state rollback-in-progress false || rollback_failed=1
    fi
    local stage
    for stage in quiesce_runtime_services restore_runtime_files restore_state_migrations restore_steward_token restore_node_dependencies restore_code_revision block_ombre_ingress clear_ombre_ingress_block restore_service_state; do
      if "$stage"; then
        printf 'deploy-hermes-release: rollback-stage=%s result=ok\n' "$stage" >&2
      else
        printf 'deploy-hermes-release: rollback-stage=%s result=failed\n' "$stage" >&2
        rollback_failed=1
      fi
    done
    if destroy_secret_rollback; then
      printf 'deploy-hermes-release: rollback-stage=secret-cleanup result=ok\n' >&2
    else
      printf 'deploy-hermes-release: rollback-stage=secret-cleanup result=failed\n' >&2
      rollback_failed=1
    fi
    if record_protected_capability_evidence rollback; then
      printf 'deploy-hermes-release: rollback-stage=evidence result=ok\n' >&2
    else
      printf 'deploy-hermes-release: rollback-stage=evidence result=failed\n' >&2
      rollback_failed=1
    fi
    if [[ "$rollback_failed" -ne 0 ]]; then
      if [[ "$EXPLICIT_ROLLBACK" -eq 0 ]]; then write_transaction_state rollback-incomplete false || :; fi
      printf 'deploy-hermes-release: rollback-incomplete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
      stop_release_transaction_lock
      exit 70
    fi
    write_transaction_state rolled-back false "$(date -u +%s)" || {
      printf 'deploy-hermes-release: rollback-incomplete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
      stop_release_transaction_lock
      exit 70
    }
    if ! clear_current_production_pointer "$EXPLICIT_ROLLBACK"; then
      printf 'deploy-hermes-release: rollback-incomplete deployment_status=%s candidate=%s snapshot=%s reason=production-pointer-finalization\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
      stop_release_transaction_lock
      exit 70
    fi
    cleanup_root="${STAGE_DIR:-$SCRIPT_ROOT}"
    if "${SUDO[@]}" env RAN_AGENT_RELEASE_ARTIFACT_ROOT="$ARTIFACT_ROOT" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
      RAN_AGENT_RELEASE_TRANSACTION_CONTEXT=1 \
      bash "$cleanup_root/scripts/prune-hermes-release-artifacts.sh" --apply-under-transaction >&2; then
      printf 'deploy-hermes-release: rollback-stage=artifact-payload-cleanup result=ok\n' >&2
    else
      printf 'deploy-hermes-release: rollback-stage=artifact-payload-cleanup result=warning\n' >&2
    fi
    cleanup_pretransaction_artifacts
    printf 'deploy-hermes-release: rollback-complete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
  fi
  stop_release_transaction_lock
  exit "$deployment_status"
}

load_rollback_snapshot() {
  local decision reason completed production_transaction production_candidate
  SNAPSHOT_DIR="$1"
  [[ "$(dirname "$SNAPSHOT_DIR")" == "$SNAPSHOT_ROOT" && -d "$SNAPSHOT_DIR" ]] || fail rollback_snapshot_invalid
  "${SUDO[@]}" test ! -L "$SNAPSHOT_ROOT" && "${SUDO[@]}" test ! -L "$SNAPSHOT_DIR" && \
    "${SUDO[@]}" test -d "$SNAPSHOT_DIR/files" && "${SUDO[@]}" test ! -L "$SNAPSHOT_DIR/files" ||
    fail rollback_snapshot_not_eligible
  "${SUDO[@]}" test -f "$CURRENT_PRODUCTION_POINTER" && "${SUDO[@]}" test ! -L "$CURRENT_PRODUCTION_POINTER" ||
    fail production_pointer_invalid
  IFS=$'\t' read -r production_transaction production_candidate < <(
    "${SUDO[@]}" "$PYTHON_BIN" "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" read-production-pointer \
      "$CURRENT_PRODUCTION_POINTER" --format tsv 2>/dev/null
  ) || fail production_pointer_invalid
  [[ "$(basename "$SNAPSHOT_DIR")" == "$production_transaction" ]] || fail rollback_snapshot_not_current_production
  IFS=$'\t' read -r decision reason completed < <(
    "${SUDO[@]}" "$PYTHON_BIN" "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" classify-snapshot \
      "$SNAPSHOT_DIR" --format tsv
  ) || fail rollback_snapshot_not_eligible
  if [[ "$decision" == PRUNE_PAYLOAD && "$reason" == verified_completed_rollback_used ]]; then
    ROLLBACK_METADATA_FINALIZE=1
  else
    [[ "$decision" == ELIGIBLE ]] || fail rollback_snapshot_not_eligible
  fi
  "${SUDO[@]}" test -s "$SNAPSHOT_DIR/prior-head" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || fail rollback_manifest_invalid
  CANDIDATE="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/candidate" 2>/dev/null)" || fail rollback_candidate_unreadable
  [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail rollback_candidate_invalid
  [[ "$CANDIDATE" == "$production_candidate" ]] || fail rollback_candidate_not_current_production
}

clear_current_production_pointer() {
  local strict="${1:-1}" production_transaction production_candidate contract_root="${STAGE_DIR:-$SCRIPT_ROOT}"
  if ! "${SUDO[@]}" test -e "$CURRENT_PRODUCTION_POINTER"; then
    [[ "$strict" -eq 0 ]]
    return
  fi
  "${SUDO[@]}" test -f "$CURRENT_PRODUCTION_POINTER" && "${SUDO[@]}" test ! -L "$CURRENT_PRODUCTION_POINTER" || return 1
  IFS=$'\t' read -r production_transaction production_candidate < <(
    "${SUDO[@]}" "$PYTHON_BIN" "$contract_root/scripts/ombre_o1_contract.py" read-production-pointer \
      "$CURRENT_PRODUCTION_POINTER" --format tsv 2>/dev/null
  ) || return 1
  if [[ "$production_transaction" != "$(basename "$SNAPSHOT_DIR")" || "$production_candidate" != "$CANDIDATE" ]]; then
    [[ "$strict" -eq 0 ]]
    return
  fi
  "${SUDO[@]}" "$PYTHON_BIN" -I -c '
import os, pathlib, sys
target = pathlib.Path(sys.argv[1])
target.unlink()
directory = os.open(target.parent, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
' "$CURRENT_PRODUCTION_POINTER"
}

explicit_rollback() {
  [[ "$REPO_ROOT" == "$SERVER_ROOT" ]] || fail server_root_required
  [[ "$EUID" -ne 0 ]] || fail checkout_operator_root_forbidden
  [[ "$CONTROLLER_CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail rollback_controller_candidate_invalid
  git -C "$REPO_ROOT" cat-file -e "${CONTROLLER_CANDIDATE}^{commit}" 2>/dev/null || fail candidate_object_missing
  require_python_runtime
  CANONICAL_LIVE_STATE_DIR="$("${SUDO[@]}" sh -c 'cd "$1" && pwd -P' sh "$CANONICAL_LIVE_STATE_DIR")" ||
    fail state_dir_unavailable
  STATE_DIR="$CANONICAL_LIVE_STATE_DIR"
  require_artifact_layout
  load_rollback_snapshot "$2"
  [[ "$CONTROLLER_CANDIDATE" == "$CANDIDATE" ]] || fail rollback_controller_candidate_mismatch
  require_candidate_bootstrap_authority
  if [[ "$ROLLBACK_METADATA_FINALIZE" -eq 1 ]]; then
    clear_current_production_pointer 1 || fail rollback_pointer_finalization_failed
    if ! "${SUDO[@]}" env RAN_AGENT_RELEASE_ARTIFACT_ROOT="$ARTIFACT_ROOT" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
      RAN_AGENT_RELEASE_TRANSACTION_CONTEXT=1 \
      bash "$SCRIPT_ROOT/scripts/prune-hermes-release-artifacts.sh" --apply-under-transaction >&2; then
      printf 'deploy-hermes-release: rollback-stage=artifact-payload-cleanup result=warning\n' >&2
    fi
    stop_release_transaction_lock
    printf 'deploy-hermes-release: rollback-complete candidate=%s snapshot=%s metadata-finalized=1\n' "$CANDIDATE" "$SNAPSHOT_DIR"
    return 0
  fi
  stage_candidate
  verify_stage_candidate
  project_checkout_permissions repair
  "${SUDO[@]}" bash "$STAGE_DIR/scripts/verify-ran-agent-runtime-identity.sh" --verify-account ||
    fail steward_identity_conflict
  backup_steward_token
  EXPLICIT_ROLLBACK=1
  TRANSACTION_STARTED=1
  trap 'exit 130' INT
  trap 'exit 143' TERM
  rollback_transaction 0
}

if [[ "$MODE" == --rollback ]]; then explicit_rollback "$@"; exit 0; fi
if [[ "$MODE" == --dry-run ]]; then require_plan_prerequisites; printf 'deploy-hermes-release: dry-run-ok candidate=%s plan=server-local-transaction-redacted\n' "$CANDIDATE"; exit 0; fi

require_apply_prerequisites
prune_release_artifacts "$SCRIPT_ROOT"
PRE_STAGE_RESERVE="$(candidate_stage_reserve)" || fail candidate_size_unavailable
IFS=$'\t' read -r PRE_STAGE_ARCHIVE_BYTES PRE_STAGE_TREE_BYTES PRE_STAGE_TREE_INODES <<<"$PRE_STAGE_RESERVE"
PRE_STAGE_RESERVE_BYTES=$((PRE_STAGE_ARCHIVE_BYTES + PRE_STAGE_TREE_BYTES + PRE_STAGE_TREE_INODES * 4096))
PRE_STAGE_RESERVE_INODES=$((PRE_STAGE_TREE_INODES + 1))
snapshot_capacity_gate "$SCRIPT_ROOT" "$PRE_STAGE_RESERVE_BYTES" "$PRE_STAGE_RESERVE_INODES"
require_gate_copy_capacity estimate "$SCRIPT_ROOT" "$PRE_STAGE_TREE_BYTES" "$PRE_STAGE_TREE_INODES"
report_release_delta
stage_candidate
verify_stage_candidate
candidate_stage_preflight owner
stage_gate_copy
# Gates run on the traversable read-only copy before any checkout/config/runtime mutation.
run_candidate_gates
prepare_candidate_node_dependencies
require_gate_copy_capacity measured "$STAGE_DIR"
project_gate_copy_node_modules
runtime_checkout_access "$GATE_DIR" modules
snapshot_capacity_gate "$STAGE_DIR" 0 0
snapshot_runtime_state
record_protected_capability_evidence before || fail protected_capability_evidence_before
trap 'exit 130' INT
trap 'exit 143' TERM
"${SUDO[@]}" bash "$STAGE_DIR/scripts/verify-ran-agent-runtime-identity.sh" --ensure-account
block_ombre_ingress
quiesce_runtime_services
snapshot_node_durable_state
snapshot_state_migrations
write_transaction_state snapshot-created false
verify_in_progress_snapshot "$SNAPSHOT_DIR" || fail snapshot_authority_invalid
backup_steward_token
STEWARD_ROTATION_ACTIVE=1
activate_candidate_checkout
activate_candidate_node_dependencies
runtime_checkout_access "$REPO_ROOT" modules
"${SUDO[@]}" env RAN_AGENT_RELEASE_PRESERVE_RUNTIME_SHAPE=1 RAN_AGENT_NODE_BIN="$NODE_BIN" RAN_AGENT_DEPLOY_HERMES_MODEL="$DEPLOY_MODEL" RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED="$DEPLOY_OMBRE_COMPAT_ENABLED" RAN_AGENT_DEPLOY_OMBRE_COMPAT_STATE_DIR="$CANONICAL_LIVE_STATE_DIR/ombre-compat" RAN_AGENT_DEPLOY_OMBRE_COMPAT_STEWARD_ENDPOINT=http://127.0.0.1:18001/internal/ran-agent/steward/v1 RAN_AGENT_DEPLOY_OMBRE_COMPAT_STEWARD_IDENTITY_FILE="$CANONICAL_LIVE_STATE_DIR/ombre-brain/steward-identity.v1.json" RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL="$DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL" RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_MODEL="$DEPLOY_OMBRE_COMPAT_CURATOR_MODEL" RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL="$DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL" RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL="$DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL" RAN_AGENT_REPO_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 RAN_AGENT_DEPLOY_STATE_DIR="$CANONICAL_LIVE_STATE_DIR" RAN_AGENT_STATE_DIR="$CANONICAL_LIVE_STATE_DIR" RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME="$CANONICAL_LIVE_STATE_DIR/ombre-brain" RAN_AGENT_OMBRE_PATCH_PYTHON_BIN="$OMBRE_PATCH_PYTHON_BIN" RAN_AGENT_ROTATE_STEWARD_TOKEN=1 RAN_AGENT_STEWARD_ROTATION_QUIESCED=1 bash "$STAGE_DIR/scripts/apply-hermes-runtime-split.sh" --preserve-runtime-shape
project_checkout_permissions verify
restore_ombre_ingress
OLD_STEWARD_TOKEN_FILE=''
[[ "$STEWARD_TOKEN_HAD_PRIOR" -ne 1 ]] || OLD_STEWARD_TOKEN_FILE="$SECRET_ROLLBACK_DIR/steward-api-token.rollback"
"${SUDO[@]}" env RAN_AGENT_EXPECTED_HERMES_MODEL="$DEPLOY_MODEL" RAN_AGENT_EXPECTED_OMBRE_COMPAT_ENABLED="$DEPLOY_OMBRE_COMPAT_ENABLED" RAN_AGENT_EXPECTED_OMBRE_COMPAT_CURATOR_BASE_URL="$DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL" RAN_AGENT_EXPECTED_OMBRE_COMPAT_CURATOR_MODEL="$DEPLOY_OMBRE_COMPAT_CURATOR_MODEL" RAN_AGENT_EXPECTED_OMBRE_COMPAT_REVIEWER_BASE_URL="$DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL" RAN_AGENT_EXPECTED_OMBRE_COMPAT_REVIEWER_MODEL="$DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL" RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 RAN_AGENT_RELEASE_CONTROL_ROOT="$REPO_ROOT" RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_RELEASE_PREMUTATION_GATE=1 RAN_AGENT_NODE_BIN="$NODE_BIN" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" RAN_AGENT_STATE_DIR="$CANONICAL_LIVE_STATE_DIR" OMBRE_BRAIN_HOME="$CANONICAL_LIVE_STATE_DIR/ombre-brain" RAN_AGENT_RELEASE_SNAPSHOT_DIR="$SNAPSHOT_DIR" RAN_AGENT_RELEASE_SECRET_ROLLBACK_ROOT="$SECRET_ROLLBACK_ROOT" RAN_AGENT_RELEASE_SECRET_ROLLBACK_DIR="$SECRET_ROLLBACK_DIR" RAN_AGENT_STEWARD_OLD_TOKEN_FILE="$OLD_STEWARD_TOKEN_FILE" bash "$STAGE_DIR/scripts/verify-hermes-release.sh" --release
record_protected_capability_evidence after || fail protected_capability_evidence_after
destroy_secret_rollback || fail secret_rollback_cleanup_failed
mark_snapshot_accepted
TRANSACTION_ACCEPTED=1
TRANSACTION_STARTED=0
prune_accepted_snapshots
if ! prune_release_artifacts "$STAGE_DIR" >&2; then
  printf 'deploy-hermes-release: accepted artifact cleanup warning candidate=%s\n' "$CANDIDATE" >&2
fi
cleanup_pretransaction_artifacts
trap - EXIT INT TERM
stop_release_transaction_lock
printf 'deploy-hermes-release: apply-ok candidate=%s model=%s snapshot=%s\n' "$CANDIDATE" "$DEPLOY_MODEL" "$SNAPSHOT_DIR"
