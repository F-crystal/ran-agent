import fs from 'node:fs';

import { canonicalDigest, newId } from './canonical.mjs';
import {
  COMPAT_ADAPTER_ID,
  COMPAT_ADAPTER_VERSION,
  COMPAT_PROTOCOL_ID,
  COMPAT_UPSTREAM_VERSION,
  compatError,
} from './constants.mjs';
import {
  adapterPolicyDigest,
  isBound,
  resolveGrowthMethod,
  resolveLifecycleMethod,
} from './adapterPolicy.mjs';

const API_VERSION = 'ombre.steward-api/1';
const RECEIPT_VERSION = 'ombre.steward-receipt/1';
const TOKEN_HEADER = 'X-Ran-Agent-Steward-Token';
const IDENTITY_KEYS = [
  'base_upstream_commit',
  'patch_manifest_sha256',
  'api_schema_sha256',
  'effective_source_tree_sha256',
];
const RECEIPT_KEYS = [
  'schema_version', 'ok', 'outcome', 'error', 'idempotency', 'operation_key',
  'idempotency_key', 'attempt', 'source', 'target', 'evidence_ref', 'api_version',
  ...IDENTITY_KEYS, 'issued_at', 'issuer_id',
];

export function createStewardAdapter(options = {}) {
  const endpoint = String(options.endpoint || options.upstreamUrl || '').replace(/\/+$/, '');
  const tokenFile = String(options.tokenFile || '');
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 5000;
  const expectedIdentity = Object.freeze({
    base_upstream_commit: options.baseUpstreamCommit || COMPAT_UPSTREAM_VERSION,
    patch_manifest_sha256: options.patchManifestSha256,
    api_schema_sha256: options.apiSchemaSha256,
    effective_source_tree_sha256: options.effectiveSourceTreeSha256,
  });
  const policyDigest = adapterPolicyDigest();
  if (!endpoint || typeof fetchImpl !== 'function' || !tokenFile
    || IDENTITY_KEYS.some((key) => typeof expectedIdentity[key] !== 'string' || !expectedIdentity[key])) {
    throw compatError('COMPAT_CONFIG_INCOMPLETE', 'steward adapter configuration incomplete');
  }

  function token() {
    let info;
    try {
      info = fs.lstatSync(tokenFile);
      if (info.isSymbolicLink() || !info.isFile()
        || info.uid !== process.getuid() || info.gid !== process.getgid()
        || (info.mode & 0o777) !== 0o600) throw new Error('identity');
      const value = fs.readFileSync(tokenFile, 'ascii');
      if (!/^[a-f0-9]{64}\n$/.test(value)) throw new Error('format');
      return value.slice(0, -1);
    } catch (cause) {
      throw compatError('COMPAT_CONFIG_INCOMPLETE', 'steward token unavailable', cause);
    }
  }

  async function request(path, { method = 'POST', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/${path}`, {
        method,
        headers: {
          [TOKEN_HEADER]: token(),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return { kind: 'ambiguous', reason: 'malformed_response' };
      }
      if (!response.ok) {
        const error = value?.error;
        if (!error || typeof error.code !== 'string' || typeof error.retryable !== 'boolean') {
          return { kind: 'ambiguous', reason: 'malformed_response' };
        }
        return { kind: 'typed_error', status: response.status, error };
      }
      return { kind: 'ok', value };
    } catch (error) {
      return {
        kind: 'ambiguous',
        reason: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'transport_unknown',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function verifyIdentity(value) {
    for (const key of IDENTITY_KEYS) {
      if (value?.[key] !== expectedIdentity[key]) {
        throw compatError('COMPAT_ADAPTER_UPSTREAM_DRIFT', `steward identity mismatch: ${key}`);
      }
    }
  }

  async function verifyUpstreamVersion() {
    const result = await request('health', { method: 'GET' });
    if (result.kind !== 'ok' || result.value?.status !== 'ok' || result.value?.schema_version !== API_VERSION) {
      throw compatError('COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE', 'authenticated steward health unavailable');
    }
    verifyIdentity(result.value);
    return Object.freeze({ ...expectedIdentity });
  }

  function requireMethod(identifier, lifecycle = false) {
    const row = lifecycle ? resolveLifecycleMethod(identifier) : resolveGrowthMethod(identifier);
    if (!row || !isBound(row)) throw compatError('COMPAT_ADAPTER_METHOD_DENIED', 'steward method denied');
    return row;
  }

  function source(operation) {
    return {
      compat_protocol_id: COMPAT_PROTOCOL_ID,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_digest: operation.candidate_payload_digest,
      scope_envelope_digest: operation.scope_envelope_digest,
      sensitivity: operation.sensitivity,
      deletion_domain: operation.deletion_domain,
      adapter_policy_digest: operation.adapter_policy_digest,
    };
  }

  function params(row, operation, payloadBody, targetRefs) {
    switch (row.steward_method) {
      case 'append_experience':
        return { body: payloadBody };
      case 'append_association':
        return { body: payloadBody, endpoint_refs: [...(operation.endpoint_refs || [])] };
      case 'append_low_impact_preference_observation':
        return { body: payloadBody, non_current: true };
      case 'append_i_observation_candidate':
        return { body: payloadBody, candidate_only: true };
      case 'append_correction_or_supersession_observation':
        return { body: payloadBody, supersedes_target_ref: operation.supersedes_target_ref || operation.supersedes_ref };
      case 'suppress':
      case 'tombstone':
        return {
          target_ref: targetRefs?.[0],
          lifecycle_ref: operation.lifecycle_ref,
          expected_revision: operation.expected_revision,
        };
      case 'total_delete':
        return {
          target_ref: targetRefs?.[0],
          lifecycle_ref: operation.lifecycle_ref,
          expected_revision: operation.expected_revision,
          cascade_manifest_digest: operation.cascade_manifest_digest,
          source_deletion_receipt: null,
        };
      default:
        throw compatError('COMPAT_ADAPTER_METHOD_DENIED', 'steward method denied');
    }
  }

  function envelope({ row, operation, attempt, requestParams }) {
    return {
      schema_version: API_VERSION,
      method: row.steward_method,
      operation_key: operation.operation_key,
      idempotency_key: `${operation.operation_key}:${attempt.attempt_number}`,
      attempt: {
        attempt_id: attempt.attempt_id,
        attempt_number: attempt.attempt_number,
      },
      source: source(operation),
      params: requestParams,
      meta: {
        adapter_id: COMPAT_ADAPTER_ID,
        adapter_version: COMPAT_ADAPTER_VERSION,
        issued_at: new Date().toISOString(),
      },
    };
  }

  function prepare({ operation, attemptNumber, methodIdentifier, payloadBody, targetRefs, lifecycle }) {
    const row = requireMethod(methodIdentifier, lifecycle);
    const attempt = {
      attempt_id: `ocq_attempt_${String(operation.operation_id || '').replace(/[^a-f0-9]/g, '').slice(-24).padStart(24, '0')}`,
      attempt_number: attemptNumber,
    };
    const body = params(row, operation, payloadBody, targetRefs);
    const value = envelope({ row, operation, attempt, requestParams: body });
    return { methodRow: row, params: body, envelope: value, request_digest: canonicalDigest(value) };
  }

  function prepareGrowthRequest(input = {}) {
    return prepare({ ...input, lifecycle: false });
  }

  function prepareLifecycleRequest(input = {}) {
    return prepare({ ...input, lifecycle: true });
  }

  function strictReceipt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...RECEIPT_KEYS].sort())
      || value.schema_version !== RECEIPT_VERSION
      || value.api_version !== API_VERSION
      || !['succeeded', 'failed'].includes(value.outcome)
      || !['new', 'exact_replay'].includes(value.idempotency)) {
      throw compatError('COMPAT_RECEIPT_INVALID', 'steward receipt schema invalid');
    }
    verifyIdentity(value);
    return value;
  }

  function normalizedReceipt({ operation, attempt, prepared, value, outcome = null, errorCode = null, ambiguousReason = null }) {
    const strict = value ? strictReceipt(value) : null;
    const resultOutcome = outcome || (strict.outcome === 'succeeded' ? 'succeeded' : 'failed');
    return {
      receipt_id: newId('ocq_rcpt'),
      receipt_operation_key: operation.operation_key,
      receipt_attempt_id: attempt.attempt_id,
      outcome: resultOutcome,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_ref: operation.candidate_payload_ref,
      candidate_payload_digest: operation.candidate_payload_digest,
      projection_kind: prepared.methodRow.internal_method,
      projection_target: operation.projection_target,
      adapter_id: COMPAT_ADAPTER_ID,
      adapter_version: COMPAT_ADAPTER_VERSION,
      adapter_policy_digest: policyDigest,
      upstream_version: COMPAT_UPSTREAM_VERSION,
      request_digest: prepared.request_digest,
      target_projection_ref: strict?.target?.target_ref || null,
      target_revision_before: strict?.target?.revision_before ?? null,
      target_revision_after: strict?.target?.revision_after ?? null,
      upstream_evidence_ref: strict?.evidence_ref || null,
      response_digest: strict ? canonicalDigest(strict) : null,
      idempotency_disposition: strict?.idempotency || null,
      receipt_adapter_id: COMPAT_ADAPTER_ID,
      receipt_adapter_version: COMPAT_ADAPTER_VERSION,
      receipt_upstream_version: COMPAT_UPSTREAM_VERSION,
      issued_at: strict?.issued_at || new Date().toISOString(),
      issuer_id: strict?.issuer_id || 'ombre-brain-steward/1',
      ambiguous_reason_code: ambiguousReason,
      error_code: errorCode || strict?.error?.code || null,
    };
  }

  async function dispatch({ operation, attempt, prepared }) {
    await verifyUpstreamVersion();
    const value = {
      ...prepared.envelope,
      attempt: { attempt_id: attempt.attempt_id, attempt_number: attempt.attempt_number },
      idempotency_key: `${operation.operation_key}:${attempt.attempt_number}`,
    };
    const result = await request('mutate', { body: value });
    if (result.kind === 'ok') return normalizedReceipt({ operation, attempt, prepared, value: result.value });
    if (result.kind === 'typed_error') {
      const code = result.error.code === 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED'
        ? 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED'
        : result.error.code;
      return normalizedReceipt({ operation, attempt, prepared, outcome: 'failed', errorCode: code });
    }
    return normalizedReceipt({
      operation,
      attempt,
      prepared,
      outcome: 'ambiguous',
      ambiguousReason: result.reason,
    });
  }

  function invokeGrowth({ operation, attempt, methodIdentifier, payloadBody, prepared }) {
    return dispatch({
      operation,
      attempt,
      prepared: prepared || prepareGrowthRequest({
        operation, attemptNumber: attempt.attempt_number, methodIdentifier, payloadBody,
      }),
    });
  }

  function invokeLifecycle({ operation, attempt, methodIdentifier, targetRefs, prepared }) {
    return dispatch({
      operation,
      attempt,
      prepared: prepared || prepareLifecycleRequest({
        operation, attemptNumber: attempt.attempt_number, methodIdentifier, targetRefs,
      }),
    });
  }

  async function reconcile({ operation, attempt }) {
    await verifyUpstreamVersion();
    const row = resolveGrowthMethod(operation.candidate_kind) || resolveLifecycleMethod(operation.lifecycle_operation);
    if (!row) throw compatError('COMPAT_ADAPTER_METHOD_DENIED', 'reconcile method denied');
    const value = envelope({
      row: { steward_method: 'reconcile_operation' },
      operation,
      attempt,
      requestParams: { operation_key: operation.operation_key },
    });
    const result = await request('reconcile', { body: value });
    if (result.kind !== 'ok') return { disposition: 'unknown', evidence_refs: [], evidence_digest: null };
    const receipt = strictReceipt(result.value);
    return {
      disposition: receipt.outcome === 'succeeded' ? 'observed_applied' : 'observed_not_applied',
      target_projection_ref: receipt.target?.target_ref || null,
      target_revision_before: receipt.target?.revision_before ?? null,
      target_revision_after: receipt.target?.revision_after ?? null,
      upstream_evidence_ref: receipt.evidence_ref,
      evidence_refs: receipt.evidence_ref ? [receipt.evidence_ref] : [],
      evidence_digest: canonicalDigest(receipt),
    };
  }

  return Object.freeze({
    endpoint,
    policyDigest,
    expectedIdentity,
    verifyUpstreamVersion,
    prepareGrowthRequest,
    prepareLifecycleRequest,
    invokeGrowth,
    invokeLifecycle,
    reconcile,
  });
}
