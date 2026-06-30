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
for key in RAN_AGENT_REPO_ROOT XHS_COOKIE TAVILY_API_KEY DEEPSEEK_API_KEY DASHSCOPE_API_KEY; do
  found="MISSING"
  for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
    [ -f "$f" ] && grep -q "^${key}=" "$f" 2>/dev/null && found="PRESENT" && break
  done
  echo "$key: $found"
done

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
echo "=== 5. XHS token cache status ==="
XHS_CACHE_PATHS=(
  ".ran_agent_state/social_reader/xhs-note-token-cache.json"
  "node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json"
)
for cache_path in "${XHS_CACHE_PATHS[@]}"; do
  if [ -f "$cache_path" ]; then
    entry_count=$("$PYTHON_BIN" -c "import json; d=json.load(open('$cache_path')); print(len(d.get('entries', d)))" 2>/dev/null || echo "parse_error")
    echo "$cache_path: EXISTS ($entry_count entries)"
  else
    echo "$cache_path: NOT FOUND"
  fi
done

echo ""
echo "=== 6. UV cache and timeout env ==="
for f in .env.local node_bridge/.env.local "$HERMES_HOME/.env" "$HERMES_HOME/profiles/ran-assistant/.env"; do
  if [ -f "$f" ]; then
    for key in UV_CACHE_DIR UV_TOOL_DIR SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS XHS_BACKEND_MCP_TIMEOUT_MS SOCIAL_READER_MCP_TIMEOUT_MS MEDIA_READER_MCP_TIMEOUT_MS PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS PERSONAL_AGENT_OCR_PROVIDER PERSONAL_AGENT_OCR_MODEL PERSONAL_AGENT_OCR_TIMEOUT_MS XHS_GENERIC_FALLBACK_MIN_VERSION; do
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
echo "--- XHS browse backend readiness ---"
BROWSE_MARKER_PATH="$(effective_env_value XHS_BROWSE_MARKER_PATH /opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json)"
echo "XHS_BROWSE_ENABLED: $(effective_env_value XHS_BROWSE_ENABLED false)"
echo "SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: $(effective_env_value SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS false)"
echo "XHS_BROWSE_MCP_COMMAND: $(effective_env_value XHS_BROWSE_MCP_COMMAND NOT_SET)"
echo "XHS_BROWSE_MCP_ARGS_JSON: $(effective_env_value XHS_BROWSE_MCP_ARGS_JSON NOT_SET)"
echo "XHS_BROWSE_MCP_COOKIE_ENV: $(effective_env_value XHS_BROWSE_MCP_COOKIE_ENV XHS_COOKIE)"
echo "XHS_BROWSE_MCP_URL: $(effective_env_value XHS_BROWSE_MCP_URL http://127.0.0.1:18060/mcp)"
echo "marker path: $BROWSE_MARKER_PATH"

if [ -f "$BROWSE_MARKER_PATH" ]; then
  echo "marker: EXISTS"
  if ! "$PYTHON_BIN" -m json.tool "$BROWSE_MARKER_PATH" > /dev/null 2>&1; then
    echo "ERROR: marker CORRUPTED (not valid JSON)"
    echo "marker content (first 200 chars): $(head -c 200 "$BROWSE_MARKER_PATH" 2>/dev/null)"
    echo "xhs browse: NOT READY (marker corrupted)"
  else
    BROWSE_MARKER_OK="$(json_field "$BROWSE_MARKER_PATH" ok)"
    BROWSE_BACKEND="$(json_field "$BROWSE_MARKER_PATH" backend)"
    BROWSE_RELEASE="$(json_field "$BROWSE_MARKER_PATH" release_tag)"
    BROWSE_SERVER="$(json_field "$BROWSE_MARKER_PATH" server_name)"
    BROWSE_MCP_URL="$(json_field "$BROWSE_MARKER_PATH" mcp_url)"
    BROWSE_MCP_EXEC="$(json_field "$BROWSE_MARKER_PATH" mcp_executable)"
    BROWSE_LOGIN_EXEC="$(json_field "$BROWSE_MARKER_PATH" login_executable)"
    BROWSE_MCPORTER="$(json_field "$BROWSE_MARKER_PATH" mcporter_cli)"
    BROWSE_MCPORTER_CONFIG="$(json_field "$BROWSE_MARKER_PATH" mcporter_config_path)"
    BROWSE_COMMAND="$(json_field "$BROWSE_MARKER_PATH" command)"
    echo "marker ok: ${BROWSE_MARKER_OK:-NOT SET}"
    echo "marker backend: ${BROWSE_BACKEND:-NOT SET}"
    echo "marker release_tag: ${BROWSE_RELEASE:-NOT SET}"
    echo "marker server_name: ${BROWSE_SERVER:-NOT SET}"
    echo "marker mcp_url: ${BROWSE_MCP_URL:-NOT SET}"
    echo "marker mcp_executable: ${BROWSE_MCP_EXEC:-NOT SET}"
    echo "marker login_executable: ${BROWSE_LOGIN_EXEC:-NOT SET}"
    echo "marker mcporter_cli: ${BROWSE_MCPORTER:-NOT SET}"
    echo "marker mcporter_config_path: ${BROWSE_MCPORTER_CONFIG:-NOT SET}"
    echo "marker command: ${BROWSE_COMMAND:-NOT SET}"
    if [ -n "$BROWSE_MCP_EXEC" ] && [ -x "$BROWSE_MCP_EXEC" ]; then
      echo "mcp_executable: EXECUTABLE"
    else
      echo "mcp_executable: NOT EXECUTABLE"
    fi
    if [ -n "$BROWSE_MCPORTER" ] && [ -f "$BROWSE_MCPORTER" ]; then
      echo "mcporter_cli: FOUND"
    else
      echo "mcporter_cli: NOT FOUND"
    fi
    if [ -n "$BROWSE_MCPORTER_CONFIG" ] && [ -f "$BROWSE_MCPORTER_CONFIG" ]; then
      echo "mcporter_config: FOUND"
    else
      echo "mcporter_config: NOT FOUND"
    fi
    if [ "$BROWSE_MARKER_OK" = "True" ] && [ -n "$BROWSE_MCP_EXEC" ] && [ -x "$BROWSE_MCP_EXEC" ] && [ -n "$BROWSE_MCPORTER" ] && [ -f "$BROWSE_MCPORTER" ]; then
      echo "xhs browse install: READY"
    else
      echo "xhs browse install: NOT READY"
      echo "hint: run scripts/prepare-xhs-browse-backend.sh --write-env"
    fi
  fi
else
  echo "marker: NOT FOUND"
  echo "xhs browse install: NOT READY"
  echo "hint: run scripts/prepare-xhs-browse-backend.sh --write-env"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files ran-agent-xhs-browse.service >/dev/null 2>&1; then
    if systemctl is-active --quiet ran-agent-xhs-browse.service 2>/dev/null; then
      echo "ran-agent-xhs-browse.service: ACTIVE"
    else
      echo "ran-agent-xhs-browse.service: NOT ACTIVE"
    fi
  else
    echo "ran-agent-xhs-browse.service: NOT INSTALLED"
  fi
fi

if has_arg "--smoke-browse" "$@"; then
  echo ""
  echo "--- XHS browse bridge smoke test ---"
  if [ ! -f "$BROWSE_MARKER_PATH" ]; then
    echo "SKIPPED: marker not found. Run scripts/prepare-xhs-browse-backend.sh --write-env first."
  else
    BROWSE_COMMAND="$(json_field "$BROWSE_MARKER_PATH" command)"
    if [ -n "$BROWSE_COMMAND" ] && [ -x "$BROWSE_COMMAND" ]; then
      echo "smoke testing via $BROWSE_COMMAND (timeout 30s)..."
      BROWSE_SMOKE_STDERR="$(mktemp)"
      BROWSE_SMOKE_RESULT=$(XHS_BROWSE_MARKER_PATH="$BROWSE_MARKER_PATH" timeout 30 "$BROWSE_COMMAND" 2>"$BROWSE_SMOKE_STDERR" <<'MCP_EOF' || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag-xhs-browse","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
MCP_EOF
)
      BROWSE_SMOKE_ERROR="$(head -n 3 "$BROWSE_SMOKE_STDERR" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
      rm -f "$BROWSE_SMOKE_STDERR"
      if [ -n "$BROWSE_SMOKE_ERROR" ]; then
        echo "xhs browse bridge error: $BROWSE_SMOKE_ERROR"
      fi
      if echo "$BROWSE_SMOKE_RESULT" | grep -Eq 'search_feeds|search_notes'; then
        echo "xhs browse search tool: CONFIRMED"
      else
        echo "xhs browse search tool: NOT CONFIRMED"
      fi
      if echo "$BROWSE_SMOKE_RESULT" | grep -Eq 'get_feed_detail|get_note_info|get_note_content'; then
        echo "xhs browse detail tool: CONFIRMED"
      else
        echo "xhs browse detail tool: NOT CONFIRMED"
      fi
    else
      echo "SKIPPED: marker command not executable: $BROWSE_COMMAND"
    fi
  fi
fi

# Token cache (read-only, no side effects)
for cache_path in ".ran_agent_state/social_reader/xhs-note-token-cache.json" "node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json"; do
  if [ -f "$cache_path" ]; then
    count=$("$PYTHON_BIN" -c "import json; d=json.load(open('$cache_path')); print(len(d.get('entries', d)))" 2>/dev/null || echo "?")
    echo "token cache: $cache_path ($count entries)"
  else
    echo "token cache: $cache_path NOT FOUND"
  fi
done

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
