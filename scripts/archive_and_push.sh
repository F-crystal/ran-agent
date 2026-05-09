#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ARCHIVE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN=1
RUN_TESTS=1
REMOTE_NAME="origin"
REMOTE_URL="${ARCHIVE_REMOTE_URL:-}"
BRANCH_NAME="main"
COMMIT_MESSAGE="${ARCHIVE_COMMIT_MESSAGE:-archive: $(date +%F)}"
ARCHIVE_RECORD="${ARCHIVE_RECORD:-$ROOT_DIR/local_archive/docs/governance/archive/$(date +%F)-archive-and-push.md}"
SENSITIVE_PRESENT=()
STAGED_FILES=()

usage() {
  cat <<'EOF'
Usage: scripts/archive_and_push.sh [--push] [--dry-run] [--skip-tests] [--remote-url URL] [--commit-message MSG] [--record PATH]

Options:
  --push             Run the full archive path, including git commit and push when a remote exists.
  --dry-run          Preflight only. Run checks and print a summary, but do not init git or commit.
  --skip-tests       Skip the baseline test commands.
  --remote-url URL   Add origin with this URL if it is missing.
  --commit-message   Override the commit message.
  --record PATH      Override the archive record output path. Defaults to local_archive/docs/governance/archive/.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

run_cmd() {
  log "+ $*"
  "$@"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --push)
        DRY_RUN=0
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --skip-tests)
        RUN_TESTS=0
        ;;
      --remote-url)
        shift
        [ "$#" -gt 0 ] || die "--remote-url requires a value"
        REMOTE_URL="$1"
        ;;
      --commit-message)
        shift
        [ "$#" -gt 0 ] || die "--commit-message requires a value"
        COMMIT_MESSAGE="$1"
        ;;
      --record)
        shift
        [ "$#" -gt 0 ] || die "--record requires a value"
        ARCHIVE_RECORD="$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
    shift
  done
}

repo_has_git() {
  [ -d "$ROOT_DIR/.git" ]
}

ensure_git_repo() {
  if repo_has_git; then
    return 0
  fi
  if git -C "$ROOT_DIR" init -b "$BRANCH_NAME" >/dev/null 2>&1; then
    return 0
  fi
  run_cmd git -C "$ROOT_DIR" init -q
}

ensure_main_branch() {
  if ! repo_has_git; then
    return 1
  fi
  if git -C "$ROOT_DIR" rev-parse --verify --quiet "$BRANCH_NAME" >/dev/null; then
    run_cmd git -C "$ROOT_DIR" checkout "$BRANCH_NAME"
  else
    run_cmd git -C "$ROOT_DIR" checkout -b "$BRANCH_NAME"
  fi
}

run_baseline_tests() {
  [ "$RUN_TESTS" -eq 1 ] || return 0

  run_cmd env PYTHONPATH="$ROOT_DIR/src" pytest -q \
    "$ROOT_DIR/tests/test_http_server.py" \
    "$ROOT_DIR/tests/test_knowledge_agent.py" \
    "$ROOT_DIR/tests/test_config.py"

  run_cmd npm --prefix "$ROOT_DIR/node_bridge" test
}

collect_sensitive_paths() {
  SENSITIVE_PRESENT=()
  for path in \
    ".env.local" \
    ".openclaw_state" \
    "data" \
    "logs" \
    "debug" \
    "state" \
    "local_archive" \
    "docs/deployment" \
    "docs/governance/archive" \
    "vault/inbox" \
    "vault/raw" \
    "vault/wiki" \
    "vault/.obsidian/workspace.json" \
    "vault/.qwen/settings.json" \
    "vault/.qwen/settings.json.orig" \
    ".npm" \
    ".pytest_cache" \
    ".venv" \
    "node_modules" \
    "__pycache__"
  do
    if [ -e "$ROOT_DIR/$path" ]; then
      SENSITIVE_PRESENT+=("$path")
    fi
  done
}

format_paths() {
  if [ "$#" -eq 0 ]; then
    printf 'none'
    return 0
  fi
  local item
  local first=1
  for item in "$@"; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ', '
    fi
    printf '%s' "$item"
  done
}

collect_stage_candidates() {
  STAGED_FILES=()
  while IFS= read -r -d '' file; do
    STAGED_FILES+=("${file#./}")
  done < <(
    cd "$ROOT_DIR" && find . \
      \( -path './.git' -o -path './.git/*' \
         -o -path './.openclaw_state' -o -path './.openclaw_state/*' \
         -o -path './data' -o -path './data/*' \
         -o -path './logs' -o -path './logs/*' \
         -o -path './debug' -o -path './debug/*' \
         -o -path './state' -o -path './state/*' \
         -o -path './local_archive' -o -path './local_archive/*' \
         -o -path './docs/deployment' -o -path './docs/deployment/*' \
         -o -path './docs/governance/archive' -o -path './docs/governance/archive/*' \
         -o -path './vault/inbox' -o -path './vault/inbox/*' \
         -o -path './vault/raw' -o -path './vault/raw/*' \
         -o -path './vault/wiki' -o -path './vault/wiki/*' \
         -o -path './vault/.obsidian/workspace.json' \
         -o -path './vault/.qwen/settings.json' \
         -o -path './vault/.qwen/settings.json.orig' \
         -o -path './.npm' -o -path './.npm/*' \
         -o -path './.pytest_cache' -o -path './.pytest_cache/*' \
         -o -path './.venv' -o -path './.venv/*' \
         -o -path './node_modules' -o -path './node_modules/*' \
         -o -path './__pycache__' -o -path './__pycache__/*' \
      \) -prune -o -type f -print0
  )
}

ensure_no_sensitive_tracked() {
  repo_has_git || return 0

  local tracked
  tracked="$(git -C "$ROOT_DIR" ls-files)"
  local bad=()
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ -e "$ROOT_DIR/$path" ] || continue
    case "$path" in
      .env|.env.local|.openclaw_state/*|.openclaw_state|data/*|data|logs/*|logs|debug/*|debug|state/*|state|local_archive/*|local_archive|docs/deployment/*|docs/deployment|docs/governance/archive/*|docs/governance/archive|vault/inbox/*|vault/inbox|vault/raw/*|vault/raw|vault/wiki/*|vault/wiki|vault/.obsidian/workspace.json|vault/.qwen/settings.json|vault/.qwen/settings.json.orig|.npm/*|.npm|.pytest_cache/*|.pytest_cache|.venv/*|.venv|node_modules/*|node_modules|__pycache__/*|__pycache__|*.pyc)
        bad+=("$path")
        ;;
    esac
  done <<EOF
$tracked
EOF

  [ "${#bad[@]}" -eq 0 ] || die "sensitive paths are already tracked: $(format_paths "${bad[@]}")"
}

stage_allowed_files() {
  repo_has_git || return 1
  run_cmd git -C "$ROOT_DIR" add -A -- .
  run_cmd git -C "$ROOT_DIR" reset -q -- \
    .env.local \
    .openclaw_state \
    data \
    logs \
    debug \
    state \
    local_archive \
    vault/inbox \
    vault/raw \
    vault/wiki \
    .npm \
    .pytest_cache \
    .venv \
    node_modules \
    __pycache__
}

ensure_no_forbidden_staged() {
  repo_has_git || return 0

  local staged
  staged="$(git -C "$ROOT_DIR" diff --cached --name-status)"
  local bad=()
  local status path
  while IFS=$'\t' read -r status path _rest; do
    [ -n "${path:-}" ] || continue
    if [ "$status" = "D" ]; then
      continue
    fi
    case "$path" in
      .env|.env.local|.openclaw_state/*|.openclaw_state|data/*|data|logs/*|logs|debug/*|debug|state/*|state|local_archive/*|local_archive|docs/deployment/*|docs/deployment|docs/governance/archive/*|docs/governance/archive|vault/inbox/*|vault/inbox|vault/raw/*|vault/raw|vault/wiki/*|vault/wiki|vault/.obsidian/workspace.json|vault/.qwen/settings.json|vault/.qwen/settings.json.orig|.npm/*|.npm|.pytest_cache/*|.pytest_cache|.venv/*|.venv|node_modules/*|node_modules|__pycache__/*|__pycache__|*.pyc)
        bad+=("$path")
        ;;
    esac
  done <<EOF
$staged
EOF

  [ "${#bad[@]}" -eq 0 ] || die "forbidden paths are staged: $(format_paths "${bad[@]}")"
}

commit_changes() {
  repo_has_git || return 1
  if git -C "$ROOT_DIR" diff --cached --quiet; then
    log "nothing to commit"
    return 1
  fi
  run_cmd git -C "$ROOT_DIR" commit -m "$COMMIT_MESSAGE"
}

ensure_origin_remote() {
  repo_has_git || return 1
  if git -C "$ROOT_DIR" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  [ -n "$REMOTE_URL" ] || die "missing remote '$REMOTE_NAME'; set it with --remote-url or add it manually"
  run_cmd git -C "$ROOT_DIR" remote add "$REMOTE_NAME" "$REMOTE_URL"
}

write_archive_record() {
  local commit_sha="$1"
  local push_state="$2"
  local staged_list="$3"

  mkdir -p "$(dirname "$ARCHIVE_RECORD")"
  {
    cat <<EOF
# Archive And Push Record

Status: ARCHIVE

Date: $(date '+%Y-%m-%d')

## Scope

- Ran the archive workflow for the current workspace.
- Baseline tests, sensitive-path checks, git commit, and optional push are all part of this workflow.

## Result

- Commit: \`$commit_sha\`
- Branch: \`$BRANCH_NAME\`
- Remote: \`$REMOTE_NAME\`
- Push: \`$push_state\`

## Tests

- Python baseline: \`PYTHONPATH=src pytest -q tests/test_http_server.py tests/test_knowledge_agent.py tests/test_config.py\`
- Node bridge baseline: \`npm --prefix node_bridge test\`

## Sensitive Paths

- \`.env.local\`
- \`.openclaw_state/\`
- \`data/\`
- \`logs/\`
- \`debug/\`
- \`state/\`
- \`local_archive/\`
- \`docs/deployment/\`
- \`docs/governance/archive/\`
- \`vault/inbox/\`
- \`vault/raw/\`
- \`vault/wiki/\`
- \`vault/.obsidian/workspace.json\`
- \`vault/.qwen/settings.json\`
- \`vault/.qwen/settings.json.orig\`
- \`.npm/\`
- \`.pytest_cache/\`
- \`.venv/\`
- \`node_modules/\`
- \`__pycache__/\`

## Staged Files
EOF
    printf '%s\n' "$staged_list" | sed '/^$/d; s/^/- `/; s/$/`/'
    cat <<'EOF'

## Notes

- Future archive runs should keep push as an explicit action when the operator is ready to publish to the remote.
- Archive and deployment notes are local-only. Keep them under `local_archive/docs/`.
- The record was written by `scripts/archive_and_push.sh`.
EOF
  } >"$ARCHIVE_RECORD"
}

print_summary() {
  local mode="$1"
  local commit_sha="${2:-none}"
  local push_state="${3:-skipped}"

  printf '\n== archive summary ==\n'
  printf 'root: %s\n' "$ROOT_DIR"
  printf 'mode: %s\n' "$mode"
  printf 'tests: %s\n' "$([ "$RUN_TESTS" -eq 1 ] && printf 'ran' || printf 'skipped')"
  printf 'sensitive_present: %s\n' "$(format_paths "${SENSITIVE_PRESENT[@]}")"
  printf 'stage_candidates: %s\n' "${#STAGED_FILES[@]}"
  printf 'commit: %s\n' "$commit_sha"
  printf 'push: %s\n' "$push_state"
  printf 'archive_record: %s\n' "$ARCHIVE_RECORD"
}

main() {
  parse_args "$@"
  collect_sensitive_paths
  collect_stage_candidates

  log "workspace: $ROOT_DIR"
  log "sensitive paths present: $(format_paths "${SENSITIVE_PRESENT[@]}")"
  log "stage candidates: ${#STAGED_FILES[@]}"

  run_baseline_tests
  ensure_no_sensitive_tracked

  if [ "$DRY_RUN" -eq 1 ]; then
    print_summary "dry-run" "none" "skipped"
    exit 0
  fi

  ensure_git_repo
  ensure_main_branch
  ensure_origin_remote
  stage_allowed_files
  ensure_no_forbidden_staged
  commit_changes || {
    print_summary "no-op" "none" "skipped"
    exit 0
  }

  local commit_sha
  local staged_list
  commit_sha="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  staged_list="$(printf '%s\n' "${STAGED_FILES[@]}")"

  run_cmd git -C "$ROOT_DIR" push "$REMOTE_NAME" "$BRANCH_NAME"
  write_archive_record "$commit_sha" "pushed" "$staged_list"
  print_summary "push" "$commit_sha" "pushed"
}

main "$@"
