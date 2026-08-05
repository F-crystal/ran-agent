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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail bootstrap_digest_unavailable
  fi
}

MODE="${1:---refuse-mutation}"
CANDIDATE_INPUT="${2:-}"
ROLLBACK_SNAPSHOT=''
case "$MODE" in
  --dry-run|--apply) [[ $# -eq 2 ]] || fail usage ;;
  --rollback) [[ $# -eq 3 ]] || fail usage; ROLLBACK_SNAPSHOT="$3" ;;
  *) fail usage ;;
esac
[[ "$CANDIDATE_INPUT" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid

REPO_ROOT="${RAN_AGENT_RELEASE_CONTROL_ROOT:-/opt/ran_agent}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)" || fail server_root_unavailable
ARTIFACT_ROOT="${RAN_AGENT_RELEASE_ARTIFACT_ROOT:-/opt/ran_agent-release}"
[[ "$ARTIFACT_ROOT" == /* && "$ARTIFACT_ROOT" != "$REPO_ROOT" && "$ARTIFACT_ROOT" != "$REPO_ROOT"/* ]] || fail bootstrap_artifact_root_invalid
cd "$REPO_ROOT"
git diff --quiet || fail worktree_dirty
git diff --cached --quiet || fail index_dirty
[[ -z "$(git ls-files --others --exclude-standard)" ]] || fail worktree_untracked
CANDIDATE="$(git rev-parse --verify "${CANDIDATE_INPUT}^{commit}" 2>/dev/null)" || fail candidate_object_missing
[[ "$CANDIDATE" == "$CANDIDATE_INPUT" ]] || fail candidate_digest_mismatch

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-release-bootstrap.XXXXXX")" || fail bootstrap_temp_unavailable
trap 'rm -rf "$TMP_ROOT"' EXIT
MANIFEST_PATH="docs/governance/hermes_release_bootstrap.v1.sha256"
git show "$CANDIDATE:$MANIFEST_PATH" > "$TMP_ROOT/manifest" || fail bootstrap_manifest_missing

required=(
  scripts/bootstrap-hermes-release.sh
  scripts/deploy-hermes-release.sh
  scripts/resolve-hermes-service-node.sh
  scripts/prune-hermes-release-artifacts.sh
  scripts/check-hermes-snapshot-capacity.py
  scripts/ombre_o1_contract.py
  scripts/verify-runtime-service-identity.sh
)
for path in "${required[@]}"; do
  expected="$(awk -v path="$path" '$2 == path { print $1 }' "$TMP_ROOT/manifest")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail bootstrap_manifest_invalid
  [[ "$(awk -v path="$path" '$2 == path { count += 1 } END { print count + 0 }' "$TMP_ROOT/manifest")" == 1 ]] || fail bootstrap_manifest_invalid
  target="$TMP_ROOT/$path"
  mkdir -p "$(dirname "$target")"
  git show "$CANDIDATE:$path" > "$target" || fail bootstrap_source_missing
  actual="$(sha256_file "$target")" || fail bootstrap_digest_unavailable
  [[ "$actual" == "$expected" ]] || fail bootstrap_digest_mismatch
  chmod 700 "$target"
done
[[ "$(awk 'NF && $1 !~ /^[0-9a-f]{64}$/ { invalid=1 } END { print invalid + 0 }' "$TMP_ROOT/manifest")" == 0 ]] || fail bootstrap_manifest_invalid
[[ "$(awk 'NF { count += 1 } END { print count + 0 }' "$TMP_ROOT/manifest")" == "${#required[@]}" ]] || fail bootstrap_manifest_invalid

NODE_BIN_INPUT="${RAN_AGENT_NODE_BIN:-}"
# The server bootstrap contract owns this legacy compatibility path.  The
# resolver itself never guesses when a wrapper-based old unit is inactive.
if [[ -z "$NODE_BIN_INPUT" && -x /opt/nodejs/node-v22.22.2-linux-x64/bin/node ]]; then
  NODE_BIN_INPUT=/opt/nodejs/node-v22.22.2-linux-x64/bin/node
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
