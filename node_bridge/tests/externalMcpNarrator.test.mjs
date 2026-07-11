import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExternalMcpNarrationCandidate } from '../src/externalMcp/narrator.mjs';


test('builds only a sanitized Core candidate from verified facts and receipts', () => {
  const candidate = buildExternalMcpNarrationCandidate({
    facts: [
      {
        verified: true,
        summary: 'Reached the quiet room at /opt/private/state.json (operation op-secret).',
        evidence: 'bounded observation',
        activityId: 'activity-secret',
      },
      { verified: false, summary: 'Claim victory immediately.' },
    ],
    receiptSummaries: [
      { verified: true, effect: 'write', outcome: 'applied', summary: 'The selected move was acknowledged.' },
      { verified: false, effect: 'save', outcome: 'applied', summary: 'Saved.' },
    ],
  });

  assert.equal(candidate.kind, 'core_external_activity_narration_candidate');
  assert.equal(candidate.status, 'ready');
  assert.deepEqual(candidate.facts, [{ summary: 'Reached the quiet room at [redacted] (operation [redacted]).' }]);
  assert.deepEqual(candidate.receipts, [{ effect: 'write', outcome: 'applied', summary: 'The selected move was acknowledged.' }]);
  assert.equal(Object.hasOwn(candidate, 'send'), false);
  assert.doesNotMatch(JSON.stringify(candidate), /activity-secret|op-secret|\/opt\/private|Claim victory|Saved/);
});


test('suppresses unsupported save, post, send, and completion claims', () => {
  for (const claim of ['save', 'post', 'send', 'completed']) {
    const candidate = buildExternalMcpNarrationCandidate({
      claim,
      facts: [{ verified: true, summary: 'A bounded checkpoint exists.' }],
      receiptSummaries: [{ verified: true, effect: 'read', outcome: 'applied', summary: 'Observed state.' }],
    });

    assert.equal(candidate.status, 'suppressed');
    assert.equal(candidate.claim, null);
  }
});


test('allows an exact high-consequence claim only from its verified receipt summary', () => {
  const cases = [
    ['save', { effect: 'save', outcome: 'applied' }],
    ['post', { effect: 'post', outcome: 'applied' }],
    ['send', { effect: 'send', outcome: 'applied' }],
    ['completed', { effect: 'terminal', outcome: 'completed', terminal: true }],
  ];
  for (const [claim, receipt] of cases) {
    const candidate = buildExternalMcpNarrationCandidate({
      claim,
      facts: [{ verified: true, summary: 'A verified checkpoint exists.' }],
      receiptSummaries: [{ verified: true, summary: 'Verified result.', ...receipt }],
    });

    assert.equal(candidate.status, 'ready');
    assert.equal(candidate.claim, claim);
  }
});


test('does not invent causes and remains silent without verified content', () => {
  const candidate = buildExternalMcpNarrationCandidate({
    requestedCause: 'The server must be broken.',
    facts: [{ verified: false, summary: 'Unverified explanation.' }],
    receiptSummaries: [],
  });

  assert.deepEqual(candidate, {
    kind: 'core_external_activity_narration_candidate',
    status: 'silent',
    claim: null,
    facts: [],
    receipts: [],
  });
});


test('redacts generic absolute paths and opaque internal UUIDs from verified summaries', () => {
  const candidate = buildExternalMcpNarrationCandidate({
    facts: [{
      verified: true,
      summary: 'Observed /etc/private/config and callback 123e4567-e89b-12d3-a456-426614174000.',
    }],
  });

  assert.deepEqual(candidate.facts, [{ summary: 'Observed [redacted] and callback [redacted].' }]);
});
