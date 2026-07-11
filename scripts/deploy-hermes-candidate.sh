#!/usr/bin/env bash

# Discover a reviewed candidate branch (or an already fetched SHA), then pin
# it before entering the same immutable release transaction as main.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"
SOURCE=''
CANDIDATE=''
MODE=''
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf 'deploy-hermes-candidate: failed:worktree_dirty\n' >&2
  exit 1
fi
case "$#" in
  3)
    case "$1" in
      --branch)
        git check-ref-format --branch "$2" >/dev/null || { printf 'deploy-hermes-candidate: failed:branch_invalid\n' >&2; exit 1; }
        git fetch --no-tags origin "refs/heads/$2:refs/remotes/origin/$2"
        CANDIDATE="$(git rev-parse --verify "refs/remotes/origin/$2^{commit}")"
        SOURCE="origin/$2"
        ;;
      --commit)
        [[ "$2" =~ ^[0-9a-f]{40}$ ]] || { printf 'deploy-hermes-candidate: failed:commit_invalid\n' >&2; exit 1; }
        git fetch --no-tags origin "$2"
        CANDIDATE="$(git rev-parse --verify "$2^{commit}")"
        SOURCE="commit:$2"
        ;;
      *) printf 'deploy-hermes-candidate: failed:source_required\n' >&2; exit 1 ;;
    esac
    MODE="$3"
    ;;
  *) printf 'deploy-hermes-candidate: failed:usage\n' >&2; exit 1 ;;
esac
[[ "$MODE" == --dry-run || "$MODE" == --apply ]] || { printf 'deploy-hermes-candidate: failed:mode_invalid\n' >&2; exit 1; }
[[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || { printf 'deploy-hermes-candidate: failed:candidate_digest_invalid\n' >&2; exit 1; }
exec env RAN_AGENT_RELEASE_CANDIDATE="$CANDIDATE" RAN_AGENT_RELEASE_SOURCE="$SOURCE" bash "$REPO_ROOT/scripts/deploy-hermes-release.sh" "$MODE"
