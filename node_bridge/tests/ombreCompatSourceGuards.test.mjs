import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { createOmbreCompatRuntime } from '../src/ombreCompat/runtime.mjs';
import { validateFinalTurnSourceEvent } from '../src/ombreCompat/sourceEvent.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

const ORACLES = [
  ['SR1', 'C1'],
  ['SR2', 'C2'],
  ['SR3', 'C3'],
  ['SR4', 'C4'],
  ['SR5', 'C5'],
  ['SR6', 'C6', 'drop'],
  ['SR7', 'C7'],
];

for (const [oracle, checkpoint, upstreamMode = 'normal'] of ORACLES) {
  test(`${oracle} / ${checkpoint} re-reads all source guards and stops downstream work`, async (t) => {
    const fixture = await guardedFixture(t, { checkpoint, upstreamMode });
    await fixture.send();
    assert.equal(lastOutcome(fixture.runtime), 'COMPAT_STALE_SOURCE_REVISION');
    assertCounters(fixture, checkpoint);
    if (checkpoint === 'C5') {
      const attempt = fixture.runtime.store.listAttempts()[0];
      assert.equal(attempt.adapter_attempt_state, 'superseded-by-source-revision');
      assert.equal(attempt.attempt_retryable, false);
      assert.equal(attempt.failed_at, null);
    }
  });
}

test('RACE-C4-CAS rejects a source advance after C4 guard but before intent append', async (t) => {
  const fixture = await guardedFixture(t, { checkpoint: 'C4', injectAfter: true });
  await fixture.send();
  assert.equal(lastOutcome(fixture.runtime), 'COMPAT_STALE_SOURCE_REVISION');
  assert.equal(countEvents(fixture.runtime, 'dispatch_intent_committed'), 0);
  assert.equal(fixture.upstream.callCount.mutate, 0);
});

async function guardedFixture(t, { checkpoint, injectAfter = false, upstreamMode = 'normal' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-source-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  upstream.setMode(upstreamMode);
  t.after(() => upstream.close());
  const identityFile = path.join(dir, 'identity.json');
  fs.writeFileSync(identityFile, `${JSON.stringify(upstream.identity)}\n`, { mode: 0o600 });
  const env = {
    NODE_ENV: 'test',
    RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
    RAN_AGENT_STATE_DIR: dir,
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(dir, 'timeline.jsonl'),
    RAN_AGENT_TIMELINE_ARCHIVE_DIR: path.join(dir, 'timeline-archive'),
    RAN_AGENT_TIMELINE_COMPACT_ENABLED: 'false',
    OMBRE_COMPAT_ENABLED: 'true',
    OMBRE_COMPAT_TEST_MODE: 'true',
    OMBRE_COMPAT_STATE_DIR: path.join(dir, 'ombre-compat'),
    OMBRE_COMPAT_STEWARD_ENDPOINT: upstream.stewardUrl(),
    RAN_AGENT_STEWARD_TOKEN_FILE: upstream.tokenFile,
    OMBRE_COMPAT_STEWARD_IDENTITY_FILE: identityFile,
    OMBRE_COMPAT_DISPATCH_TIMEOUT_MS: '1000',
    OMBRE_COMPAT_CURATOR_BASE_URL: 'http://127.0.0.1:9/unused',
    OMBRE_COMPAT_CURATOR_MODEL: 'guard-curator',
    OMBRE_COMPAT_REVIEWER_BASE_URL: 'http://127.0.0.1:9/unused',
    OMBRE_COMPAT_REVIEWER_MODEL: 'guard-reviewer',
  };
  const outbox = createDurableOutbox({ env, path: path.join(dir, 'outbox.json') });
  let runtime;
  let injected = false;
  const inject = async ({ checkpoint: at }) => {
    if (injected || at !== checkpoint) return;
    injected = true;
    advanceSource(runtime.store);
  };
  runtime = await createOmbreCompatRuntime({
    env,
    outbox,
    beforeCheckpoint: injectAfter ? undefined : inject,
    afterCheckpoint: injectAfter ? inject : undefined,
    curatorImpl: async (request) => {
      const envelope = JSON.parse(request.body.messages[1].content);
      return JSON.stringify({
        candidates: [{
          candidate_kind: 'append_experience',
          title: 'source guard',
          first_person_text: 'I must never cross a source revision.',
          source_refs: [
            envelope.source_event.user_final_payload_ref,
            envelope.source_event.assistant_final_payload_ref,
          ],
          scope_envelope_digest: envelope.source_event.scope_envelope_digest,
          sensitivity: envelope.source_event.sensitivity,
          counterevidence: 'none observed',
          uncertainty: 'low',
        }],
      });
    },
    reviewerImpl: async () => JSON.stringify({
      decision: 'accept',
      reason_code: 'grounded',
      claim_manifest: { claims: [] },
    }),
  });
  env.ombreCompatRuntime = runtime;
  t.after(() => runtime.stop());
  return {
    env,
    outbox,
    runtime,
    upstream,
    async send() {
      await handleIncomingMessage({
        id: `exchange-${checkpoint}-${injectAfter ? 'race' : 'sr'}`,
        platform: 'desktop',
        channel_type: 'desktop',
        conversation_id: `conversation-${checkpoint}`,
        sender_id: 'ran',
        text: 'source revision guard input',
        created_at: Date.now(),
      }, {
        env,
        outbox,
        replyBackend: {
          getReply: async () => ({
            replyText: 'source revision guard visible result',
            source: 'fixture',
            suppressSend: false,
          }),
        },
        adapter: {
          sendReply: async () => ({
            textStatus: 'sent',
            attachments: [],
            knownFailure: false,
            adapterReceiptRef: 'desktop:guard-sent',
          }),
        },
      });
    },
  };
}

function advanceSource(store) {
  const source = store.exportView().sources[0];
  const current = source.revisions.find((entry) => entry.source_revision === source.current_revision);
  store.ingressSourceEvent(validateFinalTurnSourceEvent({
    ...current,
    source_revision: current.source_revision + 1,
    emitted_at: new Date(Date.parse(current.emitted_at) + 1).toISOString(),
    source_event_digest: undefined,
  }));
}

function assertCounters(fixture, checkpoint) {
  const order = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
  const at = order.indexOf(checkpoint);
  const counts = [
    fixture.runtime.store.listEvents({ type: 'curator_started' }).length,
    fixture.runtime.store.listEvents({ type: 'reviewer_started' }).length,
    countEvents(fixture.runtime, 'gate_evaluated'),
    countEvents(fixture.runtime, 'dispatch_intent_committed'),
    fixture.upstream.callCount.mutate,
    fixture.upstream.callCount.reconcile,
    countEvents(fixture.runtime, 'snapshot_recorded'),
  ];
  for (let index = at; index < counts.length; index += 1) {
    assert.equal(counts[index], 0, `${order[index]} downstream count`);
  }
}

function countEvents(runtime, type) {
  return runtime.store.listEvents({ type }).length;
}

function lastOutcome(runtime) {
  return runtime.diagnostics().latest_drain_reports.at(-1)?.outcome;
}
