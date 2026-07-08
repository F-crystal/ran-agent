#!/usr/bin/env bash
# Foreground service launcher for the server-local Ombre Brain container.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/node_bridge/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

OMBRE_BRAIN_ENABLED="${OMBRE_BRAIN_ENABLED:-true}"
if [ "$OMBRE_BRAIN_ENABLED" = "0" ] || [ "$OMBRE_BRAIN_ENABLED" = "false" ] || [ "$OMBRE_BRAIN_ENABLED" = "no" ] || [ "$OMBRE_BRAIN_ENABLED" = "off" ]; then
  echo "OMBRE_BRAIN_DISABLED"
  exit 0
fi

OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$ROOT_DIR/.ran_agent_state/ombre-brain}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_STATUS_FILE="${OMBRE_BRAIN_STATUS_FILE:-$OMBRE_BRAIN_HOME/status.json}"
OMBRE_BRAIN_RUNNER="${OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_SOURCE_DIR="${OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME/upstream}"
OMBRE_BRAIN_VENV="${OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME/.venv}"
export OMBRE_BRAIN_HOME
export OMBRE_BRAIN_COMPOSE_FILE
export OMBRE_BRAIN_STATUS_FILE
export OMBRE_BRAIN_RUNNER
export OMBRE_BRAIN_SOURCE_DIR
export OMBRE_BRAIN_VENV
export OMBRE_BRAIN_IMAGE="${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
export OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
export OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
export OMBRE_PORT="$OMBRE_BRAIN_PORT"
export OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
export OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"

bash "$ROOT_DIR/scripts/prepare-ombre-brain.sh"

case "$OMBRE_BRAIN_RUNNER" in
  source)
    if [ -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ] && [ -x "$OMBRE_BRAIN_VENV/bin/python" ]; then
      cd "$OMBRE_BRAIN_SOURCE_DIR"
      exec "$OMBRE_BRAIN_VENV/bin/python" src/server.py
    fi
    echo "ERROR: Ombre Brain source runner is not prepared: $OMBRE_BRAIN_SOURCE_DIR" >&2
    exit 1
    ;;
  docker)
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      exec docker compose -f "$OMBRE_BRAIN_COMPOSE_FILE" up
    fi
    echo "ERROR: docker compose is required when OMBRE_BRAIN_RUNNER=docker" >&2
    exit 1
    ;;
  auto)
    if [ -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ] && [ -x "$OMBRE_BRAIN_VENV/bin/python" ]; then
      cd "$OMBRE_BRAIN_SOURCE_DIR"
      exec "$OMBRE_BRAIN_VENV/bin/python" src/server.py
    fi
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      exec docker compose -f "$OMBRE_BRAIN_COMPOSE_FILE" up
    fi
    echo "ERROR: no available Ombre Brain runner (source not prepared, docker compose unavailable)" >&2
    exit 1
    ;;
  external)
    echo "OMBRE_BRAIN_EXTERNAL_RUNNER"
    exec sleep infinity
    ;;
  *)
    echo "ERROR: invalid OMBRE_BRAIN_RUNNER=$OMBRE_BRAIN_RUNNER" >&2
    exit 1
    ;;
esac
