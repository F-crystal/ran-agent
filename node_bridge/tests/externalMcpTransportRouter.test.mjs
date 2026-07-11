import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalMcpTransportRouter } from '../src/externalMcp/transportRouter.mjs';


function executionInput(overrides = {}) {
  return {
    effect: 'read',
    operationId: 'operation-1',
    manifest: {
      id: 'provider-neutral-server',
      url: 'https://mcp.example.test/rpc',
      transport: 'streamable-http',
    },
    tool: { name: 'resource.read', tier: 'T1' },
    arguments: { resourceId: 'resource-1' },
    session: {
      sessionId: 'extmcp_session_1',
      upstreamSessionId: 'upstream-that-must-not-trigger-hidden-replay',
      globalUserId: 'user:owner',
    },
    scopeDigest: 'scope-digest',
    riskDigest: 'risk-digest',
    evidenceContext: { watchScope: 'resource:1', tier: 'T1' },
    preferredTransport: 'gateway',
    ...overrides,
  };
}


test('known failed read retries once through the alternate route with one exact operation envelope', async () => {
  const calls = [];
  const router = createExternalMcpTransportRouter({
    gatewayCall: async (request) => {
      calls.push({ route: 'gateway', request });
      return { ok: false, error: 'gateway unavailable', error_code: 'EXTERNAL_MCP_TRANSPORT_FAILED' };
    },
    directCall: async (request) => {
      calls.push({ route: 'direct', request });
      return { ok: true, result: { value: 42 }, upstreamSessionId: 'upstream-new' };
    },
  });

  const result = await router.execute(executionInput());

  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((item) => item.route), ['gateway', 'direct']);
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].request, calls[1].request);
  assert.equal(calls[0].request.operationId, 'operation-1');
  assert.equal(calls[0].request.scopeDigest, 'scope-digest');
  assert.equal(calls[0].request.riskDigest, 'risk-digest');
  assert.deepEqual(calls[0].request.evidenceContext, { watchScope: 'resource:1', tier: 'T1' });
  assert.equal(calls[0].request.upstreamSessionId, '');
});


test('read retry is bounded to two explicit attempts', async () => {
  let calls = 0;
  const fail = async () => {
    calls += 1;
    return { ok: false, error: 'still unavailable', error_code: 'EXTERNAL_MCP_TRANSPORT_FAILED' };
  };
  const result = await createExternalMcpTransportRouter({ gatewayCall: fail, directCall: fail })
    .execute(executionInput());

  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 2);
});


test('remote read rejection is terminal and does not select an alternate route', async () => {
  let directCalls = 0;
  const result = await createExternalMcpTransportRouter({
    gatewayCall: async () => ({ ok: false, outcome: 'not_applied', error_code: 'REMOTE_REJECTED' }),
    directCall: async () => { directCalls += 1; return { ok: true, result: { shouldNotRun: true } }; },
  }).execute(executionInput());

  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(directCalls, 0);
});


test('effectful timeout or session loss is never replayed on another route', async () => {
  for (const errorCode of ['EXTERNAL_MCP_ABORTED', 'EXTERNAL_MCP_SESSION_LOST']) {
    let gatewayCalls = 0;
    let directCalls = 0;
    const router = createExternalMcpTransportRouter({
      gatewayCall: async () => {
        gatewayCalls += 1;
        return { ok: false, error: 'ambiguous effect', error_code: errorCode };
      },
      directCall: async () => {
        directCalls += 1;
        return { ok: true, result: { shouldNotRun: true } };
      },
    });

    const result = await router.execute(executionInput({ effect: 'effect' }));

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.needsReconciliation, true);
    assert.equal(gatewayCalls, 1);
    assert.equal(directCalls, 0);
    assert.equal(result.attempts.length, 1);
  }
});


test('only an explicit not_applied effect result is retryable after reconciliation', async () => {
  const router = createExternalMcpTransportRouter({
    gatewayCall: async () => ({ ok: false, outcome: 'not_applied', error_code: 'REMOTE_REJECTED' }),
    directCall: async () => ({ ok: true, result: { shouldNotRun: true } }),
  });

  const result = await router.execute(executionInput({ effect: 'effect' }));
  assert.equal(result.outcome, 'not_applied');
  assert.equal(result.retryAllowed, true);
  assert.equal(result.attempts.length, 1);
});
