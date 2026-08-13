#!/usr/bin/env bash

# One-time bridge for a production checkout that predates the release scripts.
# This script is extracted from a reviewed candidate SHA into /tmp; it never
# writes the active checkout before the common transaction snapshots it.
set -euo pipefail
umask 077

fail() {
  printf 'bootstrap-hermes-release: failed:%s\n' "$1" >&2
  exit 1
}

MODE="${1:---refuse-mutation}"
CANDIDATE_INPUT="${2:-}"
ROLLBACK_SNAPSHOT=''
case "$MODE" in
  --verify|--dry-run|--apply) [[ $# -eq 2 ]] || fail usage ;;
  --rollback) [[ $# -eq 3 ]] || fail usage; ROLLBACK_SNAPSHOT="$3" ;;
  *) fail usage ;;
esac
[[ "$CANDIDATE_INPUT" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid
[[ "$MODE" != --verify ]] || export GIT_OPTIONAL_LOCKS=0

REPO_ROOT="${RAN_AGENT_RELEASE_CONTROL_ROOT:-/opt/ran_agent}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)" || fail server_root_unavailable
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$REPO_ROOT"
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
[[ "$ARTIFACT_ROOT" == /* && "$ARTIFACT_ROOT" != "$REPO_ROOT" && "$ARTIFACT_ROOT" != "$REPO_ROOT"/* ]] || fail bootstrap_artifact_root_invalid
cd "$REPO_ROOT"
worktree_status="$(git status --porcelain)" || fail git_repository_unavailable
[[ -z "$worktree_status" ]] || fail worktree_dirty
CANDIDATE="$(git rev-parse --verify "${CANDIDATE_INPUT}^{commit}" 2>/dev/null)" || fail candidate_object_missing
[[ "$CANDIDATE" == "$CANDIDATE_INPUT" ]] || fail candidate_digest_mismatch

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-release-bootstrap.XXXXXX")" || fail bootstrap_temp_unavailable
trap 'rm -rf "$TMP_ROOT"' EXIT
required=(
  scripts/bootstrap-hermes-release.sh
  scripts/deploy-hermes-release.sh
  scripts/deploy-hermes-runtime-release.py
  scripts/resolve-hermes-service-node.sh
  scripts/prune-hermes-release-artifacts.sh
  scripts/check-hermes-snapshot-capacity.py
  scripts/ombre_o1_contract.py
  scripts/verify-runtime-service-identity.sh
)
for path in "${required[@]}"; do
  target="$TMP_ROOT/$path"
  mkdir -p "$(dirname "$target")"
  git show "$CANDIDATE:$path" > "$target" || fail bootstrap_source_missing
  chmod 700 "$target"
done

NODE_BIN_INPUT="${RAN_AGENT_NODE_BIN:-}"
# The server bootstrap contract owns this legacy compatibility path.  The
# resolver itself never guesses when a wrapper-based old unit is inactive.
if [[ -z "$NODE_BIN_INPUT" && -x /opt/nodejs/node-v22.22.2-linux-x64/bin/node ]]; then
  NODE_BIN_INPUT=/opt/nodejs/node-v22.22.2-linux-x64/bin/node
fi

if [[ "${RAN_AGENT_RELEASE_UNIFIED_SOURCE:-0}" == 1 ]]; then
  [[ "$(git rev-parse --verify refs/remotes/origin/main^{commit})" == "$CANDIDATE" ]] ||
    fail source_candidate_not_archived_main
  case "$MODE" in
    --verify) source_mode=source-verify ;;
    --dry-run) source_mode=source-dry-run ;;
    --apply) source_mode=source-apply ;;
    --rollback) source_mode=source-rollback ;;
  esac
  source_args=(--candidate "$CANDIDATE" --mode "$source_mode")
  [[ "$MODE" != --rollback ]] || source_args+=(--snapshot "$ROLLBACK_SNAPSHOT")
  source_env=(
    "GIT_CONFIG_COUNT=$GIT_CONFIG_COUNT"
    "GIT_CONFIG_KEY_0=$GIT_CONFIG_KEY_0"
    "GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0"
  )
  [[ "$MODE" != --verify ]] || source_env+=("GIT_OPTIONAL_LOCKS=0")
  sudo /usr/bin/env "${source_env[@]}" "$TMP_ROOT/scripts/deploy-hermes-runtime-release.py" "${source_args[@]}"
  printf 'bootstrap-hermes-release: bootstrap-ok candidate=%s\n' "$CANDIDATE"
  exit 0
fi

deploy_args=("$MODE")
[[ "$MODE" != --rollback ]] || deploy_args+=("$ROLLBACK_SNAPSHOT")
env \
  RAN_AGENT_RELEASE_CONTROL_ROOT="$REPO_ROOT" \
  RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" \
  RAN_AGENT_RELEASE_ARTIFACT_ROOT="$ARTIFACT_ROOT" \
  RAN_AGENT_RELEASE_BOOTSTRAP_ROOT="$TMP_ROOT" \
  RAN_AGENT_NODE_BIN="$NODE_BIN_INPUT" \
  RAN_AGENT_SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-}" \
  RAN_AGENT_PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-}" \
  bash "$TMP_ROOT/scripts/deploy-hermes-release.sh" "${deploy_args[@]}"
printf 'bootstrap-hermes-release: bootstrap-ok candidate=%s\n' "$CANDIDATE"
