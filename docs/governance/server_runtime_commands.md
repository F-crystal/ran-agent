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

sudo systemctl stop ran-agent-node.service ran-agent-openclaw.service ran-agent-python.service 2>/dev/null || true
sudo systemctl disable ran-agent-openclaw.service 2>/dev/null || true

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
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=HERMES_PROFILE=ran-assistant
Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=127.0.0.1
Environment=API_SERVER_PORT=8642
Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
Environment=HERMES_REPLY_MODE=api
Environment=HERMES_REPLY_TIMEOUT_SECONDS=180
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

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /etc/systemd/system/ran-agent-node.service.d
sudo tee /etc/systemd/system/ran-agent-node.service.d/10-hermes.conf >/dev/null <<'EOF'
[Unit]
After=ran-agent-hermes.service ran-agent-python.service
Wants=ran-agent-hermes.service ran-agent-python.service

[Service]
Environment=NODE_BRIDGE_REPLY_BACKEND=hermes
Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642/v1
Environment=HERMES_REPLY_MODE=api
Environment=HERMES_REPLY_TIMEOUT_SECONDS=180
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_ENABLED=true
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
EOF

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

## Port Occupied Recovery

Use this when startup logs show:

- `OSError: [Errno 98] Address already in use`
- `Error: listen EADDRINUSE: address already in use 127.0.0.1:8791`

Paste this on the server:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

if systemctl list-units --type=service --all | grep -q 'ran-agent-'; then
  sudo systemctl stop ran-agent-node.service ran-agent-hermes.service ran-agent-openclaw.service ran-agent-python.service 2>/dev/null || true
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

## If Node Bridge Still Points At OpenClaw

Force Hermes mode in `node_bridge/.env.local`:

```bash
cd /opt/ran_agent
printf '\nNODE_BRIDGE_REPLY_BACKEND=hermes\nHERMES_API_BASE_URL=http://127.0.0.1:8642/v1\nHERMES_REPLY_MODE=api\nPYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787\nPYTHON_BACKEND_INGEST_TIMEOUT_MS=5000\nPERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000\n' >> node_bridge/.env.local
```
