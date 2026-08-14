#!/usr/bin/env bash
set -euo pipefail

export RAN_AGENT_STATE_DIR=/opt/ran_agent/.ran_agent_state
export RAN_AGENT_CORE_WAKE_ENABLED=true

exec /opt/nodejs/node-v22.22.2-linux-x64/bin/node /opt/ran_agent/scripts/core-wake.mjs
