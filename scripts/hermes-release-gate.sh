#!/usr/bin/env bash

set -euo pipefail

STAGED_CANDIDATE="${RAN_AGENT_RELEASE_STAGED_CANDIDATE:-0}"
if [[ "$STAGED_CANDIDATE" == 1 ]]; then
  PATH=/usr/bin:/bin
  export PATH
fi

fail() {
  printf 'hermes-release-gate: failed:%s\n' "$1" >&2
  exit 1
}

SOURCE_ROOT_INPUT="${RAN_AGENT_RELEASE_SOURCE_ROOT:-$(/usr/bin/dirname "${BASH_SOURCE[0]}")/..}"
REPO_ROOT="$(cd "$SOURCE_ROOT_INPUT" && pwd -P)" || fail source_root_unavailable
MODE="${1:---core}"
case "$MODE" in
  --core|--all|--preflight-only) ;;
  *) fail invalid_mode ;;
esac

SANDBOX_ROOT="$(mktemp -d /tmp/ran-agent-release-gate.XXXXXX)"
cleanup() {
  chmod -R u+w "$SANDBOX_ROOT" 2>/dev/null || true
  rm -rf "$SANDBOX_ROOT"
}
trap cleanup EXIT INT TERM
mkdir -p "$SANDBOX_ROOT/home" "$SANDBOX_ROOT/tmp"

NODE_BIN="${RAN_AGENT_NODE_BIN:-}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  fail node_binary_required
fi

SAFE_PATH="$(/usr/bin/dirname "$NODE_BIN"):/usr/bin:/bin"
run_clean() {
  /usr/bin/env -i \
    HOME="$SANDBOX_ROOT/home" \
    PATH="$SAFE_PATH" \
    TMPDIR="$SANDBOX_ROOT/tmp" \
    XDG_CACHE_HOME="$SANDBOX_ROOT/cache" \
    XDG_CONFIG_HOME="$SANDBOX_ROOT/config" \
    XDG_DATA_HOME="$SANDBOX_ROOT/data" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    npm_config_cache="$SANDBOX_ROOT/npm-cache" \
    PIP_CACHE_DIR="$SANDBOX_ROOT/pip-cache" \
    UV_CACHE_DIR="$SANDBOX_ROOT/uv-cache" \
    UV_TOOL_DIR="$SANDBOX_ROOT/uv-tools" \
    "$@"
}

NODE_VERSION="$(run_clean "$NODE_BIN" -p 'process.versions.node' 2>/dev/null)" || fail node_version_probe
IFS=. read -r NODE_MAJOR NODE_MINOR NODE_PATCH <<<"$NODE_VERSION"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || ! "$NODE_MINOR" =~ ^[0-9]+$ || ! "$NODE_PATCH" =~ ^[0-9]+$ ]]; then
  fail node_version_invalid
fi
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 13) )); then
  fail node_version_unsupported
fi

SQLITE_PROBE='import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); const row = db.prepare("SELECT 1 AS ok").get(); db.close(); if (row?.ok !== 1) process.exit(1);'
run_clean "$NODE_BIN" --input-type=module -e "$SQLITE_PROBE" >/dev/null 2>&1 || fail node_sqlite_unavailable

if [[ "$MODE" == "--preflight-only" ]]; then
  printf 'hermes-release-gate: preflight-ok\n'
  exit 0
fi

PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in "$(command -v python 2>/dev/null || true)" "$(command -v python3 2>/dev/null || true)"; do
    if [[ -n "$candidate" && "$candidate" == /* && -x "$candidate" ]] \
      && run_clean "$candidate" -I -c 'import pytest' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON_BIN" || "$PYTHON_BIN" != /* || ! -x "$PYTHON_BIN" ]]; then
  fail python_with_pytest_required
fi
SAFE_PATH="$(/usr/bin/dirname "$NODE_BIN"):$(/usr/bin/dirname "$PYTHON_BIN"):/usr/bin:/bin"
run_clean "$PYTHON_BIN" -I -c 'import pytest' >/dev/null 2>&1 || fail pytest_unavailable

HERMES_TEST_BIN=''
resolve_test_hermes_bin() {
  local resolver version
  if [[ "$STAGED_CANDIDATE" == 1 ]]; then
    resolver="$REPO_ROOT/scripts/resolve-hermes-gate-runtime.mjs"
    [[ -f "$resolver" && ! -L "$resolver" && -x /usr/bin/systemctl ]] ||
      fail hermes_runtime_resolver_required
    HERMES_TEST_BIN="$(run_clean "$NODE_BIN" "$resolver" /usr/bin/systemctl)" ||
      fail hermes_v0_13_runtime_required
  else
    HERMES_TEST_BIN="${RAN_AGENT_HERMES_TEST_BIN:-$HOME/.local/bin/hermes}"
  fi
  [[ "$HERMES_TEST_BIN" == /* && -x "$HERMES_TEST_BIN" ]] || fail hermes_v0_13_runtime_required
  version="$(run_clean "$NODE_BIN" -e '
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.argv[1], ["version"], { encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) process.exit(1);
    process.stdout.write(result.stdout);
  ' "$HERMES_TEST_BIN")" || fail hermes_v0_13_runtime_required
  [[ "$version" =~ ^Hermes\ Agent\ v0\.13\. ]] || fail hermes_v0_13_runtime_required
}

SOURCE_ROOT="$SANDBOX_ROOT/source"
mkdir -p "$SOURCE_ROOT"
copy_source_file() {
  local relative_path="$1"
  [[ -n "$relative_path" && "$relative_path" != /* && "$relative_path" != *$'\n'* ]] || fail source_path_invalid
  [[ -f "$REPO_ROOT/$relative_path" && ! -L "$REPO_ROOT/$relative_path" ]] || fail "source_file_invalid:$relative_path"
  mkdir -p "$SOURCE_ROOT/$(dirname "$relative_path")"
  cp -pP "$REPO_ROOT/$relative_path" "$SOURCE_ROOT/$relative_path"
}

if [[ -e "$REPO_ROOT/.git" ]]; then
  while IFS= read -r -d '' relative_path; do
    copy_source_file "$relative_path"
  done < <(/usr/bin/env -i \
    HOME="$SANDBOX_ROOT/home" \
    PATH=/usr/bin:/bin \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    git -C "$REPO_ROOT" ls-files -co --exclude-standard -z)
else
  # A deployment gate runs from the root-owned, git-less archive made by the
  # deploy transaction.  It cannot use git to enumerate files; the explicit
  # marker prevents an arbitrary unpacked directory from gaining this path.
  [[ "${RAN_AGENT_RELEASE_STAGED_CANDIDATE:-0}" == 1 ]] || fail staged_source_marker_required
  find -P "$REPO_ROOT" -type l -print -quit | grep -q . && fail source_symlink_present
  while IFS= read -r -d '' source_path; do
    relative_path="${source_path#"$REPO_ROOT"/}"
    copy_source_file "$relative_path"
  done < <(find -P "$REPO_ROOT" -type f -print0)
fi
if find "$SOURCE_ROOT" -name .env.local -print -quit | grep -q .; then
  fail source_env_file_present
fi
if find "$SOURCE_ROOT" -type l -print -quit | grep -q .; then
  fail source_symlink_present
fi
if find "$SOURCE_ROOT" -name sitecustomize.py -print -quit | grep -q .; then
  fail source_sitecustomize_present
fi
chmod -R a-w "$SOURCE_ROOT"

run_node_test() {
  local test_file="$1"
  local test_name case_root hermes_test_bin=''
  test_name="$(basename "$test_file" .test.mjs)"
  if [[ "$(basename "$test_file")" == hermesGatewayProviderBoundary.integration.test.mjs ]]; then
    resolve_test_hermes_bin
    hermes_test_bin="$HERMES_TEST_BIN"
  fi
  case_root="$SANDBOX_ROOT/node-test-$test_name"
  mkdir -p "$case_root/home" "$case_root/tmp/state" "$case_root/cache" "$case_root/config" \
    "$case_root/data" "$case_root/uv-cache" "$case_root/uv-tools" "$case_root/npm-cache" \
    "$case_root/pip-cache" "$case_root/vault" "$case_root/media" "$case_root/co-reading"
  (
    cd "$SOURCE_ROOT/node_bridge"
    /usr/bin/env -i \
      HOME="$case_root/home" \
      PATH="$SAFE_PATH" \
      TMPDIR="$case_root/tmp" \
      NODE_ENV=test \
      RAN_AGENT_ALLOW_TEST_STATE_DIR=1 \
      RAN_AGENT_STATE_DIR="$case_root/tmp/state" \
      RAN_AGENT_SKIP_ENV_FILE_LOAD=1 \
      RAN_AGENT_NODE_BIN="$NODE_BIN" \
      RAN_AGENT_PYTHON_BIN="$PYTHON_BIN" \
      RAN_AGENT_HERMES_TEST_BIN="$hermes_test_bin" \
      SOCIAL_READER_NODE_BIN="$NODE_BIN" \
      EXTERNAL_MCP_GATEWAY_NODE_BIN="$NODE_BIN" \
      RAN_AGENT_GLOBAL_TIMELINE_PATH="$case_root/tmp/state/global-timeline.jsonl" \
      RAN_AGENT_TIMELINE_ARCHIVE_DIR="$case_root/tmp/state/timeline-archive" \
      OBSIDIAN_MEMORY_VAULT_DIR="$case_root/vault" \
      OBSIDIAN_MEMORY_INDEX_PATH="$case_root/tmp/state/obsidian-memory-index.duckdb" \
      CO_READING_ROOT_DIR="$case_root/co-reading" \
      STICKER_CATALOG_ROOT_DIR="$case_root/tmp/state/stickers" \
      WEIXIN_SDK_INBOUND_MEDIA_DIRS="$case_root/media" \
      XHS_GENERIC_FALLBACK_READY_PATH="$case_root/tmp/state/xhs-ready.json" \
      UV_CACHE_DIR="$case_root/uv-cache" \
      UV_TOOL_DIR="$case_root/uv-tools" \
      XDG_CACHE_HOME="$case_root/cache" \
      XDG_CONFIG_HOME="$case_root/config" \
      XDG_DATA_HOME="$case_root/data" \
      npm_config_cache="$case_root/npm-cache" \
      PIP_CACHE_DIR="$case_root/pip-cache" \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 \
      "$NODE_BIN" --test "$test_file"
  )
}

for test_file in "$SOURCE_ROOT"/node_bridge/tests/*.test.mjs; do
  run_node_test "$test_file" || fail "node_test:$(basename "$test_file")"
done

run_node_smoke() {
  local smoke_mode="$1"
  local case_root="$SANDBOX_ROOT/node-smoke-${smoke_mode#--}"
  mkdir -p "$case_root/home" "$case_root/tmp/state" "$case_root/cache" "$case_root/config" \
    "$case_root/data" "$case_root/uv-cache" "$case_root/uv-tools" "$case_root/npm-cache" \
    "$case_root/pip-cache" "$case_root/vault" "$case_root/media" "$case_root/co-reading"
  (
    cd "$SOURCE_ROOT"
    /usr/bin/env -i \
      HOME="$case_root/home" \
      PATH="$SAFE_PATH" \
      TMPDIR="$case_root/tmp" \
      NODE_ENV=test \
      RAN_AGENT_ALLOW_TEST_STATE_DIR=1 \
      RAN_AGENT_STATE_DIR="$case_root/tmp/state" \
      RAN_AGENT_SKIP_ENV_FILE_LOAD=1 \
      RAN_AGENT_NODE_BIN="$NODE_BIN" \
      SOCIAL_READER_NODE_BIN="$NODE_BIN" \
      EXTERNAL_MCP_GATEWAY_NODE_BIN="$NODE_BIN" \
      RAN_AGENT_GLOBAL_TIMELINE_PATH="$case_root/tmp/state/global-timeline.jsonl" \
      RAN_AGENT_TIMELINE_ARCHIVE_DIR="$case_root/tmp/state/timeline-archive" \
      OBSIDIAN_MEMORY_VAULT_DIR="$case_root/vault" \
      OBSIDIAN_MEMORY_INDEX_PATH="$case_root/tmp/state/obsidian-memory-index.duckdb" \
      CO_READING_ROOT_DIR="$case_root/co-reading" \
      STICKER_CATALOG_ROOT_DIR="$case_root/tmp/state/stickers" \
      WEIXIN_SDK_INBOUND_MEDIA_DIRS="$case_root/media" \
      XHS_GENERIC_FALLBACK_READY_PATH="$case_root/tmp/state/xhs-ready.json" \
      UV_CACHE_DIR="$case_root/uv-cache" \
      UV_TOOL_DIR="$case_root/uv-tools" \
      XDG_CACHE_HOME="$case_root/cache" \
      XDG_CONFIG_HOME="$case_root/config" \
      XDG_DATA_HOME="$case_root/data" \
      npm_config_cache="$case_root/npm-cache" \
      PIP_CACHE_DIR="$case_root/pip-cache" \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 \
      "$NODE_BIN" scripts/hermes-release-smoke.mjs "$smoke_mode"
  )
}

if [[ "$MODE" == "--core" ]]; then
  run_node_smoke --core || fail core_smoke
else
  run_node_smoke --all || fail all_smoke
fi

PYTHON_ROOT="$SANDBOX_ROOT/python-test"
mkdir -p "$PYTHON_ROOT/home" "$PYTHON_ROOT/tmp/state" "$PYTHON_ROOT/cache" \
  "$PYTHON_ROOT/config" "$PYTHON_ROOT/data" "$PYTHON_ROOT/uv-cache" \
  "$PYTHON_ROOT/uv-tools" "$PYTHON_ROOT/pip-cache" "$PYTHON_ROOT/pytest"
(
  cd "$SOURCE_ROOT"
  /usr/bin/env -i \
    HOME="$PYTHON_ROOT/home" \
    PATH="$SAFE_PATH" \
    TMPDIR="$PYTHON_ROOT/tmp" \
    NODE_ENV=test \
    RAN_AGENT_ALLOW_TEST_STATE_DIR=1 \
    RAN_AGENT_STATE_DIR="$PYTHON_ROOT/tmp/state" \
    RAN_AGENT_SKIP_ENV_FILE_LOAD=1 \
    RAN_AGENT_NODE_BIN="$NODE_BIN" \
    PYTHONPATH="$SOURCE_ROOT/src" \
    PYTHONSAFEPATH=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
    XDG_CACHE_HOME="$PYTHON_ROOT/cache" \
    XDG_CONFIG_HOME="$PYTHON_ROOT/config" \
    XDG_DATA_HOME="$PYTHON_ROOT/data" \
    UV_CACHE_DIR="$PYTHON_ROOT/uv-cache" \
    UV_TOOL_DIR="$PYTHON_ROOT/uv-tools" \
    PIP_CACHE_DIR="$PYTHON_ROOT/pip-cache" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    "$PYTHON_BIN" -s -m pytest -q -p no:cacheprovider \
      --basetemp "$PYTHON_ROOT/pytest" tests
) || fail python_tests

printf 'hermes-release-gate: ok\n'
