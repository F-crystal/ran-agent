#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NODE_BRIDGE_ENV_FILE"
  set +a
fi

export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PERSONAL_AGENT_OCR_PROVIDER="${PERSONAL_AGENT_OCR_PROVIDER:-dashscope-qwen-vl-ocr}"
export PERSONAL_AGENT_OCR_MODEL="${PERSONAL_AGENT_OCR_MODEL:-qwen-vl-ocr-2025-11-20}"
export PERSONAL_AGENT_VISION_PROVIDER="${PERSONAL_AGENT_VISION_PROVIDER:-dashscope-qwen-vl}"
export PERSONAL_AGENT_VISION_MODEL="${PERSONAL_AGENT_VISION_MODEL:-qwen3-vl-flash}"
export PERSONAL_AGENT_ASR_PROVIDER="${PERSONAL_AGENT_ASR_PROVIDER:-dashscope-asr}"
export PERSONAL_AGENT_ASR_MODEL="${PERSONAL_AGENT_ASR_MODEL:-qwen3-asr-flash}"
NODE_BIN="${MEDIA_READER_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/mediaReaderMcpServer.mjs"
