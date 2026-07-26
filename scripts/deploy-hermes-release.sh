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

if [[ -n "${RAN_AGENT_NODE_BIN:-}" ]]; then
  NODE_BIN="$(RAN_AGENT_NODE_BIN="$RAN_AGENT_NODE_BIN" bash "$SCRIPT_ROOT/scripts/resolve-hermes-service-node.sh")" || fail node_service_path_unavailable
else
  NODE_BIN="$("${SUDO[@]}" env RAN_AGENT_SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-}" bash "$SCRIPT_ROOT/scripts/resolve-hermes-service-node.sh")" || fail node_service_path_unavailable
fi
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-$REPO_ROOT/.venv/bin/python}"
STATE_DIR="${RAN_AGENT_RELEASE_STATE_DIR:-$REPO_ROOT/.ran_agent_state}"
# Kept outside STATE_DIR: snapshots must never archive their own transaction.
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
SNAPSHOT_ROOT="$ARTIFACT_ROOT/snapshots"
SUCCESSFUL_SNAPSHOT_RETENTION=2
CURRENT_PRODUCTION_POINTER="$SNAPSHOT_ROOT/current-production.json"
STAGE_ROOT="$ARTIFACT_ROOT/stages"
ARCHIVE_ROOT="$ARTIFACT_ROOT/archives"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
FULL_PROFILE="${HERMES_FULL_PROFILE:-ran-assistant}"
LITE_PROFILE="${HERMES_LITE_PROFILE:-ran-assistant-lite}"
CORE_RUNTIME_UNITS=(ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service)
ALL_RUNTIME_UNITS=("${CORE_RUNTIME_UNITS[@]}" ran-agent-ombre-brain.service ran-agent-ombre-recall.service ran-agent-xhs-browse.service ran-agent-xhs-public-sidecar.service)
SNAPSHOT_DIR=''
STAGE_DIR=''
CANDIDATE_ARCHIVE=''
PRODUCTION_HEAD=''
DELTA_FILE=''
TRANSACTION_STARTED=0
RETENTION_PRODUCTION_TRANSACTION=''

[[ "$MODE" == --rollback ]] || {
  CANDIDATE="${RAN_AGENT_RELEASE_CANDIDATE:-}"
  [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid
  git -C "$REPO_ROOT" cat-file -e "${CANDIDATE}^{commit}" 2>/dev/null || fail candidate_object_missing
}

require_node_sqlite() {
  [[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || fail node_binary_required
  local version major minor patch
  version="$($NODE_BIN -p 'process.versions.node' 2>/dev/null)" || fail node_version_probe
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || fail node_version_invalid
  (( major > 22 || (major == 22 && minor >= 13) )) || fail node_version_unsupported
  "$NODE_BIN" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1); db.close();' >/dev/null 2>&1 || fail node_sqlite_unavailable
}

require_python_runtime() {
  [[ "$PYTHON_BIN" == /* && -x "$PYTHON_BIN" ]] || fail python_runtime_required
  "$PYTHON_BIN" -I -c 'import sqlite3; import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1 || fail python_runtime_invalid
}

inside_path() {
  local child="$1" parent="$2"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

require_artifact_layout() {
  [[ "$ARTIFACT_ROOT" == /* && "$STATE_DIR" == /* ]] || fail artifact_root_absolute_required
  ! inside_path "$ARTIFACT_ROOT" "$REPO_ROOT" || fail artifact_root_inside_repo
  ! inside_path "$ARTIFACT_ROOT" "$STATE_DIR" || fail artifact_root_inside_state_dir
  ! inside_path "$STATE_DIR" "$ARTIFACT_ROOT" || fail state_dir_inside_artifact_root
  "${SUDO[@]}" install -d -m 700 "$SNAPSHOT_ROOT" "$STAGE_ROOT" "$ARCHIVE_ROOT" || fail artifact_root_unavailable
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
  PRODUCTION_HEAD="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" || fail current_head_unavailable
  git -C "$REPO_ROOT" diff --quiet || fail worktree_dirty
  git -C "$REPO_ROOT" diff --cached --quiet || fail index_dirty
  [[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]] || fail worktree_untracked
  require_node_sqlite
  require_python_runtime
  require_artifact_layout
  require_service_environment
  require_atomic_state
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
  local digest
  digest="$("${SUDO[@]}" sha256sum "$CANDIDATE_ARCHIVE" | awk '{ print $1 }')" || fail candidate_stage_digest_unavailable
  printf '%s %s\n' "$CANDIDATE" "$digest" | "${SUDO[@]}" tee "$STAGE_DIR/candidate" >/dev/null
  "${SUDO[@]}" chmod 600 "$STAGE_DIR/candidate"
  "${SUDO[@]}" chmod -R a-w "$STAGE_DIR"
}

verify_stage_candidate() {
  local expected_candidate expected_digest actual_digest
  read -r expected_candidate expected_digest < <("${SUDO[@]}" cat "$STAGE_DIR/candidate") || fail candidate_stage_manifest_invalid
  actual_digest="$("${SUDO[@]}" sha256sum "$CANDIDATE_ARCHIVE" | awk '{ print $1 }')" || fail candidate_stage_digest_unavailable
  [[ "$expected_candidate" == "$CANDIDATE" && "$expected_digest" == "$actual_digest" ]] || fail candidate_stage_digest_mismatch
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
  local path="$1" index="$2"
  if "${SUDO[@]}" test -e "$path"; then
    printf 'present\t%s\t%s\n' "$index" "$path" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
    "${SUDO[@]}" cp -a -- "$path" "$SNAPSHOT_DIR/files/$index"
  else
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

snapshot_runtime_state() {
  SNAPSHOT_DIR="$("${SUDO[@]}" mktemp -d "$SNAPSHOT_ROOT/release-transaction.${CANDIDATE:0:12}.XXXXXX")" || fail snapshot_create_failed
  "${SUDO[@]}" chmod 700 "$SNAPSHOT_DIR"
  "${SUDO[@]}" mkdir -p "$SNAPSHOT_DIR/files"
  printf '%s\n' "$CANDIDATE" | "${SUDO[@]}" tee "$SNAPSHOT_DIR/candidate" >/dev/null
  snapshot_code_revision
  [[ -z "$DELTA_FILE" ]] || "${SUDO[@]}" cp -a -- "$DELTA_FILE" "$SNAPSHOT_DIR/deployment-delta"
  local paths=(
    "$FULL_HOME/config.yaml" "$FULL_HOME/.env" "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml" "$FULL_HOME/profiles/$FULL_PROFILE/.env"
    "$LITE_HOME/config.yaml" "$LITE_HOME/.env" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/.env"
    "$SYSTEMD_DIR/ran-agent-hermes.service" "$SYSTEMD_DIR/ran-agent-hermes-full.service" "$SYSTEMD_DIR/ran-agent-node.service" "$SYSTEMD_DIR/ran-agent-python.service"
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service" "$SYSTEMD_DIR/ran-agent-ombre-recall.service" "$SYSTEMD_DIR/ran-agent-xhs-browse.service" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service"
    "$SYSTEMD_DIR/ran-agent-hermes.service.d" "$SYSTEMD_DIR/ran-agent-hermes-full.service.d" "$SYSTEMD_DIR/ran-agent-node.service.d" "$SYSTEMD_DIR/ran-agent-python.service.d"
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service.d" "$SYSTEMD_DIR/ran-agent-ombre-recall.service.d" "$SYSTEMD_DIR/ran-agent-xhs-browse.service.d" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service.d"
    "$FULL_HOME/profiles/$FULL_PROFILE/IDENTITY.md" "$FULL_HOME/profiles/$FULL_PROFILE/SOUL.md" "$FULL_HOME/profiles/$FULL_PROFILE/AGENTS.md"
    "$LITE_HOME/profiles/$LITE_PROFILE/IDENTITY.md" "$LITE_HOME/profiles/$LITE_PROFILE/SOUL.md" "$LITE_HOME/profiles/$LITE_PROFILE/AGENTS.md"
  )
  local index=0 path unit
  while IFS= read -r path; do paths+=("$path"); done < <(
    for unit in "${ALL_RUNTIME_UNITS[@]}"; do service_env_files "$unit"; done | sort -u
  )
  for path in "${paths[@]}"; do snapshot_path "$path" "$index"; index=$((index + 1)); done
  for unit in "${ALL_RUNTIME_UNITS[@]}"; do snapshot_service_state "$unit"; done
  write_transaction_state snapshot-created false
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
  transaction_id="$(basename "$SNAPSHOT_DIR")"
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
import json, os
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
temporary = target.with_name("." + target.name + ".tmp")
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(value, handle, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, target)
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
import json, os
from pathlib import Path
target = Path(os.environ["TX_POINTER"])
temporary = target.with_name("." + target.name + ".tmp")
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump({"schema_version": 1, "transaction_id": os.environ["TX_ID"], "candidate_sha": os.environ["TX_CANDIDATE"]}, handle, sort_keys=True)
    handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
os.replace(temporary, target)
directory = os.open(target.parent, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
'
}

classify_snapshot() {
  local directory="$1" current_transaction='' production_transaction="$RETENTION_PRODUCTION_TRANSACTION"
  [[ "$TRANSACTION_STARTED" -eq 1 && -n "$SNAPSHOT_DIR" ]] && current_transaction="$(basename "$SNAPSHOT_DIR")"
  "${SUDO[@]}" "$PYTHON_BIN" "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" classify-snapshot \
    "$directory" --current-transaction "$current_transaction" \
    --production-transaction "$production_transaction" --format tsv
}

prune_accepted_snapshots() {
  local directory decision reason completed index=0 retained_slots=0
  local -a eligible=()
  if "${SUDO[@]}" test -e "$CURRENT_PRODUCTION_POINTER"; then
    RETENTION_PRODUCTION_TRANSACTION="$("${SUDO[@]}" "$PYTHON_BIN" \
      "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" read-production-pointer \
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

# Node uses JSON/JSONL durable files under state; snapshot the complete state
# only after services stop, so the SQLite and outbox snapshots agree.
snapshot_node_durable_state() { snapshot_path "$STATE_DIR" 900; }

snapshot_state_migrations() {
  local path index=1000
  # Directory-level snapshot also removes a database first created by a failed
  # candidate; individual files retain explicit SQLite/WAL evidence in manifest.
  snapshot_path "$REPO_ROOT/data" 901
  "${SUDO[@]}" test -d "$REPO_ROOT/data" || return 0
  while IFS= read -r -d '' path; do
    printf 'migration-present\t%s\t%s\n' "$index" "$path" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
    "${SUDO[@]}" cp -a -- "$path" "$SNAPSHOT_DIR/files/$index"
    index=$((index + 1))
  done < <("${SUDO[@]}" find "$REPO_ROOT/data" -type f \( -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.db' -o -name '*.db-*' \) -print0)
}

activate_candidate_checkout() {
  git -C "$REPO_ROOT" checkout --detach "$CANDIDATE" >/dev/null 2>&1 || fail candidate_checkout_failed
  [[ "$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" == "$CANDIDATE" ]] || fail candidate_checkout_mismatch
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
  git -C "$REPO_ROOT" checkout --detach "$prior_head" >/dev/null 2>&1 || return 1
  [[ "$prior_ref" != refs/heads/* ]] || git -C "$REPO_ROOT" checkout "${prior_ref#refs/heads/}" >/dev/null 2>&1
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
  set +e
  if [[ "$TRANSACTION_STARTED" -eq 1 ]]; then
    write_transaction_state rollback-in-progress false || rollback_failed=1
    local stage
    for stage in quiesce_runtime_services restore_code_revision restore_runtime_files restore_state_migrations restore_service_state; do
      if "$stage"; then
        printf 'deploy-hermes-release: rollback-stage=%s result=ok\n' "$stage" >&2
      else
        printf 'deploy-hermes-release: rollback-stage=%s result=failed\n' "$stage" >&2
        rollback_failed=1
      fi
    done
    if record_protected_capability_evidence rollback; then
      printf 'deploy-hermes-release: rollback-stage=evidence result=ok\n' >&2
    else
      printf 'deploy-hermes-release: rollback-stage=evidence result=failed\n' >&2
      rollback_failed=1
    fi
    if [[ "$rollback_failed" -ne 0 ]]; then
      write_transaction_state rollback-incomplete false || :
      printf 'deploy-hermes-release: rollback-incomplete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
      exit 70
    fi
    write_transaction_state rolled-back false "$(date -u +%s)" || {
      printf 'deploy-hermes-release: rollback-incomplete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
      exit 70
    }
    printf 'deploy-hermes-release: rollback-complete deployment_status=%s candidate=%s snapshot=%s\n' "$deployment_status" "$CANDIDATE" "$SNAPSHOT_DIR" >&2
  fi
  exit "$deployment_status"
}

load_rollback_snapshot() {
  SNAPSHOT_DIR="$1"
  [[ "$SNAPSHOT_DIR" == "$SNAPSHOT_ROOT"/* && -d "$SNAPSHOT_DIR" ]] || fail rollback_snapshot_invalid
  "${SUDO[@]}" test -s "$SNAPSHOT_DIR/prior-head" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || fail rollback_manifest_invalid
  CANDIDATE="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/candidate" 2>/dev/null)" || fail rollback_candidate_unreadable
  [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail rollback_candidate_invalid
}

explicit_rollback() {
  [[ "$REPO_ROOT" == "$SERVER_ROOT" ]] || fail server_root_required
  require_artifact_layout
  load_rollback_snapshot "$2"
  TRANSACTION_STARTED=1
  trap 'exit 130' INT
  trap 'exit 143' TERM
  rollback_transaction 0
}

if [[ "$MODE" == --rollback ]]; then explicit_rollback "$@"; exit 0; fi
if [[ "$MODE" == --dry-run ]]; then require_plan_prerequisites; printf 'deploy-hermes-release: dry-run-ok candidate=%s plan=server-local-transaction-redacted\n' "$CANDIDATE"; exit 0; fi

require_apply_prerequisites
report_release_delta
stage_candidate
verify_stage_candidate
candidate_stage_preflight owner
# Gate runs in immutable stage before any checkout/config/runtime mutation.
"${SUDO[@]}" env RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_NODE_BIN="$NODE_BIN" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" bash "$STAGE_DIR/scripts/hermes-release-gate.sh" --all
snapshot_runtime_state
TRANSACTION_STARTED=1
record_protected_capability_evidence before || fail protected_capability_evidence_before
trap 'rollback_transaction $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
quiesce_runtime_services
snapshot_node_durable_state
snapshot_state_migrations
activate_candidate_checkout
"${SUDO[@]}" env RAN_AGENT_RELEASE_PRESERVE_RUNTIME_SHAPE=1 RAN_AGENT_REPO_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 bash "$STAGE_DIR/scripts/apply-hermes-runtime-split.sh" --preserve-runtime-shape
"${SUDO[@]}" env RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 RAN_AGENT_RELEASE_CONTROL_ROOT="$REPO_ROOT" RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_RELEASE_PREMUTATION_GATE=1 RAN_AGENT_NODE_BIN="$NODE_BIN" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" bash "$STAGE_DIR/scripts/verify-hermes-release.sh" --release
record_protected_capability_evidence after || fail protected_capability_evidence_after
mark_snapshot_accepted
TRANSACTION_STARTED=0
trap - EXIT INT TERM
prune_accepted_snapshots
printf 'deploy-hermes-release: apply-ok candidate=%s snapshot=%s\n' "$CANDIDATE" "$SNAPSHOT_DIR"
