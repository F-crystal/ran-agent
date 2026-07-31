import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../../src/ombreCompat/canonical.mjs';
import { OMBRE_UPSTREAM_COMMIT } from '../../src/ombreRecallPolicy.mjs';

const IDENTITY = Object.freeze({
  base_upstream_commit: OMBRE_UPSTREAM_COMMIT,
  patch_manifest_sha256: `sha256:${'1'.repeat(64)}`,
  api_schema_sha256: `sha256:${'2'.repeat(64)}`,
  effective_source_tree_sha256: `sha256:${'3'.repeat(64)}`,
});
const MODES = new Set([
  'normal', 'drop', 'drop_before_apply', 'garbage', 'health_garbage',
  'conflict', 'drift', 'error',
]);

export function createFakeUpstreamOmbre() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-steward-'));
  const tokenFile = path.join(root, 'steward-api-token');
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const operations = new Map();
  const targets = new Map();
  const requests = [];
  const sockets = new Set();
  let mode = 'normal';
  let revision = 0;
  let sequence = 0;
  const callCount = {
    total: 0,
    mutate: 0,
    mutate_applied: 0,
    reconcile: 0,
    health: 0,
    hold: 0,
    hold_applied: 0,
    breath_search: 0,
    release: 0,
    release_applied: 0,
    conflict: 0,
  };

  const server = http.createServer((request, response) => {
    if (!request.socket.localAddress?.includes('127.0.0.1')
      && request.socket.localAddress !== '::1') return response.writeHead(403).end();
    if (request.headers['x-ran-agent-steward-token'] !== token) {
      return json(response, 401, typedError('STEWARD_AUTH_INVALID', false));
    }
    const base = '/internal/ran-agent/steward/v1/';
    if (request.method === 'GET' && request.url === `${base}health`) {
      callCount.health += 1;
      if (mode === 'health_garbage') return response.writeHead(200).end('not-json');
      return json(response, 200, {
        schema_version: 'ombre.steward-api/1',
        status: 'ok',
        ...(mode === 'drift' ? { ...IDENTITY, base_upstream_commit: 'f'.repeat(40) } : IDENTITY),
      });
    }
    if (request.method !== 'POST'
      || ![`${base}mutate`, `${base}reconcile`].includes(request.url)) {
      return json(response, 404, typedError('STEWARD_METHOD_UNKNOWN', false));
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (mode === 'garbage') return response.writeHead(200).end('not-json');
      let envelope;
      try { envelope = JSON.parse(body); } catch { return json(response, 400, typedError('STEWARD_SCHEMA_INVALID', false)); }
      requests.push(structuredClone(envelope));
      if (request.url === `${base}reconcile`) return reconcile(response, envelope);
      if (mode === 'drop_before_apply') return;
      if (mode === 'drop') {
        mutate({ writeHead() { return this; }, end() {} }, envelope);
        return;
      }
      return mutate(response, envelope);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function mutate(response, envelope) {
    callCount.total += 1;
    callCount.mutate += 1;
    if (mode === 'error') return json(response, 422, typedError('STEWARD_PAYLOAD_REJECTED', false));
    if (envelope?.method === 'total_delete') {
      return json(response, 501, typedError('STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED', false));
    }
    if (![
      'append_experience',
      'append_association',
      'append_low_impact_preference_observation',
      'append_i_observation_candidate',
      'append_correction_or_supersession_observation',
      'suppress',
      'tombstone',
    ].includes(envelope?.method)) return json(response, 400, typedError('STEWARD_SCHEMA_INVALID', false));
    if (mode === 'conflict') {
      callCount.conflict += 1;
      return json(response, 409, typedError('STEWARD_IDEMPOTENCY_CONFLICT', false));
    }
    const digest = canonicalDigest(envelope);
    const existing = operations.get(envelope.idempotency_key);
    if (existing) {
      if (existing.digest !== digest) return json(response, 409, typedError('STEWARD_IDEMPOTENCY_CONFLICT', false));
      return json(response, 200, { ...existing.receipt, idempotency: 'exact_replay' });
    }
    sequence += 1;
    revision += 1;
    const layer = envelope.method.replace(/^append_/, '').replaceAll('_', '-');
    const targetRef = envelope.params.target_ref
      || `ombre-steward://target/${layer}/target_${sequence}`;
    const receipt = makeReceipt(envelope, {
      target_ref: targetRef,
      revision_before: revision - 1,
      revision_after: revision,
    });
    operations.set(envelope.idempotency_key, { digest, receipt });
    targets.set(targetRef, { revision, lifecycle_state: envelope.method });
    callCount.mutate_applied += 1;
    if (envelope.method.startsWith('append_')) {
      callCount.hold += 1;
      callCount.hold_applied += 1;
    } else {
      callCount.release += 1;
      callCount.release_applied += 1;
    }
    return json(response, 200, receipt);
  }

  function reconcile(response, envelope) {
    callCount.reconcile += 1;
    callCount.breath_search += 1;
    const found = [...operations.values()].find(
      (entry) => entry.receipt.operation_key === envelope?.params?.operation_key,
    );
    if (!found) return json(response, 200, makeReceipt(envelope, null, 'failed'));
    return json(response, 200, { ...found.receipt, idempotency: 'exact_replay' });
  }

  function makeReceipt(envelope, target, outcome = 'succeeded') {
    return {
      schema_version: 'ombre.steward-receipt/1',
      ok: outcome === 'succeeded',
      outcome,
      error: outcome === 'failed' ? { code: 'STEWARD_NOT_APPLIED', retryable: true } : null,
      idempotency: 'new',
      operation_key: envelope.operation_key,
      idempotency_key: envelope.idempotency_key,
      attempt: envelope.attempt,
      source: envelope.source,
      target,
      evidence_ref: target ? `steward-evidence:${sequence}` : null,
      api_version: 'ombre.steward-api/1',
      ...IDENTITY,
      issued_at: '2026-07-30T00:00:00.000Z',
      issuer_id: 'ombre-brain-steward/1',
    };
  }

  return {
    server,
    callCount,
    requests,
    identity: IDENTITY,
    tokenFile,
    setMode(next) {
      if (!MODES.has(next)) throw new Error(`unknown fake upstream mode: ${next}`);
      mode = next;
    },
    getMode: () => mode,
    inspectTarget: (ref) => targets.get(ref) || null,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    }),
    port: () => server.address()?.port || 0,
    stewardUrl() {
      return `http://127.0.0.1:${server.address()?.port || 0}/internal/ran-agent/steward/v1`;
    },
    adapterOptions() {
      return {
        endpoint: this.stewardUrl(),
        tokenFile,
        baseUpstreamCommit: IDENTITY.base_upstream_commit,
        patchManifestSha256: IDENTITY.patch_manifest_sha256,
        apiSchemaSha256: IDENTITY.api_schema_sha256,
        effectiveSourceTreeSha256: IDENTITY.effective_source_tree_sha256,
      };
    },
    mcpUrl() { return this.stewardUrl(); },
    healthUrl() { return `${this.stewardUrl()}/health`; },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => {
        fs.rmSync(root, { recursive: true, force: true });
        resolve();
      }));
    },
  };
}

function typedError(code, retryable) {
  return { error: { code, retryable } };
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
