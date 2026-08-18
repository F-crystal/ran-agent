#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
QWEN_SETTINGS="${QWEN_SETTINGS_PATH:-/home/ubuntu/.qwen/settings.json}"
DROPIN="/etc/systemd/system/ran-agent-hermes.service.d/40-qwen-token-plan.conf"
BASE_URL="${TOKEN_PLAN_BASE_URL:-https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1}"
MODEL=qwen3.6-flash
WORK_DIR="$(mktemp -d /tmp/qwen-token-plan-config.XXXXXX)"
APPLIED=false
SUCCESS=false

cleanup() {
  set +e
  if [[ "$APPLIED" == true && "$SUCCESS" != true ]]; then
    rollback
  fi
  TOKEN_PLAN_KEY=''
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

[[ -t 0 ]] || { echo "ERROR: please run this command in an interactive SSH terminal" >&2; exit 1; }
[[ -f "$ENV_FILE" && -O "$ENV_FILE" ]] || { echo "ERROR: run this as the owner of $ENV_FILE" >&2; exit 1; }
[[ -f "$QWEN_SETTINGS" ]] || { echo "ERROR: Qwen settings not found: $QWEN_SETTINGS" >&2; exit 1; }

bash "$ROOT_DIR/scripts/prepare-qwen-mm-api.sh"

echo
echo '=================================================='
echo '现在请粘贴 TOKEN_PLAN_KEY（输入不会显示）'
echo '粘贴后只按一次回车：'
echo '=================================================='
IFS= read -r -s TOKEN_PLAN_KEY
echo
[[ "$TOKEN_PLAN_KEY" =~ ^sk-sp-[A-Za-z0-9_-]+$ ]] || { echo "ERROR: this is not a Token Plan key (expected prefix: sk-sp-)" >&2; exit 1; }

token_plan_curl() {
  curl --config <(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN_PLAN_KEY") "$@"
}

cat >"$WORK_DIR/vision-request.json" <<'JSON'
{"model":"qwen3.6-flash","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}},{"type":"text","text":"Reply with OK."}]}],"max_tokens":8}
JSON
status="$(token_plan_curl -sS -o "$WORK_DIR/vision-response.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data-binary "@$WORK_DIR/vision-request.json" "$BASE_URL/chat/completions")"
if [[ "$status" != 200 ]]; then
  message="$(jq -r '.error.message // .message // .code // "unknown error"' "$WORK_DIR/vision-response.json" 2>/dev/null || true)"
  echo "ERROR: Token Plan vision validation failed (HTTP $status): $message" >&2
  exit 1
fi
jq -e '.choices[0].message.content | type == "string" and length > 0' "$WORK_DIR/vision-response.json" >/dev/null || {
  echo "ERROR: Token Plan vision validation returned an empty response" >&2
  exit 1
}

cat >"$WORK_DIR/responses-request.json" <<'JSON'
{"model":"qwen3.6-flash","input":"Reply with OK.","max_output_tokens":8}
JSON
status="$(token_plan_curl -sS -o "$WORK_DIR/responses-response.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data-binary "@$WORK_DIR/responses-request.json" "$BASE_URL/responses")"
if [[ "$status" != 200 ]]; then
  message="$(jq -r '.error.message // .message // .code // "unknown error"' "$WORK_DIR/responses-response.json" 2>/dev/null || true)"
  echo "ERROR: Token Plan knowledge validation failed (HTTP $status): $message" >&2
  exit 1
fi
jq -e '.output | type == "array" and length > 0' "$WORK_DIR/responses-response.json" >/dev/null || {
  echo "ERROR: Token Plan knowledge validation returned an empty response" >&2
  exit 1
}

cp "$ENV_FILE" "$WORK_DIR/env.old"
# shellcheck disable=SC2024 # sudo reads the root-owned source; the current user owns the private destination.
sudo cat "$QWEN_SETTINGS" >"$WORK_DIR/qwen-settings.old"
if sudo test -f "$DROPIN"; then
  # shellcheck disable=SC2024 # same intentional source/destination ownership split as above.
  sudo cat "$DROPIN" >"$WORK_DIR/dropin.old"
fi

awk '!/^(TOKEN_PLAN_API_KEY|TOKEN_PLAN_BASE_URL|QWEN_MM_API_VL_MODEL|PERSONAL_AGENT_OCR_PROVIDER|PERSONAL_AGENT_VISION_PROVIDER|PERSONAL_AGENT_BACKEND_QWEN_ENABLED|PERSONAL_AGENT_KNOWLEDGE_AGENT_API_KEY_ENV|PERSONAL_AGENT_QWEN_API_KEY_ENV|PERSONAL_AGENT_QWEN_BASE_URL|PERSONAL_AGENT_QWEN_TOOLS_MODEL)=/' "$ENV_FILE" >"$WORK_DIR/env.new"
{
  printf 'TOKEN_PLAN_API_KEY=%s\n' "$TOKEN_PLAN_KEY"
  printf 'TOKEN_PLAN_BASE_URL=%s\n' "$BASE_URL"
  printf 'QWEN_MM_API_VL_MODEL=%s\n' "$MODEL"
  printf 'PERSONAL_AGENT_OCR_PROVIDER=qwen-mm\n'
  printf 'PERSONAL_AGENT_VISION_PROVIDER=qwen-mm\n'
  printf 'PERSONAL_AGENT_BACKEND_QWEN_ENABLED=true\n'
  printf 'PERSONAL_AGENT_KNOWLEDGE_AGENT_API_KEY_ENV=TOKEN_PLAN_API_KEY\n'
  printf 'PERSONAL_AGENT_QWEN_API_KEY_ENV=TOKEN_PLAN_API_KEY\n'
  printf 'PERSONAL_AGENT_QWEN_BASE_URL=%s/responses\n' "$BASE_URL"
  printf 'PERSONAL_AGENT_QWEN_TOOLS_MODEL=%s\n' "$MODEL"
} >>"$WORK_DIR/env.new"

jq --arg model "$MODEL" --arg base "$BASE_URL" '
  .modelProviders.openai = [{id:$model,name:$model,baseUrl:$base,envKey:"TOKEN_PLAN_API_KEY"}]
  | .model.name = $model
' "$QWEN_SETTINGS" >"$WORK_DIR/qwen-settings.new"

cat >"$WORK_DIR/dropin.new" <<'EOF'
[Service]
Environment=PERSONAL_AGENT_OCR_PROVIDER=qwen-mm
Environment=PERSONAL_AGENT_VISION_PROVIDER=qwen-mm
EOF

rollback() {
  install -m 600 "$WORK_DIR/env.old" "$ENV_FILE"
  sudo install -o root -g root -m 644 "$WORK_DIR/qwen-settings.old" "$QWEN_SETTINGS"
  if [[ -f "$WORK_DIR/dropin.old" ]]; then
    sudo install -o root -g root -m 644 "$WORK_DIR/dropin.old" "$DROPIN"
  else
    sudo rm -f "$DROPIN"
  fi
  sudo systemctl daemon-reload
  sudo systemctl restart ran-agent-python.service ran-agent-hermes.service || true
}

APPLIED=true
install -m 600 "$WORK_DIR/env.new" "$ENV_FILE"
sudo install -o root -g root -m 644 "$WORK_DIR/qwen-settings.new" "$QWEN_SETTINGS"
sudo install -o root -g root -m 644 "$WORK_DIR/dropin.new" "$DROPIN"
sudo systemctl daemon-reload
if ! sudo systemctl restart ran-agent-python.service ran-agent-hermes.service \
  || ! systemctl is-active --quiet ran-agent-python.service \
  || ! systemctl is-active --quiet ran-agent-hermes.service; then
  echo "ERROR: service validation failed; restoring previous configuration" >&2
  exit 1
fi

SUCCESS=true
echo '配置完成：Qwen-MM 图片理解和 Qwen 知识管理已切换到 qwen3.6-flash Token Plan。'
