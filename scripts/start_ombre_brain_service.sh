#!/usr/bin/env bash
# Foreground service launcher for the server-local Ombre Brain container.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CALLER_STATE_DIR="${RAN_AGENT_STATE_DIR:-}"
CALLER_OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-}"
CALLER_MANAGED_OMBRE_RUNTIME="${RAN_AGENT_MANAGED_OMBRE_RUNTIME:-0}"
CALLER_MANAGED_OMBRE_STATE_DIR="${RAN_AGENT_MANAGED_OMBRE_STATE_DIR:-}"
CALLER_MANAGED_OMBRE_BUCKETS_DIR="${RAN_AGENT_MANAGED_OMBRE_BUCKETS_DIR:-}"

if [ "${NODE_ENV:-}" != "test" ] || [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" != "1" ]; then
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
RAN_AGENT_STEWARD_IDENTITY_FILE="${RAN_AGENT_STEWARD_IDENTITY_FILE:-$OMBRE_BRAIN_HOME/steward-identity.v1.json}"
RAN_AGENT_STEWARD_TOKEN_FILE="${RAN_AGENT_STEWARD_TOKEN_FILE:-$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token}"
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
  OMBRE_BRAIN_COMPOSE_FILE="$OMBRE_BRAIN_HOME/docker-compose.yml"
  OMBRE_BRAIN_STATUS_FILE="$OMBRE_BRAIN_HOME/status.json"
  OMBRE_BRAIN_SOURCE_DIR="$OMBRE_BRAIN_HOME/upstream"
  OMBRE_BRAIN_VENV="$OMBRE_BRAIN_HOME/.venv"
  OMBRE_BRAIN_CONFIG_FILE="$OMBRE_BRAIN_HOME/config.yaml"
  RAN_AGENT_STEWARD_IDENTITY_FILE="$OMBRE_BRAIN_HOME/steward-identity.v1.json"
  RAN_AGENT_STEWARD_TOKEN_FILE="$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token"
  OMBRE_BUCKETS_DIR="$CALLER_MANAGED_OMBRE_BUCKETS_DIR"
fi
for actual_expected in \
  "$OMBRE_BRAIN_COMPOSE_FILE|$OMBRE_BRAIN_HOME/docker-compose.yml" \
  "$OMBRE_BRAIN_STATUS_FILE|$OMBRE_BRAIN_HOME/status.json" \
  "$OMBRE_BRAIN_SOURCE_DIR|$OMBRE_BRAIN_HOME/upstream" \
  "$OMBRE_BRAIN_VENV|$OMBRE_BRAIN_HOME/.venv" \
  "$OMBRE_BRAIN_CONFIG_FILE|$OMBRE_BRAIN_HOME/config.yaml" \
  "$RAN_AGENT_STEWARD_IDENTITY_FILE|$OMBRE_BRAIN_HOME/steward-identity.v1.json" \
  "$RAN_AGENT_STEWARD_TOKEN_FILE|$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token"; do
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
export OMBRE_PORT="$OMBRE_BRAIN_PORT"
export OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
export OMBRE_BRAIN_CONFIG_FILE
export RAN_AGENT_STEWARD_IDENTITY_FILE
export RAN_AGENT_STEWARD_TOKEN_FILE

if [ "$OMBRE_BRAIN_RUNNER" != "source" ] ||
  [ "$OMBRE_BRAIN_COMMIT" != "0e83d4671ce1629e03ad36bb9160235bf60dbd34" ] ||
  [ "$OMBRE_BIND_HOST" != "127.0.0.1" ] ||
  [ "${OMBRE_MCP_REQUIRE_AUTH:-}" != "false" ]; then
  echo "ERROR: Ombre O1 source/commit/loopback/auth contract is not satisfied" >&2
  exit 2
fi

if [ -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ] && [ -x "$OMBRE_BRAIN_VENV/bin/python" ]; then
  cd "$OMBRE_BRAIN_SOURCE_DIR"
  exec "$OMBRE_BRAIN_VENV/bin/python" src/server.py
fi
echo "ERROR: Ombre Brain source runner is not prepared: $OMBRE_BRAIN_SOURCE_DIR" >&2
exit 1
