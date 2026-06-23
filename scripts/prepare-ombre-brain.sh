#!/usr/bin/env bash
# Prepare the server-local Ombre Brain runtime files.
# This script is idempotent and does not write secrets.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

OMBRE_BRAIN_REPO_URL="${OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$ROOT_DIR/.ran_agent_state/ombre-brain}"
OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
OMBRE_BRAIN_IMAGE="${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"
OMBRE_BRAIN_ENV_EXAMPLE_FILE="${OMBRE_BRAIN_ENV_EXAMPLE_FILE:-$OMBRE_BRAIN_HOME/.env.example}"
OMBRE_BRAIN_PULL_IMAGE="${OMBRE_BRAIN_PULL_IMAGE:-false}"

FORCE_CONFIG=0
FORCE_COMPOSE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-config)
      FORCE_CONFIG=1
      ;;
    --force-compose)
      FORCE_COMPOSE=1
      ;;
    --pull)
      OMBRE_BRAIN_PULL_IMAGE=true
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '[prepare-ombre-brain] %s\n' "$*"
}

write_if_missing() {
  local path="$1"
  local force="$2"
  if [ -f "$path" ] && [ "$force" != "1" ]; then
    log "preserving existing $path"
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  cat > "$path"
  log "wrote $path"
}

mkdir -p "$OMBRE_BRAIN_HOME" "$OMBRE_BUCKETS_DIR"

printf '%s\n' "$OMBRE_BRAIN_REPO_URL" > "$OMBRE_BRAIN_HOME/upstream_url.txt"

write_if_missing "$OMBRE_BRAIN_CONFIG_FILE" "$FORCE_CONFIG" <<'YAML'
transport: "streamable-http"
log_level: "INFO"
buckets_dir: "/app/buckets"

dehydration:
  model: "deepseek-chat"
  base_url: "https://api.deepseek.com/v1"
  max_tokens: 1024
  temperature: 0.1

embedding:
  enabled: true
  backend: "local"

matching:
  fuzzy_threshold: 50
  max_results: 5

surfacing:
  breath_max_results: 20
  breath_max_tokens: 10000
  feel_max_tokens: 6000

limits:
  max_bucket_bytes: 51200
  max_pinned: 20
YAML

write_if_missing "$OMBRE_BRAIN_COMPOSE_FILE" "$FORCE_COMPOSE" <<'YAML'
services:
  ombre-brain:
    image: ${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}
    container_name: ${OMBRE_BRAIN_CONTAINER_NAME:-ran-agent-ombre-brain}
    restart: unless-stopped
    ports:
      - "${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}:${OMBRE_BRAIN_PORT:-18001}:8000"
    environment:
      - OMBRE_TRANSPORT=streamable-http
      - OMBRE_EMBED_BACKEND=${OMBRE_EMBED_BACKEND:-local}
      - OMBRE_COMPRESS_API_KEY=${OMBRE_COMPRESS_API_KEY:-}
      - OMBRE_COMPRESS_BASE_URL=${OMBRE_COMPRESS_BASE_URL:-}
      - OMBRE_COMPRESS_MODEL=${OMBRE_COMPRESS_MODEL:-}
      - OMBRE_EMBED_API_KEY=${OMBRE_EMBED_API_KEY:-}
      - OMBRE_EMBED_BASE_URL=${OMBRE_EMBED_BASE_URL:-}
      - OMBRE_EMBED_MODEL=${OMBRE_EMBED_MODEL:-}
      - OMBRE_DASHBOARD_PASSWORD=${OMBRE_DASHBOARD_PASSWORD:-}
    volumes:
      - ${OMBRE_BUCKETS_DIR:-/opt/ran_agent/vault/ombre}:/app/buckets
      - ${OMBRE_BRAIN_CONFIG_FILE:-/opt/ran_agent/.ran_agent_state/ombre-brain/config.yaml}:/app/config.yaml:ro
YAML

write_if_missing "$OMBRE_BRAIN_ENV_EXAMPLE_FILE" 0 <<'EOF'
# Optional local-only Ombre Brain secrets/config.
# Copy values into a server env file such as /opt/ran_agent/.env.local.
# Do not commit real values.
OMBRE_COMPRESS_API_KEY=
OMBRE_COMPRESS_BASE_URL=
OMBRE_COMPRESS_MODEL=
OMBRE_EMBED_API_KEY=
OMBRE_EMBED_BASE_URL=
OMBRE_EMBED_MODEL=
OMBRE_DASHBOARD_PASSWORD=
EOF

if [ "$OMBRE_BRAIN_PULL_IMAGE" = "1" ] || [ "$OMBRE_BRAIN_PULL_IMAGE" = "true" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required for --pull" >&2
    exit 1
  fi
  log "pulling $OMBRE_BRAIN_IMAGE"
  docker pull "$OMBRE_BRAIN_IMAGE"
fi

log "ready home=$OMBRE_BRAIN_HOME buckets=$OMBRE_BUCKETS_DIR compose=$OMBRE_BRAIN_COMPOSE_FILE"
