#!/usr/bin/env bash

# Server-local acceptance. It never contacts a chat channel or external MCP.
# Its gateway canary is valid only against the controlled local provider boundary.
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
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-/opt/ran_agent/.venv/bin/python}"
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
RUNTIME_GROUP="${RAN_AGENT_RUNTIME_GROUP:-$RUNTIME_USER}"
RAN_AGENT_STATE_DIR="${RAN_AGENT_STATE_DIR:-/opt/ran_agent/.ran_agent_state}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$RAN_AGENT_STATE_DIR/ombre-brain}"
[[ "$OMBRE_BRAIN_HOME" == "$RAN_AGENT_STATE_DIR/ombre-brain" ]] ||
  fail ombre_home_state_dir_mismatch
RELEASE_SNAPSHOT_DIR="${RAN_AGENT_RELEASE_SNAPSHOT_DIR:-}"
HERMES_LITE_BRIDGE_SMOKE_URL="${RAN_AGENT_RELEASE_LITE_BRIDGE_SMOKE_URL:-http://127.0.0.1:8642/v1/models}"
GATEWAY_READY_TIMEOUT_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS:-120}"
GATEWAY_READY_INTERVAL_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS:-2}"
GATEWAY_HEADER_FILE=''
EXPECTED_MODEL="${RAN_AGENT_EXPECTED_HERMES_MODEL:-deepseek-v4-flash}"
case "$EXPECTED_MODEL" in
  deepseek-v4-pro|deepseek-v4-flash) ;;
  *) fail expected_model_invalid ;;
esac

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
  (( major > 22 || (major == 22 && minor >= 19) )) || fail node_version_unsupported
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
  for unit in ran-agent-python.service ran-agent-node.service ran-agent-ombre-brain.service ran-agent-hermes.service; do
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "service_inactive:$unit"
  done
  for unit in ran-agent-ombre-recall.service ran-agent-hermes-full.service; do
    ! "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "retired_service_active:$unit"
  done
  release_o2_retirement_contract
  release_managed_endpoint_health \
    ran-agent-ombre-brain.service 18001 \
    "${OMBRE_BRAIN_HEALTH_URL:-http://127.0.0.1:18001/health}" \
    ombre_upstream
  release_ombre_unit_contract
}

release_o2_retirement_contract() {
  local pid_before pid_after process_env
  pid_before="$("${SUDO[@]}" systemctl show ran-agent-node.service --property=MainPID --value 2>/dev/null)" ||
    fail node_pid_unavailable
  [[ "$pid_before" =~ ^[1-9][0-9]*$ ]] || fail node_pid_invalid
  process_env="$("${SUDO[@]}" cat "/proc/$pid_before/environ" 2>/dev/null | tr '\0' '\n')" ||
    fail node_environment_unavailable
  pid_after="$("${SUDO[@]}" systemctl show ran-agent-node.service --property=MainPID --value 2>/dev/null)" ||
    fail node_pid_recheck_unavailable
  [[ "$pid_after" == "$pid_before" ]] || fail node_pid_drift
  ! grep -Eq '^(OMBRE_COMPAT_|RAN_AGENT_STEWARD_)' <<<"$process_env" ||
    fail retired_o2_process_environment_present
  [[ ! -e "$SOURCE_ROOT/node_bridge/src/ombreCompat" ]] || fail retired_o2_source_present
}

release_ombre_unit_contract() {
  local pid process_env dropins process_exe process_cwd process_args expected_launcher expected_python status_revision
  dropins="$("${SUDO[@]}" systemctl show ran-agent-ombre-brain.service --property=DropInPaths --value 2>/dev/null)" ||
    fail ombre_upstream_dropin_probe_failed
  [[ -z "$dropins" ]] || fail ombre_upstream_dropin_override_present
  pid="$("${SUDO[@]}" systemctl show ran-agent-ombre-brain.service --property=MainPID --value 2>/dev/null)" ||
    fail ombre_upstream_main_pid_unavailable
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail ombre_upstream_main_pid_invalid
  process_env="$("${SUDO[@]}" cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n')" ||
    fail ombre_upstream_process_environment_unavailable
  for setting in \
    'OMBRE_BRAIN_RUNNER=source' \
    'OMBRE_BIND_HOST=127.0.0.1' \
    'OMBRE_MCP_REQUIRE_AUTH=false' \
    'OMBRE_PORT=18001' \
    "OMBRE_BRAIN_HOME=$OMBRE_BRAIN_HOME" \
    'OMBRE_BUCKETS_DIR=/opt/ran_agent/vault/ombre' \
    'RAN_AGENT_REPO_ROOT=/opt/ran_agent'; do
    grep -qxF "$setting" <<<"$process_env" || fail ombre_upstream_process_environment_contract
  done
  for rejected in BASH_ENV ENV BASHOPTS SHELLOPTS BASH_XTRACEFD PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH; do
    ! grep -q "^$rejected=" <<<"$process_env" || fail "ombre_upstream_process_environment_injection:$rejected"
  done
  expected_launcher="$OMBRE_BRAIN_HOME/.venv/bin/python"
  expected_python="$(realpath "$expected_launcher")" || fail ombre_upstream_python_unavailable
  process_exe="$("${SUDO[@]}" readlink -f "/proc/$pid/exe")" || fail ombre_upstream_process_unavailable
  process_cwd="$("${SUDO[@]}" readlink -f "/proc/$pid/cwd")" || fail ombre_upstream_process_unavailable
  process_args="$("${SUDO[@]}" cat "/proc/$pid/cmdline" | tr '\0' '\n')" || fail ombre_upstream_process_unavailable
  [[ "$process_exe" == "$expected_python" && "$process_cwd" == "$OMBRE_BRAIN_HOME/upstream" ]] ||
    fail ombre_upstream_process_contract
  [[ "$process_args" == "$expected_launcher"$'\n''src/server.py' ]] || fail ombre_upstream_process_contract
  status_revision="$("$PYTHON_BIN" -I -c '
import json, pathlib, sys
status = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
revision = status.get("repo", {}).get("after")
if (status.get("schema_version") != 1 or status.get("ok") is not True
        or status.get("deploy_ready") is not True or status.get("runner") != "source"
        or status.get("repo", {}).get("dir") != sys.argv[2]
        or status.get("repo", {}).get("remote") != revision
        or not isinstance(revision, str) or len(revision) != 40
        or any(value not in "0123456789abcdef" for value in revision)):
    raise SystemExit(1)
print(revision)
' "$OMBRE_BRAIN_HOME/status.json" "$OMBRE_BRAIN_HOME/upstream")" || fail ombre_upstream_status_contract
  [[ "$(git -C "$OMBRE_BRAIN_HOME/upstream" rev-parse HEAD)" == "$status_revision" ]] ||
    fail ombre_upstream_source_contract
  curl --fail --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    http://127.0.0.1:18001/mcp |
    "$NODE_BIN" --input-type=module -e '
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      const names = new Set(JSON.parse(body)?.result?.tools?.map((tool) => tool.name));
      for (const required of ["breath_search", "hold", "grow", "trace", "I"]) {
        if (!names.has(required)) process.exit(1);
      }
    ' || fail ombre_upstream_toolset_invalid
}

release_managed_endpoint_health() {
  local unit="$1" port="$2" health_url="$3" label="$4" pid listeners
  pid="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" ||
    fail "${label}_main_pid_unavailable"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "${label}_main_pid_invalid"
  listeners="$("${SUDO[@]}" ss -ltnp 2>/dev/null)" || fail "${label}_listener_probe_failed"
  printf '%s\n' "$listeners" |
    grep -Eq "127\\.0\\.0\\.1:$port([^0-9]|$).*pid=$pid([^0-9]|$)" ||
    fail "${label}_listener_not_owned_by_main_pid"
  curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null ||
    fail "${label}_health_failed"
}

release_projection_acceptance() {
  RAN_AGENT_RELEASE_SOURCE_ROOT="$SOURCE_ROOT" \
  RAN_AGENT_PROJECTION_POINTER="${RAN_AGENT_PROJECTION_POINTER:-/opt/ran_agent/.ran_agent_state/hermes/published-memory-context.json}" \
    "$NODE_BIN" --input-type=module -e '
      import { computeHermesIdentityVersion, loadPublishedProjection } from "./node_bridge/src/hermesIdentityProjection.mjs";
      const identity = computeHermesIdentityVersion(process.env.RAN_AGENT_RELEASE_SOURCE_ROOT);
      const snapshot = loadPublishedProjection(process.env.RAN_AGENT_PROJECTION_POINTER, identity.version);
      if (!snapshot.projection_revision || !Number.isInteger(snapshot.activity_revision)) process.exit(1);
    ' >/dev/null || fail projection_not_verified
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
}

release_provider_boundary_canary() {
  local mode="$1" unit="$2" port="$3" profile="$4" pid key nonce
  pid="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" ||
    fail "${mode}_provider_canary_main_pid_unavailable"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "${mode}_provider_canary_main_pid_invalid"
  key="$(gateway_api_key "$pid")" || fail "${mode}_provider_canary_key_unavailable"
  [[ -n "$key" ]] || fail "${mode}_provider_canary_key_missing"
  nonce="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" ||
    fail "${mode}_provider_canary_nonce_failed"
  env \
    HERMES_REPLY_MODE=api \
    HERMES_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_LITE_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_FULL_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_API_KEY="$key" \
    HERMES_PROVIDER=deepseek \
    HERMES_INFERENCE_PROVIDER=deepseek \
    HERMES_DEFAULT_MODEL="$EXPECTED_MODEL" \
    HERMES_INFERENCE_MODEL="$EXPECTED_MODEL" \
    HERMES_PRO_MODEL="$EXPECTED_MODEL" \
    HERMES_DEEPSEEK_THINKING_MODE=disabled \
    HERMES_PROFILE="$profile" \
    HERMES_LITE_PROFILE="$profile" \
    HERMES_FULL_PROFILE="$profile" \
    RAN_AGENT_CAPABILITY_MODE="$mode" \
    RAN_AGENT_REPO_ROOT="$SOURCE_ROOT" \
    HERMES_PUBLISHED_MEMORY_CONTEXT_PATH="${RAN_AGENT_PROJECTION_POINTER:-/opt/ran_agent/.ran_agent_state/hermes/published-memory-context.json}" \
    RAN_AGENT_PROVIDER_CANARY_MODE="$mode" \
    RAN_AGENT_PROVIDER_CANARY_NONCE="$nonce" \
    RAN_AGENT_CONTEXT_SIZE_LOG=0 \
    "$NODE_BIN" "$SOURCE_ROOT/node_bridge/src/hermesProviderBoundaryCanary.mjs" >/dev/null ||
    fail "${mode}_provider_boundary_canary_failed"
}

release_provider_boundary_canaries() {
  release_provider_boundary_canary lite ran-agent-hermes.service 8642 ran-assistant-lite
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
# Direct acceptance executes the immutable code gate. Deploy completes that
# gate before mutation and verifies the live direct Ombre endpoint below.
if [[ "${RAN_AGENT_RELEASE_PREMUTATION_GATE:-0}" != 1 ]]; then
  RAN_AGENT_GATE_SKIP_PRIVILEGED_TESTS=0 \
  RAN_AGENT_RUNTIME_USER="$RUNTIME_USER" \
  RAN_AGENT_RUNTIME_GROUP="$RUNTIME_GROUP" \
    bash "$SOURCE_ROOT/scripts/hermes-release-gate.sh" --all || fail release_gate
fi
release_semantic_verifier_preflight
foreign_owner_binding_denied
release_post_start_health
release_projection_acceptance
release_bridge_synthetic_paths
release_provider_boundary_canaries
release_broker_read_only_smoke
release_post_start_health
release_projection_acceptance
release_provider_boundary_canaries
printf 'accept-hermes-release: apply-ok candidate=%s\n' "$CANDIDATE"
