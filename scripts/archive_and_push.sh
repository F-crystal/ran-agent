#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ARCHIVE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PYTHON_BIN="${ARCHIVE_PYTHON_BIN:-python3}"
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
NODE_TEST_COMMAND="${ARCHIVE_NODE_TEST_COMMAND:-npm --prefix '$ROOT_DIR/node_bridge' test}"
ARCHIVE_RECORD="${ARCHIVE_RECORD:-$ROOT_DIR/local_archive/docs/governance/archive/$(date +%F)-archive-and-push.md}"
REUSE_VALIDATION=""
SKIP_TESTS_REASON=""
RESUME_ID=""
STAGE_PATHS=()
TRANSACTION_ID=""
TRANSACTION_DIR=""
JOURNAL=""
LOCK_DIR="$ROOT_DIR/local_archive/runtime/archive-and-push/.lock"
LOCK_HELD=0
TEMPORARY_REMOTE_SWITCHED=0
TEMPORARY_ORIGINAL_REMOTE=""
SOURCE_BRANCH=""
SOURCE_HEAD=""
EXPECTED_ORIGIN_MAIN=""
LOCAL_MAIN_BEFORE=""
FINAL_HEAD=""
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
  archive_root="$(canonical_path "$ROOT_DIR/local_archive")"
  resolved="$(canonical_path "$ARCHIVE_RECORD")"
  case "$resolved" in "$archive_root"/*) ARCHIVE_RECORD="$resolved" ;; *) die "archive record must be inside $archive_root" ;; esac
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
Usage: scripts/archive_and_push.sh [--push] [--dry-run] [--skip-tests --skip-tests-reason TEXT] [--reuse-validation PATH] [--resume ID] [--remote-url URL] [--commit-message MSG] [--record PATH] [--path PATH] [--no-merge-current-branch] [--self-test]

--push                    Run a journaled archive transaction, ff merge to main, and push.
--reuse-validation PATH   Reuse a verified validation record for the exact clean HEAD.
--resume ID               Resume only the next provably safe phase of a prior transaction.
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

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --push) DRY_RUN=0 ;;
      --dry-run) DRY_RUN=1 ;;
      --skip-tests) RUN_TESTS=0 ;;
      --skip-tests-reason) shift; [ "$#" -gt 0 ] || die "--skip-tests-reason requires text"; SKIP_TESTS_REASON="$1" ;;
      --reuse-validation) shift; [ "$#" -gt 0 ] || die "--reuse-validation requires a path"; REUSE_VALIDATION="$1" ;;
      --resume) shift; [ "$#" -gt 0 ] || die "--resume requires a transaction id"; RESUME_ID="$1"; DRY_RUN=0 ;;
      --remote-url) shift; [ "$#" -gt 0 ] || die "--remote-url requires a URL"; REMOTE_URL="$1" ;;
      --commit-message) shift; [ "$#" -gt 0 ] || die "--commit-message requires text"; COMMIT_MESSAGE="$1" ;;
      --record) shift; [ "$#" -gt 0 ] || die "--record requires a path"; ARCHIVE_RECORD="$1" ;;
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
  run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"
  [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$EXPECTED_ORIGIN_MAIN" ] || fail "remote_race" 40
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'pid=%s\ntransaction_id=%s\nstarted_at=%s\nrepository_realpath=%s\n' "$$" "$TRANSACTION_ID" "$(date -u +%FT%TZ)" "$(realpath_of "$ROOT_DIR")" >"$LOCK_DIR/owner"
    LOCK_HELD=1
    return 0
  fi
  local pid=""
  [ -f "$LOCK_DIR/owner" ] && pid="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" | head -n1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then die "archive transaction lock is active (pid $pid)"; fi
  [ -n "$RESUME_ID" ] || die "archive transaction lock is stale; inspect it and resume explicitly with --resume"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || die "unable to recover stale transaction lock"
  printf 'pid=%s\ntransaction_id=%s\nstarted_at=%s\nrepository_realpath=%s\n' "$$" "$TRANSACTION_ID" "$(date -u +%FT%TZ)" "$(realpath_of "$ROOT_DIR")" >"$LOCK_DIR/owner"
  LOCK_HELD=1
}
release_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -rf "$LOCK_DIR"
  fi
}
restore_temporary_remote() {
  [ "$TEMPORARY_REMOTE_SWITCHED" -eq 1 ] || return 0
  git -C "$ROOT_DIR" remote set-url "$REMOTE_NAME" "$TEMPORARY_ORIGINAL_REMOTE" || return 1
  TEMPORARY_REMOTE_SWITCHED=0
}

write_archive_record() {
  [ ! -e "$ARCHIVE_RECORD" ] || return 1
  mkdir -p "$(dirname "$ARCHIVE_RECORD")" || return 1
  local changed_file="$TRANSACTION_DIR/changed-files.txt" commits_file="$TRANSACTION_DIR/included-commits.txt" temporary="$TRANSACTION_DIR/archive-record.md"
  rm -f "$temporary" || return 1
  local archive_head
  archive_head="$(journal_get head_sha)" || return 1
  git -C "$ROOT_DIR" diff --name-status "$EXPECTED_ORIGIN_MAIN" "$archive_head" >"$changed_file" || return 1
  git -C "$ROOT_DIR" log --reverse --format='%H %s' "$EXPECTED_ORIGIN_MAIN..$archive_head" >"$commits_file" || return 1
  helper archive-render --journal "$JOURNAL" --output "$temporary" --included-commits-file "$commits_file" --changed-files-file "$changed_file" --remote "$REMOTE_NAME" || return 1
  helper archive-verify --journal "$JOURNAL" --record "$temporary" || return 1
  mv "$temporary" "$ARCHIVE_RECORD" || return 1
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
    restore_temporary_remote || journal_update --set-json 'push_result.original_remote_url_restored=false' || true
  fi
  [ -z "$JOURNAL" ] || journal_update --phase-status interrupted --failure-stage signal --failure-code 130 || true
  exit 130
}
trap release_lock EXIT
trap on_signal INT TERM

begin_transaction() {
  ensure_repo
  ensure_origin
  SOURCE_BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
  [ -n "$SOURCE_BRANCH" ] || die "detached HEAD is not resumable"
  [ "$SOURCE_BRANCH" = "$TARGET_BRANCH" ] || [ "$MERGE_CURRENT_BRANCH" -eq 1 ] || die "--no-merge-current-branch is unsafe for a non-main source branch"
  SOURCE_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"
  EXPECTED_ORIGIN_MAIN="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")"
  LOCAL_MAIN_BEFORE="$(git -C "$ROOT_DIR" rev-parse "$TARGET_BRANCH")"
  TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  TRANSACTION_DIR="$ROOT_DIR/local_archive/runtime/archive-and-push/$TRANSACTION_ID"
  JOURNAL="$TRANSACTION_DIR/transaction.json"
  mkdir -p "$TRANSACTION_DIR/logs"
  helper journal-init --path "$JOURNAL" --transaction-id "$TRANSACTION_ID" --repository "$ROOT_DIR" --source-branch "$SOURCE_BRANCH" --source-head "$SOURCE_HEAD" --target-branch "$TARGET_BRANCH" --expected-origin-main "$EXPECTED_ORIGIN_MAIN" --local-main-before "$LOCAL_MAIN_BEFORE" --archive-record-path "$(repo_relative_path "$ARCHIVE_RECORD")"
  FINAL_HEAD="$SOURCE_HEAD"
  acquire_lock
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
  ARCHIVE_RECORD="$ROOT_DIR/$(journal_get archive_record_path)"; ensure_archive_record_path
  acquire_lock
  ensure_repo; ensure_origin; run_cmd git -C "$ROOT_DIR" fetch "$REMOTE_NAME"
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
    run_one_test python "$PYTHON_TEST_COMMAND" "$PYTHON_TIMEOUT"
    run_one_test node "$NODE_TEST_COMMAND" "$NODE_TIMEOUT"
    [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || fail validation 36
    local created="$TRANSACTION_DIR/validation-record.json" checksum completed
    helper validation-create --journal "$JOURNAL" --output "$created" --repository "$ROOT_DIR" --branch "$SOURCE_BRANCH" --base-sha "$EXPECTED_ORIGIN_MAIN" --head "$SOURCE_HEAD" --worktree-clean "$(worktree_clean && printf true || printf false)" --node-version "$(node --version 2>/dev/null || printf unavailable)" --python-version "$($PYTHON_BIN --version 2>&1)" --commands-json "$(printf '[%s,%s]' "$(json_quote "$PYTHON_TEST_COMMAND")" "$(json_quote "$NODE_TEST_COMMAND")")" || fail validation 35
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
  run_cmd git -C "$ROOT_DIR" reset -q
  if [ "${#STAGE_PATHS[@]}" -gt 0 ]; then run_cmd git -C "$ROOT_DIR" add -- "${STAGE_PATHS[@]}"; else run_cmd git -C "$ROOT_DIR" add -A -- .; fi
  run_cmd git -C "$ROOT_DIR" reset -q -- .env .env.local .ran_agent_state .openclaw_state data logs debug state local_archive vault/inbox vault/raw vault/wiki .npm .pytest_cache .venv node_bridge/.ran_agent_state node_modules __pycache__
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

merge_to_main() {
  journal_update --phase merge --phase-status running
  fetch_and_check_origin
  [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] || fail merge 61
  [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || fail merge 62
  worktree_clean || fail merge 63
  [ "$SOURCE_BRANCH" = "$TARGET_BRANCH" ] || [ "$MERGE_CURRENT_BRANCH" -eq 1 ] || fail merge 60
  run_cmd git -C "$ROOT_DIR" checkout "$TARGET_BRANCH"
  if [ "$SOURCE_BRANCH" != "$TARGET_BRANCH" ]; then run_cmd git -C "$ROOT_DIR" merge --ff-only "$SOURCE_BRANCH" || fail merge 64; fi
  FINAL_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  journal_update --phase-status succeeded --set-json "merge_result={\"status\":\"succeeded\",\"head\":\"$FINAL_HEAD\"}"
}

push_main() {
  journal_update --phase push --phase-status running
  fetch_and_check_origin
  [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || fail push 71
  local original alt
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

resume() {
  local phase status
  phase="$(journal_get phase)"; status="$(journal_get phase_status)"
  case "$phase:$status" in
    validation:failed|validation:interrupted) validate; stage_and_commit; merge_to_main; push_main; archive_success ;;
    staging:failed|staging:interrupted|commit:failed|commit:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_HEAD" ] || die "unsafe resume before commit"; stage_and_commit; merge_to_main; push_main; archive_success ;;
    merge:failed|merge:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get commit_result.commit_sha)"; [ -n "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$SOURCE_BRANCH" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] || die "unsafe merge resume"; [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$EXPECTED_ORIGIN_MAIN" ] || die "origin changed; refusing resume"; merge_to_main; push_main; archive_success ;;
    push:failed|push:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get merge_result.head)"; [ "$(git -C "$ROOT_DIR" branch --show-current)" = "$TARGET_BRANCH" ] && [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$FINAL_HEAD" ] && [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$EXPECTED_ORIGIN_MAIN" ] || die "unsafe push resume"; push_main; archive_success ;;
    archive:failed|archive:interrupted) validate_persisted_provenance || die "validation provenance is not safely resumable"; FINAL_HEAD="$(journal_get push_result.head)"; [ "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$REMOTE_NAME/$TARGET_BRANCH")" = "$FINAL_HEAD" ] || die "unsafe archive resume"; archive_success ;;
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
  if [ -n "$RESUME_ID" ]; then resume_transaction; resume; else ensure_archive_record_path; begin_transaction; validate; stage_and_commit; merge_to_main; push_main; archive_success; fi
  printf 'archive transaction completed: %s\n' "$TRANSACTION_ID"
}

main "$@"
