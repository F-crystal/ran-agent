#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ran_agent_connectivity.XXXXXX")"
BACKEND_LOG="$TMP_DIR/python-backend.log"
GATEWAY_LOG="$TMP_DIR/openclaw-gateway.log"
BACKEND_PID=""
GATEWAY_PID=""

if command -v qwen >/dev/null 2>&1; then
  QWEN_NODE_DIR="$(cd "$(dirname "$(command -v qwen)")" && pwd)"
  export PATH="$QWEN_NODE_DIR:$PATH"
fi

cleanup() {
  local exit_code=$?

  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  echo "logs: $TMP_DIR"
  exit "$exit_code"
}

trap cleanup EXIT

wait_for_http() {
  local url="$1"
  local attempts="${2:-30}"
  local delay_seconds="${3:-1}"
  local attempt=1

  while [ "$attempt" -le "$attempts" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "backend process exited before $url became healthy"
      return 1
    fi
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done

  echo "timed out waiting for $url"
  return 1
}

wait_for_openclaw_health() {
  local attempts="${1:-60}"
  local delay_seconds="${2:-1}"
  local attempt=1

  while [ "$attempt" -le "$attempts" ]; do
    if npx openclaw health --json --timeout 3000 >/dev/null 2>&1; then
      return 0
    fi
    if [ -n "$GATEWAY_PID" ] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      echo "openclaw gateway process exited before health probe succeeded"
      return 1
    fi
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done

  echo "timed out waiting for openclaw health"
  return 1
}

json_field() {
  local json="$1"
  local filter="$2"
  printf '%s' "$json" | jq -r "$filter"
}

post_json_capture() {
  local url="$1"
  local payload="$2"
  local response_file="$3"
  local timeout_seconds="${4:-30}"
  local http_code

  http_code="$(
    curl -sS \
      -X POST \
      -H 'Content-Type: application/json' \
      --data-raw "$payload" \
      --max-time "$timeout_seconds" \
      -o "$response_file" \
      -w '%{http_code}' \
      "$url"
  )"

  printf '%s' "$http_code"
}

log_knowledge_state() {
  local label="$1"
  local state_json="$2"
  echo "$label: last_status=$(json_field "$state_json" '.last_status // ""') last_action=$(json_field "$state_json" '.last_action // ""') pending=$(json_field "$state_json" '.pending_knowledge_maintenance') inbox=$(json_field "$state_json" '.inbox_count') processed=$(json_field "$state_json" '.processed_inbox_count')"
}

run_knowledge_action() {
  local action="$1"
  local trigger="$2"
  local response_file="$TMP_DIR/knowledge-${action}.json"
  local state_before_file="$TMP_DIR/knowledge-before-${action}.json"
  local state_after_file="$TMP_DIR/knowledge-after-${action}.json"
  local state_before
  local state_after
  local response_json
  local http_code

  state_before="$(curl -fsS --max-time 5 "http://127.0.0.1:8787/tools/knowledge/state")"
  printf '%s' "$state_before" >"$state_before_file"
  log_knowledge_state "knowledge.state.before.${action}" "$state_before"

  http_code="$(post_json_capture \
    "http://127.0.0.1:8787/tools/knowledge/run" \
    "{\"action\":\"$action\",\"trigger\":\"$trigger\"}" \
    "$response_file" \
    180)"

  if [ ! -s "$response_file" ]; then
    echo "knowledge.run.${action}: http=$http_code response=empty"
    return 1
  fi

  state_after="$(curl -fsS --max-time 5 "http://127.0.0.1:8787/tools/knowledge/state")"
  printf '%s' "$state_after" >"$state_after_file"
  response_json="$(cat "$response_file")"

  echo "knowledge.run.${action}: http=$http_code action=$(json_field "$response_json" '.action // ""') status=$(json_field "$response_json" '.status // ""') processed=$(json_field "$response_json" '.processed_inbox_count') pending=$(json_field "$response_json" '.pending_knowledge_maintenance')"
  echo "knowledge.run.${action}.output_excerpt: $(json_field "$response_json" '.output_excerpt // ""')"
  log_knowledge_state "knowledge.state.after.${action}" "$state_after"

  if [ "$http_code" != "200" ]; then
    echo "knowledge.run.${action}: unexpected HTTP status"
    return 1
  fi
}

echo "==> workspace: $ROOT_DIR"
echo "==> temporary logs: $TMP_DIR"

cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export OPENCLAW_CONFIG_PATH="$ROOT_DIR/openclaw/openclaw.personal-system.json"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$ROOT_DIR/.openclaw_state}"
export QWEN_API_KEY="${QWEN_API_KEY:-${DASHSCOPE_API_KEY:-}}"
export MODELSTUDIO_API_KEY="${MODELSTUDIO_API_KEY:-${QWEN_API_KEY:-${DASHSCOPE_API_KEY:-}}}"

echo "==> checking backend"
if curl -fsS --max-time 2 "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
  echo "backend: already healthy"
else
  ./start_python.sh >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  echo "backend: started pid=$BACKEND_PID"
  wait_for_http "http://127.0.0.1:8787/health" 60 1
fi

BACKEND_HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:8787/health")"
echo "backend.health: $BACKEND_HEALTH"
printf '%s' "$BACKEND_HEALTH" | jq -e '.status == "ok"' >/dev/null

KNOWLEDGE_STATE_BEFORE="$(curl -fsS --max-time 5 "http://127.0.0.1:8787/tools/knowledge/state")"
echo "knowledge.state.before: $(json_field "$KNOWLEDGE_STATE_BEFORE" '.last_status // ""') / pending=$(json_field "$KNOWLEDGE_STATE_BEFORE" '.pending_knowledge_maintenance') / inbox=$(json_field "$KNOWLEDGE_STATE_BEFORE" '.inbox_count')"

SMOKE_FAILURES=0

if ! run_knowledge_action "plan" "connectivity_smoke_plan"; then
  SMOKE_FAILURES=$((SMOKE_FAILURES + 1))
fi

if ! run_knowledge_action "apply" "connectivity_smoke_apply"; then
  SMOKE_FAILURES=$((SMOKE_FAILURES + 1))
fi

if ! run_knowledge_action "auto" "connectivity_smoke_auto"; then
  SMOKE_FAILURES=$((SMOKE_FAILURES + 1))
fi

KNOWLEDGE_STATE_AFTER="$(curl -fsS --max-time 5 "http://127.0.0.1:8787/tools/knowledge/state")"
echo "knowledge.state.after: action=$(json_field "$KNOWLEDGE_STATE_AFTER" '.last_action // ""') status=$(json_field "$KNOWLEDGE_STATE_AFTER" '.last_status // ""') pending=$(json_field "$KNOWLEDGE_STATE_AFTER" '.pending_knowledge_maintenance')"

echo "==> checking openclaw"
if npx openclaw health --json --timeout 3000 >/dev/null 2>&1; then
  echo "openclaw: already healthy"
else
  ./start_openclaw.sh >"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
  echo "openclaw: started pid=$GATEWAY_PID"
  wait_for_openclaw_health 90 1
fi

OPENCLAW_HEALTH="$(npx openclaw health --json --timeout 30000)"
echo "openclaw.health: $OPENCLAW_HEALTH"
printf '%s' "$OPENCLAW_HEALTH" | jq -e '.' >/dev/null

HEARTBEAT_CONFIG="$(jq '{heartbeat: .agents.defaults.heartbeat, list_heartbeat: .agents.list[0].heartbeat, tools_profile: .tools.profile, tools_allow: .tools.allow}' openclaw/openclaw.personal-system.json)"
echo "heartbeat.config: $HEARTBEAT_CONFIG"
printf '%s' "$HEARTBEAT_CONFIG" | jq -e '.heartbeat.activeHours.start == "08:30" and .heartbeat.activeHours.end == "23:30" and (.tools_allow | length) > 0' >/dev/null

test -f HEARTBEAT.md
echo "heartbeat.file: $(realpath HEARTBEAT.md)"

echo "==> triggering a heartbeat event"
HEARTBEAT_EVENT="$(npx openclaw system event --text "connectivity smoke heartbeat" --mode now --expect-final --json --timeout 30000)"
echo "heartbeat.event: $HEARTBEAT_EVENT"
printf '%s' "$HEARTBEAT_EVENT" | jq -e '.' >/dev/null

HEARTBEAT_LAST="$(npx openclaw system heartbeat last --timeout 30000)"
echo "heartbeat.last: $HEARTBEAT_LAST"
printf '%s' "$HEARTBEAT_LAST" | rg -n 'HEARTBEAT.md|HEARTBEAT_OK|heartbeat' >/dev/null || true

HEARTBEAT_EVIDENCE="$(rg -n 'HEARTBEAT.md|HEARTBEAT_OK|heartbeat' .openclaw_state/agents/personal-system/sessions -g '*.jsonl' | tail -n 20 || true)"
if [ -n "$HEARTBEAT_EVIDENCE" ]; then
  echo "heartbeat.evidence:"
  printf '%s\n' "$HEARTBEAT_EVIDENCE"
else
  echo "heartbeat.evidence: none found in local session logs"
fi

if [ "$SMOKE_FAILURES" -gt 0 ]; then
  echo "==> smoke completed with $SMOKE_FAILURES knowledge action failure(s)"
  exit 1
fi

echo "==> success"
