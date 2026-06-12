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

if [ "${1:-}" = "initialize" ]; then
  cd "$ROOT_DIR"
  exec node --input-type=module -e '
import { handleStickerCatalogMcpRequest } from "./node_bridge/src/stickerCatalogMcpServer.mjs";
const result = await handleStickerCatalogMcpRequest({ method: "initialize", params: {} });
process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`);
'
fi

exec node "$ROOT_DIR/node_bridge/src/stickerCatalogMcpServer.mjs"
