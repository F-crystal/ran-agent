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
export OMBRE_BRAIN_HOME
export OMBRE_BRAIN_COMPOSE_FILE
export OMBRE_BRAIN_IMAGE="${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
export OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
export OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
export OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
export OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"

bash "$ROOT_DIR/scripts/prepare-ombre-brain.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required to run Ombre Brain service" >&2
  exit 1
fi

exec docker compose -f "$OMBRE_BRAIN_COMPOSE_FILE" up
