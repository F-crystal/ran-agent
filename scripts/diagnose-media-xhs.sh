#!/bin/bash
# Diagnostic script for media context decay and XHS routing
# Run on server: bash scripts/diagnose-media-xhs.sh
# No secrets exposed.

set -euo pipefail
cd "$(dirname "$0")/.."

HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
ENV_FILES=(
  "$HERMES_HOME/.env"
  "$HERMES_HOME/profiles/ran-assistant/.env"
  "$HERMES_HOME/lite/.env"
  "$HERMES_HOME/lite/profiles/ran-assistant-lite/.env"
  ".env.local"
  "node_bridge/.env.local"
)
PYTHON_BIN="${PYTHON_BIN:-python3}"

effective_env_value() {
  local key="$1"
  local fallback="${2:-}"
  local value="${!key:-}"
  local f line
  for f in "${ENV_FILES[@]}"; do
    if [ -f "$f" ]; then
      line=$(grep "^${key}=" "$f" 2>/dev/null | tail -n 1 || true)
      if [ -n "$line" ]; then
        value="${line#*=}"
      fi
    fi
  done
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '%s' "$fallback"
  fi
}

host_list_contains() {
  local needle="$1"
  local list="$2"
  local item
  IFS=',' read -ra items <<< "$list"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | xargs)"
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

has_arg() {
  local needle="$1"
  local arg
  shift || true
  for arg in "$@"; do
    if [ "$arg" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

json_field() {
  local file="$1"
  local field="$2"
  "$PYTHON_BIN" - "$file" "$field" <<'PYEOF' 2>/dev/null || true
import json
import sys
path, field = sys.argv[1:]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data
for part in field.split("."):
    if isinstance(value, dict):
        value = value.get(part, "")
    else:
        value = ""
        break
print(value if value is not None else "")
PYEOF
}

echo "=== 0. Deployed revision check ==="
echo "repo: $(pwd)"
echo "branch: $(git branch --show-current 2>/dev/null || echo unknown)"
echo "head: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if git diff --quiet -- . 2>/dev/null; then
  echo "worktree: clean"
else
  echo "worktree: dirty"
fi
if grep -q "'xhscdn.com'" node_bridge/src/mediaReader/assetResolver.mjs 2>/dev/null; then
  echo "assetResolver default xhscdn.com: PRESENT"
else
  echo "assetResolver default xhscdn.com: MISSING"
fi

echo ""
echo "=== 1. Hermes runtime config check ==="
if [ -f "$HERMES_HOME/config.yaml" ]; then
  echo "config.yaml: EXISTS"

  echo ""
  echo "--- disabled_tools ---"
  grep -A20 'disabled_tools' "$HERMES_HOME/config.yaml" 2>/dev/null | head -15 || echo "NOT FOUND"

  echo ""
  echo "--- mcp_servers present ---"
  grep '^\s\+\w\+:$' "$HERMES_HOME/config.yaml" 2>/dev/null | sed 's/://' | tr -d ' ' || echo "NONE"

  echo ""
  echo "--- social_reader config ---"
  grep -A6 'social_reader' "$HERMES_HOME/config.yaml" 2>/dev/null || echo "NOT FOUND in runtime config"

  echo ""
  echo "--- web_extract/web_search status ---"
  if grep -q 'web_extract' "$HERMES_HOME/config.yaml" 2>/dev/null; then
    if grep -A10 'disabled_tools' "$HERMES_HOME/config.yaml" | grep -q 'web_extract'; then
      echo "web_extract: DISABLED (in disabled_tools)"
    else
      echo "web_extract: PRESENT (not disabled)"
    fi
  else
    echo "web_extract: not mentioned (Hermes default = enabled)"
  fi
  if grep -A10 'disabled_tools' "$HERMES_HOME/config.yaml" | grep -q 'web_search'; then
    echo "web_search: DISABLED (in disabled_tools) -- WARNING: weather skill needs this"
  else
    echo "web_search: ENABLED"
  fi
else
  echo "config.yaml: NOT FOUND at $HERMES_HOME/config.yaml"
fi

echo ""
echo "=== 2. Profile config MCP check ==="
PROFILE_CONFIG="$HERMES_HOME/profiles/ran-assistant/config.yaml"
if [ -f "$PROFILE_CONFIG" ]; then
  echo "profile config: EXISTS"
  grep -A2 'search_hub\|social_reader\|media_reader\|tavily' "$PROFILE_CONFIG" 2>/dev/null | head -30 || echo "no MCP entries found"
else
  echo "profile config: NOT FOUND"
fi

echo ""
echo "=== 3. Env var check (names only) ==="
for key in RAN_AGENT_REPO_ROOT TAVILY_API_KEY DEEPSEEK_API_KEY DASHSCOPE_API_KEY; do
  found="MISSING"
  for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
    [ -f "$f" ] && grep -q "^${key}=" "$f" 2>/dev/null && found="PRESENT" && break
  done
  echo "$key: $found"
done
ACCOUNT_BACKED_KEYS=$(grep -hE '^(XHS_COOKIE|XHS_MCP_|PERSONAL_AGENT_XHS_MCP_|XHS_BROWSE_|SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS|XHS_NOTE_TOKEN_CACHE_)' "${ENV_FILES[@]}" 2>/dev/null | cut -d= -f1 | sort -u | tr '\n' ' ' || true)
if [ -n "$ACCOUNT_BACKED_KEYS" ]; then
  echo "account-backed XHS env: PRESENT ($ACCOUNT_BACKED_KEYS) -- SHOULD BE REMOVED"
else
  echo "account-backed XHS env: ABSENT"
fi

echo ""
echo "=== 4. Artifact age distribution ==="
"$PYTHON_BIN" -c "
import json, os, glob
from datetime import datetime, timezone

artifact_dir = 'debug/media_context/artifacts'
files = sorted(glob.glob(os.path.join(artifact_dir, '*.json')))
now = datetime.now(timezone.utc)
buckets = {'<1h': 0, '1-6h': 0, '6-24h': 0, '1-3d': 0, '>3d': 0}
for f in files:
    try:
        data = json.loads(open(f).read())
        if data.get('ok') == False: continue
        created = data.get('created_at', '')
        if created:
            ct = datetime.fromisoformat(created.replace('Z', '+00:00'))
            hours = (now - ct).total_seconds() / 3600
            if hours < 1: buckets['<1h'] += 1
            elif hours < 6: buckets['1-6h'] += 1
            elif hours < 24: buckets['6-24h'] += 1
            elif hours < 72: buckets['1-3d'] += 1
            else: buckets['>3d'] += 1
    except: pass
print(f'Total artifacts: {len(files)}')
for bucket, count in buckets.items():
    print(f'  {bucket}: {count}')
"

echo ""
echo "=== 5. Legacy XHS token cache guard ==="
XHS_CACHE_PATHS=(
  ".ran_agent_state/social_reader/xhs-note-token-cache.json"
  "node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json"
)
for cache_path in "${XHS_CACHE_PATHS[@]}"; do
  if [ -f "$cache_path" ]; then
    entry_count=$("$PYTHON_BIN" -c "import json; d=json.load(open('$cache_path')); print(len(d.get('entries', d)))" 2>/dev/null || echo "parse_error")
    echo "$cache_path: EXISTS ($entry_count entries) -- SHOULD BE REMOVED"
  else
    echo "$cache_path: NOT FOUND (OK)"
  fi
done

echo ""
echo "=== 6. UV cache and timeout env ==="
for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
  if [ -f "$f" ]; then
    for key in UV_CACHE_DIR UV_TOOL_DIR SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS XHS_BACKEND_MCP_TIMEOUT_MS SOCIAL_READER_MCP_TIMEOUT_MS MEDIA_READER_MCP_TIMEOUT_MS PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS PERSONAL_AGENT_OCR_PROVIDER PERSONAL_AGENT_OCR_MODEL PERSONAL_AGENT_OCR_TIMEOUT_MS XHS_GENERIC_FALLBACK_MIN_VERSION XHS_PUBLIC_SIDECAR_ENABLED XHS_PUBLIC_SIDECAR_URL XHS_PUBLIC_SIDECAR_TIMEOUT_MS XHS_PUBLIC_HTML_FALLBACK_ENABLED XHS_PUBLIC_SIDECAR_MARKER_PATH; do
      val=$(grep "^${key}=" "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
      if [ -n "$val" ]; then
        echo "$f: $key=$val"
      fi
    done
  fi
done
if [ -d /opt/ran_agent/.ran_agent_state/uv-cache ]; then
  echo "uv-cache size: $(du -sh /opt/ran_agent/.ran_agent_state/uv-cache 2>/dev/null | cut -f1)"
else
  echo "uv-cache: NOT FOUND"
fi

echo ""
echo "--- Effective timeout resolution ---"
# Compute effective timeout using the env files actually sourced by the MCP wrappers.
EFFECTIVE_XHS_TIMEOUT="$(effective_env_value SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS "")"
if [ -z "$EFFECTIVE_XHS_TIMEOUT" ]; then
  EFFECTIVE_XHS_TIMEOUT="$(effective_env_value XHS_BACKEND_MCP_TIMEOUT_MS 90000)"
fi
EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT="$(effective_env_value SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS "$EFFECTIVE_XHS_TIMEOUT")"
EFFECTIVE_GENERIC_TIMEOUT="$(effective_env_value SOCIAL_READER_MCP_TIMEOUT_MS 90000)"
EFFECTIVE_MEDIA_READER_TIMEOUT="$(effective_env_value MEDIA_READER_MCP_TIMEOUT_MS 1200000)"
EFFECTIVE_MEDIA_DOWNLOAD_TIMEOUT="$(effective_env_value PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS 60000)"
EFFECTIVE_MEDIA_CONCURRENCY="$(effective_env_value PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY 3)"
EFFECTIVE_MEDIA_BATCH_TIMEOUT="$(effective_env_value PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS 1200000)"
EFFECTIVE_MEDIA_PER_ITEM_TIMEOUT="$(effective_env_value PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS 120000)"
EFFECTIVE_OCR_PROVIDER="$(effective_env_value PERSONAL_AGENT_OCR_PROVIDER dashscope-qwen-vl-ocr)"
EFFECTIVE_OCR_MODEL="$(effective_env_value PERSONAL_AGENT_OCR_MODEL qwen-vl-ocr-2025-11-20)"
EFFECTIVE_OCR_TIMEOUT="$(effective_env_value PERSONAL_AGENT_OCR_TIMEOUT_MS 120000)"
echo "effective XHS backend timeout: ${EFFECTIVE_XHS_TIMEOUT}"
echo "effective XHS generic fallback timeout: ${EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT}"
echo "effective generic timeout: ${EFFECTIVE_GENERIC_TIMEOUT}"
echo "effective media reader MCP timeout: ${EFFECTIVE_MEDIA_READER_TIMEOUT}"
echo "effective media download timeout: ${EFFECTIVE_MEDIA_DOWNLOAD_TIMEOUT}"
echo "effective media max concurrency: ${EFFECTIVE_MEDIA_CONCURRENCY}"
echo "effective media batch timeout: ${EFFECTIVE_MEDIA_BATCH_TIMEOUT}"
echo "effective media per-item timeout: ${EFFECTIVE_MEDIA_PER_ITEM_TIMEOUT}"
echo "effective OCR provider: ${EFFECTIVE_OCR_PROVIDER}"
echo "effective OCR model: ${EFFECTIVE_OCR_MODEL}"
echo "effective OCR timeout: ${EFFECTIVE_OCR_TIMEOUT}"
if [ "$EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT" = "$EFFECTIVE_GENERIC_TIMEOUT" ] && [ "$EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT" != "90000" ]; then
  echo "WARNING: XHS generic fallback timeout equals generic timeout ($EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT). XHS fallback should use a longer timeout."
elif [ "$EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT" -lt "$EFFECTIVE_GENERIC_TIMEOUT" ] 2>/dev/null; then
  echo "WARNING: XHS generic fallback timeout ($EFFECTIVE_XHS_GENERIC_FALLBACK_TIMEOUT) is shorter than generic timeout ($EFFECTIVE_GENERIC_TIMEOUT). XHS fallback should use a longer timeout."
elif [ "$EFFECTIVE_XHS_TIMEOUT" = "$EFFECTIVE_GENERIC_TIMEOUT" ] && [ "$EFFECTIVE_XHS_TIMEOUT" != "90000" ]; then
  echo "WARNING: XHS timeout equals generic timeout ($EFFECTIVE_XHS_TIMEOUT). XHS should use a longer timeout."
elif [ "$EFFECTIVE_XHS_TIMEOUT" -lt "$EFFECTIVE_GENERIC_TIMEOUT" ] 2>/dev/null; then
  echo "WARNING: XHS timeout ($EFFECTIVE_XHS_TIMEOUT) is shorter than generic timeout ($EFFECTIVE_GENERIC_TIMEOUT). XHS should use a longer timeout."
else
  echo "OK: XHS timeout ($EFFECTIVE_XHS_TIMEOUT) >= generic timeout ($EFFECTIVE_GENERIC_TIMEOUT)"
fi

echo ""
echo "--- Effective media host allowlist ---"
DEFAULT_MEDIA_ALLOWED_HOSTS="xiaohongshu.com,xhscdn.com,xhslink.com,rednote.com,douyin.com,iesdouyin.com,bilibili.com,b23.tv,weibo.com,weibo.cn,kuaishou.com,gifshow.com,music.163.com,y.music.163.com,163cn.tv"
MEDIA_ALLOWED_HOSTS="$(effective_env_value PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS "")"
if [ -n "$MEDIA_ALLOWED_HOSTS" ]; then
  echo "PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS: $MEDIA_ALLOWED_HOSTS"
else
  MEDIA_ALLOWED_HOSTS="$DEFAULT_MEDIA_ALLOWED_HOSTS"
  echo "PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS: DEFAULT"
fi
if host_list_contains "xiaohongshu.com" "$MEDIA_ALLOWED_HOSTS"; then
  echo "ci.xiaohongshu.com: ALLOWED via xiaohongshu.com"
else
  echo "ci.xiaohongshu.com: BLOCKED (missing xiaohongshu.com)"
fi
if host_list_contains "xhscdn.com" "$MEDIA_ALLOWED_HOSTS"; then
  echo "sns-webpic-qc.xhscdn.com: ALLOWED via xhscdn.com"
else
  echo "sns-webpic-qc.xhscdn.com: BLOCKED (missing xhscdn.com)"
fi

echo ""
echo "--- Generic fallback readiness ---"
MARKER_PATH="$(effective_env_value XHS_GENERIC_FALLBACK_READY_PATH /opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json)"
echo "SOCIAL_READER_GENERIC_FALLBACK_ENABLED: $(effective_env_value SOCIAL_READER_GENERIC_FALLBACK_ENABLED true)"
echo "marker path: $MARKER_PATH"

if [ -f "$MARKER_PATH" ]; then
  echo "marker: EXISTS"
  # Validate JSON first
  if ! "$PYTHON_BIN" -m json.tool "$MARKER_PATH" > /dev/null 2>&1; then
    echo "ERROR: marker CORRUPTED (not valid JSON)"
    echo "marker content (first 200 chars): $(head -c 200 "$MARKER_PATH" 2>/dev/null)"
    echo "hint: delete marker and re-prepare: rm '$MARKER_PATH' && bash scripts/prepare-xhs-generic-fallback.sh"
    echo "generic fallback: NOT READY (marker corrupted)"
  else
    MARKER_OK=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "parse_error")
    echo "marker ok: $MARKER_OK"
    MARKER_CMD=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('command', ''))" 2>/dev/null || echo "")
    echo "marker command: ${MARKER_CMD:-NOT SET}"
    MARKER_TOOL=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('tool_name', ''))" 2>/dev/null || echo "")
    echo "marker tool_name: ${MARKER_TOOL:-NOT SET}"
    MARKER_EXEC=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_executable', ''))" 2>/dev/null || echo "")
    echo "marker backend_executable: ${MARKER_EXEC:-NOT SET}"
    MARKER_PYTHON=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_python', ''))" 2>/dev/null || echo "")
    echo "marker backend_python: ${MARKER_PYTHON:-NOT SET}"
    MARKER_MODULE=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_module', ''))" 2>/dev/null || echo "")
    echo "marker backend_module: ${MARKER_MODULE:-NOT SET}"
    MARKER_VERSION=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('version', ''))" 2>/dev/null || echo "")
    echo "marker version: ${MARKER_VERSION:-NOT SET}"
    MIN_GENERIC_FALLBACK_VERSION="$(effective_env_value XHS_GENERIC_FALLBACK_MIN_VERSION 1.2.0)"
    echo "marker min_version: $MIN_GENERIC_FALLBACK_VERSION"
    VERSION_OK=$("$PYTHON_BIN" - "$MARKER_VERSION" "$MIN_GENERIC_FALLBACK_VERSION" <<'PY' 2>/dev/null || echo "False"
import re
import sys

def parts(value):
    return tuple(int(item) for item in re.findall(r"\d+", value)[:3])

current = parts(sys.argv[1])
minimum = parts(sys.argv[2])
width = max(len(current), len(minimum), 1)
print(bool(current) and current + (0,) * (width - len(current)) >= minimum + (0,) * (width - len(minimum)))
PY
)
    if [ "$VERSION_OK" != "True" ]; then
      echo "WARNING: generic fallback version (${MARKER_VERSION:-unknown}) is older than required ($MIN_GENERIC_FALLBACK_VERSION)"
      echo "hint: run scripts/prepare-xhs-generic-fallback.sh --force"
    fi
    if [ "$MARKER_OK" = "True" ]; then
      echo "generic fallback: READY"
    else
      echo "generic fallback: NOT READY (marker ok=false)"
      echo "hint: run scripts/prepare-xhs-generic-fallback.sh"
    fi
  fi
else
  echo "marker: NOT FOUND"
  echo "generic fallback: NOT READY"
  echo "hint: run scripts/prepare-xhs-generic-fallback.sh"
fi

echo ""
echo "--- Account-backed XHS guard ---"
OLD_BROWSE_MARKER="/opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json"
OLD_TOKEN_CACHE="/opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json"
if [ -f "$OLD_BROWSE_MARKER" ]; then
  echo "old browse marker: PRESENT -- SHOULD BE REMOVED"
else
  echo "old browse marker: ABSENT"
fi
if [ -f "$OLD_TOKEN_CACHE" ]; then
  echo "old token cache: PRESENT -- SHOULD BE REMOVED"
else
  echo "old token cache: ABSENT"
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files ran-agent-xhs-browse.service >/dev/null 2>&1; then
    if systemctl is-active --quiet ran-agent-xhs-browse.service 2>/dev/null; then
      echo "ran-agent-xhs-browse.service: ACTIVE -- SHOULD BE STOPPED"
    else
      echo "ran-agent-xhs-browse.service: INSTALLED BUT INACTIVE -- SHOULD BE REMOVED"
    fi
  else
    echo "ran-agent-xhs-browse.service: ABSENT"
  fi
fi
echo "account-backed XHS disabled: $( [ -z "$ACCOUNT_BACKED_KEYS" ] && [ ! -f "$OLD_BROWSE_MARKER" ] && [ ! -f "$OLD_TOKEN_CACHE" ] && echo OK || echo CHECK_REQUIRED )"

echo ""
echo "--- XHS public sidecar readiness ---"
SIDECAR_MARKER_PATH="$(effective_env_value XHS_PUBLIC_SIDECAR_MARKER_PATH /opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json)"
SIDECAR_URL="$(effective_env_value XHS_PUBLIC_SIDECAR_URL http://127.0.0.1:18061/xhs/detail)"
echo "XHS_PUBLIC_SIDECAR_ENABLED: $(effective_env_value XHS_PUBLIC_SIDECAR_ENABLED true)"
echo "XHS_PUBLIC_SIDECAR_URL: $SIDECAR_URL"
echo "XHS_PUBLIC_SIDECAR_TIMEOUT_MS: $(effective_env_value XHS_PUBLIC_SIDECAR_TIMEOUT_MS 90000)"
echo "XHS_PUBLIC_HTML_FALLBACK_ENABLED: $(effective_env_value XHS_PUBLIC_HTML_FALLBACK_ENABLED true)"
echo "marker path: $SIDECAR_MARKER_PATH"

if [ -f "$SIDECAR_MARKER_PATH" ]; then
  echo "marker: EXISTS"
  if ! "$PYTHON_BIN" -m json.tool "$SIDECAR_MARKER_PATH" > /dev/null 2>&1; then
    echo "ERROR: marker CORRUPTED (not valid JSON)"
    echo "marker content (first 200 chars): $(head -c 200 "$SIDECAR_MARKER_PATH" 2>/dev/null)"
    echo "xhs public sidecar: NOT READY (marker corrupted)"
  else
    SIDECAR_MARKER_OK="$(json_field "$SIDECAR_MARKER_PATH" ok)"
    SIDECAR_BACKEND="$(json_field "$SIDECAR_MARKER_PATH" backend)"
    SIDECAR_SOURCE="$(json_field "$SIDECAR_MARKER_PATH" source_dir)"
    SIDECAR_PYTHON="$(json_field "$SIDECAR_MARKER_PATH" venv_python)"
    SIDECAR_COMMAND="$(json_field "$SIDECAR_MARKER_PATH" command)"
    SIDECAR_MARKER_URL="$(json_field "$SIDECAR_MARKER_PATH" api_url)"
    SIDECAR_VERSION="$(json_field "$SIDECAR_MARKER_PATH" version)"
    SIDECAR_COMMIT="$(json_field "$SIDECAR_MARKER_PATH" commit)"
    SIDECAR_COOKIE="$(json_field "$SIDECAR_MARKER_PATH" cookie)"
    SIDECAR_DOWNLOAD="$(json_field "$SIDECAR_MARKER_PATH" download)"
    echo "marker ok: ${SIDECAR_MARKER_OK:-NOT SET}"
    echo "marker backend: ${SIDECAR_BACKEND:-NOT SET}"
    echo "marker source_dir: ${SIDECAR_SOURCE:-NOT SET}"
    echo "marker venv_python: ${SIDECAR_PYTHON:-NOT SET}"
    echo "marker command: ${SIDECAR_COMMAND:-NOT SET}"
    echo "marker api_url: ${SIDECAR_MARKER_URL:-NOT SET}"
    echo "marker version: ${SIDECAR_VERSION:-NOT SET}"
    echo "marker commit: ${SIDECAR_COMMIT:-NOT SET}"
    echo "marker cookie: $( [ -z "$SIDECAR_COOKIE" ] && echo EMPTY || echo SHOULD_BE_EMPTY )"
    echo "marker download: ${SIDECAR_DOWNLOAD:-NOT SET}"
    if [ "$SIDECAR_MARKER_OK" = "True" ] && [ -n "$SIDECAR_SOURCE" ] && [ -f "$SIDECAR_SOURCE/main.py" ] && [ -n "$SIDECAR_PYTHON" ] && [ -x "$SIDECAR_PYTHON" ] && [ -n "$SIDECAR_COMMAND" ] && [ -x "$SIDECAR_COMMAND" ]; then
      echo "xhs public sidecar install: READY"
    else
      echo "xhs public sidecar install: NOT READY"
      echo "hint: run scripts/prepare-xhs-public-sidecar.sh"
    fi
  fi
else
  echo "marker: NOT FOUND"
  echo "xhs public sidecar install: NOT READY"
  echo "hint: run scripts/prepare-xhs-public-sidecar.sh"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files ran-agent-xhs-public-sidecar.service >/dev/null 2>&1; then
    if systemctl is-active --quiet ran-agent-xhs-public-sidecar.service 2>/dev/null; then
      echo "ran-agent-xhs-public-sidecar.service: ACTIVE"
    else
      echo "ran-agent-xhs-public-sidecar.service: NOT ACTIVE"
    fi
  else
    echo "ran-agent-xhs-public-sidecar.service: NOT INSTALLED"
  fi
fi

if has_arg "--smoke-public-sidecar" "$@"; then
  echo ""
  echo "--- XHS public sidecar smoke test ---"
  if ! command -v curl >/dev/null 2>&1; then
    echo "SKIPPED: curl not found"
  else
    DOCS_URL="${SIDECAR_URL%/xhs/detail}/docs"
    OPENAPI_URL="${SIDECAR_URL%/xhs/detail}/openapi.json"
    CONFIRMED_URL=""
    for _attempt in 1 2 3 4 5 6; do
      if curl -fsS -m 5 "$DOCS_URL" >/dev/null 2>&1; then
        CONFIRMED_URL="$DOCS_URL"
        break
      fi
      if curl -fsS -m 5 "$OPENAPI_URL" >/dev/null 2>&1; then
        CONFIRMED_URL="$OPENAPI_URL"
        break
      fi
      sleep 2
    done
    if [ -n "$CONFIRMED_URL" ]; then
      echo "xhs public sidecar HTTP: CONFIRMED ($CONFIRMED_URL)"
    else
      echo "xhs public sidecar HTTP: NOT CONFIRMED"
    fi
  fi
fi

if has_arg "--smoke-social-tools" "$@"; then
  echo ""
  echo "--- Social reader public-only tools smoke test ---"
  SOCIAL_TOOLS_RESULT=$(timeout 30 bash scripts/start_social_reader_mcp.sh <<'MCP_EOF' 2>/dev/null || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag-social-tools","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
MCP_EOF
)
  if echo "$SOCIAL_TOOLS_RESULT" | grep -q '"read_social_post"'; then
    echo "read_social_post tool: PRESENT"
  else
    echo "read_social_post tool: NOT CONFIRMED"
  fi
  if echo "$SOCIAL_TOOLS_RESULT" | grep -Eq 'check_social_login|xhs_browse_'; then
    echo "login/browse tools: PRESENT -- SHOULD BE ABSENT"
  else
    echo "login/browse tools: ABSENT"
  fi
fi

echo "browser fallback: DISABLED (lite default)"

# Optional: real smoke test (only if marker ok=true, uses marker command)
if has_arg "--smoke-generic" "$@"; then
  echo ""
  echo "--- Generic parser smoke test ---"
  if [ ! -f "$MARKER_PATH" ]; then
    echo "SKIPPED: marker not found. Run scripts/prepare-xhs-generic-fallback.sh first."
  else
    MARKER_OK=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "False")
    if [ "$MARKER_OK" != "True" ]; then
      echo "SKIPPED: marker ok=false. Run scripts/prepare-xhs-generic-fallback.sh first."
    else
      SMOKE_CMD=$("$PYTHON_BIN" -c "import json; print(json.load(open('$MARKER_PATH')).get('command', ''))" 2>/dev/null)
      if [ -n "$SMOKE_CMD" ] && [ -x "$SMOKE_CMD" ]; then
        echo "smoke testing via $SMOKE_CMD (timeout 15s)..."
        SMOKE_RESULT=$(timeout 15 "$SMOKE_CMD" <<'MCP_EOF' 2>/dev/null || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag-probe","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
MCP_EOF
)
        if echo "$SMOKE_RESULT" | grep -q 'parse_xhs_link'; then
          echo "parse_xhs_link: CONFIRMED"
        else
          echo "parse_xhs_link: NOT CONFIRMED in smoke response"
          echo "GENERIC_FALLBACK_TOOL_UNCONFIRMED"
        fi
      else
        echo "SKIPPED: marker command not executable: $SMOKE_CMD"
      fi
    fi
  fi
fi

echo ""
echo "=== 7. Recent hermes XHS/social logs ==="
sudo journalctl -u ran-agent-hermes.service --since "30 min ago" --no-pager 2>/dev/null | grep -i 'social_reader\|xhs\|xhslink\|web_extract\|read_social_post' | tail -10 || echo "No recent XHS logs"

echo ""
echo "=== 8. Recent hermes tool usage logs ==="
sudo journalctl -u ran-agent-hermes.service --since "30 min ago" --no-pager 2>/dev/null | grep -i 'tool.*call\|tool.*return\|mcp.*tool' | tail -10 || echo "No recent tool logs"
