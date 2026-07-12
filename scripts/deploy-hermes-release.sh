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
STAGE_ROOT="$ARTIFACT_ROOT/stages"
ARCHIVE_ROOT="$ARTIFACT_ROOT/archives"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
FULL_PROFILE="${HERMES_FULL_PROFILE:-ran-assistant}"
LITE_PROFILE="${HERMES_LITE_PROFILE:-ran-assistant-lite}"
CORE_RUNTIME_UNITS=(ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service)
ALL_RUNTIME_UNITS=("${CORE_RUNTIME_UNITS[@]}" ran-agent-ombre-brain.service ran-agent-xhs-browse.service ran-agent-xhs-public-sidecar.service)
SNAPSHOT_DIR=''
STAGE_DIR=''
CANDIDATE_ARCHIVE=''
PRODUCTION_HEAD=''
DELTA_FILE=''
TRANSACTION_STARTED=0

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

snapshot_service_state() {
  local unit="$1" active enabled
  if "${SUDO[@]}" systemctl is-active --quiet "$unit"; then active=active; else active=inactive; fi
  enabled="$("${SUDO[@]}" systemctl is-enabled "$unit" 2>/dev/null || true)"
  printf '%s\t%s\t%s\n' "$unit" "$active" "$enabled" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/services" >/dev/null
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
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service" "$SYSTEMD_DIR/ran-agent-xhs-browse.service" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service"
    "$SYSTEMD_DIR/ran-agent-hermes.service.d" "$SYSTEMD_DIR/ran-agent-hermes-full.service.d" "$SYSTEMD_DIR/ran-agent-node.service.d" "$SYSTEMD_DIR/ran-agent-python.service.d"
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service.d" "$SYSTEMD_DIR/ran-agent-xhs-browse.service.d" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service.d"
  )
  local index=0 path unit
  while IFS= read -r path; do paths+=("$path"); done < <(
    for unit in "${ALL_RUNTIME_UNITS[@]}"; do service_env_files "$unit"; done | sort -u
  )
  for path in "${paths[@]}"; do snapshot_path "$path" "$index"; index=$((index + 1)); done
  for unit in "${ALL_RUNTIME_UNITS[@]}"; do snapshot_service_state "$unit"; done
}

quiesce_runtime_services() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 0
  local unit
  for unit in "${ALL_RUNTIME_UNITS[@]}"; do
    "${SUDO[@]}" awk -F '\t' -v unit="$unit" '$1 == unit && $2 == "active" { found=1 } END { exit !found }' "$SNAPSHOT_DIR/services" || continue
    "${SUDO[@]}" systemctl stop "$unit" || return 1
  done
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
  local kind index path
  while IFS=$'\t' read -r kind index path; do
    [[ "$kind" == present || "$kind" == absent ]] || continue
    if [[ "$kind" == present ]]; then
      "${SUDO[@]}" rm -rf -- "$path"; "${SUDO[@]}" mkdir -p "$(dirname "$path")"; "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"
    else
      "${SUDO[@]}" rm -rf -- "$path"
    fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
}

restore_state_migrations() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || return 1
  local kind index path
  while IFS=$'\t' read -r kind index path; do
    [[ "$kind" == migration-present ]] || continue
    "${SUDO[@]}" rm -f -- "$path"; "${SUDO[@]}" mkdir -p "$(dirname "$path")"; "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
}

restore_service_state() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 1
  "${SUDO[@]}" systemctl daemon-reload
  local unit active enabled
  while IFS=$'\t' read -r unit active enabled; do
    case "$enabled" in enabled|enabled-runtime) "${SUDO[@]}" systemctl enable "$unit" >/dev/null ;; disabled|masked) "${SUDO[@]}" systemctl disable "$unit" >/dev/null ;; esac
    if [[ "$active" == active ]]; then "${SUDO[@]}" systemctl restart "$unit"; else "${SUDO[@]}" systemctl stop "$unit"; fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/services")
}

rollback_transaction() {
  local status="$1"
  trap - EXIT INT TERM
  set +e
  if [[ "$TRANSACTION_STARTED" -eq 1 ]]; then
    quiesce_runtime_services || true
    restore_code_revision || true
    restore_runtime_files || true
    restore_state_migrations || true
    restore_service_state || true
    record_protected_capability_evidence rollback || true
    printf 'deploy-hermes-release: rollback-complete candidate=%s snapshot=%s\n' "$CANDIDATE" "$SNAPSHOT_DIR" >&2
  fi
  exit "$status"
}

load_rollback_snapshot() {
  SNAPSHOT_DIR="$1"
  [[ "$SNAPSHOT_DIR" == "$SNAPSHOT_ROOT"/* && -d "$SNAPSHOT_DIR" ]] || fail rollback_snapshot_invalid
  "${SUDO[@]}" test -s "$SNAPSHOT_DIR/prior-head" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || fail rollback_manifest_invalid
  "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || fail rollback_manifest_invalid
  CANDIDATE="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/candidate" 2>/dev/null || true)"
  [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail rollback_candidate_invalid
}

explicit_rollback() {
  [[ "$REPO_ROOT" == "$SERVER_ROOT" ]] || fail server_root_required
  require_artifact_layout
  load_rollback_snapshot "$2"
  TRANSACTION_STARTED=1
  trap 'rollback_transaction $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  quiesce_runtime_services || fail rollback_quiesce_failed
  restore_code_revision || fail rollback_code_failed
  restore_runtime_files || fail rollback_runtime_files_failed
  restore_state_migrations || fail rollback_state_failed
  restore_service_state || fail rollback_services_failed
  record_protected_capability_evidence explicit_rollback || fail rollback_evidence_failed
  TRANSACTION_STARTED=0
  trap - EXIT INT TERM
  printf 'deploy-hermes-release: rollback-ok snapshot=%s restored=%s\n' "$SNAPSHOT_DIR" "$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-head")"
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
TRANSACTION_STARTED=0
trap - EXIT INT TERM
printf 'deploy-hermes-release: apply-ok candidate=%s snapshot=%s\n' "$CANDIDATE" "$SNAPSHOT_DIR"
