# Server Runtime Commands

Status: CURRENT (2026-05-15)

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

## Sync Hermes Profile Env From Local Env Files

Run this when Hermes MCP tools are missing variables that already exist in
`/opt/ran_agent/.env.local` or `/opt/ran_agent/node_bridge/.env.local`.

This command copies env assignments into the Hermes profile env file and only
prints key lengths/hashes, not secret values.

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

export HERMES_PROFILE=ran-assistant
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
PROFILE_ENV="$HERMES_HOME/profiles/$HERMES_PROFILE/.env"

mkdir -p "$(dirname "$PROFILE_ENV")"
touch "$PROFILE_ENV"
chmod 600 "$PROFILE_ENV"
cp -p "$PROFILE_ENV" "$PROFILE_ENV.bak.$(date +%Y%m%d%H%M%S)"

for SRC in /opt/ran_agent/.env.local /opt/ran_agent/node_bridge/.env.local; do
  [ -f "$SRC" ] || continue
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    case "$key" in ''|*[!A-Za-z0-9_]* ) continue ;; esac
    sed -i "/^${key}=/d" "$PROFILE_ENV"
    printf '%s\n' "$line" >> "$PROFILE_ENV"
  done < "$SRC"
done

for entry in \
  "RAN_AGENT_REPO_ROOT=/opt/ran_agent" \
  "HERMES_PROFILE=$HERMES_PROFILE" \
  "HERMES_HOME=$HERMES_HOME" \
  "HERMES_API_BASE_URL=http://127.0.0.1:8642/v1" \
  "PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787" \
  "OBSIDIAN_MEMORY_VAULT_DIR=/opt/ran_agent/vault" \
  "OBSIDIAN_MEMORY_INDEX_PATH=/opt/ran_agent/data/obsidian-memory-index.duckdb" \
  "OBSIDIAN_INDEX_DEVICE=cpu" \
  "OBSIDIAN_MEMORY_REINDEX=0" \
  "OBSIDIAN_MEMORY_WATCH=0"
do
  key="${entry%%=*}"
  sed -i "/^${key}=/d" "$PROFILE_ENV"
  printf '%s\n' "$entry" >> "$PROFILE_ENV"
done

chmod 600 "$PROFILE_ENV"

for key in \
  API_SERVER_KEY HERMES_API_KEY DEEPSEEK_API_KEY RAN_AGENT_REPO_ROOT \
  PYTHON_BACKEND_BASE_URL DASHSCOPE_API_KEY QWEN_API_KEY \
  MIMO_TOKEN_PLAN_API_KEY OBSIDIAN_INDEX_DEVICE OBSIDIAN_MEMORY_INDEX_PATH \
  OBSIDIAN_MEMORY_REINDEX OBSIDIAN_MEMORY_WATCH TAVILY_API_KEY
do
  value="$(grep -E "^${key}=" "$PROFILE_ENV" | tail -n 1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then
    hash="$(printf '%s' "$value" | sha256sum | awk '{print substr($1,1,12)}')"
    echo "$key: SET len=${#value} sha256=$hash"
  else
    echo "$key: UNSET"
  fi
done

sudo systemctl restart ran-agent-python.service
sleep 3
sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

sudo systemctl status ran-agent-python.service --no-pager
sudo systemctl status ran-agent-hermes.service --no-pager
sudo systemctl status ran-agent-node.service --no-pager
```

## Fix Hermes Gateway Warnings

Use this if the Hermes gateway log shows either of these warnings:

- `Stale systemd unit detected ... TimeoutStopSec=90s`
- `No user allowlists configured`

Do not keep rewriting the systemd unit if `TimeoutStopSec` stays at `90s`.
Hermes accepts the other fix shown in its warning: shorten the restart drain
timeout so `90s` is enough.

References checked:

- Hermes CLI docs: `hermes gateway install/start/stop/restart/status` are the
  supported service commands.
- Hermes env docs: variables belong in `/home/ubuntu/.hermes/.env`.
- Hermes security docs: authorization checks `GATEWAY_ALLOWED_USERS` and
  `GATEWAY_ALLOW_ALL_USERS`; no allowlist means unauthorized users are denied.
- Hermes config analysis: `HERMES_RESTART_DRAIN_TIMEOUT` overrides
  `agent.restart_drain_timeout`.

Paste this on the server to suppress both warnings for the local bridge runtime:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

export HERMES_PROFILE=ran-assistant
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
PROFILE_ENV="$HERMES_HOME/profiles/$HERMES_PROFILE/.env"
GLOBAL_ENV=/home/ubuntu/.hermes/.env

mkdir -p "$(dirname "$PROFILE_ENV")" "$(dirname "$GLOBAL_ENV")"
touch "$PROFILE_ENV"
touch "$GLOBAL_ENV"
chmod 600 "$PROFILE_ENV"
chmod 600 "$GLOBAL_ENV"
cp -p "$PROFILE_ENV" "$PROFILE_ENV.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$GLOBAL_ENV" "$GLOBAL_ENV.bak.$(date +%Y%m%d%H%M%S)"

for ENV_FILE in "$PROFILE_ENV" "$GLOBAL_ENV"; do
  sed -i '/^HERMES_RESTART_DRAIN_TIMEOUT=/d' "$ENV_FILE"
  printf 'HERMES_RESTART_DRAIN_TIMEOUT=60\n' >> "$ENV_FILE"
done

for ENV_FILE in "$PROFILE_ENV" "$GLOBAL_ENV"; do
  sed -i '/^GATEWAY_ALLOW_ALL_USERS=/d' "$ENV_FILE"
  printf 'GATEWAY_ALLOW_ALL_USERS=true\n' >> "$ENV_FILE"
done

sudo mkdir -p /etc/systemd/system/ran-agent-hermes.service.d
sudo tee /etc/systemd/system/ran-agent-hermes.service.d/30-hermes-env.conf >/dev/null <<'EOF'
[Service]
EnvironmentFile=-/home/ubuntu/.hermes/.env
EnvironmentFile=-/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
EOF

sudo systemctl daemon-reload
sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

for key in HERMES_RESTART_DRAIN_TIMEOUT GATEWAY_ALLOW_ALL_USERS; do
  value="$(grep -E "^${key}=" "$GLOBAL_ENV" | tail -n 1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then
    echo "$key: SET len=${#value}"
  else
    echo "$key: UNSET"
  fi
done

sudo systemctl show ran-agent-hermes.service -p TimeoutStopUSec --no-pager
sudo journalctl -u ran-agent-hermes -n 80 --no-pager
```

If the allowlist warning still appears, use an explicit cross-platform allowlist
instead of global allow-all:

```bash
cd /opt/ran_agent

GLOBAL_ENV=/home/ubuntu/.hermes/.env
PROFILE_ENV=/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
ALLOWED_WECHAT_USER='replace-with-wechat-user-id'

for ENV_FILE in "$GLOBAL_ENV" "$PROFILE_ENV"; do
  sed -i '/^GATEWAY_ALLOW_ALL_USERS=/d' "$ENV_FILE"
  sed -i '/^GATEWAY_ALLOWED_USERS=/d' "$ENV_FILE"
  printf 'GATEWAY_ALLOWED_USERS=%s\n' "$ALLOWED_WECHAT_USER" >> "$ENV_FILE"
done

sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

sudo journalctl -u ran-agent-hermes -n 80 --no-pager
```

## Systemd Cutover To Hermes Runtime

Use this when `systemctl list-units 'ran-agent*' --type=service` shows the
server is already managed by systemd. This is the normal production path.

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull

export RAN_AGENT_REPO_ROOT=/opt/ran_agent
export HERMES_PROFILE=ran-assistant
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
export HERMES_HOST=127.0.0.1
export HERMES_PORT=8642
export HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
export PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787

mkdir -p "$HERMES_HOME" /opt/ran_agent/logs
hermes profile install /opt/ran_agent/hermes/profile --name "$HERMES_PROFILE" --force -y

sudo systemctl stop ran-agent-node.service ran-agent-python.service 2>/dev/null || true
sudo systemctl disable 2>/dev/null || true

pkill -f '/tmp/ran-agent-hermes-home-phase5' 2>/dev/null || true
pkill -f 'obsidian-index mcp' 2>/dev/null || true
pkill -f 'hermes .*gateway run' 2>/dev/null || true
pkill -f 'personal_agent.http_runner' 2>/dev/null || true
pkill -f 'node_bridge/src/wechatBridge.mjs' 2>/dev/null || true

sudo tee /etc/systemd/system/ran-agent-hermes.service >/dev/null <<'EOF'
[Unit]
Description=Ran Agent Hermes Gateway
After=network-online.target ran-agent-python.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-/opt/ran_agent/.env.local
EnvironmentFile=-/opt/ran_agent/node_bridge/.env.local
EnvironmentFile=-/home/ubuntu/.hermes/.env
EnvironmentFile=-/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=HERMES_PROFILE=ran-assistant
Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=127.0.0.1
Environment=API_SERVER_PORT=8642
Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
Environment=HERMES_REPLY_MODE=api
Environment=HERMES_REPLY_TIMEOUT_SECONDS=180
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
Environment=HF_ENDPOINT=https://hf-mirror.com
Environment=HF_HOME=/home/ubuntu/.hermes-ran-agent/hf-home
Environment=TRANSFORMERS_CACHE=/home/ubuntu/.hermes-ran-agent/hf-home
Environment=SENTENCE_TRANSFORMERS_HOME=/home/ubuntu/.hermes-ran-agent/sentence-transformers
Environment=OBSIDIAN_MEMORY_VAULT_DIR=/opt/ran_agent/vault
Environment=OBSIDIAN_MEMORY_INDEX_PATH=/opt/ran_agent/data/obsidian-memory-index.duckdb
Environment=OBSIDIAN_INDEX_DEVICE=cpu
Environment=OBSIDIAN_MEMORY_REINDEX=0
Environment=OBSIDIAN_MEMORY_WATCH=0
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p ran-assistant gateway run --replace --accept-hooks'
Restart=always
RestartSec=5
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /etc/systemd/system/ran-agent-node.service.d
printf '%s\n' \
  '[Unit]' \
  '# Reset legacy dependencies from the base unit. Older installs had' \
  '# Requires=ran-agent-openclaw.service, which makes systemd stop/restart the' \
  '# Node bridge when the retired OpenClaw service stops.' \
  'Requires=' \
  'After=' \
  'After=ran-agent-hermes.service ran-agent-python.service' \
  'Wants=ran-agent-hermes.service ran-agent-python.service' \
  '' \
  '[Service]' \
  'Environment=NODE_BRIDGE_REPLY_BACKEND=hermes' \
  'Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642/v1' \
  'Environment=HERMES_REPLY_MODE=api' \
  'Environment=HERMES_REPLY_TIMEOUT_SECONDS=180' \
  'Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787' \
  'Environment=PYTHON_BACKEND_INGEST_ENABLED=true' \
  'Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000' \
  'Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000' \
  | sudo tee /etc/systemd/system/ran-agent-node.service.d/10-hermes.conf >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable ran-agent-python.service ran-agent-hermes.service ran-agent-node.service
sudo systemctl restart ran-agent-python.service
sleep 3
sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

systemctl status ran-agent-python.service --no-pager
systemctl status ran-agent-hermes.service --no-pager
systemctl status ran-agent-node.service --no-pager
ss -ltnp | grep -E ':(8787|8791|8642)\b' || true
```

## Fix Node Bridge Still Bound To Retired OpenClaw

Use this if `systemctl cat ran-agent-node.service` shows
`Requires=ran-agent-openclaw.service` or `After=... ran-agent-openclaw.service`.
That stale dependency can interrupt WeChat QR login because systemd will stop the
Node bridge whenever the retired OpenClaw service stops or restarts.

Paste this on the server:

```bash
cd /opt/ran_agent

sudo mkdir -p /etc/systemd/system/ran-agent-node.service.d
printf '%s\n' \
  '[Unit]' \
  'Requires=' \
  'After=' \
  'After=network.target ran-agent-python.service ran-agent-hermes.service' \
  'Wants=ran-agent-python.service ran-agent-hermes.service' \
  '' \
  '[Service]' \
  'Environment=NODE_BRIDGE_REPLY_BACKEND=hermes' \
  'Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642/v1' \
  'Environment=HERMES_REPLY_MODE=api' \
  'Environment=HERMES_REPLY_TIMEOUT_SECONDS=180' \
  'Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787' \
  'Environment=PYTHON_BACKEND_INGEST_ENABLED=true' \
  'Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000' \
  'Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000' \
  | sudo tee /etc/systemd/system/ran-agent-node.service.d/10-hermes.conf >/dev/null

sudo systemctl daemon-reload
sudo systemctl reset-failed ran-agent-node.service
sudo systemctl restart ran-agent-python.service
sudo systemctl restart ran-agent-hermes.service
sudo systemctl stop ran-agent-node.service
sudo systemctl start ran-agent-node.service

sudo systemctl cat ran-agent-node.service
sudo systemctl status ran-agent-node.service --no-pager -l
sudo journalctl -u ran-agent-node.service -n 120 --no-pager -l
sudo ss -ltnp | grep -E ':(8787|8791|8642)\b' || true
```

## Pull And Restart Runtime Without Systemd

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

## Fix Hermes API Key 401

Use this when Node bridge logs show:

- `reply backend failed: hermes api request failed: HTTP 401`
- `Invalid API key`

This block does not print secret values. It only prints whether keys are set,
their length, and a short hash prefix.

Short paste version:

```bash
cd /opt/ran_agent

P=/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
R=/opt/ran_agent/.env.local

AK="$(grep '^API_SERVER_KEY=' "$P" | tail -1 | cut -d= -f2-)"
HK="$(grep '^HERMES_API_KEY=' "$P" | tail -1 | cut -d= -f2-)"

cp "$R" "$R.bak.$(date +%Y%m%d-%H%M%S)"

for K in NODE_BRIDGE_REPLY_BACKEND HERMES_HOME HERMES_PROFILE HERMES_API_BASE_URL API_SERVER_ENABLED API_SERVER_HOST API_SERVER_PORT API_SERVER_KEY HERMES_API_KEY HERMES_REPLY_MODE; do
  sed -i "/^$K=/d" "$R"
done

cat >> "$R" <<EOF
NODE_BRIDGE_REPLY_BACKEND=hermes
HERMES_HOME=/home/ubuntu/.hermes-ran-agent
HERMES_PROFILE=ran-assistant
HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=$AK
HERMES_API_KEY=$HK
HERMES_REPLY_MODE=api
EOF

chmod 600 "$R"

sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

grep -E '^(API_SERVER_KEY|HERMES_API_KEY)=' /opt/ran_agent/.env.local /home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env | awk -F= '{print $1, length($2)}'
```

Detailed inventory and repair version:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

echo "== redacted key inventory before =="
python3 - <<'PY'
from pathlib import Path
import hashlib

files = [
    Path("/opt/ran_agent/.env.local"),
    Path("/opt/ran_agent/node_bridge/.env.local"),
    Path("/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env"),
]
keys = ["API_SERVER_KEY", "HERMES_API_KEY", "DEEPSEEK_API_KEY"]

for file_path in files:
    print(f"\n== {file_path} ==")
    if not file_path.exists():
        print("missing")
        continue
    env = {}
    for line in file_path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    for key in keys:
        value = env.get(key, "")
        if value:
            digest = hashlib.sha256(value.encode()).hexdigest()[:12]
            print(f"{key}: SET len={len(value)} sha256={digest}")
        else:
            print(f"{key}: UNSET")
PY

PROFILE_ENV=/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
ROOT_ENV=/opt/ran_agent/.env.local

set -a
[ -f "$PROFILE_ENV" ] && source "$PROFILE_ENV"
set +a

if [ -z "${API_SERVER_KEY:-}" ] && [ -n "${HERMES_API_KEY:-}" ]; then
  API_SERVER_KEY="$HERMES_API_KEY"
fi
if [ -z "${HERMES_API_KEY:-}" ] && [ -n "${API_SERVER_KEY:-}" ]; then
  HERMES_API_KEY="$API_SERVER_KEY"
fi
if [ -z "${API_SERVER_KEY:-}" ] || [ -z "${HERMES_API_KEY:-}" ]; then
  API_SERVER_KEY="$(openssl rand -hex 24)"
  HERMES_API_KEY="$API_SERVER_KEY"
fi

export API_SERVER_KEY
export HERMES_API_KEY

python3 - <<'PY'
from pathlib import Path
import os

path = Path("/opt/ran_agent/.env.local")
updates = {
    "NODE_BRIDGE_REPLY_BACKEND": "hermes",
    "HERMES_HOME": "/home/ubuntu/.hermes-ran-agent",
    "HERMES_PROFILE": "ran-assistant",
    "HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
    "API_SERVER_ENABLED": "true",
    "API_SERVER_HOST": "127.0.0.1",
    "API_SERVER_PORT": "8642",
    "API_SERVER_KEY": os.environ["API_SERVER_KEY"],
    "HERMES_API_KEY": os.environ["HERMES_API_KEY"],
    "HERMES_REPLY_MODE": "api",
    "PYTHON_BACKEND_BASE_URL": "http://127.0.0.1:8787",
    "PYTHON_BACKEND_INGEST_TIMEOUT_MS": "5000",
    "PERSONAL_MEMORY_BACKEND_TIMEOUT_MS": "5000",
}

lines = path.read_text(errors="ignore").splitlines() if path.exists() else []
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if stripped and not stripped.startswith("#") and "=" in stripped:
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    out.append(line)

if out and out[-1].strip():
    out.append("")
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")

path.write_text("\n".join(out) + "\n")
path.chmod(0o600)
PY

python3 - <<'PY'
from pathlib import Path
import os

path = Path("/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env")
updates = {
    "RAN_AGENT_REPO_ROOT": "/opt/ran_agent",
    "API_SERVER_KEY": os.environ["API_SERVER_KEY"],
    "HERMES_API_KEY": os.environ["HERMES_API_KEY"],
}

lines = path.read_text(errors="ignore").splitlines() if path.exists() else []
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if stripped and not stripped.startswith("#") and "=" in stripped:
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    out.append(line)

if out and out[-1].strip():
    out.append("")
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(out) + "\n")
path.chmod(0o600)
PY

echo "== redacted key inventory after =="
python3 - <<'PY'
from pathlib import Path
import hashlib

files = [
    Path("/opt/ran_agent/.env.local"),
    Path("/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env"),
]
keys = ["API_SERVER_KEY", "HERMES_API_KEY"]

for file_path in files:
    print(f"\n== {file_path} ==")
    env = {}
    for line in file_path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    for key in keys:
        value = env.get(key, "")
        digest = hashlib.sha256(value.encode()).hexdigest()[:12] if value else "-"
        print(f"{key}: {'SET' if value else 'UNSET'} len={len(value)} sha256={digest}")
PY

sudo systemctl daemon-reload
sudo systemctl restart ran-agent-python.service
sleep 3
sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

journalctl -u ran-agent-hermes -n 80 --no-pager
journalctl -u ran-agent-node -n 80 --no-pager
```

## Fix DeepSeek Provider Key 500

Use this when Node bridge logs show:

- `Provider 'deepseek' is set in config.yaml but no API key was found`
- `Set the DEEPSEEK_API_KEY environment variable`

Short paste version. It prompts for the key without echoing it:

```bash
cd /opt/ran_agent

read -rsp "DEEPSEEK_API_KEY: " DEEPSEEK_API_KEY
echo
export DEEPSEEK_API_KEY

for F in /opt/ran_agent/.env.local /home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env; do
  [ -f "$F" ] || touch "$F"
  cp "$F" "$F.bak.$(date +%Y%m%d-%H%M%S)"
  sed -i '/^DEEPSEEK_API_KEY=/d' "$F"
  printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" >> "$F"
  chmod 600 "$F"
done

grep -E '^DEEPSEEK_API_KEY=' /opt/ran_agent/.env.local /home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env | awk -F= '{print $1, length($2)}'

sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl restart ran-agent-node.service

journalctl -u ran-agent-hermes -n 80 --no-pager
journalctl -u ran-agent-node -n 80 --no-pager
```

## Port Occupied Recovery

Use this when startup logs show:

- `OSError: [Errno 98] Address already in use`
- `Error: listen EADDRINUSE: address already in use 127.0.0.1:8791`

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

if systemctl list-units --type=service --all | grep -q 'ran-agent-'; then
  sudo systemctl stop ran-agent-node.service ran-agent-hermes.service ran-agent-python.service 2>/dev/null || true
  sleep 2
fi

echo "== ports before =="
ss -ltnp | grep -E ':(8787|8791|8642)\b' || true

for port in 8787 8791 8642; do
  pids="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "killing port $port: $pids"
    kill $pids 2>/dev/null || true
  fi
done

sleep 2

for port in 8787 8791 8642; do
  pids="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "force killing port $port: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
done

echo "== ports after kill =="
ss -ltnp | grep -E ':(8787|8791|8642)\b' || true
```

Then rerun `Systemd Cutover To Hermes Runtime` if the server has systemd
`ran-agent-*` services, otherwise rerun `Pull And Restart Runtime Without
Systemd`.

## Legacy Notes

Force Hermes mode in `node_bridge/.env.local`:

```bash
cd /opt/ran_agent
printf '\nNODE_BRIDGE_REPLY_BACKEND=hermes\nHERMES_API_BASE_URL=http://127.0.0.1:8642/v1\nHERMES_REPLY_MODE=api\nPYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787\nPYTHON_BACKEND_INGEST_TIMEOUT_MS=5000\nPERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000\n' >> node_bridge/.env.local
```

## Hermes Compression Configuration

Add this to the Hermes profile config on the server
(`/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/config.yaml`) to reduce
context cost for long conversations:

```yaml
compression:
  enabled: true
  threshold: 0.35
  target_ratio: 0.12
  protect_last_n: 8
  hygiene_hard_message_limit: 160

auxiliary:
  compression:
    provider: main
    model: ""
    base_url: null
  web_extract:
    provider: main
    model: ""
    base_url: null
  session_search:
    provider: main
    model: ""
    base_url: null
```

- `threshold: 0.35` — compress when context reaches 35% of model window.
- `target_ratio: 0.12` — compress down to 12% of model window.
- `protect_last_n: 8` — keep the last 8 messages uncompressed.
- `hygiene_hard_message_limit: 160` — hard cap on messages before forced hygiene.
- Auxiliary services use the main provider (no separate model). Set `model: ""`
  and `base_url: null` to inherit from the profile's default provider.

## Fix Hermes DeepSeek model empty error

Use this when Hermes gateway logs show:

- `provider=deepseek ... model=`
- `The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed .`

Root cause:

Hermes gateway does not only rely on the installable profile config at:

```bash
/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/config.yaml
```

For the real server runtime, the main Hermes config must also exist at:

```bash
/home/ubuntu/.hermes-ran-agent/config.yaml
```

Required runtime config:

```yaml
model:
  provider: deepseek
  default: deepseek-v4-flash
  base_url: https://api.deepseek.com/v1
  api_mode: chat_completions
```

Required env:

```bash
DEEPSEEK_API_KEY=...
```

Do not set:

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
```

together with:

```yaml
model:
  provider: deepseek
```

Otherwise Hermes may warn:

```text
OPENAI_BASE_URL is set (https://api.deepseek.com/v1) but model.provider is 'deepseek'. Auxiliary clients may route to the wrong endpoint.
```

Paste this on the server to repair the config:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
mkdir -p "$HERMES_HOME"

[ -f "$HERMES_HOME/config.yaml" ] && cp -p "$HERMES_HOME/config.yaml" "$HERMES_HOME/config.yaml.bak.$(date +%Y%m%d-%H%M%S)"
[ -f "$HERMES_HOME/.env" ] && cp -p "$HERMES_HOME/.env" "$HERMES_HOME/.env.bak.$(date +%Y%m%d-%H%M%S)"

cat > "$HERMES_HOME/config.yaml" <<'YAML'
model:
  provider: deepseek
  default: deepseek-v4-flash
  base_url: https://api.deepseek.com/v1
  api_mode: chat_completions
YAML

chmod 600 "$HERMES_HOME/config.yaml"

touch "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"

DS_KEY="$(grep -E '^DEEPSEEK_API_KEY=' /opt/ran_agent/.env.local | tail -n 1 | cut -d= -f2-)"
if [ -z "$DS_KEY" ]; then
  DS_KEY="$(grep -E '^DEEPSEEK_API_KEY=' /home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env | tail -n 1 | cut -d= -f2-)"
fi

if [ -z "$DS_KEY" ]; then
  read -rsp "DEEPSEEK_API_KEY: " DS_KEY
  echo
fi

for K in DEEPSEEK_API_KEY OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL; do
  sed -i "/^${K}=/d" "$HERMES_HOME/.env"
done

printf 'DEEPSEEK_API_KEY=%s\n' "$DS_KEY" >> "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"

sudo systemctl daemon-reload
sudo systemctl restart ran-agent-hermes.service
sleep 8
sudo systemctl restart ran-agent-node.service
sleep 3
```

Smoke test:

```bash
PROFILE_ENV=/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/.env
KEY="$(grep -E '^(HERMES_API_KEY|API_SERVER_KEY)=' "$PROFILE_ENV" | tail -n 1 | cut -d= -f2-)"

curl -sS \
  -o /tmp/hermes-smoke.json \
  -w 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8642/v1/chat/completions \
  -d '{"model":"ran-assistant","messages":[{"role":"user","content":"只回复 OK"}],"max_tokens":32}'

python3 - <<'PY'
from pathlib import Path
print(Path("/tmp/hermes-smoke.json").read_text(errors="ignore")[:1000])
PY
```

Expected result:

```text
HTTP 200
```

A successful response may look like:

```json
{"choices":[{"message":{"role":"assistant","content":"OK"}}]}
```

## Sync Hermes SOUL.md for courtly attendant persona

The Hermes runtime reads SOUL.md from `$HERMES_HOME/SOUL.md`. After updating
`hermes/profile/SOUL.md` in the repo, sync it to the runtime location:

```bash
cd /opt/ran_agent
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
mkdir -p "$HERMES_HOME"
cp -p /opt/ran_agent/hermes/profile/SOUL.md "$HERMES_HOME/SOUL.md"
chmod 600 "$HERMES_HOME/SOUL.md"
sudo systemctl restart ran-agent-hermes.service
sleep 8
sudo systemctl restart ran-agent-node.service
```

The `hermes profile install` command also copies profile files, but the explicit
`cp` above guarantees SOUL.md is current even if the profile was installed from
an older revision.

To disable courtly mode, set `RAN_AGENT_COURTLY_MODE=off` in `.env.local` and
restart the Node bridge. To re-enable, set `RAN_AGENT_COURTLY_MODE=on`.

## Quick Fix: Hermes model empty / gateway crash

Use this one-shot paste when Hermes logs show `you passed .` or `model=`:

```bash
cd /opt/ran_agent
export HERMES_HOME=/home/ubuntu/.hermes-ran-agent
mkdir -p "$HERMES_HOME"

cat > "$HERMES_HOME/config.yaml" <<'YAML'
model:
  provider: deepseek
  default: deepseek-v4-flash
  base_url: https://api.deepseek.com/v1
  api_mode: chat_completions
YAML
chmod 600 "$HERMES_HOME/config.yaml"

DS_KEY="$(grep -E '^DEEPSEEK_API_KEY=' /opt/ran_agent/.env.local | tail -1 | cut -d= -f2-)"
[ -z "$DS_KEY" ] && DS_KEY="$(grep -E '^DEEPSEEK_API_KEY=' "$HERMES_HOME/profiles/ran-assistant/.env" | tail -1 | cut -d= -f2-)"
if [ -n "$DS_KEY" ]; then
  sed -i '/^DEEPSEEK_API_KEY=/d' "$HERMES_HOME/.env"
  printf 'DEEPSEEK_API_KEY=%s\n' "$DS_KEY" >> "$HERMES_HOME/.env"
  chmod 600 "$HERMES_HOME/.env"
  echo "DEEPSEEK_API_KEY: SET len=${#DS_KEY}"
else
  echo "ERROR: DEEPSEEK_API_KEY not found"
fi

sudo systemctl restart ran-agent-hermes.service
sleep 5
sudo systemctl status ran-agent-hermes.service --no-pager | head -10
```

## Web vs Social Link Routing

Hermes has two kinds of web tools:

**Hermes native tools (keep enabled):**
- `web_search` — Tavily-based web search. Used by weather skill, web-search-live skill, general queries.
- `web_fetch` — fetch and extract web page content. Used for news, blogs, docs, official sites.

**Disabled Hermes built-in tools (in `disabled_tools`):**
- `browser_vision`, `image_generate`, `text_to_speech`, `video_analyze`, `vision_analyze`
- These conflict with ran-agent MCP tools (`media_reader`, `mimo_power`, `media_generation`).

**Social platform links MUST use `social_reader` MCP:**
- xhslink.com, xiaohongshu.com (小红书)
- bilibili.com, b23.tv (B站)
- mp.weixin.qq.com (微信公众号)
- douyin.com (抖音)
- kuaishou.com (快手)
- weibo.com (微博)
- zhihu.com (知乎)
- music.163.com (网易云音乐)

The Node bridge detects these URLs and injects a routing instruction into the user message. The instruction tells Hermes to:
1. Use `resolve_social_url` first
2. Then `read_social_post_deep`
3. Never use `web_extract` for these links
4. Feed images/video/audio to `media_reader`/`mimo_power`

**Normal web links (news, blogs, docs) do NOT get the routing instruction** and can use `web_extract`/`web_search` freely.

**Media (images/video/audio) MUST use ran-agent MCP tools:**
- `media_reader` for OCR, ASR, video analysis
- `mimo_power` for deep multimodal analysis
- `media_generation` for image/speech generation
- DeepSeek V4 must never receive raw `image_url` payloads

Run `bash scripts/diagnose-media-xhs.sh` to verify the routing configuration.

## Hermes Tool Visibility Configuration

Two-layer defense to prevent Hermes built-in vision tools from interfering:

### Layer 1: `disabled_tools` (single tool filter)

Filters individual tools from the available tool list:

```yaml
disabled_tools:
  - browser_vision
  - image_generate
  - text_to_speech
  - video_analyze
  - vision_analyze
```

Do NOT add `web_search` or `web_extract` — these are needed for normal web pages.

### Layer 2: `platform_toolsets` (toolset filter)

Controls which toolsets are available per platform. Excludes `vision`, `image_gen`,
`tts`, and `browser_vision` toolsets entirely:

```yaml
platform_toolsets:
  cli:
    - web
    - terminal
    - file
    - skills
    - memory
    - session_search
    - safe
    - mcp-time
    - mcp-social_reader
    - mcp-media_reader
    - mcp-mimo_power
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
    - mcp-playwright
    - mcp-tavily
  gateway:
    # Same as cli
```

The `web` toolset includes `web_search` and `web_extract` — both kept for normal pages.

### Why both layers

- `disabled_tools` catches individual tools even if a toolset includes them.
- `platform_toolsets` prevents entire toolset categories from loading.
- Together they ensure `vision_analyze` cannot be invoked by the model.

### Diagnostic

Run `bash scripts/diagnose-hermes-tools.sh` to verify:
- `disabled_tools` contains the 5 forbidden tools
- `platform_toolsets` does NOT contain `vision`/`image_gen`/`tts`
- `platform_toolsets` DOES contain `web` and all `mcp-*` tools
- No recent `vision_analyze` / `image_url BadRequest` in logs

## Hermes Lite/Full Runtime Split

Final runtime口径：two Hermes gateway instances run on different ports for
context/capability routing. This is not a DeepSeek model change.

| Instance | Port | Profile | HERMES_HOME | Purpose |
|----------|------|---------|-------------|---------|
| `ran-agent-hermes.service` | 8642 | `ran-assistant-lite` | `/home/ubuntu/.hermes-ran-agent/lite` | lite-context daily entry |
| `ran-agent-hermes-full.service` | 8643 | `ran-assistant` | `/home/ubuntu/.hermes-ran-agent` | full-debug heavy-tool entry |

**Design decision:** 8642 is a lite-context daily entry, not a security sandbox.
Hermes API Server may still retain full tool access on 8642, so terminal
isolation is not a hard guarantee and "8642 cannot terminal" is no longer an
acceptance item. 8643 is the full-debug entry for heavy tools; it has been
validated to call `lark-cli` through terminal.

### Systemd services

**Lite (8642):**
```
/etc/systemd/system/ran-agent-hermes.service
  drop-in: 90-lite-runtime.conf
  HERMES_HOME=/home/ubuntu/.hermes-ran-agent/lite
  HERMES_PROFILE=ran-assistant-lite
  API_SERVER_PORT=8642
```

**Full (8643):**
```
/etc/systemd/system/ran-agent-hermes-full.service
  HERMES_HOME=/home/ubuntu/.hermes-ran-agent
  HERMES_PROFILE=ran-assistant
  API_SERVER_PORT=8643
```

### Node bridge env vars (in `.env.local`)

```
HERMES_LITE_API_BASE_URL=http://127.0.0.1:8642/v1
HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1
RAN_AGENT_CAPABILITY_MODE=auto
HERMES_LITE_PROFILE=ran-assistant-lite
HERMES_FULL_PROFILE=ran-assistant
HERMES_SESSION_CONTINUITY_ENABLED=true
HERMES_RECENT_TEXT_TURNS=10
HERMES_RECENT_TEXT_CHAR_BUDGET=6000
```

### Auto detection rules

Node bridge selects gateway per request:

- **Default / chat / XHS / media / memory**: lite (8642)
- **Debug intent** (调试/执行命令/看日志/systemctl/journalctl/git/npm/lark-cli): full (8643)
- **File / Playwright / media_generation intent**: full (8643)
- **Generation intent** (画/生成/语音/朗读/媒体生成): full (8643)
- **User override**: "开 full / 全能力 / 调试模式" → full; "轻量 / 省 token" → lite
- **Full unavailable**: fallback to lite with `fallback_reason=full_gateway_unavailable`

### WeChat continuity

Node bridge keeps short-term conversation continuity client-side. WeChat,
Feishu/Lark, and desktop proxy all enter `ChannelHub` before `replyBackend`.
Each Hermes API request carries stable `X-Hermes-Session-Id` and
`X-Hermes-Session-Key` headers plus bounded local/global recent history before
the current user message. Logs print only hashes and counts under
`[hermes-session-continuity]`.

This is required so follow-ups such as "她", "这个故事", "那张图", or "那个链接"
resolve from the last few turns instead of asking who or what the user means.
Do not explain session headers, history windows, or token budgeting in ordinary
user replies.

### Multi-frontend entry

Current architecture:

```text
WeChatBridge / FeishuBridge / DesktopProxy
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> Hermes 8642/8643
```

`global_user_id=user:ran` is shared across platforms for persona and memory
scope. Platform-specific session ids remain isolated for short-term local
context. Details: `docs/governance/multi_frontend_identity_strategy.md`.

Enable Feishu bridge:

```bash
sudo sed -i 's/^FEISHU_BRIDGE_ENABLED=.*/FEISHU_BRIDGE_ENABLED=true/' /opt/ran_agent/.env.local
sudo systemctl restart ran-agent-node.service
bash scripts/diagnose-multi-frontend.sh
```

Feishu requires a valid `lark-cli` auth/config and bot permissions for
`im.message.receive_v1` plus message sending. The main path is not Hermes native
Feishu adapter.

Enable desktop OpenAI-compatible proxy:

```bash
sudo sed -i 's/^DESKTOP_PROXY_ENABLED=.*/DESKTOP_PROXY_ENABLED=true/' /opt/ran_agent/.env.local
sudo systemctl restart ran-agent-node.service
bash scripts/diagnose-multi-frontend.sh
```

Desktop clients should use `base_url=http://127.0.0.1:8650/v1` and model
`ran-agent`. Directly connecting Open WebUI/Chatbox/LobeChat to Hermes
8642/8643 is a debug-only path and does not provide the unified timeline entry.

Rollback:

```bash
sudo sed -i 's/^FEISHU_BRIDGE_ENABLED=.*/FEISHU_BRIDGE_ENABLED=false/' /opt/ran_agent/.env.local
sudo sed -i 's/^DESKTOP_PROXY_ENABLED=.*/DESKTOP_PROXY_ENABLED=false/' /opt/ran_agent/.env.local
sudo systemctl restart ran-agent-node.service
```

### Runtime config files

| File | Purpose |
|------|---------|
| `/etc/systemd/system/ran-agent-hermes.service.d/90-lite-runtime.conf` | Lite gateway systemd drop-in (HERMES_HOME=lite, profile=ran-assistant-lite, port 8642) |
| `/etc/systemd/system/ran-agent-hermes-full.service` | Full gateway systemd service (HERMES_HOME=default, profile=ran-assistant, port 8643) |
| `/home/ubuntu/.hermes-ran-agent/lite/config.yaml` | Lite runtime config (restricted toolsets) |
| `/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/config.yaml` | Lite profile MCP servers |
| `/home/ubuntu/.hermes-ran-agent/lite/.env` | Lite gateway secrets |
| `/home/ubuntu/.hermes-ran-agent/config.yaml` | Full runtime config (full toolsets) |
| `/home/ubuntu/.hermes-ran-agent/profiles/ran-assistant/config.yaml` | Full profile MCP servers |
| `/home/ubuntu/.hermes-ran-agent/.env` | Full gateway secrets |
| `/opt/ran_agent/.env.local` | Node bridge env (HERMES_LITE_API_BASE_URL, HERMES_FULL_API_BASE_URL, RAN_AGENT_CAPABILITY_MODE) |

Do not commit `.env`, runtime state, local caches, temporary package-lock
changes, `/home/ubuntu/.hermes-ran-agent/*`, `/etc/systemd/*`,
`.ran_agent_state/`, `.openclaw_state/`, or `local_archive/`.

### Deployment / drift repair

After server `git pull`, Hermes profile reinstall, or any suspected systemd/env
drift, use the repo script as the single deployment entry:

```bash
cd /opt/ran_agent
bash scripts/apply-hermes-runtime-split.sh
```

The script reinstalls both Hermes profiles, refreshes the lite runtime home,
rewrites the lite drop-in and full service, upserts only non-sensitive routing
env keys, restarts `ran-agent-hermes`, `ran-agent-hermes-full`, and
`ran-agent-node`, then verifies process env and listening ports. Do not hand-edit
systemd or runtime env for the lite/full split unless the script itself is being
updated.

When inspecting runtime drift, use the effective merged systemd view, not only
the main unit file:

```bash
systemctl cat ran-agent-hermes.service
systemctl cat ran-agent-hermes-full.service
```

Lite-critical settings live in
`/etc/systemd/system/ran-agent-hermes.service.d/90-lite-runtime.conf`; full-debug
settings live primarily in `/etc/systemd/system/ran-agent-hermes-full.service`.

### Verified runtime state (2026-05-15)

- 8642 (lite): `ran-assistant-lite` profile, ~22644 prompt tokens
- 8643 (full): `ran-assistant` profile, ~24331 prompt tokens
- 8643 can invoke `/usr/bin/lark-cli` via terminal
- Both exclude `vision_analyze`, `browser_vision`, `video_analyze`, `image_generate`, `text_to_speech`
- Node auto-routes: chat/XHS/media/memory → 8642; debug/commands/lark-cli/file/playwright/media_generation → 8643
- 8642 terminal isolation is a warning only, not a hard validation target

### Verified token counts

- 8642 (lite): ~22644 prompt tokens for basic "只回复 OK"
- 8643 (full): ~24331 prompt tokens (includes terminal/file/playwright tool descriptions)

### Diagnostic

```bash
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-multi-frontend.sh
```

Checks: both ports listening, both services active, token comparison,
vision errors, lark-cli availability, session-continuity env/log presence, and
manual smoke steps for WeChat continuity, XHS image fallback, Feishu bridge,
desktop proxy, identity map, and global timeline.

### Recovery

```bash
bash scripts/apply-hermes-runtime-split.sh
```

## XHS Troubleshooting

### resolve_social_url OK but read_social_post_deep fails

Symptom: `resolve_social_url` returns `has_xsec_token: true` but deep read fails
with `XHS_COOKIE_EXPIRED`, `XHS_IP_RISK`, or `XHS_MISSING_XSEC_TOKEN`.

Causes:
- **XHS_COOKIE_EXPIRED** — Cookie has expired. Re-login to xiaohongshu.com,
  copy fresh cookie, update `XHS_COOKIE` in `.env.local`.
- **XHS_IP_RISK** — XHS detected suspicious IP. May need captcha verification
  or network change. Try again later.
- **XHS_MISSING_XSEC_TOKEN** — Short link resolved but no `xsec_token` was
  returned. The note may need a fresh search-based token resolution.
- **XHS_CAPTCHA_REQUIRED** — XHS requires captcha. Manual browser verification
  needed.

### CallToolResult content Field required

Symptom: Hermes MCP client reports `CallToolResult content Field required`.

Cause: A social_reader handler returned a bare object `{ok: true, ...}` instead
of a proper MCP CallToolResult `{content: [{type:"text", text:...}]}`.

Fix: Already resolved — all handlers now go through `wrapMcpResult()` which
wraps bare objects with `buildTextResult()` or `buildErrorResult()`.

### require is not defined

Symptom: `search_media_artifacts` reports `ReferenceError: require is not defined`.

Cause: ESM module (`.mjs`) using `require()`. The file imports `fs` and `path`
at the top level; the redundant `require()` calls crashed at runtime.

Fix: Already resolved — removed `require('fs')` and `require('path')` from
`searchMediaArtifacts`. Uses the existing ESM imports.

### Don't misdiagnose

- These are **code bugs**, not Hermes MCP loading failures. If Hermes logs show
  `social_reader` process started and `resolve_social_url` works, the MCP is
  loaded correctly.
- Cookie/IP issues are **external platform problems**, not ran-agent bugs.
- `web_extract` failing on XHS links is **expected** — XHS blocks non-browser
  requests. Always use `social_reader` for XHS.

### XHS deep read two-path fallback

`read_social_post_deep` for XHS uses two independent paths:

1. **Detail path** (`xhs_browse_note` / `get_note_content`): extracts structured
   text — title, description, tags, comments. May require cookie + xsec_token.
2. **Media path** (`wanyi-watermark`): extracts images, videos, media URLs.
   Uses the original xhslink short link or canonical_url. May not require cookie.

The two paths run in parallel. Results are merged:
- Both fail → `ok: false` with diagnostics for both paths
- Detail fails, media succeeds → `ok: true`, `partial_success: true`
- Detail succeeds, media fails → `ok: true` with detail text only
- Both succeed → full result with text + media

"正文失败"不代表"媒体失败". If `diagnostics.detail_backend.ok` is false but
`diagnostics.media_backend.ok` is true, the result still contains images/videos.

Check `diagnostics.detail_backend.error_code` and
`diagnostics.media_backend.error_code` separately to understand which path failed.
