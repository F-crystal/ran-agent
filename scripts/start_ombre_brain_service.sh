#!/usr/bin/env bash
# Foreground service launcher for the server-local Ombre Brain container.

set -euo pipefail

MANAGED_ARG=0
if [ "${1:-}" = "--managed" ]; then
  [ "$#" -eq 4 ] || { echo "ERROR: --managed requires repo, state, and buckets paths" >&2; exit 2; }
  MANAGED_ARG=1
  MANAGED_REPO_ROOT="$2"
  MANAGED_STATE_DIR="$3"
  MANAGED_BUCKETS_DIR="$4"
  shift 4
elif [ "$#" -ne 0 ]; then
  echo "ERROR: invalid Ombre Brain launcher arguments" >&2
  exit 2
fi

if [ "$MANAGED_ARG" = 1 ]; then
  ROOT_DIR="$MANAGED_REPO_ROOT"
else
  ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
fi
CALLER_STATE_DIR="${RAN_AGENT_STATE_DIR:-}"
CALLER_OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-}"
CALLER_MANAGED_OMBRE_RUNTIME="${RAN_AGENT_MANAGED_OMBRE_RUNTIME:-0}"
CALLER_MANAGED_OMBRE_STATE_DIR="${RAN_AGENT_MANAGED_OMBRE_STATE_DIR:-}"
CALLER_MANAGED_OMBRE_BUCKETS_DIR="${RAN_AGENT_MANAGED_OMBRE_BUCKETS_DIR:-}"
if [ "$MANAGED_ARG" = 1 ]; then
  for managed_path in "$MANAGED_REPO_ROOT" "$MANAGED_STATE_DIR" "$MANAGED_BUCKETS_DIR"; do
    [[ "$managed_path" == /* && "$managed_path" != *//* && ! "$managed_path" =~ (^|/)\.\.?(/|$) ]] || {
      echo "ERROR: managed Ombre runtime paths must be normalized absolute paths" >&2
      exit 2
    }
  done
  CALLER_MANAGED_OMBRE_RUNTIME=1
  CALLER_MANAGED_OMBRE_STATE_DIR="$MANAGED_STATE_DIR"
  CALLER_MANAGED_OMBRE_BUCKETS_DIR="$MANAGED_BUCKETS_DIR"
fi

# The managed unit removes these before bash starts; direct invocations also
# keep the absolute venv interpreter isolated from host Python/shell injection.
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH
if [ "$MANAGED_ARG" = 1 ]; then
  export HOME="$ROOT_DIR"
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

if [ "$CALLER_MANAGED_OMBRE_RUNTIME" != "1" ] &&
  { [ "${NODE_ENV:-}" != "test" ] || [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" != "1" ]; }; then
  for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/node_bridge/.env.local"; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
    fi
  done
fi

if [ "$CALLER_MANAGED_OMBRE_RUNTIME" = "1" ]; then
  OMBRE_BRAIN_ENABLED=true
else
  OMBRE_BRAIN_ENABLED="${OMBRE_BRAIN_ENABLED:-true}"
fi
if [ "$OMBRE_BRAIN_ENABLED" = "0" ] || [ "$OMBRE_BRAIN_ENABLED" = "false" ] || [ "$OMBRE_BRAIN_ENABLED" = "no" ] || [ "$OMBRE_BRAIN_ENABLED" = "off" ]; then
  echo "OMBRE_BRAIN_DISABLED"
  exit 0
fi

export RAN_AGENT_STATE_DIR="${CALLER_MANAGED_OMBRE_STATE_DIR:-${CALLER_STATE_DIR:-${RAN_AGENT_STATE_DIR:-/opt/ran_agent/.ran_agent_state}}}"
DERIVED_OMBRE_BRAIN_HOME="$RAN_AGENT_STATE_DIR/ombre-brain"
if [ "$CALLER_MANAGED_OMBRE_RUNTIME" = "1" ]; then
  OMBRE_BRAIN_HOME="$DERIVED_OMBRE_BRAIN_HOME"
elif [ -n "$CALLER_OMBRE_BRAIN_HOME" ]; then
  OMBRE_BRAIN_HOME="$CALLER_OMBRE_BRAIN_HOME"
fi
if [[ -n "${OMBRE_BRAIN_HOME:-}" && "$OMBRE_BRAIN_HOME" != "$DERIVED_OMBRE_BRAIN_HOME" ]]; then
  echo "ERROR: Ombre Brain home must derive from RAN_AGENT_STATE_DIR" >&2
  exit 2
fi
OMBRE_BRAIN_HOME="$DERIVED_OMBRE_BRAIN_HOME"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_STATUS_FILE="${OMBRE_BRAIN_STATUS_FILE:-$OMBRE_BRAIN_HOME/status.json}"
OMBRE_BRAIN_RUNNER="${OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_COMMIT="${OMBRE_BRAIN_COMMIT:-0e83d4671ce1629e03ad36bb9160235bf60dbd34}"
OMBRE_BRAIN_SOURCE_DIR="${OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME/upstream}"
OMBRE_BRAIN_VENV="${OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME/.venv}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"
if [ "$CALLER_MANAGED_OMBRE_RUNTIME" = "1" ]; then
  [ -n "$CALLER_MANAGED_OMBRE_STATE_DIR" ] && [ -n "$CALLER_MANAGED_OMBRE_BUCKETS_DIR" ] || {
    echo "ERROR: managed Ombre runtime requires explicit state and buckets directories" >&2
    exit 2
  }
  OMBRE_BRAIN_RUNNER=source
  OMBRE_BRAIN_COMMIT=0e83d4671ce1629e03ad36bb9160235bf60dbd34
  OMBRE_BIND_HOST=127.0.0.1
  OMBRE_MCP_REQUIRE_AUTH=false
  OMBRE_BRAIN_PORT=18001
  OMBRE_TRANSPORT=streamable-http
  OMBRE_PORT=18001
  OMBRE_BRAIN_COMPOSE_FILE="$OMBRE_BRAIN_HOME/docker-compose.yml"
  OMBRE_BRAIN_STATUS_FILE="$OMBRE_BRAIN_HOME/status.json"
  OMBRE_BRAIN_SOURCE_DIR="$OMBRE_BRAIN_HOME/upstream"
  OMBRE_BRAIN_VENV="$OMBRE_BRAIN_HOME/.venv"
  OMBRE_BRAIN_CONFIG_FILE="$OMBRE_BRAIN_HOME/config.yaml"
  OMBRE_CONFIG_PATH="$OMBRE_BRAIN_CONFIG_FILE"
  OMBRE_BUCKETS_DIR="$CALLER_MANAGED_OMBRE_BUCKETS_DIR"
  OMBRE_VAULT_DIR="$CALLER_MANAGED_OMBRE_BUCKETS_DIR"
fi
for actual_expected in \
  "$OMBRE_BRAIN_COMPOSE_FILE|$OMBRE_BRAIN_HOME/docker-compose.yml" \
  "$OMBRE_BRAIN_STATUS_FILE|$OMBRE_BRAIN_HOME/status.json" \
  "$OMBRE_BRAIN_SOURCE_DIR|$OMBRE_BRAIN_HOME/upstream" \
  "$OMBRE_BRAIN_VENV|$OMBRE_BRAIN_HOME/.venv" \
  "$OMBRE_BRAIN_CONFIG_FILE|$OMBRE_BRAIN_HOME/config.yaml"; do
  [[ "${actual_expected%%|*}" == "${actual_expected#*|}" ]] || {
    echo "ERROR: Ombre runtime path must derive from RAN_AGENT_STATE_DIR" >&2
    exit 2
  }
done
export OMBRE_BRAIN_HOME
export OMBRE_BRAIN_COMPOSE_FILE
export OMBRE_BRAIN_STATUS_FILE
export OMBRE_BRAIN_RUNNER
export OMBRE_BRAIN_COMMIT
export OMBRE_BRAIN_SOURCE_DIR
export OMBRE_BRAIN_VENV
export OMBRE_BRAIN_IMAGE="${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
export OMBRE_BIND_HOST="${OMBRE_BIND_HOST:-127.0.0.1}"
export OMBRE_MCP_REQUIRE_AUTH="${OMBRE_MCP_REQUIRE_AUTH:-false}"
export OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
export OMBRE_TRANSPORT="${OMBRE_TRANSPORT:-streamable-http}"
export OMBRE_PORT="${OMBRE_PORT:-$OMBRE_BRAIN_PORT}"
export OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
export OMBRE_VAULT_DIR="${OMBRE_VAULT_DIR:-$OMBRE_BUCKETS_DIR}"
export OMBRE_BRAIN_CONFIG_FILE
export OMBRE_CONFIG_PATH="${OMBRE_CONFIG_PATH:-$OMBRE_BRAIN_CONFIG_FILE}"

if [ "$OMBRE_BRAIN_RUNNER" != "source" ] ||
  [ "$OMBRE_BRAIN_COMMIT" != "0e83d4671ce1629e03ad36bb9160235bf60dbd34" ] ||
  [ "$OMBRE_BIND_HOST" != "127.0.0.1" ] ||
  [ "${OMBRE_MCP_REQUIRE_AUTH:-}" != "false" ] ||
  [ "$OMBRE_TRANSPORT" != "streamable-http" ]; then
  echo "ERROR: Ombre O1 source/commit/loopback/auth contract is not satisfied" >&2
  exit 2
fi

if [ -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ] && [ -x "$OMBRE_BRAIN_VENV/bin/python" ]; then
  cd "$OMBRE_BRAIN_SOURCE_DIR"
  exec "$OMBRE_BRAIN_VENV/bin/python" -E -s src/server.py
fi
echo "ERROR: Ombre Brain source runner is not prepared: $OMBRE_BRAIN_SOURCE_DIR" >&2
exit 1
