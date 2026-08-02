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
case "$MODE" in --dry-run|--apply) ;; *) fail invalid_mode ;; esac

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
SNAPSHOT_ROOT="$ARTIFACT_ROOT/snapshots"
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
run_privileged test ! -L "$ARTIFACT_ROOT" || fail artifact_root_symlink
run_privileged test ! -L "$SNAPSHOT_ROOT" || fail snapshot_root_symlink
if ! run_privileged test -d "$SNAPSHOT_ROOT"; then
  printf 'prune-hermes-release-artifacts: ok mode=%s payloads=0 reclaimed_kib=0\n' "${MODE#--}"
  exit 0
fi

if [[ "$MODE" == --apply ]]; then
  exec 9>"$ARTIFACT_ROOT/.payload-cleanup.lock"
  "$PYTHON_BIN" -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 9>&9 ||
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

production_transaction="$(read_production_transaction)" || fail production_pointer_invalid

payloads=0
reclaimed_kib=0
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
    "$directory" "$size_kib" "${MODE#--}"
  if [[ "$MODE" == --apply ]]; then
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
done < <(run_privileged find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'release-transaction.*' | sort)

printf 'prune-hermes-release-artifacts: ok mode=%s payloads=%s reclaimed_kib=%s\n' \
  "${MODE#--}" "$payloads" "$reclaimed_kib"
