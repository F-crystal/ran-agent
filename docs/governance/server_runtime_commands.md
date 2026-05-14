# Server Runtime Commands

Status: CURRENT (2026-05-14)

This is the pasteable server runbook for the real `/opt/ran_agent` runtime.
It does not run Phase 5 smoke tests.

## First-Time Hermes Runtime Setup

Run this once if the server is still using a temporary `HERMES_HOME` under
`/tmp`.

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_PROFILE=ran-assistant
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent

mkdir -p "$HERMES_HOME"
hermes profile install /opt/ran_agent/hermes/profile --name "$HERMES_PROFILE" --force -y

PROFILE_ENV="$HERMES_HOME/profiles/$HERMES_PROFILE/.env"
touch "$PROFILE_ENV"
chmod 600 "$PROFILE_ENV"

if [ -f /opt/ran_agent/.env.local ]; then
  set -a
  source /opt/ran_agent/.env.local
  set +a
fi
if [ -f /opt/ran_agent/node_bridge/.env.local ]; then
  set -a
  source /opt/ran_agent/node_bridge/.env.local
  set +a
fi

if [ -z "${API_SERVER_KEY:-}" ] && [ -z "${HERMES_API_KEY:-}" ]; then
  API_SERVER_KEY="$(openssl rand -hex 24)"
  HERMES_API_KEY="$API_SERVER_KEY"
fi
if [ -z "${HERMES_API_KEY:-}" ] && [ -n "${API_SERVER_KEY:-}" ]; then
  HERMES_API_KEY="$API_SERVER_KEY"
fi
if [ -z "${API_SERVER_KEY:-}" ] && [ -n "${HERMES_API_KEY:-}" ]; then
  API_SERVER_KEY="$HERMES_API_KEY"
fi

{
  printf 'RAN_AGENT_REPO_ROOT=%s\n' "$RAN_AGENT_REPO_ROOT"
  printf 'API_SERVER_KEY=%s\n' "$API_SERVER_KEY"
  printf 'HERMES_API_KEY=%s\n' "$HERMES_API_KEY"
  [ -n "${DEEPSEEK_API_KEY:-}" ] && printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"
  [ -n "${DASHSCOPE_API_KEY:-}" ] && printf 'DASHSCOPE_API_KEY=%s\n' "$DASHSCOPE_API_KEY"
  [ -n "${TAVILY_API_KEY:-}" ] && printf 'TAVILY_API_KEY=%s\n' "$TAVILY_API_KEY"
  [ -n "${XHS_COOKIE:-}" ] && printf 'XHS_COOKIE=%s\n' "$XHS_COOKIE"
  [ -n "${SESSDATA:-}" ] && printf 'SESSDATA=%s\n' "$SESSDATA"
} > "$PROFILE_ENV"
chmod 600 "$PROFILE_ENV"

echo "Hermes runtime home is ready: $HERMES_HOME"
hermes profile show "$HERMES_PROFILE"
```

## Pull And Restart Runtime

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull

export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_PROFILE=ran-assistant
export HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
export HERMES_HOST="${HERMES_HOST:-127.0.0.1}"
export HERMES_PORT="${HERMES_PORT:-8642}"
export API_SERVER_ENABLED=true
export API_SERVER_HOST="$HERMES_HOST"
export API_SERVER_PORT="$HERMES_PORT"
export HERMES_API_BASE_URL="http://$HERMES_HOST:$HERMES_PORT/v1"
export NODE_BRIDGE_REPLY_BACKEND=hermes
export HERMES_REPLY_MODE=api
export HERMES_REPLY_TIMEOUT_SECONDS=180
export PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
export PYTHON_BACKEND_INGEST_ENABLED=true
export PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
export PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
export PERSONAL_AGENT_PROACTIVE_ENABLED=false
export PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HF_HOME="${HF_HOME:-$HERMES_HOME/hf-home}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME}"
export SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME:-$HERMES_HOME/sentence-transformers}"
export OBSIDIAN_MEMORY_VAULT_DIR="${OBSIDIAN_MEMORY_VAULT_DIR:-/opt/ran_agent/vault}"
export OBSIDIAN_MEMORY_INDEX_PATH="${OBSIDIAN_MEMORY_INDEX_PATH:-/opt/ran_agent/data/obsidian-memory-index.duckdb}"
export OBSIDIAN_INDEX_DEVICE="${OBSIDIAN_INDEX_DEVICE:-cpu}"
export OBSIDIAN_MEMORY_REINDEX=0
export OBSIDIAN_MEMORY_WATCH=0

mkdir -p /opt/ran_agent/logs "$HERMES_HOME"

if ! hermes profile show "$HERMES_PROFILE" >/dev/null 2>&1; then
  hermes profile install /opt/ran_agent/hermes/profile --name "$HERMES_PROFILE" --force -y
else
  hermes profile install /opt/ran_agent/hermes/profile --name "$HERMES_PROFILE" --force -y
fi

pkill -f 'personal_agent.http_runner' 2>/dev/null || true
pkill -f 'hermes .*gateway run' 2>/dev/null || true
pkill -f 'node_bridge/src/wechatBridge.mjs' 2>/dev/null || true
pkill -f 'node_bridge.*npm start' 2>/dev/null || true

nohup /opt/ran_agent/start_python.sh > /opt/ran_agent/logs/python-backend.log 2>&1 &
sleep 3

nohup hermes -p "$HERMES_PROFILE" gateway run --replace --accept-hooks > /opt/ran_agent/logs/hermes-gateway.log 2>&1 &
sleep 5

cd /opt/ran_agent/node_bridge
nohup env \
  NODE_BRIDGE_REPLY_BACKEND=hermes \
  HERMES_API_BASE_URL="$HERMES_API_BASE_URL" \
  HERMES_REPLY_MODE=api \
  HERMES_REPLY_TIMEOUT_SECONDS=180 \
  PYTHON_BACKEND_BASE_URL="$PYTHON_BACKEND_BASE_URL" \
  PYTHON_BACKEND_INGEST_ENABLED=true \
  PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000 \
  PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000 \
  npm start > /opt/ran_agent/logs/node-bridge.log 2>&1 &

cd /opt/ran_agent
tail -n 80 logs/python-backend.log
tail -n 80 logs/hermes-gateway.log
tail -n 80 logs/node-bridge.log
```

## Quick Health Checks

These are runtime health checks, not Phase 5 smoke tests:

```bash
cd /opt/ran_agent
curl -sS http://127.0.0.1:8787/health
bash -c ':</dev/tcp/127.0.0.1/8642' && echo hermes_gateway_port_ok
tail -n 120 logs/node-bridge.log
```

## If Node Bridge Still Points At OpenClaw

Force Hermes mode in `node_bridge/.env.local`:

```bash
cd /opt/ran_agent
printf '\nNODE_BRIDGE_REPLY_BACKEND=hermes\nHERMES_API_BASE_URL=http://127.0.0.1:8642/v1\nHERMES_REPLY_MODE=api\nPYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787\nPYTHON_BACKEND_INGEST_TIMEOUT_MS=5000\nPERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000\n' >> node_bridge/.env.local
```
