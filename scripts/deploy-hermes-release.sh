#!/usr/bin/env bash

# A release is run by an operator *on* the server.  This script deliberately
# has no network, SSH, rsync, or git-fetch behaviour: a reviewed immutable
# commit must already be checked out at /opt/ran_agent.
set -euo pipefail
umask 077

fail() {
  printf 'deploy-hermes-release: failed:%s\n' "$1" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVER_ROOT="/opt/ran_agent"
cd "$REPO_ROOT"
MODE="${1:---refuse-mutation}"
if [[ $# -gt 1 ]]; then fail invalid_arguments; fi
case "$MODE" in --dry-run|--apply) ;; --refuse-mutation) fail explicit_apply_required ;; *) fail invalid_mode ;; esac

CANDIDATE_INPUT="${RAN_AGENT_RELEASE_CANDIDATE:-HEAD}"
CANDIDATE="$(git -C "$REPO_ROOT" rev-parse --verify "${CANDIDATE_INPUT}^{commit}" 2>/dev/null)" || fail invalid_candidate
[[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || fail sudo_required
  SUDO=(sudo)
fi

NODE_BIN="${RAN_AGENT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-$REPO_ROOT/.venv/bin/python}"
STATE_DIR="${RAN_AGENT_RELEASE_STATE_DIR:-$REPO_ROOT/.ran_agent_state}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
FULL_PROFILE="${HERMES_FULL_PROFILE:-ran-assistant}"
LITE_PROFILE="${HERMES_LITE_PROFILE:-ran-assistant-lite}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-$REPO_ROOT/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-$REPO_ROOT/node_bridge/.env.local}"
CORE_RUNTIME_UNITS=(ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service)
SNAPSHOT_DIR=''
STAGE_DIR=''
CANDIDATE_ARCHIVE=''
TRANSACTION_STARTED=0

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

require_owner_binding() {
  "$NODE_BIN" --input-type=module -e '
    import { validateOwnerBindingPreflight } from "./node_bridge/src/identityMap.mjs";
    const result = validateOwnerBindingPreflight();
    if (!result.ok) { process.stderr.write("owner_binding_required\\n"); process.exit(1); }
  ' >/dev/null || fail owner_binding_required
}

require_atomic_state() {
  "${SUDO[@]}" install -d -m 700 "$STATE_DIR" || fail state_dir_unavailable
  local probe="$STATE_DIR/.release-atomic-probe.$$"
  "${SUDO[@]}" sh -c ': > "$1" && mv "$1" "$1.done" && rm -f "$1.done"' sh "$probe" || fail atomic_state_unavailable
}

require_plan_prerequisites() {
  require_node_sqlite
  git -C "$REPO_ROOT" cat-file -e "${CANDIDATE}^{commit}" || fail candidate_object_missing
  local probe
  probe="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-release-plan.XXXXXX")" || fail candidate_plan_unavailable
  trap 'rm -rf "$probe"' RETURN
  git -C "$REPO_ROOT" archive --format=tar "$CANDIDATE" | tar -xf - -C "$probe" || fail candidate_plan_archive_failed
  [[ -f "$probe/node_bridge/package.json" && -f "$probe/src/personal_agent/service.py" ]] || fail candidate_plan_incomplete
  find "$probe" -type l -print -quit | grep -q . && fail candidate_plan_symlink
  rm -rf "$probe"
  trap - RETURN
}

require_apply_prerequisites() {
  [[ "$REPO_ROOT" == "$SERVER_ROOT" ]] || fail server_root_required
  HEAD="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" || fail current_head_unavailable
  [[ "$HEAD" == "$CANDIDATE" ]] || fail candidate_not_checked_out
  git -C "$REPO_ROOT" diff --quiet || fail worktree_dirty
  git -C "$REPO_ROOT" diff --cached --quiet || fail index_dirty
  require_node_sqlite
  require_python_runtime
  require_owner_binding
  require_atomic_state
}

stage_candidate() {
  STAGE_DIR="$("${SUDO[@]}" mktemp -d "$STATE_DIR/release-stage.${CANDIDATE:0:12}.XXXXXX")" || fail candidate_stage_unavailable
  "${SUDO[@]}" chmod 700 "$STAGE_DIR"
  CANDIDATE_ARCHIVE="$STATE_DIR/release-candidate.${CANDIDATE:0:12}.tar"
  git -C "$REPO_ROOT" archive --format=tar "$CANDIDATE" | "${SUDO[@]}" tee "$CANDIDATE_ARCHIVE" >/dev/null || fail candidate_stage_failed
  "${SUDO[@]}" chmod 600 "$CANDIDATE_ARCHIVE"
  "${SUDO[@]}" tar -xf "$CANDIDATE_ARCHIVE" -C "$STAGE_DIR" || fail candidate_stage_failed
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/apply-hermes-runtime-split.sh" || fail candidate_stage_incomplete
  "${SUDO[@]}" test -x "$STAGE_DIR/scripts/accept-hermes-release.sh" || fail candidate_stage_incomplete
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
  local root="$1" manifest="$root/docs/governance/hermes_protected_capabilities.v1.json"
  if "${SUDO[@]}" test -f "$manifest"; then
    "${SUDO[@]}" sha256sum "$manifest" | awk '{ print $1 }'
  else
    printf 'absent\n'
  fi
}

# Rollback snapshots contain owner-only runtime files.  This separate evidence
# trail is intentionally digest-only, so a release record can prove protected
# capability continuity without copying MCP config, credentials, or identities.
record_protected_capability_evidence() {
  local phase="$1" active staged
  [[ -n "$SNAPSHOT_DIR" ]] || return 0
  active="$(protected_manifest_digest "$REPO_ROOT")" || return 1
  staged="$(protected_manifest_digest "$STAGE_DIR")" || return 1
  printf 'phase=%s candidate=%s active_manifest_sha256=%s staged_manifest_sha256=%s\n' \
    "$phase" "${CANDIDATE:0:12}" "$active" "$staged" \
    | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/protected-capabilities.evidence" >/dev/null
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

snapshot_state_migrations() {
  local root path index="$1"
  for root in "$STATE_DIR" "$REPO_ROOT/data"; do
    "${SUDO[@]}" test -d "$root" || continue
    while IFS= read -r -d '' path; do
      printf 'migration-present\t%s\t%s\n' "$index" "$path" | "${SUDO[@]}" tee -a "$SNAPSHOT_DIR/manifest" >/dev/null
      "${SUDO[@]}" cp -a -- "$path" "$SNAPSHOT_DIR/files/$index"
      index=$((index + 1))
    done < <("${SUDO[@]}" find "$root" -type f \( -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.db' -o -name '*.db-*' \) -print0)
  done
}

snapshot_runtime_state() {
  SNAPSHOT_DIR="$("${SUDO[@]}" mktemp -d "$STATE_DIR/release-transaction.${CANDIDATE:0:12}.XXXXXX")" || fail snapshot_create_failed
  "${SUDO[@]}" chmod 700 "$SNAPSHOT_DIR"
  "${SUDO[@]}" mkdir -p "$SNAPSHOT_DIR/files"
  printf '%s\n' "$CANDIDATE" | "${SUDO[@]}" tee "$SNAPSHOT_DIR/candidate" >/dev/null
  snapshot_code_revision
  local paths=(
    "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE"
    "$FULL_HOME/config.yaml" "$FULL_HOME/.env" "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml" "$FULL_HOME/profiles/$FULL_PROFILE/.env"
    "$LITE_HOME/config.yaml" "$LITE_HOME/.env" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/.env"
    "$SYSTEMD_DIR/ran-agent-hermes.service" "$SYSTEMD_DIR/ran-agent-hermes-full.service"
    "$SYSTEMD_DIR/ran-agent-node.service" "$SYSTEMD_DIR/ran-agent-python.service"
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service" "$SYSTEMD_DIR/ran-agent-xhs-browse.service" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service"
    "$SYSTEMD_DIR/ran-agent-hermes.service.d" "$SYSTEMD_DIR/ran-agent-hermes-full.service.d"
    "$SYSTEMD_DIR/ran-agent-node.service.d" "$SYSTEMD_DIR/ran-agent-python.service.d"
    "$SYSTEMD_DIR/ran-agent-ombre-brain.service.d" "$SYSTEMD_DIR/ran-agent-xhs-browse.service.d" "$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service.d"
  )
  local index=0 path
  for path in "${paths[@]}"; do snapshot_path "$path" "$index"; index=$((index + 1)); done
  local unit
  for unit in ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-ombre-brain.service ran-agent-xhs-browse.service ran-agent-xhs-public-sidecar.service; do
    snapshot_service_state "$unit"
  done
}

quiesce_runtime_services() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 0
  local unit
  for unit in "${CORE_RUNTIME_UNITS[@]}"; do
    "${SUDO[@]}" awk -F '\t' -v unit="$unit" '$1 == unit && $2 == "active" { found=1 } END { exit !found }' "$SNAPSHOT_DIR/services" \
      || continue
    "${SUDO[@]}" systemctl stop "$unit" || return 1
  done
}

restore_code_revision() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -s "$SNAPSHOT_DIR/prior-head" || return 0
  local prior_head prior_ref
  prior_head="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-head")"
  prior_ref="$("${SUDO[@]}" cat "$SNAPSHOT_DIR/prior-ref" 2>/dev/null || true)"
  git -C "$REPO_ROOT" checkout --detach "$prior_head" >/dev/null 2>&1 || return 1
  if [[ "$prior_ref" == refs/heads/* ]]; then
    git -C "$REPO_ROOT" checkout "${prior_ref#refs/heads/}" >/dev/null 2>&1 || return 1
  fi
}

restore_runtime_files() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || return 0
  local kind index path
  while IFS=$'\t' read -r kind index path; do
    if [[ "$kind" == present ]]; then
      "${SUDO[@]}" rm -rf -- "$path"
      "${SUDO[@]}" mkdir -p "$(dirname "$path")"
      "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"
    elif [[ "$kind" == absent ]]; then
      "${SUDO[@]}" rm -rf -- "$path"
    fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
}

restore_service_state() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/services" || return 0
  "${SUDO[@]}" systemctl daemon-reload || true
  local unit active enabled
  while IFS=$'\t' read -r unit active enabled; do
    case "$enabled" in enabled|enabled-runtime) "${SUDO[@]}" systemctl enable "$unit" >/dev/null 2>&1 || true ;; disabled|masked) "${SUDO[@]}" systemctl disable "$unit" >/dev/null 2>&1 || true ;; esac
    if [[ "$active" == active ]]; then "${SUDO[@]}" systemctl restart "$unit" || true; else "${SUDO[@]}" systemctl stop "$unit" || true; fi
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/services")
}

restore_state_migrations() {
  [[ -n "$SNAPSHOT_DIR" ]] && "${SUDO[@]}" test -f "$SNAPSHOT_DIR/manifest" || return 0
  local kind index path
  while IFS=$'\t' read -r kind index path; do
    [[ "$kind" == migration-present ]] || continue
    "${SUDO[@]}" rm -f -- "$path"
    "${SUDO[@]}" mkdir -p "$(dirname "$path")"
    "${SUDO[@]}" cp -a -- "$SNAPSHOT_DIR/files/$index" "$path"
  done < <("${SUDO[@]}" cat "$SNAPSHOT_DIR/manifest")
}

rollback() {
  local status="$1"
  set +e
  if [[ "$TRANSACTION_STARTED" -eq 1 ]]; then
    restore_code_revision || true
    restore_runtime_files || true
    restore_state_migrations || true
    restore_service_state || true
    record_protected_capability_evidence rollback || true
    printf 'deploy-hermes-release: rollback-complete candidate=%s\n' "$CANDIDATE" >&2
  fi
  exit "$status"
}

if [[ "$MODE" == "--dry-run" ]]; then
  require_plan_prerequisites
  printf 'deploy-hermes-release: dry-run-ok candidate=%s plan=server-local-transaction-redacted\n' "$CANDIDATE"
  exit 0
fi

require_apply_prerequisites
stage_candidate
verify_stage_candidate
# The full local candidate gate runs before any runtime configuration, service,
# or durable-state mutation.  A failed gate never enters the transaction.
# The stage is owner-only so its immutable candidate cannot be altered between
# the gate and apply.  Execute every staged script with the same privilege that
# created it; a non-root operator otherwise cannot traverse the stage.
"${SUDO[@]}" env \
  RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" \
  RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 \
  RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" \
  RAN_AGENT_NODE_BIN="$NODE_BIN" \
  RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
  bash "$STAGE_DIR/scripts/hermes-release-gate.sh" --all
snapshot_runtime_state
TRANSACTION_STARTED=1
record_protected_capability_evidence before || fail protected_capability_evidence_before
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
quiesce_runtime_services
snapshot_state_migrations 1000

# The lower-level apply is explicitly told not to rewrite Hermes config.yaml
# files or profile membership.  Those files can contain arbitrary, opaque MCP
# definitions (including future providers); they are snapshotted for rollback.
"${SUDO[@]}" env \
  RAN_AGENT_RELEASE_PRESERVE_RUNTIME_SHAPE=1 \
  RAN_AGENT_REPO_ROOT="$STAGE_DIR" \
  RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" \
  RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 \
  bash "$STAGE_DIR/scripts/apply-hermes-runtime-split.sh" --preserve-runtime-shape
"${SUDO[@]}" env \
  RAN_AGENT_RELEASE_SOURCE_ROOT="$STAGE_DIR" \
  RAN_AGENT_RELEASE_STAGED_CANDIDATE=1 \
  RAN_AGENT_RELEASE_CONTROL_ROOT="$REPO_ROOT" \
  RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" \
  RAN_AGENT_RELEASE_PREMUTATION_GATE=1 \
  RAN_AGENT_NODE_BIN="$NODE_BIN" \
  RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
  bash "$STAGE_DIR/scripts/accept-hermes-release.sh" --apply
record_protected_capability_evidence after || fail protected_capability_evidence_after
TRANSACTION_STARTED=0
trap - ERR INT TERM
printf 'deploy-hermes-release: apply-ok candidate=%s snapshot=%s\n' "$CANDIDATE" "$SNAPSHOT_DIR"
