#!/usr/bin/env bash
set -euo pipefail
ORIGINAL_ARGS=("$@")

ROOT_DIR="${ARCHIVE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [ -n "${ARCHIVE_PYTHON_BIN:-}" ]; then
  PYTHON_BIN="$ARCHIVE_PYTHON_BIN"
elif [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
fi
HELPER="${ARCHIVE_HELPER:-$ROOT_DIR/scripts/archive_transaction_helper.py}"
TARGET_BRANCH="main"
REMOTE_NAME="origin"
DRY_RUN=1
RUN_TESTS=1
MERGE_CURRENT_BRANCH=1
SELF_TEST=0
REMOTE_URL="${ARCHIVE_REMOTE_URL:-}"
COMMIT_MESSAGE="${ARCHIVE_COMMIT_MESSAGE:-archive: $(date +%F)}"
PYTHON_TIMEOUT="${ARCHIVE_PYTHON_TEST_TIMEOUT_SECONDS:-900}"
NODE_TIMEOUT="${ARCHIVE_NODE_TEST_TIMEOUT_SECONDS:-1800}"
HEARTBEAT_SECONDS="${ARCHIVE_TEST_HEARTBEAT_SECONDS:-25}"
PYTHON_TEST_COMMAND="${ARCHIVE_PYTHON_TEST_COMMAND:-PYTHONPATH='$ROOT_DIR/src' '$PYTHON_BIN' -m pytest -q '$ROOT_DIR/tests/test_http_server.py' '$ROOT_DIR/tests/test_knowledge_agent.py' '$ROOT_DIR/tests/test_config.py'}"
NODE_BIN="${ARCHIVE_NODE_BIN:-${RAN_AGENT_NODE_BIN:-}}"
NODE_TEST_COMMAND="${ARCHIVE_NODE_TEST_COMMAND:-}"
ARCHIVE_RECORD="${ARCHIVE_RECORD:-$ROOT_DIR/local_archive/docs/governance/archive/$(date +%F)-archive-and-push.md}"
ARCHIVE_RECORD_EXPLICIT=0
REUSE_VALIDATION=""
SKIP_TESTS_REASON=""
RESUME_ID=""
INTEGRATE_MAIN_INTO_FEATURE=0
STAGE_PATHS=()
TRANSACTION_ID=""
TRANSACTION_DIR=""
JOURNAL=""
LOCK_FILE="$ROOT_DIR/local_archive/runtime/archive-and-push/.flock"
TEMPORARY_REMOTE_SWITCHED=0
TEMPORARY_ORIGINAL_REMOTE=""
SOURCE_BRANCH=""
SOURCE_HEAD=""
EXPECTED_ORIGIN_MAIN=""
LOCAL_MAIN_BEFORE=""
FINAL_HEAD=""
ORIGINAL_FEATURE_BRANCH=""
ORIGINAL_FEATURE_COMMIT=""
ORIGINAL_MAIN_COMMIT=""
ORIGINAL_BASE_COMMIT=""
RECOVERY_MAIN_COMMIT=""
RECOVERY_WORKTREE=""
RECOVERY_MERGE_COMMIT=""
EFFECTIVE_FEATURE_TIP=""
RECOVERY_MERGE_MESSAGE="merge: integrate main for archive recovery"
RECOVERY_PYTHON_COMMAND=""
RECOVERY_NODE_COMMAND=""
RECOVERY_NODE_VERSION=""
RECOVERY_ORIGINAL_EVIDENCE_PATH=""
RECOVERY_ORIGINAL_EVIDENCE_CHECKSUM=""
RECOVERY_VALIDATION_FAILURE_REASON=""
RECOVERY_OVERRIDE_PYTHON=0
RECOVERY_OVERRIDE_NODE=0
LEGACY_STUCK_RECOVERY=0
LEGACY_MAIN_WORKTREE=""
LEGACY_EVIDENCE_SOURCE=""
json_quote() { printf '%s' "$1" | "$PYTHON_BIN" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
json_or_null() { [ -n "$1" ] && json_quote "$1" || printf null; }
repo_relative_path() {
  local path
  path="$(canonical_path "$1")" || return 1
  case "$path" in "$ROOT_DIR"/*) printf '%s\n' "${path#"$ROOT_DIR"/}" ;; *) return 1 ;; esac
}
canonical_path() { "$PYTHON_BIN" -c 'import os,sys; print(os.path.realpath(os.path.abspath(sys.argv[1])))' "$1"; }
ensure_archive_record_path() {
  local archive_root resolved
  archive_root="$(canonical_path "$ROOT_DIR/local_archive")" || return 1
  resolved="$(canonical_path "$ARCHIVE_RECORD")" || return 1
  case "$resolved" in "$archive_root"/*) ARCHIVE_RECORD="$resolved" ;; *) return 1 ;; esac
}
archive_record_for_transaction() {
  case "$1" in
    *.md) printf '%s-%s.md\n' "${1%.md}" "$TRANSACTION_ID" ;;
    *) printf '%s-%s\n' "$1" "$TRANSACTION_ID" ;;
  esac
}
select_default_archive_record() {
  [ ! -e "$ARCHIVE_RECORD" ] || [ "$ARCHIVE_RECORD_EXPLICIT" -eq 0 ] || die "archive record already exists: $ARCHIVE_RECORD"
  [ ! -e "$ARCHIVE_RECORD" ] || ARCHIVE_RECORD="$(archive_record_for_transaction "$ARCHIVE_RECORD")"
  ensure_archive_record_path || die "archive record must stay inside $ROOT_DIR/local_archive"
  [ ! -e "$ARCHIVE_RECORD" ] || die "transaction archive record already exists: $ARCHIVE_RECORD"
}
select_resumable_archive_record() {
  [ -e "$ARCHIVE_RECORD" ] || return 0
  helper archive-verify --journal "$JOURNAL" --record "$ARCHIVE_RECORD" >/dev/null 2>&1 && return 0
  case "$ARCHIVE_RECORD" in *-"$TRANSACTION_ID".md|*-"$TRANSACTION_ID") return 1 ;; esac
  local previous candidate relative
  previous="$(repo_relative_path "$ARCHIVE_RECORD")" || return 1
  candidate="$(archive_record_for_transaction "$ARCHIVE_RECORD")"
  ARCHIVE_RECORD="$candidate"
  ensure_archive_record_path || return 1
  candidate="$ARCHIVE_RECORD"
  if [ -e "$candidate" ]; then
    helper archive-verify --journal "$JOURNAL" --record "$candidate" >/dev/null 2>&1 || return 1
  fi
  relative="$(repo_relative_path "$ARCHIVE_RECORD")" || return 1
  journal_update --set-json "archive_record_previous_path=$(json_quote "$previous")" --set-json "archive_record_path=$(json_quote "$relative")"
}
local_archive_path() {
  case "$1" in local_archive/*) ;; *) return 1 ;; esac
  local archive_root candidate
  archive_root="$(canonical_path "$ROOT_DIR/local_archive")"
  candidate="$(canonical_path "$ROOT_DIR/$1")"
  case "$candidate" in "$archive_root"/*) printf '%s\n' "$candidate" ;; *) return 1 ;; esac
}

usage() {
  cat <<'EOF'
Usage: scripts/archive_and_push.sh [--push] [--dry-run] [--skip-tests --skip-tests-reason TEXT] [--reuse-validation PATH] [--resume ID [--integrate-main-into-feature]] [--remote-url URL] [--commit-message MSG] [--record PATH] [--path PATH] [--no-merge-current-branch] [--self-test]

--push                    Run a journaled archive transaction, ff merge to main, and push.
--reuse-validation PATH   Reuse a verified validation record for the exact clean HEAD.
--resume ID               Resume only the next provably safe phase of a prior transaction.
--integrate-main-into-feature
                          Explicitly recover a merge/failed ff-only divergence transaction.
--skip-tests-reason TEXT  Required whenever --skip-tests is used.
EOF
}

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run_cmd() { log "+ $*"; "$@"; }
realpath_of() { cd "$1" && pwd -P; }
helper() { "$PYTHON_BIN" "$HELPER" "$@"; }
journal_update() { helper journal-update --path "$JOURNAL" "$@"; }
journal_get() { helper journal-get --path "$JOURNAL" --field "$1"; }

node_supported() {
  local executable="$1" version major minor patch
  [ "${executable#/}" != "$executable" ] && [ -x "$executable" ] || return 1
  version="$("$executable" -p 'process.versions.node' 2>/dev/null)" || return 1
  IFS=. read -r major minor patch <<EOF
$version
EOF
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 1
  (( major > 22 || (major == 22 && minor >= 13) ))
}

resolve_archive_node() {
  local candidate found=''
  if [ -n "$NODE_BIN" ]; then
    node_supported "$NODE_BIN" || die "ARCHIVE_NODE_BIN/RAN_AGENT_NODE_BIN must be an absolute executable Node >=22.13"
    return 0
  fi
  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ] && node_supported "$candidate"; then
    NODE_BIN="$candidate"
    return 0
  fi
  if [ -n "${NVM_DIR:-}" ] && [ "${NVM_DIR#/}" != "$NVM_DIR" ] && [ -d "$NVM_DIR/versions/node" ]; then
    for candidate in "$NVM_DIR"/versions/node/*/bin/node; do
      [ -e "$candidate" ] || continue
      node_supported "$candidate" && found="$candidate"
    done
  fi
  [ -n "$found" ] || die "no absolute Node >=22.13 available; set ARCHIVE_NODE_BIN"
  NODE_BIN="$found"
}

configure_node_test_command() {
  local quoted_node quoted_bridge
  [ -z "$NODE_TEST_COMMAND" ] || return 0
  resolve_archive_node
  printf -v quoted_node '%q' "$NODE_BIN"
  printf -v quoted_bridge '%q' "$ROOT_DIR/node_bridge"
  NODE_TEST_COMMAND="cd $quoted_bridge && $quoted_node --test"
}

archive_node_version() {
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then "$NODE_BIN" --version 2>/dev/null || printf unavailable; else printf unavailable; fi
}
archive_python_supported() {
  [ "${PYTHON_BIN#/}" != "$PYTHON_BIN" ] && [ -x "$PYTHON_BIN" ] || return 1
  "$PYTHON_BIN" -c 'import fcntl,os,sys; raise SystemExit(0 if sys.version_info >= (3,9) and hasattr(os,"link") and hasattr(os,"O_DIRECTORY") else 1)' >/dev/null 2>&1
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --push) DRY_RUN=0 ;;
      --dry-run) DRY_RUN=1 ;;
      --skip-tests) RUN_TESTS=0 ;;
      --skip-tests-reason) shift; [ "$#" -gt 0 ] || die "--skip-tests-reason requires text"; SKIP_TESTS_REASON="$1" ;;
      --reuse-validation) shift; [ "$#" -gt 0 ] || die "--reuse-validation requires a path"; REUSE_VALIDATION="$1" ;;
      --resume) shift; [ "$#" -gt 0 ] || die "--resume requires a transaction id"; RESUME_ID="$1"; DRY_RUN=0 ;;
      --integrate-main-into-feature) INTEGRATE_MAIN_INTO_FEATURE=1 ;;
      --remote-url) shift; [ "$#" -gt 0 ] || die "--remote-url requires a URL"; REMOTE_URL="$1" ;;
      --commit-message) shift; [ "$#" -gt 0 ] || die "--commit-message requires text"; COMMIT_MESSAGE="$1" ;;
      --record) shift; [ "$#" -gt 0 ] || die "--record requires a path"; ARCHIVE_RECORD="$1"; ARCHIVE_RECORD_EXPLICIT=1 ;;
      --path) shift; [ "$#" -gt 0 ] || die "--path requires a path"; STAGE_PATHS+=("$1") ;;
      --no-merge-current-branch) MERGE_CURRENT_BRANCH=0 ;;
      --self-test) SELF_TEST=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
    shift
  done
  [ "$RUN_TESTS" -eq 1 ] || [ -n "$SKIP_TESTS_REASON" ] || die "--skip-tests requires --skip-tests-reason"
  [ -z "$REUSE_VALIDATION" ] || [ "$RUN_TESTS" -eq 1 ] || die "--reuse-validation cannot be combined with --skip-tests"
  if [ "$INTEGRATE_MAIN_INTO_FEATURE" -eq 1 ]; then
    [ -n "$RESUME_ID" ] || die "--integrate-main-into-feature requires --resume ID"
    [ "$RUN_TESTS" -eq 1 ] || die "divergence recovery cannot skip tests"
    [ -z "$REUSE_VALIDATION" ] || die "divergence recovery must rerun validation"
  fi
}

redact_remote_url() {
  local url="${1%%\?*}"
  case "$url" in http://*@*|https://*@*) printf '%s://***@%s\n' "${url%%://*}" "${url#*@}" ;; *) printf '%s\n' "$url" ;; esac
}
github_https_to_ssh() { case "$1" in https://github.com/*/*.git) printf 'git@github.com:%s\n' "${1#https://github.com/}" ;; https://github.com/*/*) printf 'git@github.com:%s.git\n' "${1#https://github.com/}" ;; *) return 1 ;; esac; }
github_ssh_to_https() { case "$1" in git@github.com:*.git) printf 'https://github.com/%s\n' "${1#git@github.com:}" ;; git@github.com:*) printf 'https://github.com/%s.git\n' "${1#git@github.com:}" ;; ssh://git@github.com/*.git) printf 'https://github.com/%s\n' "${1#ssh://git@github.com/}" ;; ssh://git@github.com/*) printf 'https://github.com/%s.git\n' "${1#ssh://git@github.com/}" ;; *) return 1 ;; esac; }
alternate_remote_url() { github_https_to_ssh "$1" || github_ssh_to_https "$1"; }

worktree_clean() { [ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all | awk '$2 !~ /^local_archive\//')" ]; }
ensure_repo() { git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a Git repository: $ROOT_DIR"; }
ensure_origin() { git -C "$ROOT_DIR" remote get-url "$REMOTE_NAME" >/dev/null 2>&1 || { [ -n "$REMOTE_URL" ] && run_cmd git -C "$ROOT_DIR" remote add "$REMOTE_NAME" "$REMOTE_URL" || die "missing remote '$REMOTE_NAME'"; }; }
fetch_and_check_origin() {
  local remote_sha
  if ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then fail fetch 44; fi
  if ! remote_sha="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"; then fail fetch 44; fi
  [ "$remote_sha" = "$EXPECTED_ORIGIN_MAIN" ] || fail remote_race 40
}

restore_temporary_remote() {
  [ "$TEMPORARY_REMOTE_SWITCHED" -eq 1 ] || return 0
  git -C "$ROOT_DIR" remote set-url "$REMOTE_NAME" "$TEMPORARY_ORIGINAL_REMOTE" || return 1
  TEMPORARY_REMOTE_SWITCHED=0
}

write_archive_record() {
  if [ -e "$ARCHIVE_RECORD" ] || [ -L "$ARCHIVE_RECORD" ]; then
    helper archive-verify --journal "$JOURNAL" --record "$ARCHIVE_RECORD" >/dev/null 2>&1
    return
  fi
  local changed_file="$TRANSACTION_DIR/changed-files.txt" commits_file="$TRANSACTION_DIR/included-commits.txt" temporary="$TRANSACTION_DIR/archive-record.md"
  rm -f "$temporary" || return 1
  local archive_head
  archive_head="$(journal_get head_sha)" || return 1
  git -C "$ROOT_DIR" diff --name-status "$EXPECTED_ORIGIN_MAIN" "$archive_head" >"$changed_file" || return 1
  git -C "$ROOT_DIR" log --reverse --format='%H %s' "$EXPECTED_ORIGIN_MAIN..$archive_head" >"$commits_file" || return 1
  helper archive-render --journal "$JOURNAL" --output "$temporary" --included-commits-file "$commits_file" --changed-files-file "$changed_file" --remote "$REMOTE_NAME" || return 1
  helper archive-verify --journal "$JOURNAL" --record "$temporary" || return 1
  local publish_status=0
  helper archive-publish --root "$ROOT_DIR" --source "$temporary" --target "$ARCHIVE_RECORD" || publish_status=$?
  case "$publish_status" in
    0) ;;
    17) helper archive-verify --journal "$JOURNAL" --record "$ARCHIVE_RECORD" >/dev/null 2>&1 || return 1 ;;
    *) return 1 ;;
  esac
}

write_failure_summary() {
  [ -n "$TRANSACTION_DIR" ] || return 0
  {
    printf '# Archive And Push Failure\n\n'
    printf 'transaction_id=%s\nphase=%s\nphase_status=%s\nfailure_stage=%s\nfailure_code=%s\n' "$TRANSACTION_ID" "$(journal_get phase 2>/dev/null || true)" "$(journal_get phase_status 2>/dev/null || true)" "$(journal_get failure_stage 2>/dev/null || true)" "$(journal_get failure_code 2>/dev/null || true)"
  } >"$TRANSACTION_DIR/failure-summary.md"
}

fail() {
  local stage="$1" code="$2"
  [ -z "$JOURNAL" ] || journal_update --phase-status failed --failure-stage "$stage" --failure-code "$code" || true
  [ -z "$JOURNAL" ] || write_failure_summary || true
  exit "$code"
}
on_signal() {
  if [ -n "$JOURNAL" ] && [ "$TEMPORARY_REMOTE_SWITCHED" -eq 1 ]; then
    if [ "$INTEGRATE_MAIN_INTO_FEATURE" -eq 1 ]; then
      restore_temporary_remote || journal_update --set-json 'recovery_push_result.original_remote_url_restored=false' || true
    else
      restore_temporary_remote || journal_update --set-json 'push_result.original_remote_url_restored=false' || true
    fi
  fi
  if [ -n "$JOURNAL" ]; then
    if [ "$INTEGRATE_MAIN_INTO_FEATURE" -eq 1 ]; then recovery_event recovery/failed interrupted signal || true
    else journal_update --phase-status interrupted --failure-stage signal --failure-code 130 || true
    fi
  fi
  exit 130
}
trap on_signal INT TERM

begin_transaction() {
  ensure_repo
  ensure_origin
  SOURCE_BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
  [ -n "$SOURCE_BRANCH" ] || die "detached HEAD is not resumable"
  [ "$SOURCE_BRANCH" = "$TARGET_BRANCH" ] || [ "$MERGE_CURRENT_BRANCH" -eq 1 ] || die "--no-merge-current-branch is unsafe for a non-main source branch"
  SOURCE_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  select_default_archive_record
  run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"
  EXPECTED_ORIGIN_MAIN="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"
  LOCAL_MAIN_BEFORE="$(git -C "$ROOT_DIR" rev-parse "$TARGET_BRANCH")"
  TRANSACTION_DIR="$ROOT_DIR/local_archive/runtime/archive-and-push/$TRANSACTION_ID"
  JOURNAL="$TRANSACTION_DIR/transaction.json"
  helper journal-init --path "$JOURNAL" --transaction-id "$TRANSACTION_ID" --repository "$ROOT_DIR" --source-branch "$SOURCE_BRANCH" --source-head "$SOURCE_HEAD" --target-branch "$TARGET_BRANCH" --expected-origin-main "$EXPECTED_ORIGIN_MAIN" --local-main-before "$LOCAL_MAIN_BEFORE" --archive-record-path "$(repo_relative_path "$ARCHIVE_RECORD")"
  mkdir -p "$TRANSACTION_DIR/logs"
  FINAL_HEAD="$SOURCE_HEAD"
  journal_update --phase-status succeeded
}

resume_transaction() {
  case "$RESUME_ID" in *[!A-Za-z0-9TtZz_-]*|'') die "invalid transaction id" ;; esac
  TRANSACTION_ID="$RESUME_ID"
  TRANSACTION_DIR="$ROOT_DIR/local_archive/runtime/archive-and-push/$TRANSACTION_ID"
  JOURNAL="$TRANSACTION_DIR/transaction.json"
  [ -f "$JOURNAL" ] || die "transaction journal not found: $TRANSACTION_ID"
  [ "$(journal_get repository_realpath)" = "$(realpath_of "$ROOT_DIR")" ] || die "journal repository does not match"
  SOURCE_BRANCH="$(journal_get source_branch)"; SOURCE_HEAD="$(journal_get source_head)"; EXPECTED_ORIGIN_MAIN="$(journal_get expected_origin_main)"; LOCAL_MAIN_BEFORE="$(journal_get local_main_before)"
  ARCHIVE_RECORD="$ROOT_DIR/$(journal_get archive_record_path)"; ensure_archive_record_path || die "journal archive record is outside local_archive"
  ensure_repo; ensure_origin
  if [ "$INTEGRATE_MAIN_INTO_FEATURE" -eq 1 ]; then
    if [ "$(journal_optional recovery_phase)" != recovery/completed ]; then
      begin_recovery_entry_attempt
    fi
    if ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then
      recovery_entry_fetch_fail "unable to fetch origin during recovery preflight" 96
    fi
  elif ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then
    fail fetch 44
  fi
}

run_one_test() {
  local name="$1" command="$2" timeout="$3" log_path="$TRANSACTION_DIR/logs/$1-baseline.log" result_path="$TRANSACTION_DIR/$1-result.json"
  helper run --log "$log_path" --result-file "$result_path" --timeout-seconds "$timeout" --heartbeat-seconds "$HEARTBEAT_SECONDS" -- bash -lc "$command" || true
  [ -f "$result_path" ] || fail validation 31
  journal_update --set-json "test_results.$name=$(cat "$result_path")"
  local status
  status="$(journal_get "test_results.$name.status")"
  [ "$status" = passed ] || { persist_validation_provenance "$status" "$SOURCE_HEAD" executed "" "" "" "" || fail validation 35; fail validation 32; }
}

persist_validation_provenance() {
  local status="$1" head="$2" source="$3" path="$4" checksum="$5" completed="$6" skip_reason="$7"
  journal_update \
    --set-json "validation_status=$(json_or_null "$status")" \
    --set-json "validated_head=$(json_or_null "$head")" \
    --set-json "validation_source=$(json_or_null "$source")" \
    --set-json "validation_record_path=$(json_or_null "$path")" \
    --set-json "validation_record_checksum=$(json_or_null "$checksum")" \
    --set-json "validation_completed_at=$(json_or_null "$completed")" \
    --set-json "validation_skip_reason=$(json_or_null "$skip_reason")" || return 1
  journal_field_matches validation_status "$status" || return 1
  journal_field_matches validated_head "$head" || return 1
  journal_field_matches validation_source "$source" || return 1
  journal_field_matches validation_record_path "$path" || return 1
  journal_field_matches validation_record_checksum "$checksum" || return 1
  journal_field_matches validation_completed_at "$completed" || return 1
  journal_field_matches validation_skip_reason "$skip_reason" || return 1
}

accepted_validation_field() {
  local field="$1" record="$2"
  "$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$record" "$field"
}

accepted_validation_json_field() {
  local field="$1" record="$2"
  "$PYTHON_BIN" -c 'import json,sys; json.dump(json.load(open(sys.argv[1]))[sys.argv[2]], sys.stdout, separators=(",", ":"))' "$record" "$field"
}

journal_field_matches() {
  local field="$1" expected="$2" actual
  actual="$(journal_get "$field")"
  [ "$actual" = "$expected" ] || { [ -z "$expected" ] && [ -z "$actual" ]; }
}

validate_persisted_provenance() {
  local status head source path checksum record
  status="$(journal_get validation_status)"; head="$(journal_get validated_head)"; source="$(journal_get validation_source)"; path="$(journal_get validation_record_path)"; checksum="$(journal_get validation_record_checksum)"
  case "$status" in
    reused)
      [ "$head" = "$SOURCE_HEAD" ] && [ "$source" = validation_record ] && [ -n "$path" ] && [ -n "$checksum" ] || return 1
      [ "$(git -C "$ROOT_DIR" rev-parse "$SOURCE_BRANCH")" = "$head" ] || return 1
      record="$(local_archive_path "$path")" || return 1
      [ -f "$record" ] && worktree_clean || return 1
      helper validation-verify --record "$record" --repository "$ROOT_DIR" --head "$head" --worktree-clean true >/dev/null || return 1
      [ "$(accepted_validation_field checksum "$record")" = "$checksum" ]
      ;;
    ran)
      [ "$head" = "$SOURCE_HEAD" ] && [ "$source" = executed ] && [ -n "$path" ] && [ -n "$checksum" ] || return 1
      record="$(local_archive_path "$path")" || return 1
      [ -f "$record" ] || return 1
      helper validation-verify --record "$record" --repository "$ROOT_DIR" --head "$head" --worktree-clean false >/dev/null || return 1
      [ "$(accepted_validation_field checksum "$record")" = "$checksum" ]
      ;;
    skipped) [ -z "$head" ] && [ "$source" = operator_skip ] && [ -n "$(journal_get validation_skip_reason)" ] ;;
    failed|timed_out|interrupted) return 1 ;;
    *) return 1 ;;
  esac
}

validate() {
  journal_update --phase validation --phase-status running
  if [ -n "$REUSE_VALIDATION" ]; then
    worktree_clean || fail validation 33
    [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || fail validation 34
    local accepted="$TRANSACTION_DIR/accepted-validation.json" relative head checksum completed repository
    helper validation-verify --record "$REUSE_VALIDATION" --repository "$ROOT_DIR" --head "$SOURCE_HEAD" --worktree-clean true >"$accepted" || fail validation 34
    relative="$(repo_relative_path "$REUSE_VALIDATION")" || fail validation 34
    head="$(accepted_validation_field head_sha "$accepted")"; checksum="$(accepted_validation_field checksum "$accepted")"; completed="$(accepted_validation_field completed_at "$accepted")"; repository="$(accepted_validation_field repository_realpath "$accepted")"
    [ "$head" = "$SOURCE_HEAD" ] && [ "$repository" = "$(realpath_of "$ROOT_DIR")" ] || fail validation 34
    persist_validation_provenance reused "$head" validation_record "$relative" "$checksum" "$completed" "" || fail validation 35
    journal_update --set-json "test_results=$(accepted_validation_json_field per_command_status "$accepted")" || fail validation 35
  elif [ "$RUN_TESTS" -eq 0 ]; then
    persist_validation_provenance skipped "" operator_skip "" "" "" "$SKIP_TESTS_REASON" || fail validation 35
    journal_update --set-json "test_results={\"status\":\"skipped\",\"reason\":$(json_quote "$SKIP_TESTS_REASON")}" || fail validation 35
  else
    configure_node_test_command
    run_one_test python "$PYTHON_TEST_COMMAND" "$PYTHON_TIMEOUT"
    run_one_test node "$NODE_TEST_COMMAND" "$NODE_TIMEOUT"
    [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || fail validation 36
    local created="$TRANSACTION_DIR/validation-record.json" checksum completed
    helper validation-create --journal "$JOURNAL" --output "$created" --repository "$ROOT_DIR" --branch "$SOURCE_BRANCH" --base-sha "$EXPECTED_ORIGIN_MAIN" --head "$SOURCE_HEAD" --worktree-clean "$(worktree_clean && printf true || printf false)" --node-version "$(archive_node_version)" --python-version "$($PYTHON_BIN --version 2>&1)" --commands-json "$(printf '[%s,%s]' "$(json_quote "$PYTHON_TEST_COMMAND")" "$(json_quote "$NODE_TEST_COMMAND")")" || fail validation 35
    checksum="$(accepted_validation_field checksum "$created")"; completed="$(accepted_validation_field completed_at "$created")"
    persist_validation_provenance ran "$SOURCE_HEAD" executed "$(repo_relative_path "$created")" "$checksum" "$completed" "" || fail validation 35
  fi
  journal_update --phase-status succeeded
}

stage_and_commit() {
  validate_persisted_provenance || fail staging 41
  [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] || fail staging 42
  [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || fail staging 43
  journal_update --phase staging --phase-status running
  if ! run_cmd git -C "$ROOT_DIR" reset -q; then fail staging 45; fi
  if [ "${#STAGE_PATHS[@]}" -gt 0 ]; then
    if ! run_cmd git -C "$ROOT_DIR" add -- "${STAGE_PATHS[@]}"; then fail staging 46; fi
  else
    if ! run_cmd git -C "$ROOT_DIR" add -A -- .; then fail staging 46; fi
  fi
  if ! run_cmd git -C "$ROOT_DIR" reset -q -- .env .env.local .ran_agent_state .openclaw_state data logs debug state local_archive vault/inbox vault/raw vault/wiki .npm .pytest_cache .venv node_bridge/.ran_agent_state node_modules __pycache__; then fail staging 47; fi
  journal_update --phase-status succeeded
  journal_update --phase commit --phase-status running
  if git -C "$ROOT_DIR" diff --cached --quiet; then
    FINAL_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
    journal_update --phase-status succeeded --set-json "commit_result={\"status\":\"precommitted_branch\"}" --set-json "head_sha=$(json_quote "$FINAL_HEAD")"
    return 0
  fi
  if git -C "$ROOT_DIR" commit -m "$COMMIT_MESSAGE"; then
    FINAL_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
    journal_update --phase-status succeeded --set-json "commit_result={\"status\":\"succeeded\",\"commit_sha\":\"$FINAL_HEAD\"}" --set-json "head_sha=$(json_quote "$FINAL_HEAD")"
  else
    fail commit 50
  fi
}

# Advance the target branch to FINAL_HEAD without ever checking it out in the
# source worktree.  Divergence is detected by ancestry before any mutation and
# is reported as the structured ff-only failure (64).  When another worktree
# holds the target branch, the fast-forward runs inside that worktree after
# strict verification; the holding worktree is never released, removed, or
# switched.
merge_to_main() {
  journal_update --phase merge --phase-status running
  fetch_and_check_origin
  [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] || fail merge 61
  [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || fail merge 62
  worktree_clean || fail merge 63
  [ "$SOURCE_BRANCH" = "$TARGET_BRANCH" ] || [ "$MERGE_CURRENT_BRANCH" -eq 1 ] || fail merge 60
  if [ "$SOURCE_BRANCH" != "$TARGET_BRANCH" ]; then advance_target_branch_ff; fi
  journal_update --phase-status succeeded --set-json "merge_result={\"status\":\"succeeded\",\"head\":\"$FINAL_HEAD\"}"
}

advance_target_branch_ff() {
  local target_sha target_worktree
  if ! target_sha="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")"; then fail merge 65; fi
  # Ancestry gate before any checkout/merge mutation: controlled divergence.
  if ! git -C "$ROOT_DIR" merge-base --is-ancestor "$target_sha" "$FINAL_HEAD"; then
    fail merge 64
  fi
  target_worktree="$(worktree_for_branch "$TARGET_BRANCH")"
  if [ -z "$target_worktree" ]; then
    if ! run_cmd git -C "$ROOT_DIR" update-ref "refs/heads/$TARGET_BRANCH" "$FINAL_HEAD" "$target_sha"; then
      fail merge 65
    fi
    return 0
  fi
  verify_target_worktree "$target_worktree" "$target_sha"
  if ! run_cmd git -C "$target_worktree" merge --ff-only "$FINAL_HEAD"; then
    fail merge 65
  fi
}

verify_target_worktree() {
  local worktree="$1" target_sha="$2"
  [ "$(canonical_path "$worktree")" != "$(canonical_path "$ROOT_DIR")" ] || fail merge 65
  [ "$(git_common_dir "$worktree")" = "$(git_common_dir "$ROOT_DIR")" ] || fail merge 65
  [ "$(git -C "$worktree" branch --show-current)" = "$TARGET_BRANCH" ] || fail merge 65
  [ "$(git -C "$worktree" rev-parse HEAD)" = "$EXPECTED_ORIGIN_MAIN" ] || fail merge 65
  [ "$target_sha" = "$EXPECTED_ORIGIN_MAIN" ] || fail merge 65
  [ -z "$(git -C "$worktree" status --porcelain --untracked-files=all | awk '$2 !~ /^local_archive\//')" ] || fail merge 65
  git -C "$worktree" diff --cached --quiet || fail merge 65
  if git_operation_in_progress "$worktree"; then fail merge 65; fi
}

push_main() {
  journal_update --phase push --phase-status running
  fetch_and_check_origin
  [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || fail push 71
  local main_sha original alt
  if ! main_sha="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")"; then fail push 71; fi
  [ "$main_sha" = "$FINAL_HEAD" ] || fail push 71
  original="$(git -C "$ROOT_DIR" config --get "remote.$REMOTE_NAME.url")"
  journal_update --set-json "push_result={\"status\":\"running\",\"local_main_advanced\":true,\"head\":\"$FINAL_HEAD\"}"
  if git -C "$ROOT_DIR" push "$REMOTE_NAME" "$TARGET_BRANCH"; then
    journal_update --phase-status succeeded --set-json "push_result={\"status\":\"succeeded\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"succeeded\",\"alternate_attempted\":false,\"original_remote_url_restored\":true}"
    return 0
  else
    alt="$(alternate_remote_url "$original" || true)"
    [ -n "$alt" ] || { journal_update --set-json "push_result={\"status\":\"failed\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"failed\",\"alternate_attempted\":false,\"original_remote_url_restored\":true}"; fail push 72; }
    log "push retry via $(redact_remote_url "$alt")"
    git -C "$ROOT_DIR" remote set-url "$REMOTE_NAME" "$alt" || fail push 73
    TEMPORARY_ORIGINAL_REMOTE="$original"; TEMPORARY_REMOTE_SWITCHED=1
    if git -C "$ROOT_DIR" push "$REMOTE_NAME" "$TARGET_BRANCH"; then
      if restore_temporary_remote; then
        journal_update --phase-status succeeded --set-json "push_result={\"status\":\"succeeded\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"failed\",\"alternate_attempted\":true,\"alternate_push\":\"succeeded\",\"original_remote_url_restored\":true}"
        return 0
      fi
      journal_update --set-json "push_result={\"status\":\"failed\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"failed\",\"alternate_attempted\":true,\"alternate_push\":\"succeeded\",\"original_remote_url_restored\":false}"
      fail push 74
    fi
    if restore_temporary_remote; then
      journal_update --set-json "push_result={\"status\":\"failed\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"failed\",\"alternate_attempted\":true,\"alternate_push\":\"failed\",\"original_remote_url_restored\":true}"
      fail push 75
    fi
    journal_update --set-json "push_result={\"status\":\"failed\",\"head\":\"$FINAL_HEAD\",\"local_main_advanced\":true,\"primary_push\":\"failed\",\"alternate_attempted\":true,\"alternate_push\":\"failed\",\"original_remote_url_restored\":false}"
    fail push 76
  fi
}

archive_success() {
  journal_update --phase archive --phase-status running
  write_archive_record ARCHIVE || fail archive 81
  journal_update --phase-status succeeded --set-json 'archive_result={"status":"succeeded"}'
  journal_update --phase completed --phase-status succeeded
}

journal_optional() { journal_get "$1" 2>/dev/null || true; }
utc_now() { date -u +%FT%TZ; }

recovery_event() {
  local phase="$1" status="$2" reason="${3:-}" history updated
  history="$(journal_optional recovery_history)"
  [ -n "$history" ] || history='[]'
  updated="$($PYTHON_BIN -c 'import json,sys; value=json.loads(sys.argv[1]); value.append({"at":sys.argv[5],"phase":sys.argv[2],"status":sys.argv[3],"reason":sys.argv[4] or None}); print(json.dumps(value,separators=(",",":")))' "$history" "$phase" "$status" "$reason" "$(utc_now)")" || return 1
  journal_update \
    --set-json "recovery_history=$updated" \
    --set-json "recovery_phase=$(json_quote "$phase")" \
    --set-json "recovery_failure_reason=$(json_or_null "$reason")"
}

recovery_fail() {
  local reason="$1" code="${2:-90}"
  recovery_event recovery/failed failed "$reason" || true
  printf 'ERROR: divergence recovery refused: %s\n' "$reason" >&2
  exit "$code"
}

record_recovery_request() {
  [ -z "$(journal_optional recovery_requested_at)" ] || return 0
  journal_update \
    --set-json 'recovery_mode="integrate_main_into_feature"' \
    --set-json 'recovery_authorized=false' \
    --set-json "recovery_requested_at=$(json_quote "$(utc_now)")" \
    --set-json 'recovery_phase="recovery/preflight"' \
    --set-json 'recovery_failure_reason=null' \
    --set-json 'recovery_history=[]'
  recovery_event recovery/preflight requested "operator explicitly selected divergence recovery"
}

begin_recovery_entry_attempt() {
  local original_failure
  record_recovery_request
  if [ -z "$(journal_optional original_failure)" ]; then
    original_failure="$($PYTHON_BIN -c 'import json,sys
keys=("phase","phase_status","failure_stage","failure_code")
values=[value or None for value in sys.argv[1:]]
print(json.dumps(dict(zip(keys,values)),separators=(",",":")))' "$(journal_optional phase)" "$(journal_optional phase_status)" "$(journal_optional failure_stage)" "$(journal_optional failure_code)")"
    journal_update --set-json "original_failure=$original_failure"
  fi
  journal_update --set-json 'recovery_phase_status="running"'
  recovery_event recovery/preflight running "recovery entry preflight started"
}

recovery_entry_fetch_fail() {
  local reason="$1" code="$2"
  journal_update \
    --phase-status failed \
    --failure-stage recovery_fetch \
    --failure-code "$code" \
    --set-json 'recovery_phase_status="failed"' || true
  recovery_event recovery/preflight failed "$reason" || true
  write_failure_summary || true
  printf 'ERROR: divergence recovery refused: %s\n' "$reason" >&2
  exit "$code"
}

worktree_for_branch() {
  git -C "$ROOT_DIR" worktree list --porcelain | awk -v wanted="refs/heads/$1" '
    /^worktree / { path=substr($0,10) }
    $0 == "branch " wanted { print path; exit }
  '
}

git_common_dir() {
  local worktree="$1" common
  common="$(git -C "$worktree" rev-parse --git-common-dir)" || return 1
  case "$common" in /*) canonical_path "$common" ;; *) canonical_path "$worktree/$common" ;; esac
}

git_operation_in_progress() {
  local worktree="$1" marker path
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge; do
    path="$(git -C "$worktree" rev-parse --git-path "$marker")" || return 0
    [ ! -e "$path" ] || return 0
  done
  return 1
}

related_worktrees_safe() {
  local branch worktree seen=""
  for branch in "$ORIGINAL_FEATURE_BRANCH" "$TARGET_BRANCH"; do
    worktree="$(worktree_for_branch "$branch")"
    [ -n "$worktree" ] || continue
    case " $seen " in *" $worktree "*) continue ;; esac
    seen="$seen $worktree"
    [ -z "$(git -C "$worktree" status --porcelain --untracked-files=all | awk '$2 !~ /^local_archive\//')" ] || return 1
    git_operation_in_progress "$worktree" && return 1
  done
  return 0
}

commit_has_recovery_parents() {
  local commit="$1" parents
  git -C "$ROOT_DIR" cat-file -e "$commit^{commit}" 2>/dev/null || return 1
  parents="$(git -C "$ROOT_DIR" show -s --format=%P "$commit")" || return 1
  [ "$parents" = "$ORIGINAL_FEATURE_COMMIT $RECOVERY_MAIN_COMMIT" ]
}

recovery_refs_valid() {
  local feature_tip local_main remote_main
  feature_tip="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")" || return 1
  local_main="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" || return 1
  remote_main="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" || return 1
  if [ -z "$EFFECTIVE_FEATURE_TIP" ]; then
    [ "$feature_tip" = "$ORIGINAL_FEATURE_COMMIT" ] && [ "$local_main" = "$RECOVERY_MAIN_COMMIT" ] && [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ]
    return
  fi
  case "$feature_tip" in "$ORIGINAL_FEATURE_COMMIT"|"$EFFECTIVE_FEATURE_TIP") ;; *) return 1 ;; esac
  if [ "$local_main" = "$RECOVERY_MAIN_COMMIT" ]; then
    [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ]
  elif [ "$local_main" = "$EFFECTIVE_FEATURE_TIP" ]; then
    [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ] || [ "$remote_main" = "$EFFECTIVE_FEATURE_TIP" ]
  else
    return 1
  fi
}

command_sha256() { printf '%s' "$1" | "$PYTHON_BIN" -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }

json_arrays_equal() {
  [ "$("$PYTHON_BIN" -c 'import json,sys; print(json.loads(sys.argv[1])==json.loads(sys.argv[2]))' "$1" "$2")" = True ]
}

validation_record_command() {
  "$PYTHON_BIN" -c 'import json,sys
commands = json.load(open(sys.argv[1])).get("commands")
if not isinstance(commands, list) or len(commands) != 2 or not all(isinstance(command, str) and command.strip() for command in commands):
    raise SystemExit("validation record does not contain two replayable commands")
print(commands[int(sys.argv[2])])' "$1" "$2"
}

# Recovery validation reruns only the exact command pair recorded by the
# original transaction's checksummed validation evidence.  The recovery
# process environment can never replace, weaken, or backfill those commands.
bind_recovery_validation_commands() {
  local persist_override="${1:-1}" status validated_head path checksum record record_checksum
  status="$(journal_get validation_status)"
  case "$status" in
    ran|reused) ;;
    *) recovery_fail "original transaction has no replayable validation commands" 95 ;;
  esac
  validated_head="$(journal_get validated_head)"
  path="$(journal_get validation_record_path)"
  checksum="$(journal_get validation_record_checksum)"
  if [ -z "$validated_head" ] || [ -z "$path" ] || [ -z "$checksum" ]; then
    recovery_fail "original validation provenance is incomplete" 95
  fi
  record="$(local_archive_path "$path")" || recovery_fail "original validation record path is outside local_archive" 95
  [ -f "$record" ] || recovery_fail "original validation evidence is missing" 95
  helper validation-verify --record "$record" --repository "$ROOT_DIR" --head "$validated_head" --worktree-clean false >/dev/null || recovery_fail "original validation evidence failed checksum, repository, or head verification" 95
  record_checksum="$(accepted_validation_field checksum "$record")" || recovery_fail "original validation evidence is unreadable" 95
  [ "$record_checksum" = "$checksum" ] || recovery_fail "original validation evidence checksum does not match the journal" 95
  RECOVERY_PYTHON_COMMAND="$(validation_record_command "$record" 0)" || recovery_fail "original validation record does not contain two replayable commands" 95
  RECOVERY_NODE_COMMAND="$(validation_record_command "$record" 1)" || recovery_fail "original validation record does not contain two replayable commands" 95
  RECOVERY_NODE_VERSION="$(accepted_validation_field node_version "$record")" || recovery_fail "original validation record has no Node version provenance" 95
  RECOVERY_ORIGINAL_EVIDENCE_PATH="$path"
  RECOVERY_ORIGINAL_EVIDENCE_CHECKSUM="$checksum"
  RECOVERY_OVERRIDE_PYTHON=0
  RECOVERY_OVERRIDE_NODE=0
  if [ "${ARCHIVE_PYTHON_TEST_COMMAND+x}" = x ] && [ "$ARCHIVE_PYTHON_TEST_COMMAND" != "$RECOVERY_PYTHON_COMMAND" ]; then RECOVERY_OVERRIDE_PYTHON=1; fi
  if [ "${ARCHIVE_NODE_TEST_COMMAND+x}" = x ] && [ "$ARCHIVE_NODE_TEST_COMMAND" != "$RECOVERY_NODE_COMMAND" ]; then RECOVERY_OVERRIDE_NODE=1; fi
  [ "$persist_override" -eq 0 ] || persist_recovery_validation_override
}

persist_recovery_validation_override() {
  if [ "$RECOVERY_OVERRIDE_PYTHON" -eq 1 ] || [ "$RECOVERY_OVERRIDE_NODE" -eq 1 ]; then
    journal_update --set-json "recovery_validation_command_override={\"policy\":\"ignored\",\"python\":$([ "$RECOVERY_OVERRIDE_PYTHON" -eq 1 ] && printf true || printf false),\"node\":$([ "$RECOVERY_OVERRIDE_NODE" -eq 1 ] && printf true || printf false),\"command_source\":\"original_validation_record\"}" || recovery_fail "unable to journal ignored validation command override" 95
    log "recovery: ignoring environment validation command overrides; using transaction-bound commands from $RECOVERY_ORIGINAL_EVIDENCE_PATH"
  fi
}

# Captured-log evidence of the legacy failure mode: the precise Git error
# emitted when checkout of the target branch failed because another worktree
# holds it.  The quoted path must be the worktree that holds the branch now.
legacy_checkout_conflict_logged() {
  local worktree="$1" log
  [ -d "$TRANSACTION_DIR/logs" ] || return 1
  for log in "$TRANSACTION_DIR"/logs/*.log; do
    [ -f "$log" ] || continue
    grep -Fq -- "'$TARGET_BRANCH' is already checked out at '$worktree'" "$log" && return 0
  done
  return 1
}

# Strict verification for the single known legacy state: phase=merge,
# phase_status=running, failure_code=null, left by an abrupt target-branch
# checkout conflict before journaled fail paths existed.  Every binding in the
# journal must still match live Git facts; anything less fails closed.
qualify_legacy_stuck_transaction() {
  local feature_commit expected_main main_worktree
  ORIGINAL_FEATURE_BRANCH="$SOURCE_BRANCH"
  [ "$(journal_get transaction_id)" = "$RESUME_ID" ] || recovery_fail "legacy transaction id does not match the journal"
  git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH" || recovery_fail "legacy source branch is missing"
  feature_commit="$(journal_get head_sha)"
  [ -n "$feature_commit" ] || recovery_fail "legacy journal has no feature commit binding"
  [ "$(journal_optional commit_result.status)" = "succeeded" ] || recovery_fail "legacy transaction commit did not succeed"
  [ "$(journal_optional commit_result.commit_sha)" = "$feature_commit" ] || recovery_fail "legacy commit result disagrees with the journal head"
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$SOURCE_BRANCH")" = "$feature_commit" ] || recovery_fail "legacy feature commit changed"
  git -C "$ROOT_DIR" cat-file -e "$feature_commit^{commit}" 2>/dev/null || recovery_fail "legacy feature commit is missing from the object store"
  expected_main="$(journal_get expected_origin_main)"
  [ -n "$expected_main" ] || recovery_fail "legacy journal has no expected main binding"
  [ "$(journal_get local_main_before)" = "$expected_main" ] || recovery_fail "legacy journal main bindings are inconsistent"
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" = "$expected_main" ] || recovery_fail "legacy target main changed"
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$expected_main" ] || recovery_fail "legacy origin main changed"
  related_worktrees_safe || recovery_fail "legacy feature or main worktree is dirty, or a Git operation is unfinished"
  main_worktree="$(worktree_for_branch "$TARGET_BRANCH")"
  [ -n "$main_worktree" ] || recovery_fail "legacy target main is not held by another worktree; no checkout-conflict evidence"
  [ "$(canonical_path "$main_worktree")" != "$(canonical_path "$ROOT_DIR")" ] || recovery_fail "legacy target main conflict cannot involve the source worktree"
  [ "$(git_common_dir "$main_worktree")" = "$(git_common_dir "$ROOT_DIR")" ] || recovery_fail "legacy main worktree belongs to another repository"
  LEGACY_EVIDENCE_SOURCE="captured_log"
  if ! legacy_checkout_conflict_logged "$main_worktree"; then
    [ ! -e "$TRANSACTION_DIR/logs/merge.log" ] || recovery_fail "legacy merge log does not prove a main-worktree checkout conflict"
    LEGACY_EVIDENCE_SOURCE="worktree_topology_probe"
  fi
  LEGACY_MAIN_WORKTREE="$main_worktree"
  LEGACY_STUCK_RECOVERY=1
}

persist_legacy_qualification() {
  if [ "$LEGACY_EVIDENCE_SOURCE" = worktree_topology_probe ]; then
    mkdir -p "$TRANSACTION_DIR/logs" || recovery_fail "unable to prepare legacy evidence log"
    printf "fatal: '%s' is already checked out at '%s'\n" "$TARGET_BRANCH" "$LEGACY_MAIN_WORKTREE" >"$TRANSACTION_DIR/logs/merge.log" || recovery_fail "unable to record legacy checkout-conflict evidence"
  fi
  journal_update --set-json "legacy_recovery={\"reason\":\"legacy_merge_running_main_worktree_conflict\",\"evidence_source\":\"$LEGACY_EVIDENCE_SOURCE\",\"main_worktree\":$(json_quote "$LEGACY_MAIN_WORKTREE"),\"expected_main\":$(json_quote "$ORIGINAL_MAIN_COMMIT"),\"feature_commit\":$(json_quote "$ORIGINAL_FEATURE_COMMIT"),\"recorded_at\":$(json_quote "$(utc_now)")}" || recovery_fail "unable to journal the legacy recovery reason"
  persist_recovery_validation_override
}

initialize_recovery() {
  local phase status failure_code current_main remote_main common original_validation original_failure
  record_recovery_request
  phase="$(journal_get phase)"; status="$(journal_get phase_status)"; failure_code="$(journal_optional failure_code)"

  case "$(journal_optional recovery_authorized)" in true|True)
    [ "$(journal_optional recovery_mode)" = integrate_main_into_feature ] || recovery_fail "journal recovery mode is inconsistent"
    bind_recovery_validation_commands
    ORIGINAL_FEATURE_BRANCH="$(journal_get original_feature_branch)"
    ORIGINAL_FEATURE_COMMIT="$(journal_get original_feature_commit)"
    ORIGINAL_MAIN_COMMIT="$(journal_get original_main_commit)"
    RECOVERY_MAIN_COMMIT="$(journal_get recovery_main_commit)"
    ORIGINAL_BASE_COMMIT="$(journal_get original_base_commit)"
    RECOVERY_WORKTREE="$(journal_get recovery_worktree)"
    [ "$RECOVERY_WORKTREE" = "$TRANSACTION_DIR/recovery-worktree" ] || recovery_fail "journal recovery worktree path is outside the transaction"
    RECOVERY_MERGE_COMMIT="$(journal_optional recovery_merge_commit)"
    EFFECTIVE_FEATURE_TIP="$(journal_optional effective_feature_tip)"
    [ -z "$RECOVERY_MERGE_COMMIT" ] || [ "$RECOVERY_MERGE_COMMIT" = "$EFFECTIVE_FEATURE_TIP" ] || recovery_fail "effective feature tip disagrees with recovery merge commit"
    related_worktrees_safe || recovery_fail "related worktree or index is dirty, or a Git operation is unfinished"
    recovery_refs_valid || recovery_fail "feature tip or main changed outside the authorized recovery topology"
    return 0
    ;;
  esac

  LEGACY_STUCK_RECOVERY=0
  if [ "$phase:$status:$(journal_optional failure_stage):$failure_code" = "merge:failed:recovery_fetch:96" ] && [ -n "$(journal_optional original_failure)" ]; then
    phase="$(journal_optional original_failure.phase)"
    status="$(journal_optional original_failure.phase_status)"
    failure_code="$(journal_optional original_failure.failure_code)"
  fi
  if [ "$phase:$status" = "merge:running" ] && [ -z "$failure_code" ]; then
    # Legacy stuck transaction: an abrupt failure left merge/running with no
    # failure code.  Accept only the one known legacy shape, proven strictly.
    qualify_legacy_stuck_transaction
  else
    [ "$phase:$status" = merge:failed ] || [ "$phase:$status" = merge:interrupted ] || recovery_fail "transaction phase is not merge/failed"
    [ "$failure_code" = 64 ] || recovery_fail "transaction is not an ff-only divergence failure"
  fi
  [ "$(journal_optional push_result.status)" != succeeded ] || recovery_fail "transaction already has a successful original push"
  [ "$(journal_optional archive_result.status)" != succeeded ] || recovery_fail "transaction already has a successful original archive"

  if [ "$LEGACY_STUCK_RECOVERY" -eq 1 ]; then
    bind_recovery_validation_commands 0
  else
    bind_recovery_validation_commands
  fi

  ORIGINAL_FEATURE_BRANCH="$(journal_optional original_feature_branch)"
  [ -n "$ORIGINAL_FEATURE_BRANCH" ] || ORIGINAL_FEATURE_BRANCH="$(journal_get source_branch)"
  ORIGINAL_FEATURE_COMMIT="$(journal_optional original_feature_commit)"
  [ -n "$ORIGINAL_FEATURE_COMMIT" ] || ORIGINAL_FEATURE_COMMIT="$(journal_get head_sha)"
  ORIGINAL_MAIN_COMMIT="$(journal_optional original_main_commit)"
  [ -n "$ORIGINAL_MAIN_COMMIT" ] || ORIGINAL_MAIN_COMMIT="$(journal_get local_main_before)"
  if [ -z "$ORIGINAL_FEATURE_BRANCH" ] || [ -z "$ORIGINAL_FEATURE_COMMIT" ] || [ -z "$ORIGINAL_MAIN_COMMIT" ]; then
    recovery_fail "original transaction identity is incomplete"
  fi
  git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$ORIGINAL_FEATURE_BRANCH" || recovery_fail "original feature branch no longer exists"
  git -C "$ROOT_DIR" cat-file -e "$ORIGINAL_FEATURE_COMMIT^{commit}" 2>/dev/null || recovery_fail "original feature commit is missing"
  git -C "$ROOT_DIR" cat-file -e "$ORIGINAL_MAIN_COMMIT^{commit}" 2>/dev/null || recovery_fail "original main commit is missing"

  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")" = "$ORIGINAL_FEATURE_COMMIT" ] || recovery_fail "original feature tip changed"
  current_main="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")"
  remote_main="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"
  [ "$current_main" = "$remote_main" ] || recovery_fail "local main does not equal origin/main"
  git -C "$ROOT_DIR" merge-base --is-ancestor "$ORIGINAL_MAIN_COMMIT" "$current_main" || recovery_fail "current main is not a descendant of the original main target"
  common="$(git -C "$ROOT_DIR" merge-base "$ORIGINAL_FEATURE_COMMIT" "$current_main")" || recovery_fail "feature and main have no verifiable common ancestor"
  ORIGINAL_BASE_COMMIT="$(git -C "$ROOT_DIR" merge-base "$ORIGINAL_FEATURE_COMMIT" "$ORIGINAL_MAIN_COMMIT")" || recovery_fail "original feature and main have no common ancestor"
  related_worktrees_safe || recovery_fail "related worktree or index is dirty, or a Git operation is unfinished"
  [ ! -e "$ARCHIVE_RECORD" ] || recovery_fail "archive record already exists"

  if [ "$LEGACY_STUCK_RECOVERY" -eq 1 ]; then
    persist_legacy_qualification
  fi

  RECOVERY_MAIN_COMMIT="$current_main"
  RECOVERY_WORKTREE="$TRANSACTION_DIR/recovery-worktree"
  original_validation="$($PYTHON_BIN -c 'import json,sys; keys=("path","checksum","status","head","source","completed_at"); print(json.dumps(dict(zip(keys,[value or None for value in sys.argv[1:]])),separators=(",",":")))' "$(journal_optional validation_record_path)" "$(journal_optional validation_record_checksum)" "$(journal_optional validation_status)" "$(journal_optional validated_head)" "$(journal_optional validation_source)" "$(journal_optional validation_completed_at)")"
  original_failure="$(journal_optional original_failure)"
  [ -n "$original_failure" ] || original_failure="$($PYTHON_BIN -c 'import json,sys; keys=("phase","phase_status","failure_stage","failure_code"); print(json.dumps(dict(zip(keys,[value or None for value in sys.argv[1:]])),separators=(",",":")))' "$phase" "$status" "$(journal_optional failure_stage)" "$failure_code")"
  journal_update \
    --set-json 'recovery_authorized=true' \
    --set-json "original_feature_branch=$(json_quote "$ORIGINAL_FEATURE_BRANCH")" \
    --set-json "original_feature_commit=$(json_quote "$ORIGINAL_FEATURE_COMMIT")" \
    --set-json "original_main_commit=$(json_quote "$ORIGINAL_MAIN_COMMIT")" \
    --set-json "original_base_commit=$(json_quote "$ORIGINAL_BASE_COMMIT")" \
    --set-json "original_validation_record=$original_validation" \
    --set-json "original_failure=$original_failure" \
    --set-json "recovery_main_commit=$(json_quote "$RECOVERY_MAIN_COMMIT")" \
    --set-json "recovery_common_ancestor=$(json_quote "$common")" \
    --set-json "recovery_worktree=$(json_quote "$RECOVERY_WORKTREE")" \
    --set-json 'recovery_merge_commit=null' \
    --set-json 'effective_feature_tip=null' \
    --set-json 'recovery_validation_record=null' \
    --set-json 'recovery_conflict_paths=[]'
  recovery_event recovery/preflight passed ""
}

ensure_recovery_worktree() {
  local start head
  start="$ORIGINAL_FEATURE_COMMIT"
  [ -z "$EFFECTIVE_FEATURE_TIP" ] || start="$EFFECTIVE_FEATURE_TIP"
  if [ -d "$RECOVERY_WORKTREE" ]; then
    git -C "$RECOVERY_WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || recovery_fail "recovery worktree path exists but is not a Git worktree"
    [ "$(git_common_dir "$RECOVERY_WORKTREE")" = "$(git_common_dir "$ROOT_DIR")" ] || recovery_fail "recovery worktree belongs to another repository"
    head="$(git -C "$RECOVERY_WORKTREE" rev-parse HEAD)"
    case "$head" in "$ORIGINAL_FEATURE_COMMIT"|"$start") ;; *) commit_has_recovery_parents "$head" || recovery_fail "recovery worktree HEAD is untrusted" ;; esac
    [ -z "$(git -C "$RECOVERY_WORKTREE" status --porcelain --untracked-files=all)" ] || recovery_fail "recovery worktree is dirty"
    git_operation_in_progress "$RECOVERY_WORKTREE" && recovery_fail "recovery worktree has an unfinished Git operation"
    return 0
  fi
  [ ! -e "$RECOVERY_WORKTREE" ] || recovery_fail "recovery worktree path exists unexpectedly"
  run_cmd git -C "$ROOT_DIR" worktree add --detach "$RECOVERY_WORKTREE" "$start" || recovery_fail "unable to create transaction-local recovery worktree"
  recovery_event recovery/worktree-created passed ""
}

advance_branch_ff() {
  local branch="$1" old="$2" new="$3" current worktree
  current="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$branch")" || return 1
  [ "$current" != "$new" ] || return 0
  [ "$current" = "$old" ] || return 1
  git -C "$ROOT_DIR" merge-base --is-ancestor "$old" "$new" || return 1
  worktree="$(worktree_for_branch "$branch")"
  if [ -n "$worktree" ]; then
    [ -z "$(git -C "$worktree" status --porcelain --untracked-files=all | awk '$2 !~ /^local_archive\//')" ] || return 1
    git_operation_in_progress "$worktree" && return 1
    run_cmd git -C "$worktree" merge --ff-only "$new" || return 1
  else
    run_cmd git -C "$ROOT_DIR" update-ref "refs/heads/$branch" "$new" "$old" || return 1
  fi
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$branch")" = "$new" ]
}

ensure_recovery_merge() {
  local worktree_head conflict_json feature_tip
  RECOVERY_MERGE_COMMIT="$(journal_optional recovery_merge_commit)"
  EFFECTIVE_FEATURE_TIP="$(journal_optional effective_feature_tip)"
  worktree_head="$(git -C "$RECOVERY_WORKTREE" rev-parse HEAD)"
  if [ -n "$RECOVERY_MERGE_COMMIT" ]; then
    if [ "$RECOVERY_MERGE_COMMIT" != "$EFFECTIVE_FEATURE_TIP" ] || ! commit_has_recovery_parents "$RECOVERY_MERGE_COMMIT"; then
      recovery_fail "journaled recovery merge commit is invalid"
    fi
    if [ "$worktree_head" != "$RECOVERY_MERGE_COMMIT" ]; then
      [ "$worktree_head" = "$ORIGINAL_FEATURE_COMMIT" ] || recovery_fail "recovery worktree disagrees with journaled merge commit"
      run_cmd git -C "$RECOVERY_WORKTREE" checkout --detach "$RECOVERY_MERGE_COMMIT" || recovery_fail "unable to restore recovery worktree HEAD"
    fi
  elif [ "$worktree_head" != "$ORIGINAL_FEATURE_COMMIT" ]; then
    commit_has_recovery_parents "$worktree_head" || recovery_fail "unjournaled recovery worktree commit has invalid parents"
    RECOVERY_MERGE_COMMIT="$worktree_head"
    EFFECTIVE_FEATURE_TIP="$worktree_head"
    journal_update --set-json "recovery_merge_commit=$(json_quote "$worktree_head")" --set-json "effective_feature_tip=$(json_quote "$worktree_head")"
  else
    if ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then recovery_fail "unable to fetch origin before the recovery merge" 96; fi
    if [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" != "$RECOVERY_MAIN_COMMIT" ] || [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" != "$RECOVERY_MAIN_COMMIT" ]; then
      recovery_fail "main changed after recovery preflight"
    fi
    [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")" = "$ORIGINAL_FEATURE_COMMIT" ] || recovery_fail "feature tip changed before recovery merge"
    [ -z "$(git -C "$RECOVERY_WORKTREE" status --porcelain --untracked-files=all)" ] || recovery_fail "recovery worktree became dirty before merge"
    recovery_event recovery/merge-started running ""
    if ! git -C "$RECOVERY_WORKTREE" merge --no-ff --no-edit -m "$RECOVERY_MERGE_MESSAGE" "$RECOVERY_MAIN_COMMIT"; then
      conflict_json="$(git -C "$RECOVERY_WORKTREE" diff --name-only --diff-filter=U -z | "$PYTHON_BIN" -c 'import json,sys; print(json.dumps(sys.stdin.buffer.read().decode().rstrip("\0").split("\0") if sys.stdin.buffer.read else [],separators=(",",":")))')" || conflict_json='[]'
      journal_update --set-json "recovery_conflict_paths=$conflict_json" || true
      git -C "$RECOVERY_WORKTREE" merge --abort >/dev/null 2>&1 || true
      recovery_fail "merge conflict; no conflict resolution was attempted" 91
    fi
    RECOVERY_MERGE_COMMIT="$(git -C "$RECOVERY_WORKTREE" rev-parse HEAD)"
    EFFECTIVE_FEATURE_TIP="$RECOVERY_MERGE_COMMIT"
    commit_has_recovery_parents "$RECOVERY_MERGE_COMMIT" || recovery_fail "recovery merge does not have the required feature-first parent order"
    journal_update --set-json "recovery_merge_commit=$(json_quote "$RECOVERY_MERGE_COMMIT")" --set-json "effective_feature_tip=$(json_quote "$EFFECTIVE_FEATURE_TIP")"
  fi
  feature_tip="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")"
  case "$feature_tip" in
    "$ORIGINAL_FEATURE_COMMIT") advance_branch_ff "$ORIGINAL_FEATURE_BRANCH" "$ORIGINAL_FEATURE_COMMIT" "$EFFECTIVE_FEATURE_TIP" || recovery_fail "unable to fast-forward original feature branch to recovery merge" ;;
    "$EFFECTIVE_FEATURE_TIP") ;;
    *) recovery_fail "feature tip changed after recovery merge" ;;
  esac
  recovery_event recovery/merge-completed passed ""
}

recovery_run_one_test() {
  local name="$1" command="$2" timeout="$3" rewritten log_path result_path status
  rewritten="${command//$ROOT_DIR/$RECOVERY_WORKTREE}"
  log_path="$TRANSACTION_DIR/logs/recovery-$name-baseline.log"
  result_path="$TRANSACTION_DIR/recovery-$name-result.json"
  helper run --log "$log_path" --result-file "$result_path" --timeout-seconds "$timeout" --heartbeat-seconds "$HEARTBEAT_SECONDS" -- bash -lc "cd $(printf '%q' "$RECOVERY_WORKTREE") && $rewritten" || true
  [ -f "$result_path" ] || recovery_fail "recovery validation did not produce a $name result" 92
  journal_update --set-json "recovery_test_results.$name=$(cat "$result_path")"
  status="$(journal_get "recovery_test_results.$name.status")"
  [ "$status" = passed ] || recovery_fail "recovery validation $name command failed" 92
}

write_recovery_manifest() {
  local output="$TRANSACTION_DIR/recovery-manifest.json"
  "$PYTHON_BIN" -c '
import hashlib,json,os,subprocess,sys
repo,base,feature,main,effective,output=sys.argv[1:]
def git(*args): return subprocess.check_output(["git","-C",repo,*args])
def paths(left,right):
    raw=git("diff","--name-only","-z",left,right)
    return sorted(item.decode("utf-8","surrogateescape") for item in raw.rstrip(b"\0").split(b"\0") if item)
original=paths(base,feature); recovered=paths(main,effective)
if original != recovered: raise SystemExit("recovery path allowlist differs from original feature delta")
for path in recovered:
    if path in {".env",".env.local",".ran_agent_state",".openclaw_state"} or path.split("/",1)[0] in {"data","logs","debug","state","local_archive",".npm",".pytest_cache",".venv","node_modules","__pycache__"} or path.startswith(("vault/inbox/","vault/raw/","vault/wiki/","node_bridge/.ran_agent_state/")):
        raise SystemExit("forbidden recovery path: "+path)
record={"schema_version":1,"original_base_commit":base,"original_feature_commit":feature,"recovery_main_commit":main,"effective_feature_tip":effective,"original_paths":original,"effective_paths":recovered,"tree_sha":git("rev-parse",effective+"^{tree}").decode().strip(),"parents":git("show","-s","--format=%P",effective).decode().strip().split()}
raw=json.dumps(record,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode(); record["checksum"]=hashlib.sha256(raw).hexdigest()
temporary=output+".tmp"; open(temporary,"w",encoding="utf-8").write(json.dumps(record,sort_keys=True,separators=(",",":"),ensure_ascii=False)+"\n"); os.replace(temporary,output)
' "$ROOT_DIR" "$ORIGINAL_BASE_COMMIT" "$ORIGINAL_FEATURE_COMMIT" "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP" "$output" || recovery_fail "recovery path, forbidden-file, or manifest validation failed" 93
  printf '%s\n' "$output"
}

# The recovery manifest is trusted only when its canonical sha256 (stable
# sorted compact JSON of every field except checksum) matches both its stored
# checksum and the journaled checksum, and its content equals what the same
# algorithm regenerates from the journaled commits and live Git facts.
recovery_manifest_valid() {
  "$PYTHON_BIN" -c 'import hashlib,json,subprocess,sys
path,journaled,repo,base,feature,main,effective=sys.argv[1:8]
def git(*args): return subprocess.check_output(["git","-C",repo,*args])
def paths(left,right):
    raw=git("diff","--name-only","-z",left,right)
    return sorted(item.decode("utf-8","surrogateescape") for item in raw.rstrip(b"\0").split(b"\0") if item)
try:
    manifest=json.load(open(path))
except (OSError,ValueError):
    print("manifest integrity failure: unreadable manifest"); raise SystemExit(1)
stored=manifest.get("checksum")
content={key:value for key,value in manifest.items() if key != "checksum"}
digest=hashlib.sha256(json.dumps(content,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
if not isinstance(stored,str) or stored != digest or digest != journaled:
    print("manifest integrity failure: canonical checksum mismatch"); raise SystemExit(1)
expected={"schema_version":1,"original_base_commit":base,"original_feature_commit":feature,"recovery_main_commit":main,"effective_feature_tip":effective,"original_paths":paths(base,feature),"effective_paths":paths(main,effective),"tree_sha":git("rev-parse",effective+"^{tree}").decode().strip(),"parents":git("show","-s","--format=%P",effective).decode().strip().split()}
if expected["parents"] != [feature,main]:
    print("manifest topology mismatch: parents violate the feature-first order"); raise SystemExit(1)
if content != expected:
    print("manifest topology mismatch: content disagrees with journaled or Git facts"); raise SystemExit(1)' "$1" "$2" "$ROOT_DIR" "$ORIGINAL_BASE_COMMIT" "$ORIGINAL_FEATURE_COMMIT" "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP"
}

recovery_validation_valid() {
  local status path checksum manifest_path manifest_checksum record expected_commands expected_checksums
  status="$(journal_optional recovery_validation_record.status)"
  [ "$status" = passed ] || return 1
  [ "$(journal_optional recovery_validation_record.command_source)" = original_validation_record ] || return 1
  path="$(journal_get recovery_validation_record.path)"; checksum="$(journal_get recovery_validation_record.checksum)"
  manifest_path="$(journal_get recovery_validation_record.manifest_path)"; manifest_checksum="$(journal_get recovery_validation_record.manifest_checksum)"
  record="$(local_archive_path "$path")" || return 1
  [ -f "$record" ] && [ "$(accepted_validation_field checksum "$record")" = "$checksum" ] || return 1
  helper validation-verify --record "$record" --repository "$ROOT_DIR" --head "$EFFECTIVE_FEATURE_TIP" --worktree-clean true >/dev/null || return 1
  expected_commands="$(printf '[%s,%s]' "$(json_quote "${RECOVERY_PYTHON_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}")" "$(json_quote "${RECOVERY_NODE_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}")")"
  json_arrays_equal "$expected_commands" "$(accepted_validation_json_field commands "$record")" || return 1
  json_arrays_equal "$expected_commands" "$(journal_get recovery_validation_record.commands)" || return 1
  expected_checksums="$(printf '[%s,%s]' "$(json_quote "$(command_sha256 "${RECOVERY_PYTHON_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}")")" "$(json_quote "$(command_sha256 "${RECOVERY_NODE_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}")")")"
  json_arrays_equal "$expected_checksums" "$(journal_get recovery_validation_record.command_checksums)" || return 1
  [ "$(accepted_validation_field node_version "$record")" = "transaction-bound:$RECOVERY_NODE_VERSION" ] || return 1
  [ "$(journal_optional recovery_validation_record.original_evidence_path)" = "$RECOVERY_ORIGINAL_EVIDENCE_PATH" ] || return 1
  [ "$(journal_optional recovery_validation_record.original_evidence_checksum)" = "$RECOVERY_ORIGINAL_EVIDENCE_CHECKSUM" ] || return 1
  manifest_path="$(local_archive_path "$manifest_path")" || { RECOVERY_VALIDATION_FAILURE_REASON="manifest integrity failure: manifest path is outside local_archive"; return 1; }
  [ -f "$manifest_path" ] || { RECOVERY_VALIDATION_FAILURE_REASON="manifest integrity failure: manifest file is missing"; return 1; }
  RECOVERY_VALIDATION_FAILURE_REASON="$(recovery_manifest_valid "$manifest_path" "$manifest_checksum")" || return 1
  commit_has_recovery_parents "$EFFECTIVE_FEATURE_TIP" || return 1
  [ "$(git -C "$RECOVERY_WORKTREE" rev-parse HEAD)" = "$EFFECTIVE_FEATURE_TIP" ] && [ -z "$(git -C "$RECOVERY_WORKTREE" status --porcelain --untracked-files=all)" ]
}

ensure_recovery_validation() {
  local manifest manifest_checksum temporary_journal record checksum python_command node_command record_json
  if [ -n "$(journal_optional recovery_validation_record.path)" ]; then
    recovery_validation_valid || recovery_fail "journaled recovery validation record failed integrity or command-binding verification${RECOVERY_VALIDATION_FAILURE_REASON:+: $RECOVERY_VALIDATION_FAILURE_REASON}" 95
    return 0
  fi
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")" = "$EFFECTIVE_FEATURE_TIP" ] || recovery_fail "effective feature tip does not match the feature branch before validation"
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" = "$RECOVERY_MAIN_COMMIT" ] || recovery_fail "main moved before recovery validation"
  if [ "$(git -C "$RECOVERY_WORKTREE" rev-parse HEAD)" != "$EFFECTIVE_FEATURE_TIP" ] || [ -n "$(git -C "$RECOVERY_WORKTREE" status --porcelain --untracked-files=all)" ]; then
    recovery_fail "recovery worktree is not clean at the effective feature tip"
  fi
  recovery_event recovery/validation-started running ""
  journal_update --set-json 'recovery_test_results={}'
  recovery_run_one_test python "$RECOVERY_PYTHON_COMMAND" "$PYTHON_TIMEOUT"
  recovery_run_one_test node "$RECOVERY_NODE_COMMAND" "$NODE_TIMEOUT"
  commit_has_recovery_parents "$EFFECTIVE_FEATURE_TIP" || recovery_fail "recovery merge topology changed during validation"
  git -C "$ROOT_DIR" merge-base --is-ancestor "$ORIGINAL_FEATURE_COMMIT" "$EFFECTIVE_FEATURE_TIP" || recovery_fail "original feature commit is not an ancestor of the effective tip"
  git -C "$ROOT_DIR" merge-base --is-ancestor "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP" || recovery_fail "recovery main commit is not an ancestor of the effective tip"
  manifest="$(write_recovery_manifest)"
  manifest_checksum="$($PYTHON_BIN -c 'import json,sys; print(json.load(open(sys.argv[1]))["checksum"])' "$manifest")"
  temporary_journal="$TRANSACTION_DIR/recovery-validation-journal.json"
  "$PYTHON_BIN" -c 'import json,os,sys; source,target=sys.argv[1:]; value=json.load(open(source)); value["test_results"]=value["recovery_test_results"]; temporary=target+".tmp"; open(temporary,"w").write(json.dumps(value,separators=(",",":"),sort_keys=True)+"\n"); os.replace(temporary,target)' "$JOURNAL" "$temporary_journal"
  record="$TRANSACTION_DIR/recovery-validation-record.json"
  python_command="${RECOVERY_PYTHON_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}"
  node_command="${RECOVERY_NODE_COMMAND//$ROOT_DIR/$RECOVERY_WORKTREE}"
  helper validation-create --journal "$temporary_journal" --output "$record" --repository "$ROOT_DIR" --branch "$ORIGINAL_FEATURE_BRANCH" --base-sha "$RECOVERY_MAIN_COMMIT" --head "$EFFECTIVE_FEATURE_TIP" --worktree-clean true --node-version "transaction-bound:$RECOVERY_NODE_VERSION" --python-version "$($PYTHON_BIN --version 2>&1)" --commands-json "$(printf '[%s,%s]' "$(json_quote "$python_command")" "$(json_quote "$node_command")")" || recovery_fail "unable to create recovery validation record" 93
  helper validation-verify --record "$record" --repository "$ROOT_DIR" --head "$EFFECTIVE_FEATURE_TIP" --worktree-clean true >/dev/null || recovery_fail "recovery validation record verification failed" 93
  checksum="$(accepted_validation_field checksum "$record")"
  record_json="$(printf '{"status":"passed","path":%s,"checksum":%s,"manifest_path":%s,"manifest_checksum":%s,"command_source":"original_validation_record","commands":[%s,%s],"command_checksums":[%s,%s],"original_evidence_path":%s,"original_evidence_checksum":%s}' "$(json_quote "$(repo_relative_path "$record")")" "$(json_quote "$checksum")" "$(json_quote "$(repo_relative_path "$manifest")")" "$(json_quote "$manifest_checksum")" "$(json_quote "$python_command")" "$(json_quote "$node_command")" "$(json_quote "$(command_sha256 "$python_command")")" "$(json_quote "$(command_sha256 "$node_command")")" "$(json_quote "$RECOVERY_ORIGINAL_EVIDENCE_PATH")" "$(json_quote "$RECOVERY_ORIGINAL_EVIDENCE_CHECKSUM")")"
  journal_update --set-json "recovery_validation_record=$record_json"
  recovery_event recovery/validation-passed passed ""
}

ensure_recovery_main_ff() {
  local local_main remote_main
  if ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then recovery_fail "unable to fetch origin before the recovery main fast-forward" 96; fi
  local_main="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")"
  remote_main="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"
  if [ "$local_main" = "$RECOVERY_MAIN_COMMIT" ]; then
    [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ] || recovery_fail "origin/main changed before main fast-forward"
    advance_branch_ff "$TARGET_BRANCH" "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP" || recovery_fail "unable to fast-forward main to the effective feature tip"
  elif [ "$local_main" = "$EFFECTIVE_FEATURE_TIP" ]; then
    [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ] || [ "$remote_main" = "$EFFECTIVE_FEATURE_TIP" ] || recovery_fail "origin/main is outside the recovery topology"
  else
    recovery_fail "main changed outside the recovery topology"
  fi
  recovery_event recovery/main-ff-completed passed ""
}

render_recovery_archive_record() {
  local output="$1" status="$2" changed="$TRANSACTION_DIR/recovery-changed-files.txt" commits="$TRANSACTION_DIR/recovery-included-commits.txt" temporary
  temporary="$output.tmp"
  git -C "$ROOT_DIR" diff --name-status "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP" >"$changed" || return 1
  git -C "$ROOT_DIR" log --reverse --format='%H %s' "$RECOVERY_MAIN_COMMIT..$EFFECTIVE_FEATURE_TIP" >"$commits" || return 1
  {
    printf '# Archive And Push Divergence Recovery Record\n\n'
    printf 'Status: %s\n\n' "$status"
    printf '## Transaction\n- Transaction ID: %s\n- Original feature branch: %s\n- Original feature commit: %s\n- Original main commit: %s\n- Original base commit: %s\n- Recovery main commit: %s\n- Effective feature tip: %s\n- Merge mode: feature-first two-parent recovery, then main fast-forward only\n\n' "$TRANSACTION_ID" "$ORIGINAL_FEATURE_BRANCH" "$ORIGINAL_FEATURE_COMMIT" "$ORIGINAL_MAIN_COMMIT" "$ORIGINAL_BASE_COMMIT" "$RECOVERY_MAIN_COMMIT" "$EFFECTIVE_FEATURE_TIP"
    printf '## Included Commits\n'; cat "$commits"; printf '\n\n## Changed Files\n'; cat "$changed"; printf '\n\n## Validation\n- Recovery validation record: %s\n- Recovery validation checksum: %s\n\n## Production Status\n- Repository main updated: yes\n- Production deployed: no\n- Server connected: no\n- Production state modified: no\n' "$(journal_get recovery_validation_record.path)" "$(journal_get recovery_validation_record.checksum)"
  } >"$temporary" || return 1
  mv "$temporary" "$output"
}

ensure_recovery_archive_generated() {
  local pending="$TRANSACTION_DIR/recovery-archive-record.md"
  if [ -e "$ARCHIVE_RECORD" ]; then
    if ! grep -Fq -- "- Transaction ID: $TRANSACTION_ID" "$ARCHIVE_RECORD" || ! grep -Fq -- "- Effective feature tip: $EFFECTIVE_FEATURE_TIP" "$ARCHIVE_RECORD"; then
      recovery_fail "existing archive record does not match recovery journal"
    fi
    return 0
  fi
  if [ -e "$pending" ]; then
    if ! grep -Fq -- "- Transaction ID: $TRANSACTION_ID" "$pending" || ! grep -Fq -- "- Effective feature tip: $EFFECTIVE_FEATURE_TIP" "$pending"; then
      recovery_fail "pending recovery archive does not match journal"
    fi
  else
    render_recovery_archive_record "$pending" PENDING_PUSH || recovery_fail "unable to generate transaction-local recovery archive"
  fi
  journal_update --set-json "recovery_archive_record=$(json_quote "$(repo_relative_path "$pending")")"
  recovery_event recovery/archive-generated passed ""
}

ensure_recovery_push() {
  local local_main remote_main original alt
  if ! run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"; then recovery_fail "unable to fetch origin before the recovery push" 96; fi
  local_main="$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")"
  remote_main="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"
  [ "$local_main" = "$EFFECTIVE_FEATURE_TIP" ] || recovery_fail "local main is not the effective feature tip before push"
  if [ "$remote_main" = "$EFFECTIVE_FEATURE_TIP" ]; then
    journal_update --set-json "recovery_push_result={\"status\":\"succeeded\",\"head\":\"$EFFECTIVE_FEATURE_TIP\",\"mutation\":\"already_present\"}"
    recovery_event recovery/push-completed passed ""
    return 0
  fi
  [ "$remote_main" = "$RECOVERY_MAIN_COMMIT" ] || recovery_fail "origin/main changed before recovery push"
  original="$(git -C "$ROOT_DIR" config --get "remote.$REMOTE_NAME.url")"
  if git -C "$ROOT_DIR" push "$REMOTE_NAME" "$TARGET_BRANCH"; then
    journal_update --set-json "recovery_push_result={\"status\":\"succeeded\",\"head\":\"$EFFECTIVE_FEATURE_TIP\",\"primary_push\":\"succeeded\",\"alternate_attempted\":false,\"original_remote_url_restored\":true}"
  else
    alt="$(alternate_remote_url "$original" || true)"
    [ -n "$alt" ] || recovery_fail "recovery push failed and no safe alternate URL is available" 94
    log "push retry via $(redact_remote_url "$alt")"
    git -C "$ROOT_DIR" remote set-url "$REMOTE_NAME" "$alt" || recovery_fail "unable to set recovery alternate remote" 94
    TEMPORARY_ORIGINAL_REMOTE="$original"; TEMPORARY_REMOTE_SWITCHED=1
    if git -C "$ROOT_DIR" push "$REMOTE_NAME" "$TARGET_BRANCH" && restore_temporary_remote; then
      journal_update --set-json "recovery_push_result={\"status\":\"succeeded\",\"head\":\"$EFFECTIVE_FEATURE_TIP\",\"primary_push\":\"failed\",\"alternate_attempted\":true,\"alternate_push\":\"succeeded\",\"original_remote_url_restored\":true}"
    else
      restore_temporary_remote || true
      recovery_fail "recovery push failed" 94
    fi
  fi
  recovery_event recovery/push-completed passed ""
}

publish_recovery_archive() {
  local pending="$TRANSACTION_DIR/recovery-archive-record.md"
  if [ -e "$ARCHIVE_RECORD" ]; then
    if ! grep -Fq -- "- Transaction ID: $TRANSACTION_ID" "$ARCHIVE_RECORD" || ! grep -Fq -- "- Effective feature tip: $EFFECTIVE_FEATURE_TIP" "$ARCHIVE_RECORD"; then
      recovery_fail "published archive record does not match recovery journal"
    fi
    return 0
  fi
  mkdir -p "$(dirname "$ARCHIVE_RECORD")" || recovery_fail "unable to create archive record directory"
  render_recovery_archive_record "$ARCHIVE_RECORD" ARCHIVE || recovery_fail "unable to publish recovery archive record"
  journal_update --set-json "recovery_archive_record=$(json_quote "$(repo_relative_path "$ARCHIVE_RECORD")")"
  [ ! -e "$pending" ] || rm -f "$pending"
}

recovery_resume() {
  initialize_recovery
  if [ "$(journal_optional recovery_phase)" = recovery/completed ]; then
    if [ -z "$EFFECTIVE_FEATURE_TIP" ] || [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$ORIGINAL_FEATURE_BRANCH")" != "$EFFECTIVE_FEATURE_TIP" ] || [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" != "$EFFECTIVE_FEATURE_TIP" ] || [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" != "$EFFECTIVE_FEATURE_TIP" ] || [ ! -e "$ARCHIVE_RECORD" ]; then
      recovery_fail "completed recovery evidence is inconsistent"
    fi
    recovery_validation_valid || recovery_fail "completed recovery validation record failed integrity or command-binding verification${RECOVERY_VALIDATION_FAILURE_REASON:+: $RECOVERY_VALIDATION_FAILURE_REASON}" 95
    [ "$(journal_optional recovery_push_result.status)" = succeeded ] && [ "$(journal_optional recovery_push_result.head)" = "$EFFECTIVE_FEATURE_TIP" ] || recovery_fail "completed recovery push result is inconsistent" 95
    grep -Fq -- "- Transaction ID: $TRANSACTION_ID" "$ARCHIVE_RECORD" && grep -Fq -- "- Effective feature tip: $EFFECTIVE_FEATURE_TIP" "$ARCHIVE_RECORD" || recovery_fail "completed recovery archive record does not match the journal" 95
    return 0
  fi
  ensure_recovery_worktree
  ensure_recovery_merge
  ensure_recovery_validation
  ensure_recovery_main_ff
  ensure_recovery_archive_generated
  ensure_recovery_push
  publish_recovery_archive
  recovery_event recovery/completed passed ""
  if [ "$LEGACY_STUCK_RECOVERY" -eq 1 ]; then
    # The legacy transaction journal must not stay at merge/running after a
    # successful recovery; the original stuck state remains preserved in
    # original_failure, legacy_recovery, and recovery_history.
    journal_update --phase completed --phase-status succeeded
  fi
}

resume() {
  local phase status
  phase="$(journal_get phase)"; status="$(journal_get phase_status)"
  case "$phase:$status" in
    validation:failed|validation:interrupted) validate; stage_and_commit; merge_to_main; push_main; archive_success ;;
    staging:failed|staging:interrupted|commit:failed|commit:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || die "unsafe resume before commit"; stage_and_commit; merge_to_main; push_main; archive_success ;;
    merge:failed|merge:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get commit_result.commit_sha)"; [ -n "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || die "unsafe merge resume"; [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$EXPECTED_ORIGIN_MAIN" ] || die "origin changed; refusing resume"; merge_to_main; push_main; archive_success ;;
    push:failed|push:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get merge_result.head)"; [ -n "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" = "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$EXPECTED_ORIGIN_MAIN" ] || die "unsafe push resume"; push_main; archive_success ;;
    archive:running|archive:failed|archive:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get push_result.head)"; [ "$(journal_get push_result.status)" = succeeded ] && [ -n "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse "refs/heads/$TARGET_BRANCH")" = "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$FINAL_HEAD" ] || die "unsafe archive resume"; select_resumable_archive_record || fail archive 81; archive_success ;;
    *) die "journal phase is not safely resumable: $phase/$status" ;;
  esac
}

self_test() {
  [ "$(redact_remote_url 'https://user:secret@github.com/a/b.git?token=x')" = 'https://***@github.com/a/b.git' ]
  [ "$(github_https_to_ssh 'https://github.com/a/b.git')" = 'git@github.com:a/b.git' ]
  [ "$(github_ssh_to_https 'git@github.com:a/b.git')" = 'https://github.com/a/b.git' ]
  printf 'self-test: ok\n'
}

main() {
  parse_args "$@"
  [ "$SELF_TEST" -eq 0 ] || { self_test; return; }
  [ -f "$HELPER" ] || die "archive transaction helper not found: $HELPER"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: no Git mutation; use --push for a journaled transaction"
    return
  fi
  archive_python_supported || die "no supported Python available; set ARCHIVE_PYTHON_BIN to Python >=3.9"
  ensure_archive_record_path || die "archive record must stay inside $ROOT_DIR/local_archive"
  if [ -z "${ARCHIVE_TRANSACTION_LOCK_FD:-}" ]; then
    exec "$PYTHON_BIN" "$HELPER" lock-exec --root "$ROOT_DIR" --lock "$LOCK_FILE" -- "$0" "${ORIGINAL_ARGS[@]}"
  fi
  "$PYTHON_BIN" "$HELPER" lock-verify --root "$ROOT_DIR" --lock "$LOCK_FILE" --fd "$ARCHIVE_TRANSACTION_LOCK_FD" || exit $?
  if [ -n "$RESUME_ID" ]; then
    resume_transaction
    if [ "$INTEGRATE_MAIN_INTO_FEATURE" -eq 1 ]; then recovery_resume; else resume; fi
  else
    begin_transaction; validate; stage_and_commit; merge_to_main; push_main; archive_success
  fi
  printf 'archive transaction completed: %s\n' "$TRANSACTION_ID"
}

main "$@"
