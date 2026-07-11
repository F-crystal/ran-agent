import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBridgeExternalMcpOperationCapability,
  createExternalMcpOperationReceipt,
  digestExternalMcpOperationValue,
  getExternalMcpOperationAuthorization,
  isTrustedExternalMcpOperationCapability,
  verifyExternalMcpOperationReceipt,
} from '../src/externalMcp/operationReceipt.mjs';


const NOW = new Date('2026-07-10T10:00:00.000Z');


function capabilityInput(overrides = {}) {
  const scope = { serverId: 'generic-forum', resourceId: 'thread-42', parameters: { board: 'general' } };
  const risk = { envelopeId: 'owner-read-v1', allowedEffects: ['read'], boundaryGrants: [] };
  const args = { query: 'release notes' };
  return {
    operationId: 'operation-1',
    actorKey: 'actor-1',
    globalUserId: 'user:owner',
    serverId: 'generic-forum',
    toolName: 'forum.search',
    sessionId: 'extmcp_session_1',
    activityId: 'activity-1',
    actionId: 'action-1',
    activityRevision: 7,
    leaseOwner: 'runner-1',
    effect: 'read',
    profile: 'full',
    trigger: 'activity',
    watchScope: 'forum:general',
    preferredTransport: 'gateway',
    scope,
    risk,
    arguments: args,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}


test('bridge capability and operation receipt lose trust when copied through model JSON', () => {
  const scopedGrant = { grantId: 'grant-1' };
  const capability = createBridgeExternalMcpOperationCapability(capabilityInput({ scopedGrant }));

  assert.equal(isTrustedExternalMcpOperationCapability(capability, { now: NOW }), true);
  assert.equal(getExternalMcpOperationAuthorization(capability).scopedGrant, scopedGrant);
  assert.equal(isTrustedExternalMcpOperationCapability(JSON.parse(JSON.stringify(capability)), { now: NOW }), false);

  const receipt = createExternalMcpOperationReceipt(capability, {
    outcome: 'applied',
    transport: 'gateway',
    evidenceRef: 'external_mcp_evidence:abc123',
    result: { content: [{ type: 'text', text: 'done' }] },
    now: NOW,
  });
  assert.equal(verifyExternalMcpOperationReceipt(receipt, { capability, now: NOW }).ok, true);
  assert.equal(verifyExternalMcpOperationReceipt(JSON.parse(JSON.stringify(receipt)), { capability, now: NOW }).ok, false);
});


test('receipt is exact-bound and is not minted for mismatched operation context', () => {
  const capability = createBridgeExternalMcpOperationCapability(capabilityInput());
  assert.equal(capability.scopeDigest, digestExternalMcpOperationValue(capabilityInput().scope));
  assert.equal(capability.riskDigest, digestExternalMcpOperationValue(capabilityInput().risk));

  assert.throws(() => createExternalMcpOperationReceipt(capability, {
    operationId: 'operation-other',
    outcome: 'applied',
    transport: 'direct',
    evidenceRef: 'external_mcp_evidence:abc123',
    result: { ok: true },
    now: NOW,
  }), /operation context mismatch/);

  const receipt = createExternalMcpOperationReceipt(capability, {
    outcome: 'applied',
    transport: 'direct',
    evidenceRef: 'external_mcp_evidence:abc123',
    result: { ok: true },
    now: NOW,
  });
  assert.equal(verifyExternalMcpOperationReceipt(receipt, {
    capability,
    evidenceRef: 'external_mcp_evidence:different',
    now: NOW,
  }).reason, 'receipt_binding_mismatch');
});
