#!/usr/bin/env bash
# Install xiaohongshu-mcp and a project-scoped mcporter bridge for social_reader.
# No cookies or login state are written to Git-tracked files.
#
# Usage:
#   bash scripts/prepare-xhs-browse-backend.sh [--force] [--write-env]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_DIR="${RAN_AGENT_LOCK_DIR:-/opt/ran_agent/.ran_agent_state/locks}"
LOCK_FILE="$LOCK_DIR/xhs-browse-backend.lock"
MARKER_PATH="${XHS_BROWSE_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json}"
STATE_ROOT="${XHS_BROWSE_ROOT_DIR:-/opt/ran_agent/.ran_agent_state/xhs-browse}"
BIN_DIR="$STATE_ROOT/bin"
DOWNLOAD_DIR="$STATE_ROOT/downloads"
EXTRACT_ROOT="$STATE_ROOT/releases"
NODE_TOOLS_DIR="$STATE_ROOT/node-tools"
MCPORTER_CONFIG_DIR="$STATE_ROOT/mcporter"
MCPORTER_CONFIG_PATH="${XHS_MCPORTER_CONFIG_PATH:-$MCPORTER_CONFIG_DIR/mcporter.json}"
MCPORTER_VERSION="${MCPORTER_VERSION:-0.12.2}"
SERVER_NAME="${XHS_BROWSE_MCP_SERVER_NAME:-xiaohongshu}"
MCP_URL="${XHS_BROWSE_MCP_URL:-http://127.0.0.1:18060/mcp}"
RELEASE_TAG="${XHS_BROWSE_RELEASE_TAG:-v2026.06.12.1403-5c43e3d}"
DOWNLOAD_MAX_TIME_SECONDS="${XHS_BROWSE_DOWNLOAD_MAX_TIME_SECONDS:-600}"
WRAPPER="$ROOT_DIR/scripts/run_xhs_browse_mcp.sh"

FORCE=false
WRITE_ENV=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --write-env) WRITE_ENV=true ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOCK_DIR" "$(dirname "$MARKER_PATH")" "$BIN_DIR" "$DOWNLOAD_DIR" "$EXTRACT_ROOT" "$NODE_TOOLS_DIR" "$MCPORTER_CONFIG_DIR"

chown_runtime_paths_if_root() {
  local runtime_user="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
  local runtime_group="${RAN_AGENT_RUNTIME_GROUP:-$runtime_user}"
  if [ "$EUID" -eq 0 ] && id "$runtime_user" >/dev/null 2>&1; then
    chown -R "$runtime_user:$runtime_group" "$STATE_ROOT" "$(dirname "$MARKER_PATH")"
  fi
}

arch_asset() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s' "linux-amd64" ;;
    aarch64|arm64) printf '%s' "linux-arm64" ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

default_sha256_for_asset() {
  case "$1" in
    xiaohongshu-mcp-linux-amd64.tar.gz)
      printf '%s' "6467e0179b755508fb1d71405d4da8234472f7a43464ce2253d6682da6306322"
      ;;
    *)
      printf '%s' ""
      ;;
  esac
}

archive_sha_ok() {
  local file="$1"
  if [ -z "$EXPECTED_SHA" ]; then
    return 0
  fi
  [ -f "$file" ] || return 1
  echo "$EXPECTED_SHA  $file" | sha256sum -c - >/dev/null 2>&1
}

download_release_archive() {
  local local_archive="${XHS_BROWSE_ARCHIVE_PATH:-}"
  local partial_path="${ARCHIVE_PATH}.part"
  local urls url retry_all_errors resume_args

  if [ -n "$local_archive" ]; then
    if [ ! -f "$local_archive" ]; then
      echo "ERROR: XHS_BROWSE_ARCHIVE_PATH not found: $local_archive" >&2
      return 1
    fi
    echo "Using local archive from XHS_BROWSE_ARCHIVE_PATH..." >&2
    cp "$local_archive" "$ARCHIVE_PATH"
    return 0
  fi

  urls="${XHS_BROWSE_DOWNLOAD_URLS:-${XHS_BROWSE_DOWNLOAD_URL:-$DOWNLOAD_URL}}"
  retry_all_errors=()
  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    retry_all_errors=(--retry-all-errors)
  fi

  while IFS= read -r url; do
    url="$(printf '%s' "$url" | xargs)"
    [ -n "$url" ] || continue
    echo "Downloading $ASSET_NAME from $url..." >&2
    resume_args=()
    if [ -s "$partial_path" ]; then
      resume_args=(-C -)
      echo "Resuming partial download: $partial_path" >&2
    fi
    if curl -fL \
      --retry 5 \
      "${retry_all_errors[@]}" \
      --retry-delay 5 \
      --connect-timeout 30 \
      --max-time "$DOWNLOAD_MAX_TIME_SECONDS" \
      "${resume_args[@]}" \
      -o "$partial_path" \
      "$url"; then
      if archive_sha_ok "$partial_path"; then
        mv -f "$partial_path" "$ARCHIVE_PATH"
        return 0
      fi
      echo "WARNING: downloaded archive checksum mismatch; discarding partial file" >&2
      rm -f "$partial_path"
    fi
  done < <(printf '%s\n' "$urls" | tr ',' '\n')

  return 1
}

json_string_array_for_wrapper() {
  python3 - "$WRAPPER" <<'PYEOF'
import json, shlex, sys
print(shlex.quote(json.dumps([sys.argv[1]], ensure_ascii=True)))
PYEOF
}

upsert_env_file() {
  local file="$1"
  shift
  local tmp assignment key
  tmp="$(mktemp)"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      local keep=true
      if [[ "$line" == *=* ]]; then
        key="${line%%=*}"
        for assignment in "$@"; do
          if [ "$key" = "${assignment%%=*}" ]; then
            keep=false
            break
          fi
        done
      fi
      if [ "$keep" = true ]; then
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < "$file"
  fi
  for assignment in "$@"; do
    printf '%s\n' "$assignment" >> "$tmp"
  done
  install -m 600 "$tmp" "$file"
  rm -f "$tmp"
}

write_marker() {
  local ok="$1" asset_name="$2" archive_sha="$3" mcp_exec="$4" login_exec="$5" mcporter_cli="$6"
  local now tmp_marker
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp_marker="$(mktemp "${MARKER_PATH}.tmp.XXXXXX")"
  python3 - "$ok" "$SERVER_NAME" "$MCP_URL" "$RELEASE_TAG" "$asset_name" "$archive_sha" "$mcp_exec" "$login_exec" "$mcporter_cli" "$MCPORTER_CONFIG_PATH" "$WRAPPER" "$MCPORTER_VERSION" "$now" > "$tmp_marker" <<'PYEOF'
import json, sys
ok, server_name, mcp_url, release_tag, asset_name, archive_sha, mcp_exec, login_exec, mcporter_cli, mcporter_config, wrapper, mcporter_version, prepared_at = sys.argv[1:]
marker = {
    "ok": ok == "true",
    "backend": "xiaohongshu-mcp",
    "server_name": server_name,
    "mcp_url": mcp_url,
    "release_tag": release_tag,
    "asset_name": asset_name,
    "asset_sha256": archive_sha,
    "mcp_executable": mcp_exec,
    "login_executable": login_exec,
    "mcporter_cli": mcporter_cli,
    "mcporter_config_path": mcporter_config,
    "mcporter_version": mcporter_version,
    "command": wrapper,
    "args": [],
    "prepared_at": prepared_at,
}
json.dump(marker, sys.stdout, ensure_ascii=False, indent=2)
PYEOF
  python3 -m json.tool "$tmp_marker" > /dev/null
  mv -f "$tmp_marker" "$MARKER_PATH"
}

ensure_mcporter_keep_alive_config() {
  local config_path="$1"
  local server_name="$2"
  python3 - "$config_path" "$server_name" <<'PYEOF'
import json
import os
import sys
import tempfile

config_path, server_name = sys.argv[1:]
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)
servers = config.setdefault("mcpServers", {})
entry = servers.get(server_name)
if not isinstance(entry, dict):
    raise SystemExit(f"missing mcporter server entry: {server_name}")
if entry.get("lifecycle") == "keep-alive":
    raise SystemExit(0)
entry["lifecycle"] = "keep-alive"
directory = os.path.dirname(config_path) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".mcporter.", suffix=".json", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(config, out, ensure_ascii=False, indent=2)
        out.write("\n")
    os.replace(tmp_path, config_path)
finally:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
PYEOF
}

marker_is_ready() {
  python3 - "$MARKER_PATH" <<'PYEOF'
import json, os, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    marker = json.load(fh)
required_files = [
    marker.get("mcp_executable", ""),
    marker.get("mcporter_cli", ""),
    marker.get("mcporter_config_path", ""),
]
ok = (
    marker.get("ok") is True
    and all(path and os.path.exists(path) for path in required_files)
    and os.access(marker.get("mcp_executable", ""), os.X_OK)
)
sys.exit(0 if ok else 1)
PYEOF
}

find_release_executable() {
  local extract_dir="$1"
  local pattern="$2"
  find "$extract_dir" -maxdepth 4 -type f -print | while IFS= read -r file; do
    base="$(basename "$file")"
    case "$base" in
      $pattern)
        printf '%s\n' "$file"
        break
        ;;
    esac
  done
}

(
  flock -n 200 || { echo "ERROR: another XHS browse prepare is running; aborting." >&2; exit 1; }

  if [ "$FORCE" = false ] && [ -f "$MARKER_PATH" ] && marker_is_ready 2>/dev/null; then
    MARKER_CONFIG_PATH=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('mcporter_config_path', '$MCPORTER_CONFIG_PATH'))" 2>/dev/null || printf '%s' "$MCPORTER_CONFIG_PATH")
    MARKER_SERVER_NAME=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('server_name', '$SERVER_NAME'))" 2>/dev/null || printf '%s' "$SERVER_NAME")
    if ! ensure_mcporter_keep_alive_config "$MARKER_CONFIG_PATH" "$MARKER_SERVER_NAME"; then
      echo "WARNING: existing XHS browse mcporter config could not be repaired; reinstalling." >&2
    else
      MCPORTER_CONFIG_PATH="$MARKER_CONFIG_PATH"
      SERVER_NAME="$MARKER_SERVER_NAME"
      echo "Already prepared. Use --force to reinstall." >&2
      if [ "$WRITE_ENV" = true ]; then
        BROWSE_ARGS_JSON="$(json_string_array_for_wrapper)"
        upsert_env_file "$ROOT_DIR/.env.local" \
          "XHS_BROWSE_ENABLED=true" \
          "SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false" \
          "XHS_BROWSE_MARKER_PATH=$MARKER_PATH" \
          "XHS_BROWSE_ROOT_DIR=$STATE_ROOT" \
          "XHS_BROWSE_MCP_URL=$MCP_URL" \
          "XHS_BROWSE_MCP_COMMAND=bash" \
          "XHS_BROWSE_MCP_ARGS_JSON=$BROWSE_ARGS_JSON" \
          "XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE" \
          "XHS_BROWSE_SEARCH_ENABLED=true" \
          "XHS_BROWSE_NOTE_ENABLED=true" \
          "XHS_BROWSE_USER_ENABLED=false" \
          "XHS_BROWSE_FEED_ENABLED=false"
        upsert_env_file "$ROOT_DIR/node_bridge/.env.local" \
          "XHS_BROWSE_ENABLED=true" \
          "SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false" \
          "XHS_BROWSE_MARKER_PATH=$MARKER_PATH" \
          "XHS_BROWSE_ROOT_DIR=$STATE_ROOT" \
          "XHS_BROWSE_MCP_URL=$MCP_URL" \
          "XHS_BROWSE_MCP_COMMAND=bash" \
          "XHS_BROWSE_MCP_ARGS_JSON=$BROWSE_ARGS_JSON" \
          "XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE" \
          "XHS_BROWSE_SEARCH_ENABLED=true" \
          "XHS_BROWSE_NOTE_ENABLED=true" \
          "XHS_BROWSE_USER_ENABLED=false" \
          "XHS_BROWSE_FEED_ENABLED=false"
        echo "Env files updated for XHS browse backend." >&2
      fi
      chown_runtime_paths_if_root
      cat "$MARKER_PATH" >&2
      exit 0
    fi
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is required to run mcporter" >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to install mcporter" >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required to download xiaohongshu-mcp" >&2
    exit 1
  fi

  ASSET_SUFFIX="$(arch_asset)"
  ASSET_NAME="xiaohongshu-mcp-${ASSET_SUFFIX}.tar.gz"
  DOWNLOAD_URL="${XHS_BROWSE_DOWNLOAD_URL:-https://github.com/xpzouying/xiaohongshu-mcp/releases/download/${RELEASE_TAG}/${ASSET_NAME}}"
  ARCHIVE_PATH="$DOWNLOAD_DIR/$ASSET_NAME"
  EXPECTED_SHA="${XHS_BROWSE_ASSET_SHA256:-$(default_sha256_for_asset "$ASSET_NAME")}"

  echo "Installing mcporter@$MCPORTER_VERSION into $NODE_TOOLS_DIR..." >&2
  npm install --silent --prefix "$NODE_TOOLS_DIR" "mcporter@$MCPORTER_VERSION" >&2
  MCPORTER_CLI="$NODE_TOOLS_DIR/node_modules/mcporter/dist/cli.js"
  if [ ! -f "$MCPORTER_CLI" ]; then
    echo "ERROR: mcporter cli not found at $MCPORTER_CLI" >&2
    exit 1
  fi

  if [ "$FORCE" = true ] || ! archive_sha_ok "$ARCHIVE_PATH"; then
    if ! download_release_archive; then
      echo "ERROR: failed to download $ASSET_NAME" >&2
      echo "hint: copy the release tarball to the server and rerun with XHS_BROWSE_ARCHIVE_PATH=/path/to/$ASSET_NAME" >&2
      write_marker "false" "$ASSET_NAME" "$EXPECTED_SHA" "" "" "$MCPORTER_CLI"
      chown_runtime_paths_if_root
      exit 1
    fi
  else
    echo "Using existing verified archive: $ARCHIVE_PATH" >&2
  fi

  if [ -n "$EXPECTED_SHA" ]; then
    echo "$EXPECTED_SHA  $ARCHIVE_PATH" | sha256sum -c - >&2
  else
    echo "WARNING: no default sha256 pinned for $ASSET_NAME; set XHS_BROWSE_ASSET_SHA256 to enforce checksum." >&2
  fi

  EXTRACT_DIR="$EXTRACT_ROOT/$RELEASE_TAG-$ASSET_SUFFIX"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
  chmod -R u+rwX,go-rwx "$EXTRACT_DIR"

  MCP_EXECUTABLE="$(find_release_executable "$EXTRACT_DIR" "xiaohongshu-mcp*")"
  LOGIN_EXECUTABLE="$(find_release_executable "$EXTRACT_DIR" "*login*")"
  if [ -z "$MCP_EXECUTABLE" ]; then
    echo "ERROR: could not find xiaohongshu-mcp executable in release archive" >&2
    find "$EXTRACT_DIR" -maxdepth 4 -type f -print >&2
    write_marker "false" "$ASSET_NAME" "$EXPECTED_SHA" "" "$LOGIN_EXECUTABLE" "$MCPORTER_CLI"
    chown_runtime_paths_if_root
    exit 1
  fi
  chmod +x "$MCP_EXECUTABLE"
  if [ -n "$LOGIN_EXECUTABLE" ]; then
    chmod +x "$LOGIN_EXECUTABLE"
  fi
  ln -sfn "$MCP_EXECUTABLE" "$BIN_DIR/xiaohongshu-mcp"
  if [ -n "$LOGIN_EXECUTABLE" ]; then
    ln -sfn "$LOGIN_EXECUTABLE" "$BIN_DIR/xiaohongshu-login"
  fi

  echo "Writing project-scoped mcporter config at $MCPORTER_CONFIG_PATH..." >&2
  node "$MCPORTER_CLI" --config "$MCPORTER_CONFIG_PATH" \
    config add "$SERVER_NAME" "$MCP_URL" --persist "$MCPORTER_CONFIG_PATH" >&2
  ensure_mcporter_keep_alive_config "$MCPORTER_CONFIG_PATH" "$SERVER_NAME"
  node "$MCPORTER_CLI" --config "$MCPORTER_CONFIG_PATH" config get "$SERVER_NAME" --json >/dev/null

  write_marker "true" "$ASSET_NAME" "$EXPECTED_SHA" "$MCP_EXECUTABLE" "$LOGIN_EXECUTABLE" "$MCPORTER_CLI"

  if [ "$WRITE_ENV" = true ]; then
    BROWSE_ARGS_JSON="$(json_string_array_for_wrapper)"
    upsert_env_file "$ROOT_DIR/.env.local" \
      "XHS_BROWSE_ENABLED=true" \
      "SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false" \
      "XHS_BROWSE_MARKER_PATH=$MARKER_PATH" \
      "XHS_BROWSE_ROOT_DIR=$STATE_ROOT" \
      "XHS_BROWSE_MCP_URL=$MCP_URL" \
      "XHS_BROWSE_MCP_COMMAND=bash" \
      "XHS_BROWSE_MCP_ARGS_JSON=$BROWSE_ARGS_JSON" \
      "XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE" \
      "XHS_BROWSE_SEARCH_ENABLED=true" \
      "XHS_BROWSE_NOTE_ENABLED=true" \
      "XHS_BROWSE_USER_ENABLED=false" \
      "XHS_BROWSE_FEED_ENABLED=false"
    upsert_env_file "$ROOT_DIR/node_bridge/.env.local" \
      "XHS_BROWSE_ENABLED=true" \
      "SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=false" \
      "XHS_BROWSE_MARKER_PATH=$MARKER_PATH" \
      "XHS_BROWSE_ROOT_DIR=$STATE_ROOT" \
      "XHS_BROWSE_MCP_URL=$MCP_URL" \
      "XHS_BROWSE_MCP_COMMAND=bash" \
      "XHS_BROWSE_MCP_ARGS_JSON=$BROWSE_ARGS_JSON" \
      "XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE" \
      "XHS_BROWSE_SEARCH_ENABLED=true" \
      "XHS_BROWSE_NOTE_ENABLED=true" \
      "XHS_BROWSE_USER_ENABLED=false" \
      "XHS_BROWSE_FEED_ENABLED=false"
    echo "Env files updated for XHS browse backend." >&2
  fi

  echo "Prepared successfully." >&2
  chown_runtime_paths_if_root
  cat "$MARKER_PATH" >&2
) 200>"$LOCK_FILE"
