import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeReplyEnvelope } from '../src/replyEnvelope.mjs';

test('normalizes the legacy gateway reply into one versioned private envelope', () => {
  const envelope = normalizeReplyEnvelope({
    reply_text: '第一段',
    follow_up_messages: ['第二段', '  '],
    action_requests: [{
      requestRef: 'save-1',
      actionType: 'memory.remember',
      scope: { subject_key: 'reply:tone' },
    }],
    claims: [{ type: 'memory_saved', requestRef: 'save-1' }],
    commitments: [],
  });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.message, '第一段\n\n第二段');
  assert.equal(envelope.actionRequests.length, 1);
  assert.equal(envelope.actionRequests[0].requestRef, 'save-1');
  assert.deepEqual(envelope.claims, [{ type: 'memory_saved', requestRef: 'save-1' }]);
  assert.equal(Object.isFrozen(envelope), true);
});

test('rejects an explicit malformed or versionless envelope', () => {
  assert.throws(
    () => normalizeReplyEnvelope({ reply_envelope: { message: 'hello' } }),
    { code: 'REPLY_ENVELOPE_VERSION_REQUIRED' },
  );
  assert.throws(
    () => normalizeReplyEnvelope({ reply_envelope: { schemaVersion: 2, message: 'hello' } }),
    { code: 'REPLY_ENVELOPE_VERSION_UNSUPPORTED' },
  );
  assert.throws(
    () => normalizeReplyEnvelope({ reply_text: 'hello', claims: [{ type: 'ok', extra: true }] }),
    { code: 'REPLY_ENVELOPE_INVALID' },
  );
});

test('rejects model-supplied private action authority through the envelope', () => {
  assert.throws(
    () => normalizeReplyEnvelope({
      reply_text: 'saved',
      action_requests: [{
        requestRef: 'save-1',
        actionType: 'memory.remember',
        scope: {},
        receipt: { status: 'applied' },
      }],
    }),
    { code: 'ACTION_REQUEST_PRIVATE_FIELD' },
  );
});

test('rejects duplicate local action request references', () => {
  const request = { requestRef: 'same', actionType: 'memory.remember', scope: {} };
  assert.throws(
    () => normalizeReplyEnvelope({ reply_text: 'saved', action_requests: [request, request] }),
    { code: 'REPLY_ENVELOPE_INVALID' },
  );
});
