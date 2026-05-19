#!/usr/bin/env bash
# Fixed wrapper for XHS generic fallback MCP server.
# Two modes:
#   Runtime mode (default): reads marker, checks ok, uses backend_* fields.
#   Probe mode (--probe): does NOT check marker; accepts --python and --module.
#
# This wrapper NEVER executes uvx or uv tool install.

set -euo pipefail

MARKER_PATH="${XHS_GENERIC_FALLBACK_READY_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json}"

# Probe mode: skip marker check, use provided args
if [ "${1:-}" = "--probe" ]; then
  shift
  PROBE_PYTHON=""
  PROBE_MODULE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --python) PROBE_PYTHON="$2"; shift 2 ;;
      --module) PROBE_MODULE="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$PROBE_PYTHON" ] || [ -z "$PROBE_MODULE" ]; then
    echo "probe mode requires --python and --module" >&2
    exit 1
  fi
  exec "$PROBE_PYTHON" -m "$PROBE_MODULE"
fi

# Runtime mode: read marker, check ok, use backend_* fields
if [ ! -f "$MARKER_PATH" ]; then
  echo "XHS_GENERIC_FALLBACK_NOT_READY: marker not found at $MARKER_PATH" >&2
  echo "hint: run scripts/prepare-xhs-generic-fallback.sh" >&2
  exit 1
fi

MARKER_OK=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('ok', False))" 2>/dev/null || echo "False")
if [ "$MARKER_OK" != "True" ]; then
  echo "XHS_GENERIC_FALLBACK_NOT_READY: marker ok=false" >&2
  echo "hint: run scripts/prepare-xhs-generic-fallback.sh" >&2
  exit 1
fi

# Read backend_* from marker (NOT command — that points to this wrapper itself)
BACKEND_EXECUTABLE=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_executable', ''))" 2>/dev/null)
BACKEND_PYTHON=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_python', ''))" 2>/dev/null)
BACKEND_MODULE=$(python3 -c "import json; print(json.load(open('$MARKER_PATH')).get('backend_module', ''))" 2>/dev/null)

# Priority 1: backend_executable
if [ -n "$BACKEND_EXECUTABLE" ] && [ -x "$BACKEND_EXECUTABLE" ]; then
  exec "$BACKEND_EXECUTABLE"
fi

# Priority 2: backend_python -m backend_module
if [ -n "$BACKEND_PYTHON" ] && [ -n "$BACKEND_MODULE" ]; then
  exec "$BACKEND_PYTHON" -m "$BACKEND_MODULE"
fi

echo "XHS_GENERIC_FALLBACK_NOT_READY: marker has no usable backend entry" >&2
echo "hint: run scripts/prepare-xhs-generic-fallback.sh" >&2
exit 1
