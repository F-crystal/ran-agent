#!/usr/bin/env bash
# Claude Code CLI Deep Search — background dispatch with notification callback
# Usage: claude-deep-search.sh --prompt "query" [--output file.md] [--model claude-opus-4-6]
set -euo pipefail

RESULT_DIR="${RESULT_DIR:-$HOME/ran_agent/data/search-results}"
CLAUDE_BIN="$(command -v claude)"

# Defaults
PROMPT=""
OUTPUT=""
MODEL="${CLAUDE_MODEL:-claude-opus-4-6}"
TIMEOUT=300
TASK_NAME="search-$(date +%s)"
NOTIFY_CMD=""
WORKSPACE="${WORKSPACE:-$HOME/ran_agent}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --task-name) TASK_NAME="$2"; shift 2;;
    --notify-cmd) NOTIFY_CMD="$2"; shift 2;;
    --workspace) WORKSPACE="$2"; shift 2;;
    *) echo "Unknown flag: $1"; exit 1;;
  esac
done

if [[ -z "$PROMPT" ]]; then
  echo "ERROR: --prompt is required"
  exit 1
fi

[[ -z "$OUTPUT" ]] && OUTPUT="${RESULT_DIR}/${TASK_NAME}.md"
mkdir -p "$RESULT_DIR"

STARTED_AT="$(date -Iseconds)"

SEARCH_INSTRUCTION="You are a research assistant. Search the web for the following query.

CRITICAL RULES:
1. Output findings as markdown to stdout. Do NOT write files.
2. Start with a heading, then output sections as you discover them.
3. Max 8 web searches. Synthesize, don't over-research.
4. Use web_search tool to find pages, web_fetch to read key pages.
5. Include source URLs inline.
6. End with a brief summary section.
7. Write in the same language as the query.
8. Output ONLY markdown content, no wrapping code fences.

Query: ${PROMPT}"

echo "[deep-search] Task: $TASK_NAME | Model: $MODEL | Timeout: ${TIMEOUT}s"

TASK_OUTPUT="${RESULT_DIR}/task-output.txt"
: > "$TASK_OUTPUT"

# Run Claude Code CLI with the search instruction
# Using --print for non-interactive mode and --permission-mode bypassPermissions
timeout "${TIMEOUT}" bash -c "
  cd \"$WORKSPACE\" && \
  \"$CLAUDE_BIN\" -p \"$SEARCH_INSTRUCTION\" \
    --model \"$MODEL\" \
    --print \
    --permission-mode bypassPermissions \
    2>/dev/null
" > >(while IFS= read -r line; do
    echo "$line" >> "$TASK_OUTPUT"
  done) 2>&1 || true

EXIT_CODE=$?

# Build report
CLAUDE_OUTPUT=$(cat "$TASK_OUTPUT" | sed '/^Loaded cached credentials\.$/d')

cat > "$OUTPUT" <<EOF
# Deep Search Report
**Query:** $PROMPT
**Model:** $MODEL
**Timestamp:** $(date -u)
---
EOF
echo "$CLAUDE_OUTPUT" >> "$OUTPUT"

END_TS=$(date +%s)
START_TS=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo "$END_TS")
ELAPSED=$(( END_TS - START_TS ))
DURATION="$((ELAPSED/60))m$((ELAPSED%60))s"
LINES=$(wc -l < "$OUTPUT" 2>/dev/null || echo 0)

echo -e "\n---\n_Completed at $(date -u) | Duration: ${DURATION} | Exit: ${EXIT_CODE}_ | Lines: ${LINES}_" >> "$OUTPUT"

echo "[deep-search] Done (${DURATION}, exit=${EXIT_CODE}, ${LINES} lines)"
echo "[deep-search] Report: $OUTPUT"

# Notification callback (optional)
if [[ -n "$NOTIFY_CMD" ]]; then
  eval "$NOTIFY_CMD" || echo "[deep-search] Notification failed"
fi
