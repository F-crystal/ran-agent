#!/usr/bin/env bash
# Candidate patch against the pinned official source, exercised in scratch only.

set -euo pipefail
umask 077

fail() {
  printf 'verify-ombre-steward-real-process: failed:%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail invalid_arguments
SOURCE_ROOT="${RAN_AGENT_RELEASE_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
UPSTREAM="${RAN_AGENT_OMBRE_UPSTREAM_SOURCE_DIR:-}"
VENV="${RAN_AGENT_OMBRE_UPSTREAM_VENV:-}"
NODE_BIN="${RAN_AGENT_NODE_BIN:-}"
EXPECTED_COMMIT=0e83d4671ce1629e03ad36bb9160235bf60dbd34
if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_TEST_OMBRE_COMMIT:-}" ]]; then
  EXPECTED_COMMIT="$RAN_AGENT_TEST_OMBRE_COMMIT"
fi
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail expected_commit_invalid
for path in "$SOURCE_ROOT" "$UPSTREAM" "$VENV" "$NODE_BIN"; do
  [[ "$path" == /* && "$path" != *//* && ! "$path" =~ (^|/)\.\.?(/|$) ]] || fail absolute_runtime_inputs_required
done
[[ -d "$UPSTREAM/.git" && ! -L "$UPSTREAM" ]] || fail official_upstream_checkout_required
[[ -x "$VENV/bin/python" && ! -L "$VENV" ]] || fail ombre_venv_required
[[ -x "$NODE_BIN" ]] || fail node_runtime_required
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
EXPECTED_SOURCE_UID="$(id -u "$RUNTIME_USER" 2>/dev/null || true)"
if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_TEST_OMBRE_EXPECTED_SOURCE_UID:-}" ]]; then
  EXPECTED_SOURCE_UID="$RAN_AGENT_TEST_OMBRE_EXPECTED_SOURCE_UID"
fi
[[ "$EXPECTED_SOURCE_UID" =~ ^[0-9]+$ ]] || fail runtime_account_required
[[ "$(id -u)" == "$EXPECTED_SOURCE_UID" ]] || fail runtime_execution_identity_required
path_uid() {
  /usr/bin/stat -c '%u' "$1" 2>/dev/null || /usr/bin/stat -f '%u' "$1" 2>/dev/null
}
actual_source_uids="$(printf '%s %s %s' \
  "$(path_uid "$UPSTREAM")" "$(path_uid "$UPSTREAM/.git")" "$(path_uid "$VENV")")" ||
  fail official_upstream_owner_probe_failed
[[ "$actual_source_uids" == "$EXPECTED_SOURCE_UID $EXPECTED_SOURCE_UID $EXPECTED_SOURCE_UID" ]] ||
  fail official_upstream_owner_invalid

upstream_git() {
  /usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -C "$UPSTREAM" "$@"
}

[[ "$(upstream_git rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || fail official_upstream_commit_mismatch
[[ -f "$UPSTREAM/requirements.lock.txt" && ! -L "$UPSTREAM/requirements.lock.txt" ]] || fail official_lock_regular_file_required
upstream_git diff --quiet HEAD -- requirements.lock.txt || fail official_lock_worktree_dirty

VENV_PYTHON="$VENV/bin/python"
[[ "$("$VENV_PYTHON" -I -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" == 3.12 ]] ||
  fail ombre_venv_python_3_12_required
"$VENV_PYTHON" -m pip check >/dev/null || fail ombre_venv_dependency_conflict
"$VENV_PYTHON" -I -c \
  'import frontmatter, httpx, jieba, mcp, numpy, openai, rapidfuzz, rank_bm25, sklearn, uvicorn, yaml, zstandard' ||
  fail ombre_venv_import_contract

lock_digest="$("$VENV_PYTHON" -I -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$UPSTREAM/requirements.lock.txt")"
[[ "$(tr -d '[:space:]' < "$VENV/.requirements.lock.fingerprint")" == "$lock_digest" ]] ||
  fail ombre_venv_lock_fingerprint_mismatch

case_root="$(mktemp -d "${TMPDIR:-/tmp}/ombre-real-gate.XXXXXX")"
case_root="$(cd "$case_root" && pwd -P)"
server_pid=''
cleanup() {
  if [[ "$server_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$case_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

checkout="$case_root/state/ombre-brain/upstream"
vault="$case_root/vault"
mkdir -p "$case_root/state/ombre-brain" "$case_root/state/ombre-compat/secrets" "$case_root/home" "$case_root/tmp" "$vault"
git init --quiet "$checkout"
upstream_git="$(upstream_git rev-parse --absolute-git-dir)"
upstream_objects="$(cd "$upstream_git/objects" && pwd -P)"
printf '%s\n' "$upstream_objects" > "$checkout/.git/objects/info/alternates"
git -C "$checkout" update-ref HEAD "$EXPECTED_COMMIT"
git -C "$checkout" reset --quiet --hard "$EXPECTED_COMMIT"
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || fail scratch_upstream_commit_mismatch
identity="$case_root/state/ombre-brain/steward-identity.v1.json"
"$VENV_PYTHON" -I "$SOURCE_ROOT/scripts/apply_ombre_steward_patch.py" \
  --checkout "$checkout" --identity-output "$identity" >/dev/null || fail candidate_patch_apply_failed
"$VENV_PYTHON" -I "$SOURCE_ROOT/scripts/apply_ombre_steward_patch.py" \
  --checkout "$checkout" --identity-output "$identity" --verify >/dev/null || fail candidate_patch_identity_failed

token="$case_root/state/ombre-compat/secrets/steward-api-token"
"$VENV_PYTHON" -I -c 'import secrets; print(secrets.token_hex(32))' > "$token"
chmod 600 "$token"
chgrp "$(id -g)" "$token"
config="$case_root/state/ombre-brain/config.yaml"
printf 'transport: "streamable-http"\nlog_level: "INFO"\nbuckets_dir: "%s"\nembedding:\n  enabled: false\n' "$vault" > "$config"
port="$("$VENV_PYTHON" -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
[[ "$port" =~ ^[1-9][0-9]*$ ]] || fail scratch_port_invalid

/usr/bin/env -i \
  HOME="$case_root/home" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TMPDIR="$case_root/tmp" \
  OMBRE_CONFIG_PATH="$config" OMBRE_TRANSPORT=streamable-http OMBRE_PORT="$port" \
  OMBRE_BIND_HOST=127.0.0.1 OMBRE_MCP_REQUIRE_AUTH=false \
  OMBRE_VAULT_DIR="$vault" OMBRE_BUCKETS_DIR="$vault" \
  RAN_AGENT_STEWARD_IDENTITY_FILE="$identity" RAN_AGENT_STEWARD_TOKEN_FILE="$token" \
  "$VENV_PYTHON" -E -s "$checkout/src/server.py" >"$case_root/server.log" 2>&1 &
server_pid=$!

ready=0
for _ in {1..150}; do
  kill -0 "$server_pid" 2>/dev/null || break
  if "$VENV_PYTHON" -I -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=1).read()' \
    "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  tail -n 60 "$case_root/server.log" >&2 || true
  fail scratch_process_not_ready
fi

/usr/bin/env -i \
  HOME="$case_root/home" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" TMPDIR="$case_root/tmp" \
  OMBRE_PATCHED_PROCESS_URL="http://127.0.0.1:$port/internal/ran-agent/steward/v1" \
  OMBRE_PATCHED_PROCESS_MUTATION_TEST=1 \
  RAN_AGENT_STEWARD_TOKEN_FILE="$token" RAN_AGENT_STEWARD_IDENTITY_FILE="$identity" \
  "$NODE_BIN" --test "$SOURCE_ROOT/node_bridge/tests/ombreCompatPatchedProcess.test.mjs" >"$case_root/node-test.log" 2>&1 || {
    tail -n 80 "$case_root/node-test.log" >&2 || true
    fail steward_full_contract_failed
  }

printf 'verify-ombre-steward-real-process: ok commit=%s python=3.12\n' "$EXPECTED_COMMIT"
