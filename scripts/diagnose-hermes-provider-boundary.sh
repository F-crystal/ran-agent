#!/usr/bin/env bash
# Run the no-network provider-boundary proof with the installed Hermes runtime.
set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd -P)}"
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
MODEL_NAME="${RAN_AGENT_EXPECTED_HERMES_MODEL:-deepseek-v4-flash}"
MODE="${RAN_AGENT_CAPABILITY_MODE:?RAN_AGENT_CAPABILITY_MODE is required}"
SERVICE_UNIT="${HERMES_SERVICE_UNIT:?HERMES_SERVICE_UNIT is required}"
case "$MODE" in lite|full) ;; *) echo 'diagnose-hermes-provider-boundary: failed:invalid_mode' >&2; exit 1 ;; esac
HERMES_BIN="$(RAN_AGENT_SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-}" bash "$REPO_ROOT/scripts/resolve-hermes-service-runtime.sh" "$SERVICE_UNIT")"

policy_env="$(mktemp)"
trap 'rm -f "$policy_env"' EXIT INT TERM
RAN_AGENT_SYSTEMCTL_BIN="${RAN_AGENT_SYSTEMCTL_BIN:-}" \
RAN_AGENT_PROC_ROOT="${RAN_AGENT_PROC_ROOT:-/proc}" \
RAN_AGENT_EXPECTED_HERMES_MODEL="$MODEL_NAME" \
  bash "$REPO_ROOT/scripts/verify-hermes-service-policy-env.sh" --emit "$SERVICE_UNIT" > "$policy_env"
set -a
# Safe to source: the helper emits only six validated fixed assignments.
source "$policy_env"
set +a

version_output="$("$HERMES_BIN" version 2>/dev/null)"
printf '%s\n' "$version_output" | grep -Eq '^Hermes Agent v0\.13\.' || {
  echo 'diagnose-hermes-provider-boundary: failed:Hermes_v0.13_required' >&2
  exit 1
}
project="$(printf '%s\n' "$version_output" | sed -n 's/^Project:[[:space:]]*//p' | tail -n 1)"
python_bin="${HERMES_RUNTIME_PYTHON:-$project/venv/bin/python}"
if [[ -z "$project" || ! -x "$python_bin" ]]; then
  echo 'diagnose-hermes-provider-boundary: failed:runtime_python_unavailable' >&2
  exit 1
fi

env \
  HERMES_HOME="$HERMES_HOME" \
  HERMES_PROVIDER="$HERMES_PROVIDER" \
  HERMES_INFERENCE_PROVIDER="$HERMES_INFERENCE_PROVIDER" \
  HERMES_DEFAULT_MODEL="$HERMES_DEFAULT_MODEL" \
  HERMES_INFERENCE_MODEL="$HERMES_INFERENCE_MODEL" \
  HERMES_PRO_MODEL="$HERMES_PRO_MODEL" \
  HERMES_DEEPSEEK_THINKING_MODE="$HERMES_DEEPSEEK_THINKING_MODE" \
  PYTHONPATH="$project" \
  "$python_bin" "$REPO_ROOT/scripts/hermes-provider-boundary-self-check.py" \
  --hermes-home "$HERMES_HOME" \
  --mode "$MODE" \
  --model "$MODEL_NAME"
