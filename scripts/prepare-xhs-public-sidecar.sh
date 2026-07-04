#!/usr/bin/env bash
# Prepare the public-only XHS-Downloader API sidecar.
# The GPL-licensed upstream source is cloned into .ran_agent_state and is not
# vendored into this repository.
# Usage: bash scripts/prepare-xhs-public-sidecar.sh [--force]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_ROOT="${XHS_PUBLIC_SIDECAR_ROOT_DIR:-/opt/ran_agent/.ran_agent_state/xhs-public-sidecar}"
LOCK_DIR="/opt/ran_agent/.ran_agent_state/locks"
LOCK_FILE="$LOCK_DIR/xhs-public-sidecar.lock"
MARKER_PATH="${XHS_PUBLIC_SIDECAR_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json}"
SOURCE_DIR="${XHS_PUBLIC_SIDECAR_SOURCE_DIR:-$STATE_ROOT/upstream}"
VENV_DIR="${XHS_PUBLIC_SIDECAR_VENV:-$STATE_ROOT/.venv}"
REPO_URL="${XHS_PUBLIC_SIDECAR_REPO_URL:-https://github.com/JoeanAmier/XHS-Downloader.git}"
REPO_REF="${XHS_PUBLIC_SIDECAR_REF:-master}"
PYTHON_VERSION="${XHS_PUBLIC_SIDECAR_PYTHON_VERSION:-3.12}"
API_HOST="${XHS_PUBLIC_SIDECAR_HOST:-127.0.0.1}"
API_PORT="${XHS_PUBLIC_SIDECAR_PORT:-18061}"
API_URL="${XHS_PUBLIC_SIDECAR_URL:-http://$API_HOST:$API_PORT/xhs/detail}"
WRAPPER="$ROOT_DIR/scripts/start_xhs_public_sidecar.sh"
UPDATE_SOURCE="${XHS_PUBLIC_SIDECAR_UPDATE_SOURCE:-true}"

export UV_CACHE_DIR="${UV_CACHE_DIR:-/opt/ran_agent/.ran_agent_state/uv-cache}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"

FORCE_FLAG=""
if [ "${1:-}" = "--force" ]; then
  FORCE_FLAG="--force"
fi

log() {
  printf '[xhs-public-sidecar] %s\n' "$*" >&2
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

write_marker() {
  local ok="$1" version="$2" commit="$3"
  local now tmp_marker
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp_marker="$(mktemp "${MARKER_PATH}.tmp.XXXXXX")"

  python3 - "$ok" "$REPO_URL" "$REPO_REF" "$SOURCE_DIR" "$VENV_DIR/bin/python" "$WRAPPER" "$API_HOST" "$API_PORT" "$API_URL" "$version" "$commit" "$now" > "$tmp_marker" <<'PYEOF'
import json
import sys

ok, repo_url, repo_ref, source_dir, venv_python, command, api_host, api_port, api_url, version, commit, prepared_at = sys.argv[1:]
marker = {
    "ok": ok == "true",
    "backend": "XHS-Downloader",
    "repo_url": repo_url,
    "repo_ref": repo_ref,
    "source_dir": source_dir,
    "venv_python": venv_python,
    "command": command,
    "args": [],
    "api_host": api_host,
    "api_port": int(api_port),
    "api_url": api_url,
    "cookie": "",
    "download": False,
    "version": version or "unknown",
    "commit": commit or "unknown",
    "prepared_at": prepared_at,
}
json.dump(marker, sys.stdout, ensure_ascii=False, indent=2)
PYEOF

  python3 -m json.tool "$tmp_marker" >/dev/null
  mv -f "$tmp_marker" "$MARKER_PATH"
}

marker_is_ready() {
  python3 - "$MARKER_PATH" "$SOURCE_DIR" "$VENV_DIR/bin/python" "$WRAPPER" "$API_URL" <<'PYEOF'
import json
import os
import sys

marker_path, source_dir, venv_python, wrapper, api_url = sys.argv[1:]
with open(marker_path, "r", encoding="utf-8") as fh:
    marker = json.load(fh)

ok = (
    marker.get("ok") is True
    and marker.get("source_dir") == source_dir
    and marker.get("venv_python") == venv_python
    and marker.get("command") == wrapper
    and marker.get("args") == []
    and marker.get("api_url") == api_url
    and marker.get("cookie", "") == ""
    and marker.get("download") is False
    and os.path.isdir(source_dir)
    and os.path.isfile(os.path.join(source_dir, "main.py"))
    and os.path.isfile(venv_python)
    and os.access(venv_python, os.X_OK)
)
sys.exit(0 if ok else 1)
PYEOF
}

ensure_source() {
  if [ ! -d "$SOURCE_DIR/.git" ]; then
    log "cloning XHS-Downloader into $SOURCE_DIR"
    rm -rf "$SOURCE_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SOURCE_DIR" 2>/dev/null \
      || git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
    return 0
  fi

  if [ "$UPDATE_SOURCE" = "false" ] && [ -z "$FORCE_FLAG" ]; then
    log "source update disabled; preserving current checkout"
    return 0
  fi

  log "refreshing XHS-Downloader checkout"
  if ! timeout 300 git -C "$SOURCE_DIR" fetch --depth 1 origin "$REPO_REF"; then
    log "WARNING: source update timed out or failed; preserving current checkout"
    return 0
  fi
  git -C "$SOURCE_DIR" checkout --detach FETCH_HEAD >/dev/null
}

ensure_python() {
  local python_bin="$VENV_DIR/bin/python"
  if [ ! -x "$python_bin" ] || [ -n "$FORCE_FLAG" ]; then
    log "creating sidecar venv with Python $PYTHON_VERSION at $VENV_DIR"
    rm -rf "$VENV_DIR"
    if command -v uv >/dev/null 2>&1; then
      uv venv "$VENV_DIR" --python "$PYTHON_VERSION" --seed
    else
      python3 -m venv "$VENV_DIR"
    fi
  fi

  "$python_bin" - "$PYTHON_VERSION" <<'PYEOF'
import sys

required = tuple(int(part) for part in sys.argv[1].split(".")[:2])
current = sys.version_info[:2]
if current < required:
    raise SystemExit(f"Python {required[0]}.{required[1]}+ required, got {current[0]}.{current[1]}")
PYEOF
}

install_requirements() {
  local requirements="$SOURCE_DIR/requirements.txt"
  local stamp="$STATE_ROOT/requirements.sha256"
  local current_hash old_hash
  if [ ! -f "$requirements" ]; then
    echo "ERROR: missing requirements.txt in $SOURCE_DIR" >&2
    return 1
  fi
  current_hash="$(hash_file "$requirements")"
  old_hash=""
  [ -f "$stamp" ] && old_hash="$(cat "$stamp" 2>/dev/null || true)"
  if [ "$current_hash" = "$old_hash" ] && [ -z "$FORCE_FLAG" ]; then
    log "requirements unchanged; skipping dependency install"
    return 0
  fi

  log "installing sidecar dependencies"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$VENV_DIR/bin/python" -r "$requirements"
  else
    "$VENV_DIR/bin/python" -m pip install -r "$requirements"
  fi
  printf '%s\n' "$current_hash" > "$stamp"
}

write_cookie_free_settings() {
  local volume_dir="$SOURCE_DIR/Volume"
  mkdir -p "$volume_dir"
  "$VENV_DIR/bin/python" - "$volume_dir/settings.json" <<'PYEOF'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        data = {}

data.update({
    "cookie": "",
    "proxy": None,
    "record_data": False,
    "download_record": False,
    "image_download": False,
    "video_download": False,
    "live_download": False,
})
path.write_text(json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8")
PYEOF
}

discover_version() {
  "$VENV_DIR/bin/python" - "$SOURCE_DIR" <<'PYEOF' 2>/dev/null || true
import sys
sys.path.insert(0, sys.argv[1])
try:
    from source.module.static import __VERSION__
except Exception:
    __VERSION__ = ""
print(__VERSION__)
PYEOF
}

mkdir -p "$LOCK_DIR" "$(dirname "$MARKER_PATH")" "$STATE_ROOT"

(
  flock -n 200 || { echo "ERROR: another prepare is running; aborting." >&2; exit 1; }

  if [ -z "$FORCE_FLAG" ] && [ -f "$MARKER_PATH" ] && marker_is_ready 2>/dev/null; then
    echo "Already prepared. Use --force to reinstall." >&2
    cat "$MARKER_PATH" >&2
    exit 0
  fi

  command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }

  ensure_source
  ensure_python
  install_requirements
  write_cookie_free_settings

  VERSION="$(discover_version | head -n 1)"
  COMMIT="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  write_marker "true" "$VERSION" "$COMMIT"
  log "Prepared successfully."
  cat "$MARKER_PATH" >&2
) 200>"$LOCK_FILE"
