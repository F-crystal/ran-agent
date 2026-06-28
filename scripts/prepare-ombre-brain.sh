#!/usr/bin/env bash
# Prepare the server-local Ombre Brain runtime files.
# This script is idempotent and does not write secrets.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

OMBRE_BRAIN_REPO_URL="${OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$ROOT_DIR/.ran_agent_state/ombre-brain}"
OMBRE_BRAIN_RUNNER="${OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_SOURCE_DIR="${OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME/upstream}"
OMBRE_BRAIN_VENV="${OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME/.venv}"
OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
OMBRE_BRAIN_IMAGE="${OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"
OMBRE_BRAIN_ENV_EXAMPLE_FILE="${OMBRE_BRAIN_ENV_EXAMPLE_FILE:-$OMBRE_BRAIN_HOME/.env.example}"
OMBRE_BRAIN_PULL_IMAGE="${OMBRE_BRAIN_PULL_IMAGE:-false}"
OMBRE_BRAIN_UPDATE_SOURCE="${OMBRE_BRAIN_UPDATE_SOURCE:-true}"
OMBRE_BRAIN_UPDATE_TIMEOUT_SECONDS="${OMBRE_BRAIN_UPDATE_TIMEOUT_SECONDS:-300}"

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

requirements_fingerprint() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    cksum "$path" | awk '{print $1 ":" $2}'
  fi
}

install_source_requirements_if_changed() {
  local requirements="$OMBRE_BRAIN_SOURCE_DIR/requirements.txt"
  [ -f "$requirements" ] || return 0
  local stamp="$OMBRE_BRAIN_VENV/.requirements.fingerprint"
  local current
  current="$(requirements_fingerprint "$requirements")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then
    log "source requirements unchanged; skipping pip install"
    return 0
  fi
  log "installing source requirements"
  "$OMBRE_BRAIN_VENV/bin/python" -m pip install -r "$requirements"
  printf '%s\n' "$current" > "$stamp"
}

prepare_source_runner() {
  case "$OMBRE_BRAIN_RUNNER" in
    source|auto)
      ;;
    *)
      return 0
      ;;
  esac

  if [ -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ]; then
    log "preserving existing source checkout $OMBRE_BRAIN_SOURCE_DIR"
    if [ -d "$OMBRE_BRAIN_SOURCE_DIR/.git" ] && [ "$OMBRE_BRAIN_UPDATE_SOURCE" != "false" ] && [ "$OMBRE_BRAIN_UPDATE_SOURCE" != "0" ]; then
      if command -v timeout >/dev/null 2>&1; then
        timeout "$OMBRE_BRAIN_UPDATE_TIMEOUT_SECONDS" git -C "$OMBRE_BRAIN_SOURCE_DIR" pull --ff-only || log "WARNING: source update timed out or failed; preserving current checkout"
      else
        git -C "$OMBRE_BRAIN_SOURCE_DIR" pull --ff-only || log "WARNING: source update failed; preserving current checkout"
      fi
    fi
  else
    if ! command -v git >/dev/null 2>&1; then
      echo "ERROR: git is required to prepare Ombre Brain source runner" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$OMBRE_BRAIN_SOURCE_DIR")"
    log "cloning $OMBRE_BRAIN_REPO_URL to $OMBRE_BRAIN_SOURCE_DIR"
    git clone --depth 1 "$OMBRE_BRAIN_REPO_URL" "$OMBRE_BRAIN_SOURCE_DIR"
  fi

  if [ ! -f "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" ]; then
    echo "ERROR: missing Ombre Brain source server.py: $OMBRE_BRAIN_SOURCE_DIR/src/server.py" >&2
    exit 1
  fi

  if [ ! -e "$OMBRE_BRAIN_SOURCE_DIR/config.yaml" ]; then
    ln -s "$OMBRE_BRAIN_CONFIG_FILE" "$OMBRE_BRAIN_SOURCE_DIR/config.yaml" 2>/dev/null || cp "$OMBRE_BRAIN_CONFIG_FILE" "$OMBRE_BRAIN_SOURCE_DIR/config.yaml"
    log "linked source config $OMBRE_BRAIN_SOURCE_DIR/config.yaml"
  fi

  if [ ! -x "$OMBRE_BRAIN_VENV/bin/python" ]; then
    log "creating source venv $OMBRE_BRAIN_VENV"
    python3 -m venv "$OMBRE_BRAIN_VENV"
  fi

  install_source_requirements_if_changed
}

mkdir -p "$OMBRE_BRAIN_HOME" "$OMBRE_BUCKETS_DIR"

printf '%s\n' "$OMBRE_BRAIN_REPO_URL" > "$OMBRE_BRAIN_HOME/upstream_url.txt"

write_if_missing "$OMBRE_BRAIN_CONFIG_FILE" "$FORCE_CONFIG" <<YAML
transport: "streamable-http"
log_level: "INFO"
buckets_dir: "$OMBRE_BUCKETS_DIR"

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

prepare_source_runner

log "ready runner=$OMBRE_BRAIN_RUNNER home=$OMBRE_BRAIN_HOME source=$OMBRE_BRAIN_SOURCE_DIR buckets=$OMBRE_BUCKETS_DIR compose=$OMBRE_BRAIN_COMPOSE_FILE"
