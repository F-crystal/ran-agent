#!/usr/bin/env bash
# Quick search via Tavily API
# Usage: tavily-search.sh <query> [max_results]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"

# Load environment variables from .env.local
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

TAVILY_API_KEY="${TAVILY_API_KEY:?Set TAVILY_API_KEY in $ENV_FILE}"
QUERY="${1:?Usage: tavily-search.sh <query> [max_results]}"
MAX_RESULTS="${2:-5}"

jq -n --arg key "$TAVILY_API_KEY" --arg q "$QUERY" --argjson n "$MAX_RESULTS" \
  '{api_key: $key, query: $q, max_results: $n}' | \
  curl -s "https://api.tavily.com/search" -H "Content-Type: application/json" -d @-
