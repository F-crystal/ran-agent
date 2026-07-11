#!/usr/bin/env bash

launcher_test_isolation_active() {
  [ "${NODE_ENV:-}" = "test" ] && [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" = "1" ]
}

launcher_load_env_file() {
  local env_file="$1"
  launcher_test_isolation_active && return 0
  [ -f "$env_file" ] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

launcher_activate_venv() {
  local activate_file="$1"
  launcher_test_isolation_active && return 0
  [ -f "$activate_file" ] || return 0
  # shellcheck disable=SC1091
  source "$activate_file"
}

launcher_prepend_path() {
  launcher_test_isolation_active && return 0
  export PATH="$1:$PATH"
}

launcher_resolve_command() {
  command -v "$1"
}
