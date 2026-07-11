#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"
source "$ROOT_DIR/scripts/launcher_test_isolation.sh"

launcher_load_env_file "$ENV_FILE"
launcher_load_env_file "$NODE_BRIDGE_ENV_FILE"
launcher_prepend_path "/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"

if [ "${1:-}" = "initialize" ]; then
  cd "$ROOT_DIR"
  exec node --input-type=module -e '
import { handleStickerCatalogMcpRequest } from "./node_bridge/src/stickerCatalogMcpServer.mjs";
const result = await handleStickerCatalogMcpRequest({ method: "initialize", params: {} });
process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`);
'
fi

exec node "$ROOT_DIR/node_bridge/src/stickerCatalogMcpServer.mjs"
