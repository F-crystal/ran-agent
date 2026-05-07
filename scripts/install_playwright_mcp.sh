#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

INSTALL_WITH_DEPS="${PLAYWRIGHT_MCP_INSTALL_WITH_DEPS:-auto}"
SYSTEM_CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}"

if [ -z "$SYSTEM_CHROMIUM_PATH" ]; then
  for command_name in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$command_name" >/dev/null 2>&1; then
      SYSTEM_CHROMIUM_PATH="$(command -v "$command_name")"
      break
    fi
  done
fi

if [ -z "$SYSTEM_CHROMIUM_PATH" ]; then
  for candidate in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
    if [ -e "$candidate" ]; then
      SYSTEM_CHROMIUM_PATH="$candidate"
      break
    fi
  done
fi

if [ -n "$SYSTEM_CHROMIUM_PATH" ]; then
  echo "Detected system Chromium at: $SYSTEM_CHROMIUM_PATH"
  echo "Skipping Playwright-managed browser download."
  echo "If you want Node bridge to use this browser, set:"
  echo "  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$SYSTEM_CHROMIUM_PATH"
  exit 0
fi

if [ "$INSTALL_WITH_DEPS" = "true" ]; then
  exec npx -y playwright@latest install --with-deps chromium
fi

if [ "$INSTALL_WITH_DEPS" = "false" ]; then
  exec npx -y playwright@latest install chromium
fi

case "$(uname -s)" in
  Linux)
    exec npx -y playwright@latest install --with-deps chromium
    ;;
  *)
    exec npx -y playwright@latest install chromium
    ;;
esac
