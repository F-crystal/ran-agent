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
RAN_AGENT_STATE_DIR="${RAN_AGENT_STATE_DIR:-/opt/ran_agent/.ran_agent_state}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$RAN_AGENT_STATE_DIR/ombre-brain}"
[[ "$OMBRE_BRAIN_HOME" == "$RAN_AGENT_STATE_DIR/ombre-brain" ]] ||
  fail ombre_home_state_dir_mismatch
RELEASE_SNAPSHOT_DIR="${RAN_AGENT_RELEASE_SNAPSHOT_DIR:-}"
SECRET_ROLLBACK_ROOT="${RAN_AGENT_RELEASE_SECRET_ROLLBACK_ROOT:-/run/ran-agent-release-secrets}"
SECRET_ROLLBACK_DIR="${RAN_AGENT_RELEASE_SECRET_ROLLBACK_DIR:-}"
OLD_STEWARD_TOKEN_FILE="${RAN_AGENT_STEWARD_OLD_TOKEN_FILE:-}"
HERMES_LITE_BRIDGE_SMOKE_URL="${RAN_AGENT_RELEASE_LITE_BRIDGE_SMOKE_URL:-http://127.0.0.1:8642/v1/models}"
HERMES_FULL_BRIDGE_SMOKE_URL="${RAN_AGENT_RELEASE_FULL_BRIDGE_SMOKE_URL:-http://127.0.0.1:8643/v1/models}"
GATEWAY_READY_TIMEOUT_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS:-120}"
GATEWAY_READY_INTERVAL_SECONDS="${RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS:-2}"
GATEWAY_HEADER_FILE=''
EXPECTED_MODEL="${RAN_AGENT_EXPECTED_HERMES_MODEL:-deepseek-v4-flash}"
case "$EXPECTED_MODEL" in
  deepseek-v4-pro|deepseek-v4-flash) ;;
  *) fail expected_model_invalid ;;
esac
EXPECTED_OMBRE_COMPAT_ENABLED="${RAN_AGENT_EXPECTED_OMBRE_COMPAT_ENABLED:-true}"
case "$EXPECTED_OMBRE_COMPAT_ENABLED" in true|false) ;; *) fail expected_ombre_compat_enabled_invalid ;; esac
EXPECTED_OMBRE_COMPAT_CURATOR_BASE_URL="${RAN_AGENT_EXPECTED_OMBRE_COMPAT_CURATOR_BASE_URL:-https://api.deepseek.com/v1}"
EXPECTED_OMBRE_COMPAT_CURATOR_MODEL="${RAN_AGENT_EXPECTED_OMBRE_COMPAT_CURATOR_MODEL:-$EXPECTED_MODEL}"
EXPECTED_OMBRE_COMPAT_REVIEWER_BASE_URL="${RAN_AGENT_EXPECTED_OMBRE_COMPAT_REVIEWER_BASE_URL:-https://api.deepseek.com/v1}"
EXPECTED_OMBRE_COMPAT_REVIEWER_MODEL="${RAN_AGENT_EXPECTED_OMBRE_COMPAT_REVIEWER_MODEL:-$EXPECTED_MODEL}"
for expected_pair in \
  "$EXPECTED_OMBRE_COMPAT_CURATOR_BASE_URL|$EXPECTED_OMBRE_COMPAT_CURATOR_MODEL" \
  "$EXPECTED_OMBRE_COMPAT_REVIEWER_BASE_URL|$EXPECTED_OMBRE_COMPAT_REVIEWER_MODEL"; do
  case "$expected_pair" in
    'https://api.deepseek.com/v1|deepseek-v4-flash'|'https://api.deepseek.com/v1|deepseek-v4-pro') ;;
    *) fail expected_ombre_compat_model_endpoint_invalid ;;
  esac
done

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
  for unit in ran-agent-python.service ran-agent-node.service ran-agent-ombre-brain.service ran-agent-ombre-recall.service ran-agent-hermes.service ran-agent-hermes-full.service; do
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "service_inactive:$unit"
  done
  release_steward_identity_contract ran-agent-node.service
  release_steward_identity_contract ran-agent-ombre-brain.service
  release_ombre_compat_contract
  release_managed_endpoint_health \
    ran-agent-ombre-brain.service 18001 \
    "${OMBRE_BRAIN_HEALTH_URL:-http://127.0.0.1:18001/health}" \
    ombre_upstream
  release_managed_endpoint_health \
    ran-agent-ombre-recall.service 18002 \
    "${OMBRE_RECALL_HEALTH_URL:-http://127.0.0.1:18002/health}" \
    ombre_recall
  release_ombre_unit_contract
}

release_ombre_compat_contract() {
  local pid_before pid_after process_env state_dir identity_file steward_endpoint
  pid_before="$("${SUDO[@]}" systemctl show ran-agent-node.service --property=MainPID --value 2>/dev/null)" ||
    fail ombre_compat_node_pid_unavailable
  [[ "$pid_before" =~ ^[1-9][0-9]*$ ]] || fail ombre_compat_node_pid_invalid
  process_env="$("${SUDO[@]}" cat "/proc/$pid_before/environ" 2>/dev/null | tr '\0' '\n')" ||
    fail ombre_compat_node_environment_unavailable
  pid_after="$("${SUDO[@]}" systemctl show ran-agent-node.service --property=MainPID --value 2>/dev/null)" ||
    fail ombre_compat_node_pid_recheck_unavailable
  [[ "$pid_after" == "$pid_before" ]] || fail ombre_compat_node_pid_drift

  state_dir="$RAN_AGENT_STATE_DIR/ombre-compat"
  identity_file="$OMBRE_BRAIN_HOME/steward-identity.v1.json"
  steward_endpoint='http://127.0.0.1:18001/internal/ran-agent/steward/v1'
  grep -qxF "OMBRE_COMPAT_ENABLED=$EXPECTED_OMBRE_COMPAT_ENABLED" <<<"$process_env" ||
    fail ombre_compat_process_environment_contract:OMBRE_COMPAT_ENABLED
  [ "$EXPECTED_OMBRE_COMPAT_ENABLED" = true ] || return 0
  for setting in \
    "OMBRE_COMPAT_STATE_DIR=$state_dir" \
    "OMBRE_COMPAT_STEWARD_ENDPOINT=$steward_endpoint" \
    "OMBRE_COMPAT_STEWARD_IDENTITY_FILE=$identity_file" \
    "OMBRE_COMPAT_CURATOR_BASE_URL=$EXPECTED_OMBRE_COMPAT_CURATOR_BASE_URL" \
    "OMBRE_COMPAT_CURATOR_MODEL=$EXPECTED_OMBRE_COMPAT_CURATOR_MODEL" \
    "OMBRE_COMPAT_REVIEWER_BASE_URL=$EXPECTED_OMBRE_COMPAT_REVIEWER_BASE_URL" \
    "OMBRE_COMPAT_REVIEWER_MODEL=$EXPECTED_OMBRE_COMPAT_REVIEWER_MODEL"; do
    grep -qxF "$setting" <<<"$process_env" || fail "ombre_compat_process_environment_contract:${setting%%=*}"
  done
  grep -Eq '^DEEPSEEK_API_KEY=.+$' <<<"$process_env" ||
    fail ombre_compat_deepseek_auth_unavailable
  [[ "$("${SUDO[@]}" stat -c '%U:%G:%a' "$state_dir")" == ran-agent:ran-agent:700 ]] ||
    fail ombre_compat_state_identity_contract
  "${SUDO[@]}" test -f "$identity_file" && "${SUDO[@]}" test ! -L "$identity_file" ||
    fail ombre_compat_steward_identity_file_contract
}

release_steward_identity_contract() {
  local unit="$1" pid_before pid_after process_env token_path
  "${SUDO[@]}" bash "$SOURCE_ROOT/scripts/verify-ran-agent-runtime-identity.sh" \
    --verify-process "$unit" || fail "steward_numeric_identity_contract:$unit"
  pid_before="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" ||
    fail "steward_identity_pid_unavailable:$unit"
  [[ "$pid_before" =~ ^[1-9][0-9]*$ ]] || fail "steward_identity_pid_invalid:$unit"
  process_env="$("${SUDO[@]}" cat "/proc/$pid_before/environ" 2>/dev/null | tr '\0' '\n')" ||
    fail "steward_process_environment_unavailable:$unit"
  pid_after="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null)" ||
    fail "steward_identity_pid_recheck_unavailable:$unit"
  [[ "$pid_after" == "$pid_before" ]] || fail "steward_identity_pid_drift:$unit"
  token_path="$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token"
  grep -qxF "RAN_AGENT_STEWARD_TOKEN_FILE=$token_path" <<<"$process_env" ||
    fail "steward_token_path_contract:$unit"
}

release_steward_secret_boundary() {
  local token_path="$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token"
  local release_artifact_root
  [[ "$RAN_AGENT_STATE_DIR" == /* ]] || fail steward_state_dir_invalid
  [[ ! -e "$SOURCE_ROOT/.ran_agent_state/ombre-compat/secrets/steward-api-token" ]] ||
    fail steward_token_in_staged_checkout
  [[ -n "$RELEASE_SNAPSHOT_DIR" && -d "$RELEASE_SNAPSHOT_DIR" ]] ||
    fail release_snapshot_unavailable
  if find "$RELEASE_SNAPSHOT_DIR" -path '*/ombre-compat/secrets*' -print -quit | grep -q .; then
    fail steward_secret_in_release_snapshot
  fi
  [[ -n "$SECRET_ROLLBACK_DIR" && "$SECRET_ROLLBACK_DIR" == "$SECRET_ROLLBACK_ROOT"/* ]] ||
    fail secret_rollback_transaction_contract
  [[ "$("${SUDO[@]}" stat -c '%U:%G:%a' "$SECRET_ROLLBACK_DIR")" == root:root:700 ]] ||
    fail secret_rollback_identity_contract
  "${SUDO[@]}" "$PYTHON_BIN" "$SOURCE_ROOT/scripts/install-ombre-steward-token.py" \
    --state-dir "$RAN_AGENT_STATE_DIR" --verify >/dev/null ||
    fail steward_token_file_contract
  release_artifact_root="$(dirname "$(dirname "$RELEASE_SNAPSHOT_DIR")")"
  "${SUDO[@]}" "$PYTHON_BIN" - "$token_path" "$OLD_STEWARD_TOKEN_FILE" "$RELEASE_SNAPSHOT_DIR" "$release_artifact_root/archives" <<'PY' ||
import os, pathlib, sys
tokens = [pathlib.Path(sys.argv[1]).read_bytes()]
if sys.argv[2]:
    tokens.append(pathlib.Path(sys.argv[2]).read_bytes())
for scan_root in sys.argv[3:]:
    if not pathlib.Path(scan_root).exists():
        continue
    for root, _, files in os.walk(scan_root):
        for name in files:
            path = pathlib.Path(root, name)
            try:
                with path.open("rb") as source:
                    tail = b""
                    while chunk := source.read(1024 * 1024):
                        data = tail + chunk
                        if any(token in data for token in tokens):
                            raise SystemExit(1)
                        tail = data[-max(len(token) - 1 for token in tokens):]
            except (PermissionError, OSError):
                raise SystemExit(1)
PY
    fail steward_token_bytes_in_release_artifacts
  "${SUDO[@]}" journalctl -b \
    -u ran-agent-node.service -u ran-agent-ombre-brain.service --no-pager |
    "${SUDO[@]}" "$PYTHON_BIN" -c '
import pathlib, sys
tokens = [pathlib.Path(sys.argv[1]).read_bytes()]
if sys.argv[2]:
    tokens.append(pathlib.Path(sys.argv[2]).read_bytes())
tail = b""
while chunk := sys.stdin.buffer.read(1024 * 1024):
    data = tail + chunk
    if any(token in data for token in tokens):
        raise SystemExit(1)
    tail = data[-max(len(token) - 1 for token in tokens):]
' "$token_path" "$OLD_STEWARD_TOKEN_FILE" ||
    fail steward_token_bytes_in_journal
}

release_ombre_unit_contract() {
  local unit_text pid process_env effective_exec dropins
  local -a rejected_token_args=() run_as_steward=()
  unit_text="$("${SUDO[@]}" systemctl cat ran-agent-ombre-brain.service 2>/dev/null)" ||
    fail ombre_upstream_unit_unavailable
  for setting in \
    'Environment=OMBRE_BRAIN_RUNNER=source' \
    'Environment=OMBRE_BRAIN_COMMIT=0e83d4671ce1629e03ad36bb9160235bf60dbd34' \
    'Environment=OMBRE_BIND_HOST=127.0.0.1' \
    'Environment=OMBRE_MCP_REQUIRE_AUTH=false' \
    'Environment=OMBRE_TRANSPORT=streamable-http' \
    'Environment=OMBRE_PORT=18001' \
    "Environment=OMBRE_CONFIG_PATH=$OMBRE_BRAIN_HOME/config.yaml" \
    'Environment=OMBRE_VAULT_DIR=/opt/ran_agent/vault/ombre' \
    'UnsetEnvironment=BASH_ENV ENV BASHOPTS SHELLOPTS BASH_XTRACEFD PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH' \
    "ExecStart=/usr/bin/bash /opt/ran_agent/scripts/start_ombre_brain_service.sh --managed /opt/ran_agent $RAN_AGENT_STATE_DIR /opt/ran_agent/vault/ombre" \
    'Environment=OMBRE_BRAIN_MCP_URL=http://127.0.0.1:18001/mcp' \
    "Environment=RAN_AGENT_STATE_DIR=$RAN_AGENT_STATE_DIR" \
    "Environment=OMBRE_BRAIN_HOME=$OMBRE_BRAIN_HOME" \
    "Environment=RAN_AGENT_STEWARD_IDENTITY_FILE=$RAN_AGENT_STATE_DIR/ombre-brain/steward-identity.v1.json" \
    "Environment=RAN_AGENT_STEWARD_TOKEN_FILE=$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token"; do
    grep -qF "$setting" <<<"$unit_text" || fail ombre_upstream_unit_contract
  done
  dropins="$("${SUDO[@]}" systemctl show ran-agent-ombre-brain.service --property=DropInPaths --value 2>/dev/null)" ||
    fail ombre_upstream_dropin_probe_failed
  [[ -z "$dropins" ]] || fail ombre_upstream_dropin_override_present
  effective_exec="$("${SUDO[@]}" systemctl show ran-agent-ombre-brain.service --property=ExecStart --value 2>/dev/null)" ||
    fail ombre_upstream_effective_exec_unavailable
  case "$effective_exec" in
    '{ path=/usr/bin/bash ; argv[]=/usr/bin/bash /opt/ran_agent/scripts/start_ombre_brain_service.sh --managed /opt/ran_agent /opt/ran_agent/.ran_agent_state /opt/ran_agent/vault/ombre ; ignore_errors='*) ;;
    *) fail ombre_upstream_effective_exec_contract ;;
  esac
  [[ "$effective_exec" != *'} ; {'* && "$effective_exec" != *$'\n'* ]] ||
    fail ombre_upstream_effective_exec_contract
  pid="$("${SUDO[@]}" systemctl show ran-agent-ombre-brain.service --property=MainPID --value 2>/dev/null)" ||
    fail ombre_upstream_main_pid_unavailable
  process_env="$("${SUDO[@]}" cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n')" ||
    fail ombre_upstream_process_environment_unavailable
  for setting in \
    'OMBRE_BRAIN_RUNNER=source' \
    'OMBRE_BRAIN_COMMIT=0e83d4671ce1629e03ad36bb9160235bf60dbd34' \
    'OMBRE_BIND_HOST=127.0.0.1' \
    'OMBRE_MCP_REQUIRE_AUTH=false' \
    'OMBRE_TRANSPORT=streamable-http' \
    'OMBRE_PORT=18001' \
    "OMBRE_CONFIG_PATH=$OMBRE_BRAIN_HOME/config.yaml" \
    'OMBRE_VAULT_DIR=/opt/ran_agent/vault/ombre' \
    "RAN_AGENT_STATE_DIR=$RAN_AGENT_STATE_DIR" \
    "OMBRE_BRAIN_HOME=$OMBRE_BRAIN_HOME"; do
    grep -qxF "$setting" <<<"$process_env" || fail ombre_upstream_process_environment_contract
  done
  for rejected in BASH_ENV ENV BASHOPTS SHELLOPTS BASH_XTRACEFD PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH; do
    ! grep -q "^$rejected=" <<<"$process_env" || fail "ombre_upstream_process_environment_injection:$rejected"
  done
  [[ -z "$OLD_STEWARD_TOKEN_FILE" ]] ||
    rejected_token_args=(--rejected-token-file "$OLD_STEWARD_TOKEN_FILE")
  "${SUDO[@]}" "$PYTHON_BIN" "$SOURCE_ROOT/scripts/verify-ombre-steward-runtime.py" \
    --state-dir "$RAN_AGENT_STATE_DIR" \
    --identity-file "$RAN_AGENT_STATE_DIR/ombre-brain/steward-identity.v1.json" \
    --source-dir "$OMBRE_BRAIN_HOME/upstream" \
    --venv "$OMBRE_BRAIN_HOME/.venv" \
    "${rejected_token_args[@]}" \
    >/dev/null || fail ombre_steward_runtime_contract
  [[ -x /usr/sbin/runuser ]] || fail ombre_steward_runuser_required
  "${SUDO[@]}" /usr/sbin/runuser --user ran-agent --group ran-agent -- /usr/bin/env -i \
    HOME="$OMBRE_BRAIN_HOME" \
    PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
    TMPDIR=/tmp \
    OMBRE_PATCHED_PROCESS_URL=http://127.0.0.1:18001/internal/ran-agent/steward/v1 \
    RAN_AGENT_STEWARD_TOKEN_FILE="$RAN_AGENT_STATE_DIR/ombre-compat/secrets/steward-api-token" \
    RAN_AGENT_STEWARD_IDENTITY_FILE="$RAN_AGENT_STATE_DIR/ombre-brain/steward-identity.v1.json" \
    "$NODE_BIN" --test "$SOURCE_ROOT/node_bridge/tests/ombreCompatPatchedProcess.test.mjs" \
    >/dev/null || fail ombre_steward_real_process_contract
  release_steward_secret_boundary
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

release_ombre_recall_acceptance() {
  local configs=(
    "${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}/config.yaml" \
    "${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}/profiles/ran-assistant/config.yaml" \
    "${HERMES_LITE_HOME:-${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}/lite}/config.yaml" \
    "${HERMES_LITE_HOME:-${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}/lite}/profiles/ran-assistant-lite/config.yaml"
  )
  OMBRE_RECALL_MCP_URL="${OMBRE_RECALL_MCP_URL:-http://127.0.0.1:18002/mcp}" \
    "${SUDO[@]}" "$PYTHON_BIN" "$SOURCE_ROOT/scripts/ombre_o1_contract.py" \
      validate-config "${configs[@]}" >/dev/null ||
    fail ombre_runtime_semantic_contract
  curl --fail --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    "${OMBRE_RECALL_MCP_URL:-http://127.0.0.1:18002/mcp}" |
    "$NODE_BIN" --input-type=module -e '
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      const names = JSON.parse(body)?.result?.tools?.map((tool) => tool.name);
      if (JSON.stringify(names) !== JSON.stringify(["ombre_recall_search", "ombre_recall_read"])) process.exit(1);
    ' || fail ombre_recall_toolset_invalid
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
  wait_for_gateway full ran-agent-hermes-full.service "$HERMES_FULL_BRIDGE_SMOKE_URL"
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
  release_provider_boundary_canary full ran-agent-hermes-full.service 8643 ran-assistant
  RAN_AGENT_CAPABILITY_MODE=lite \
  HERMES_SERVICE_UNIT=ran-agent-hermes.service \
  HERMES_HOME="${HERMES_LITE_HOME:-${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}/lite}" \
  RAN_AGENT_EXPECTED_HERMES_MODEL="$EXPECTED_MODEL" \
  RAN_AGENT_REPO_ROOT="$SOURCE_ROOT" \
    bash "$SOURCE_ROOT/scripts/diagnose-hermes-provider-boundary.sh" >/dev/null ||
    fail lite_provider_http_body_proof_failed
  RAN_AGENT_CAPABILITY_MODE=full \
  HERMES_SERVICE_UNIT=ran-agent-hermes-full.service \
  HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}" \
  RAN_AGENT_EXPECTED_HERMES_MODEL="$EXPECTED_MODEL" \
  RAN_AGENT_REPO_ROOT="$SOURCE_ROOT" \
    bash "$SOURCE_ROOT/scripts/diagnose-hermes-provider-boundary.sh" >/dev/null ||
    fail full_provider_http_body_proof_failed
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
# Direct acceptance executes both the immutable code gate and the real Ombre
# process gate. Deploy completes the code gate before mutation, then runs the
# real gate here only after the transaction has prepared the pinned runtime.
if [[ "${RAN_AGENT_RELEASE_PREMUTATION_GATE:-0}" != 1 ]]; then
  RAN_AGENT_OMBRE_REAL_PROCESS_GATE_PHASE=required \
  RAN_AGENT_OMBRE_UPSTREAM_SOURCE_DIR="$OMBRE_BRAIN_HOME/upstream" \
  RAN_AGENT_OMBRE_UPSTREAM_VENV="$OMBRE_BRAIN_HOME/.venv" \
    bash "$SOURCE_ROOT/scripts/hermes-release-gate.sh" --all || fail release_gate
else
  [[ -x /usr/sbin/runuser ]] || fail ombre_steward_runuser_required
  "${SUDO[@]}" /usr/sbin/runuser --user ran-agent --group ran-agent -- /usr/bin/env -i \
    HOME="$OMBRE_BRAIN_HOME" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" TMPDIR=/tmp \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    RAN_AGENT_RELEASE_SOURCE_ROOT="$SOURCE_ROOT" \
    RAN_AGENT_OMBRE_UPSTREAM_SOURCE_DIR="$OMBRE_BRAIN_HOME/upstream" \
    RAN_AGENT_OMBRE_UPSTREAM_VENV="$OMBRE_BRAIN_HOME/.venv" \
    RAN_AGENT_NODE_BIN="$NODE_BIN" \
    /bin/bash "$SOURCE_ROOT/scripts/verify-ombre-steward-real-process.sh" >/dev/null ||
    fail ombre_steward_candidate_real_process_gate
fi
release_semantic_verifier_preflight
foreign_owner_binding_denied
release_post_start_health
release_ombre_recall_acceptance
release_projection_acceptance
release_bridge_synthetic_paths
release_provider_boundary_canaries
release_broker_read_only_smoke
release_post_start_health
release_projection_acceptance
release_provider_boundary_canaries
printf 'accept-hermes-release: apply-ok candidate=%s\n' "$CANDIDATE"
