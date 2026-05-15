#!/bin/bash
# Compact the ran-agent global timeline without printing secrets.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TIMELINE_PATH="${RAN_AGENT_GLOBAL_TIMELINE_PATH:-/opt/ran_agent/.ran_agent_state/global-timeline.jsonl}"
ARCHIVE_DIR="${RAN_AGENT_TIMELINE_ARCHIVE_DIR:-/opt/ran_agent/.ran_agent_state/timeline_archive}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

RAN_AGENT_GLOBAL_TIMELINE_PATH="$TIMELINE_PATH" \
RAN_AGENT_TIMELINE_ARCHIVE_DIR="$ARCHIVE_DIR" \
"$NODE_BIN" --input-type=module <<'NODE'
import { compactTimeline, getGlobalTimelineConfig } from './node_bridge/src/globalTimeline.mjs';

const config = getGlobalTimelineConfig();
const result = compactTimeline({
  timelinePath: config.timelinePath,
  archiveDir: config.archiveDir,
  maxBytes: config.maxBytes,
  maxTurns: config.maxTurns,
  retentionDays: config.retentionDays,
});

console.log(JSON.stringify(result, null, 2));
NODE
