#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"
source "$ROOT_DIR/scripts/launcher_test_isolation.sh"

launcher_load_env_file "$ENV_FILE"
launcher_load_env_file "$NODE_BRIDGE_ENV_FILE"
launcher_prepend_path "/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"
export FLAGS_use_mkldnn="${FLAGS_use_mkldnn:-false}"
export FLAGS_use_onednn="${FLAGS_use_onednn:-false}"
export PERSONAL_AGENT_OCR_ENABLED="${PERSONAL_AGENT_OCR_ENABLED:-true}"
export PERSONAL_AGENT_OCR_REQUIRED="${PERSONAL_AGENT_OCR_REQUIRED:-false}"
export PERSONAL_AGENT_IMAGE_VLM_FIRST="${PERSONAL_AGENT_IMAGE_VLM_FIRST:-true}"
export PERSONAL_AGENT_OCR_TIMEOUT_MS="${PERSONAL_AGENT_OCR_TIMEOUT_MS:-120000}"
export PERSONAL_AGENT_OCR_PROVIDER="${PERSONAL_AGENT_OCR_PROVIDER:-dashscope-qwen-vl-ocr}"
export PERSONAL_AGENT_OCR_MODEL="${PERSONAL_AGENT_OCR_MODEL:-qwen-vl-ocr-2025-11-20}"
export PERSONAL_AGENT_VISION_PROVIDER="${PERSONAL_AGENT_VISION_PROVIDER:-dashscope-qwen-vl}"
export PERSONAL_AGENT_VISION_MODEL="${PERSONAL_AGENT_VISION_MODEL:-qwen3-vl-flash}"
export PERSONAL_AGENT_ASR_PROVIDER="${PERSONAL_AGENT_ASR_PROVIDER:-dashscope-asr}"
export PERSONAL_AGENT_ASR_MODEL="${PERSONAL_AGENT_ASR_MODEL:-qwen3-asr-flash}"
NODE_BIN="${MEDIA_READER_NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/mediaReaderMcpServer.mjs"
