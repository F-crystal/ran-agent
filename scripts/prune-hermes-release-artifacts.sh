#!/usr/bin/env bash
# Reclaim payloads that a completed rollback has already consumed. Evidence stays.

set -euo pipefail
umask 077

fail() {
  printf 'prune-hermes-release-artifacts: failed:%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail invalid_arguments
MODE="$1"
case "$MODE" in
  --dry-run) MODE_LABEL=dry-run ;;
  --apply) MODE_LABEL=apply ;;
  --apply-under-transaction)
    [[ "${RAN_AGENT_RELEASE_TRANSACTION_CONTEXT:-0}" == 1 ]] || fail transaction_context_required
    MODE_LABEL=apply
    ;;
  *) fail invalid_mode ;;
esac

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
SNAPSHOT_ROOT="$ARTIFACT_ROOT/snapshots"
STAGE_ROOT="$ARTIFACT_ROOT/stages"
ARCHIVE_ROOT="$ARTIFACT_ROOT/archives"
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-$(command -v python3 || true)}"
[[ "$ARTIFACT_ROOT" == /* ]] || fail artifact_root_absolute_required
[[ "$PYTHON_BIN" == /* && -x "$PYTHON_BIN" ]] || fail python_runtime_required

if [[ "${EUID}" -ne 0 && "${RAN_AGENT_NO_SUDO:-0}" != 1 ]]; then
  command -v sudo >/dev/null 2>&1 || fail sudo_required
  exec sudo env RAN_AGENT_RELEASE_ARTIFACT_ROOT="$ARTIFACT_ROOT" RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
    bash "$0" "$MODE"
fi
USE_SUDO=0
run_privileged() {
  if [[ "$USE_SUDO" == 1 ]]; then sudo "$@"; else "$@"; fi
}
run_privileged "$PYTHON_BIN" -I -c '
import os, stat, sys

root = sys.argv[1]
expected_uid, expected_gid = os.geteuid(), os.getegid()
root_value = os.lstat(root)
if not stat.S_ISDIR(root_value.st_mode) or (root_value.st_uid, root_value.st_gid) != (expected_uid, expected_gid) or stat.S_IMODE(root_value.st_mode) != 0o700:
    raise SystemExit(1)
for path in sys.argv[2:]:
    if not os.path.lexists(path):
        continue
    value = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or (value.st_uid, value.st_gid) != (expected_uid, expected_gid) or stat.S_IMODE(value.st_mode) != 0o700 or value.st_dev != root_value.st_dev:
        raise SystemExit(1)
' "$ARTIFACT_ROOT" "$SNAPSHOT_ROOT" "$STAGE_ROOT" "$ARCHIVE_ROOT" || fail artifact_layout_identity_invalid

if [[ "$MODE" == --apply ]]; then
  exec 8>"$ARTIFACT_ROOT/.release-transaction.lock"
  chmod 600 "$ARTIFACT_ROOT/.release-transaction.lock" || fail release_lock_identity_invalid
  "$PYTHON_BIN" -I -c 'import fcntl,os,stat; value=os.fstat(8); assert stat.S_ISREG(value.st_mode) and value.st_uid == os.geteuid() and value.st_gid == os.getegid() and stat.S_IMODE(value.st_mode) == 0o600; fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)' 8>&8 ||
    fail release_transaction_locked
fi
if [[ "$MODE" != --dry-run ]]; then
  exec 9>"$ARTIFACT_ROOT/.payload-cleanup.lock"
  chmod 600 "$ARTIFACT_ROOT/.payload-cleanup.lock" || fail cleanup_lock_identity_invalid
  "$PYTHON_BIN" -I -c 'import fcntl,os,stat; value=os.fstat(9); assert stat.S_ISREG(value.st_mode) and value.st_uid == os.geteuid() and value.st_gid == os.getegid() and stat.S_IMODE(value.st_mode) == 0o600; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 9>&9 ||
    fail cleanup_locked
fi

pointer="$SNAPSHOT_ROOT/current-production.json"
read_production_transaction() {
  run_privileged test ! -L "$pointer" || return 1
  if run_privileged test -e "$pointer"; then
    run_privileged "$PYTHON_BIN" "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" \
      read-production-pointer "$pointer" --format transaction-id 2>/dev/null
  fi
}
classify() {
  run_privileged "$PYTHON_BIN" "$SCRIPT_ROOT/scripts/ombre_o1_contract.py" classify-snapshot \
    "$1" --production-transaction "$2" --format tsv
}
path_identity() {
  run_privileged "$PYTHON_BIN" -I -c \
    'import os,sys; value=os.lstat(sys.argv[1]); print(f"{value.st_dev}:{value.st_ino}")' "$1"
}
snapshot_tree_has_mounts() {
  local mountinfo=/proc/self/mountinfo
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_TEST_MOUNTINFO_FILE:-}" ]]; then
    mountinfo="$RAN_AGENT_TEST_MOUNTINFO_FILE"
  fi
  run_privileged "$PYTHON_BIN" -I - "$1" "$mountinfo" <<'PY'
import os
import sys

snapshot = os.path.realpath(sys.argv[1])
mountinfo = sys.argv[2]
if os.path.exists(mountinfo):
    def decode(value):
        for escaped, plain in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
            value = value.replace(escaped, plain)
        return value
    with open(mountinfo, encoding="utf-8") as source:
        mounts = (decode(line.split(" - ", 1)[0].split()[4]) for line in source)
        raise SystemExit(0 if any(item == snapshot or item.startswith(snapshot + os.sep) for item in mounts) else 1)
raise SystemExit(0 if os.path.ismount(snapshot) else 1)
PY
}

production_transaction=''
if run_privileged test -d "$SNAPSHOT_ROOT"; then
  production_transaction="$(read_production_transaction)" || fail production_pointer_invalid
fi

payloads=0
incomplete=0
ephemera=0
reclaimed_kib=0
while IFS= read -r directory; do
  [[ "$directory" == "$SNAPSHOT_ROOT"/.release-incomplete.* ]] || continue
  if [[ "$(basename "$directory")" == "$production_transaction" ]] ||
    run_privileged test -L "$directory" || snapshot_tree_has_mounts "$directory"; then
    printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN snapshot=%s reason=incomplete_identity\n' "$directory" >&2
    continue
  fi
  identity="$(path_identity "$directory")" || fail incomplete_identity_unavailable
  size_kib="$(run_privileged du -sk "$directory" | awk '{print $1}')" || fail incomplete_size_unavailable
  printf 'prune-hermes-release-artifacts: decision=PRUNE_INCOMPLETE snapshot=%s reclaimed_kib=%s mode=%s\n' \
    "$directory" "$size_kib" "$MODE_LABEL"
  if [[ "$MODE" != --dry-run ]]; then
    fresh_production="$(read_production_transaction)" || fail production_pointer_invalid
    [[ "$(basename "$directory")" != "$fresh_production" ]] &&
      [[ "$(path_identity "$directory")" == "$identity" ]] &&
      ! snapshot_tree_has_mounts "$directory" || fail incomplete_identity_changed
    run_privileged rm -rf -- "$directory"
  fi
  incomplete=$((incomplete + 1))
  reclaimed_kib=$((reclaimed_kib + size_kib))
done < <(
  if run_privileged test -d "$SNAPSHOT_ROOT"; then
    run_privileged find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.release-incomplete.*' | sort
  fi
)

while IFS= read -r directory; do
  [[ "$directory" == "$SNAPSHOT_ROOT"/release-transaction.* ]] || continue
  IFS=$'\t' read -r decision reason _ < <(
    classify "$directory" "$production_transaction"
  )
  payload="$directory/files"
  if [[ "$decision" != PRUNE_PAYLOAD ]]; then
    printf 'prune-hermes-release-artifacts: decision=%s snapshot=%s reason=%s\n' "$decision" "$directory" "$reason"
    continue
  fi
  if run_privileged test -L "$directory" || run_privileged test -L "$payload"; then
    printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN snapshot=%s reason=payload_symlink\n' "$directory" >&2
    continue
  fi
  if ! run_privileged test -d "$payload"; then
    printf 'prune-hermes-release-artifacts: decision=PRUNE_PAYLOAD snapshot=%s reason=already_compacted\n' "$directory"
    continue
  fi
  identity="$(path_identity "$payload")" || fail payload_identity_unavailable
  if snapshot_tree_has_mounts "$directory"; then
    printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN snapshot=%s reason=payload_mountpoint\n' "$directory" >&2
    continue
  fi
  size_kib="$(run_privileged du -sk "$payload" | awk '{print $1}')"
  printf 'prune-hermes-release-artifacts: decision=PRUNE_PAYLOAD snapshot=%s reclaimed_kib=%s mode=%s\n' \
    "$directory" "$size_kib" "$MODE_LABEL"
  if [[ "$MODE" != --dry-run ]]; then
    fresh_production="$(read_production_transaction)" || fail production_pointer_invalid
    IFS=$'\t' read -r fresh_decision fresh_reason _ < <(
      classify "$directory" "$fresh_production"
    )
    if [[ "$fresh_decision" != PRUNE_PAYLOAD ]]; then
      printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN snapshot=%s reason=revalidation_%s\n' \
        "$directory" "$fresh_reason" >&2
      continue
    fi
    if run_privileged test -L "$directory" || run_privileged test -L "$payload" || \
      [[ "$(path_identity "$payload")" != "$identity" ]] || snapshot_tree_has_mounts "$directory"; then
      printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN snapshot=%s reason=payload_changed\n' "$directory" >&2
      continue
    fi
    run_privileged rm -rf -- "$payload"
  fi
  payloads=$((payloads + 1))
  reclaimed_kib=$((reclaimed_kib + size_kib))
done < <(
  if run_privileged test -d "$SNAPSHOT_ROOT"; then
    run_privileged find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'release-transaction.*' | sort
  fi
)

prune_ephemeral_file() {
  local path="$1" preserve="$2" size_kib
  [[ -z "$preserve" || "$path" != "$preserve" ]] || return 0
  if run_privileged test -L "$path" || ! run_privileged test -f "$path"; then
    printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN artifact=%s reason=not_regular\n' "$path" >&2
    return 0
  fi
  size_kib="$(run_privileged du -sk "$path" | awk '{print $1}')" || fail ephemeral_size_unavailable
  printf 'prune-hermes-release-artifacts: decision=PRUNE_EPHEMERAL artifact=%s reclaimed_kib=%s mode=%s\n' \
    "$path" "$size_kib" "$MODE_LABEL"
  [[ "$MODE" == --dry-run ]] || run_privileged rm -f -- "$path"
  ephemera=$((ephemera + 1))
  reclaimed_kib=$((reclaimed_kib + size_kib))
}

prune_ephemeral_stage() {
  local path="$1" preserve="$2" identity size_kib
  [[ -z "$preserve" || "$path" != "$preserve" ]] || return 0
  if run_privileged test -L "$path" || ! run_privileged test -d "$path" || snapshot_tree_has_mounts "$path"; then
    printf 'prune-hermes-release-artifacts: decision=SKIP_UNCERTAIN artifact=%s reason=stage_identity\n' "$path" >&2
    return 0
  fi
  identity="$(path_identity "$path")" || fail ephemeral_identity_unavailable
  size_kib="$(run_privileged du -sk "$path" | awk '{print $1}')" || fail ephemeral_size_unavailable
  printf 'prune-hermes-release-artifacts: decision=PRUNE_EPHEMERAL artifact=%s reclaimed_kib=%s mode=%s\n' \
    "$path" "$size_kib" "$MODE_LABEL"
  if [[ "$MODE" != --dry-run ]]; then
    [[ "$(path_identity "$path")" == "$identity" ]] && ! snapshot_tree_has_mounts "$path" || fail ephemeral_identity_changed
    run_privileged rm -rf -- "$path"
  fi
  ephemera=$((ephemera + 1))
  reclaimed_kib=$((reclaimed_kib + size_kib))
}

while IFS= read -r path; do
  prune_ephemeral_stage "$path" "${RAN_AGENT_RELEASE_PRESERVE_STAGE:-}"
done < <(
  if run_privileged test -d "$STAGE_ROOT"; then
    run_privileged find "$STAGE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'release-stage.*' | sort
  fi
)
while IFS= read -r path; do
  prune_ephemeral_file "$path" "${RAN_AGENT_RELEASE_PRESERVE_ARCHIVE:-}"
done < <(
  if run_privileged test -d "$ARCHIVE_ROOT"; then
    run_privileged find "$ARCHIVE_ROOT" -mindepth 1 -maxdepth 1 -type f \
      \( -name 'release-candidate.*.tar' -o -name 'release-delta.*.txt' \) | sort
  fi
)

printf 'prune-hermes-release-artifacts: ok mode=%s payloads=%s incomplete=%s ephemera=%s reclaimed_kib=%s\n' \
  "$MODE_LABEL" "$payloads" "$incomplete" "$ephemera" "$reclaimed_kib"
