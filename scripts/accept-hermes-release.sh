#!/usr/bin/env bash

# Server-local acceptance.  It never contacts a chat channel or an MCP
# provider; it validates only the deployed process and owner/state invariants.
set -euo pipefail
umask 077

fail() {
  printf 'accept-hermes-release: failed:%s\n' "$1" >&2
  exit 1
}

SOURCE_ROOT="${RAN_AGENT_RELEASE_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
CONTROL_ROOT="${RAN_AGENT_RELEASE_CONTROL_ROOT:-$SOURCE_ROOT}"
cd "$SOURCE_ROOT"
MODE="${1:---refuse-mutation}"
if [[ $# -gt 1 ]]; then fail invalid_arguments; fi
case "$MODE" in --dry-run|--apply) ;; --refuse-mutation) fail explicit_apply_required ;; *) fail invalid_mode ;; esac
CANDIDATE_INPUT="${RAN_AGENT_RELEASE_CANDIDATE:-HEAD}"
if [[ -f "$SOURCE_ROOT/candidate" && "$CANDIDATE_INPUT" =~ ^[0-9a-f]{40}$ ]]; then
  read -r CANDIDATE _ <"$SOURCE_ROOT/candidate" || fail candidate_stage_manifest_invalid
  [[ "$CANDIDATE" == "$CANDIDATE_INPUT" ]] || fail candidate_stage_mismatch
else
  CANDIDATE="$(git -C "$CONTROL_ROOT" rev-parse --verify "${CANDIDATE_INPUT}^{commit}" 2>/dev/null)" || fail invalid_candidate
fi
[[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail candidate_digest_invalid

if [[ "${EUID}" -eq 0 ]]; then SUDO=(); else command -v sudo >/dev/null 2>&1 || fail sudo_required; SUDO=(sudo); fi
NODE_BIN="${RAN_AGENT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
HERMES_LITE_BRIDGE_SMOKE_URL="${RAN_AGENT_RELEASE_LITE_BRIDGE_SMOKE_URL:-http://127.0.0.1:8642/v1/models}"
HERMES_FULL_BRIDGE_SMOKE_URL="${RAN_AGENT_RELEASE_FULL_BRIDGE_SMOKE_URL:-http://127.0.0.1:8643/v1/models}"
GATEWAY_READY_TIMEOUT_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS:-120}"
GATEWAY_READY_INTERVAL_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS:-2}"
GATEWAY_HEADER_FILE=''

cleanup_gateway_header() {
  [[ -z "$GATEWAY_HEADER_FILE" ]] || rm -f -- "$GATEWAY_HEADER_FILE"
  GATEWAY_HEADER_FILE=''
}
trap cleanup_gateway_header EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_node_sqlite() {
  [[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || fail node_binary_required
  local version major minor patch
  version="$($NODE_BIN -p 'process.versions.node' 2>/dev/null)" || fail node_version_probe
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || fail node_version_invalid
  (( major > 22 || (major == 22 && minor >= 13) )) || fail node_version_unsupported
  "$NODE_BIN" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1); db.close();' >/dev/null 2>&1 || fail node_sqlite_unavailable
}

require_acceptance_prerequisites() {
  require_node_sqlite
  git -C "$CONTROL_ROOT" cat-file -e "${CANDIDATE}^{commit}" || fail candidate_object_missing
  [[ -f "$SOURCE_ROOT/node_bridge/src/semanticClaimVerifier.mjs" && -f "$SOURCE_ROOT/node_bridge/src/identityMap.mjs" ]] || fail candidate_acceptance_incomplete
}

release_semantic_verifier_preflight() {
  "$NODE_BIN" --input-type=module -e '
    import { getSemanticVerifierConfig, verifySemanticClaims } from "./node_bridge/src/semanticClaimVerifier.mjs";
    const config = getSemanticVerifierConfig(process.env);
    if (config.requested && !config.enabled) process.exit(1);
    if (!config.enabled) process.exit(0);
    const result = await verifySemanticClaims({
      envelope: { message: "Release verifier canary.", claims: [{ type: "release_canary" }], commitments: [] },
      receiptSummaries: [{ actionType: "release.canary", outcome: "applied", status: "sent" }],
      config,
    });
    if (!result.ok || !["supported", "rewritten"].includes(result.status)) process.exit(1);
  ' >/dev/null || fail release_semantic_verifier_preflight
}

foreign_owner_binding_denied() {
  "$NODE_BIN" --input-type=module -e '
    import { getIdentityBinding, validateOwnerBindingPreflight } from "./node_bridge/src/identityMap.mjs";
    if (!validateOwnerBindingPreflight().ok) process.exit(1);
    if (getIdentityBinding({ platform: "desktop", sender_id: "release-foreign-owner-canary" }).owner) process.exit(1);
  ' >/dev/null || fail foreign_owner_binding_denied
}

release_broker_read_only_smoke() {
  "$NODE_BIN" "$SOURCE_ROOT/scripts/hermes-release-runtime-journey.mjs" >/dev/null \
    || fail release_broker_read_only_smoke
}

release_post_start_health() {
  for unit in ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service; do
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "service_inactive:$unit"
  done
}

require_bounded_integer() {
  local value="$1" min="$2" max="$3" error="$4"
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= min && value <= max )) || fail "$error"
}

gateway_api_key() {
  local pid="$1" entry hermes_key='' api_server_key=''
  "${SUDO[@]}" cat "/proc/$pid/environ" >/dev/null 2>&1 || return 1
  while IFS= read -r -d '' entry; do
    case "$entry" in
      HERMES_API_KEY=*) hermes_key="${entry#HERMES_API_KEY=}" ;;
      API_SERVER_KEY=*) api_server_key="${entry#API_SERVER_KEY=}" ;;
    esac
  done < <("${SUDO[@]}" cat "/proc/$pid/environ")
  if [[ -n "$hermes_key" ]]; then
    printf '%s' "$hermes_key"
  elif [[ -n "$api_server_key" ]]; then
    printf '%s' "$api_server_key"
  fi
}

gateway_probe() {
  local url="$1" key="$2" max_time="$3"
  GATEWAY_HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/ran-agent-release-gateway.XXXXXX")" || return 1
  chmod 600 "$GATEWAY_HEADER_FILE"
  printf 'Authorization: Bearer %s\n' "$key" >|"$GATEWAY_HEADER_FILE"
  if GATEWAY_HTTP_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 2 --max-time "$max_time" --header "@$GATEWAY_HEADER_FILE" "$url" 2>/dev/null)"; then
    GATEWAY_CURL_EXIT=0
  else
    GATEWAY_CURL_EXIT=$?
  fi
  cleanup_gateway_header
}

wait_for_gateway() {
  local label="$1" unit="$2" url="$3" deadline now remaining max_time pid key
  deadline=$(( $(date +%s) + GATEWAY_READY_TIMEOUT_SECONDS ))
  while :; do
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "${label}_bridge_service_inactive"
    pid="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "${label}_bridge_main_pid_invalid"
    key="$(gateway_api_key "$pid")" || fail "${label}_bridge_main_pid_invalid"
    [[ -n "$key" ]] || fail "${label}_bridge_auth_key_missing"
    [[ "$key" != *$'\r'* && "$key" != *$'\n'* ]] || fail "${label}_bridge_auth_key_invalid"
    now="$(date +%s)"
    (( now < deadline )) || fail "${label}_bridge_ready_timeout"
    remaining=$(( deadline - now )); max_time=5; (( remaining < max_time )) && max_time=$remaining
    gateway_probe "$url" "$key" "$max_time" || fail "${label}_bridge_probe_failed"
    key=''
    case "$GATEWAY_HTTP_STATUS" in
      200) return 0 ;;
      401|403) fail "${label}_bridge_authentication_failed" ;;
    esac
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "${label}_bridge_service_inactive"
    now="$(date +%s)"
    (( now < deadline )) || fail "${label}_bridge_ready_timeout"
    sleep "$GATEWAY_READY_INTERVAL_SECONDS"
  done
}

release_bridge_synthetic_paths() {
  command -v curl >/dev/null 2>&1 || fail curl_required
  require_bounded_integer "$GATEWAY_READY_TIMEOUT_SECONDS" 1 600 gateway_ready_timeout_invalid
  require_bounded_integer "$GATEWAY_READY_INTERVAL_SECONDS" 1 30 gateway_ready_interval_invalid
  wait_for_gateway lite ran-agent-hermes.service "$HERMES_LITE_BRIDGE_SMOKE_URL"
  wait_for_gateway full ran-agent-hermes-full.service "$HERMES_FULL_BRIDGE_SMOKE_URL"
}

if [[ "$MODE" == "--dry-run" ]]; then
  require_acceptance_prerequisites
  bash "$SOURCE_ROOT/scripts/hermes-release-gate.sh" --preflight-only >/dev/null || fail preflight
  printf 'accept-hermes-release: dry-run-ok candidate=%s plan=server-local-acceptance-redacted\n' "$CANDIDATE"
  exit 0
fi

[[ "$CONTROL_ROOT" == /opt/ran_agent ]] || fail server_root_required
HEAD="$(git -C "$CONTROL_ROOT" rev-parse --verify HEAD)" || fail current_head_unavailable
[[ "$HEAD" == "$CANDIDATE" ]] || fail candidate_not_checked_out
git -C "$CONTROL_ROOT" diff --quiet || fail worktree_dirty
git -C "$CONTROL_ROOT" diff --cached --quiet || fail index_dirty
require_acceptance_prerequisites
# Direct acceptance still executes the candidate gate.  Deploy passes the
# already-completed marker so it is never possible to mutate first and gate later.
if [[ "${RAN_AGENT_RELEASE_PREMUTATION_GATE:-0}" != 1 ]]; then
  bash "$SOURCE_ROOT/scripts/hermes-release-gate.sh" --all || fail release_gate
fi
release_semantic_verifier_preflight
foreign_owner_binding_denied
release_post_start_health
release_bridge_synthetic_paths
release_broker_read_only_smoke
printf 'accept-hermes-release: apply-ok candidate=%s\n' "$CANDIDATE"
