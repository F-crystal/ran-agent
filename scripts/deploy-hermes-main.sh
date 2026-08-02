#!/usr/bin/env bash

# Discover origin/main, pin it to a SHA, then enter the common transaction.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"
MODE="${1:---refuse-mutation}"
[[ $# -eq 1 && ( "$MODE" == --dry-run || "$MODE" == --apply ) ]] || {
  printf 'deploy-hermes-main: failed:usage\n' >&2
  exit 1
}
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf 'deploy-hermes-main: failed:worktree_dirty\n' >&2
  exit 1
fi

git fetch --no-tags origin main
CANDIDATE="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"
[[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || { printf 'deploy-hermes-main: failed:main_digest_invalid\n' >&2; exit 1; }
BOOTSTRAP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ran-agent-main-bootstrap.XXXXXX")"
trap 'rm -rf "$BOOTSTRAP_ROOT"' EXIT
git show "$CANDIDATE:scripts/bootstrap-hermes-release.sh" > "$BOOTSTRAP_ROOT/bootstrap-hermes-release.sh" || {
  printf 'deploy-hermes-main: failed:bootstrap_missing\n' >&2
  exit 1
}
chmod 700 "$BOOTSTRAP_ROOT/bootstrap-hermes-release.sh"
env RAN_AGENT_RELEASE_SOURCE=origin/main bash "$BOOTSTRAP_ROOT/bootstrap-hermes-release.sh" "$MODE" "$CANDIDATE"
