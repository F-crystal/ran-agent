import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { adapterPolicyDigest } from '../src/ombreCompat/adapterPolicy.mjs';
import { getOmbreCompatConfig } from '../src/ombreCompat/config.mjs';
import { COMPAT_UPSTREAM_VERSION } from '../src/ombreCompat/constants.mjs';
import { readForMode } from '../src/ombreCompat/projectionRefresh.mjs';
import { createOmbreCompatRuntime } from '../src/ombreCompat/runtime.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-runtime-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

async function stack(t, overrides = {}) {
  const dir = root(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(() => upstream.close());
  const identityFile = path.join(dir, 'identity.json');
  fs.writeFileSync(identityFile, `${JSON.stringify(upstream.identity)}\n`, { mode: 0o600 });
  const env = {
    NODE_ENV: 'test',
    RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
    RAN_AGENT_STATE_DIR: dir,
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(dir, 'global-timeline.jsonl'),
    RAN_AGENT_TIMELINE_ARCHIVE_DIR: path.join(dir, 'timeline-archive'),
    RAN_AGENT_TIMELINE_COMPACT_ENABLED: 'false',
    OMBRE_COMPAT_ENABLED: 'true',
    OMBRE_COMPAT_TEST_MODE: 'true',
    OMBRE_COMPAT_STATE_DIR: path.join(dir, 'ombre-compat'),
    OMBRE_COMPAT_STEWARD_ENDPOINT: upstream.stewardUrl(),
    RAN_AGENT_STEWARD_TOKEN_FILE: upstream.tokenFile,
    OMBRE_COMPAT_STEWARD_IDENTITY_FILE: identityFile,
    OMBRE_COMPAT_CURATOR_BASE_URL: 'http://127.0.0.1:9/unused',
    OMBRE_COMPAT_CURATOR_MODEL: 'fixture-curator',
    OMBRE_COMPAT_REVIEWER_BASE_URL: 'http://127.0.0.1:9/unused',
    OMBRE_COMPAT_REVIEWER_MODEL: 'fixture-reviewer',
    ...overrides,
  };
  const outbox = createDurableOutbox({
    env,
    path: path.join(dir, 'durable-outbox.json'),
  });
  const runtime = await createOmbreCompatRuntime({
    env,
    outbox,
    curatorImpl: curatorResult('runtime truth', 'I retained only the presented final turn.'),
    reviewerImpl: async () => JSON.stringify({
      decision: 'accept',
      reason_code: 'grounded',
      claim_manifest: { claims: [] },
    }),
  });
  env.ombreCompatRuntime = runtime;
  return { dir, env, outbox, runtime, upstream };
}

test('formal composition reserves truth, records terminal presentation, then publishes', async (t) => {
  const { env, outbox, runtime, upstream } = await stack(t);
  t.after(() => runtime.stop());
  const response = await handleIncomingMessage({
    id: 'exchange-live-1',
    platform: 'desktop',
    channel_type: 'desktop',
    conversation_id: 'conversation-live-1',
    sender_id: 'ran',
    text: 'keep this only after delivery',
    created_at: Date.now(),
  }, {
    env,
    outbox,
    replyBackend: {
      getReply: async () => ({
        replyText: 'final visible result fixed',
        source: 'fixture',
        suppressSend: false,
      }),
    },
    adapter: {
      sendReply: async () => ({
        textStatus: 'sent',
        attachments: [],
        knownFailure: false,
        adapterReceiptRef: 'desktop:sent',
      }),
    },
  });
  assert.equal(response.replyText, 'final visible result fixed');

  const source = runtime.store.exportView().sources[0];
  assert.deepEqual(source.revisions.map((entry) => entry.presentation_state), [
    'not_presented',
    'presented',
  ]);
  assert.ok(source.revisions[1].delivery_observation_ref.startsWith('durable-outbox-terminal:'));
  assert.equal(runtime.store.listItems()[0].queue_item_state, 'published');
  assert.equal(upstream.callCount.mutate_applied, 1);

  const growth = runtime.store.listOperations().find((operation) => operation.candidate_kind === 'append_experience');
  const deletion = await runtime.compatibilityDelete({
    eventId: source.event_id,
    deletionRef: 'compatibility-delete://runtime/1',
    lifecycleRevision: 1,
  });
  assert.equal(deletion.status, 'compatibility_deleted');
  assert.equal(runtime.payloadStore.has(growth.candidate_payload_ref), false);
  const config = getOmbreCompatConfig(env);
  const reads = ['lite', 'full'].map((mode) => readForMode({
    projectionDir: config.projectionDir,
    mode,
    expectedAdapterPolicyDigest: adapterPolicyDigest(),
    expectedUpstreamVersion: COMPAT_UPSTREAM_VERSION,
  }));
  assert.equal(reads[0].projection_revision, reads[1].projection_revision);
  for (const read of reads) {
    const projected = read.snapshot.items.find((item) => item.target_ref === growth.projection_target_ref);
    assert.equal(projected.lifecycle_state, 'tombstoned');
    assert.equal(projected.payload_ref, null);
  }
});

test('startup catch-up binds a missed sent receipt exactly once', async (t) => {
  const first = await stack(t);
  const { env, outbox, upstream } = first;
  const message = {
    id: 'exchange-catchup-1',
    platform: 'desktop',
    channel_type: 'desktop',
    conversation_id: 'conversation-catchup-1',
    sender_id: 'ran',
    text: 'catch up this source',
    created_at: Date.now(),
  };
  // Let channel append the unique user event and reserve the source, but keep
  // the terminal callback disconnected to simulate a crash after sent commit.
  env.ombreCompatRuntime = {
    ...first.runtime,
    observeTerminal: async () => null,
  };
  await handleIncomingMessage(message, {
    env,
    outbox,
    replyBackend: {
      getReply: async () => ({ replyText: 'sent before crash', source: 'fixture', suppressSend: false }),
    },
    adapter: {
      sendReply: async () => ({
        textStatus: 'sent',
        attachments: [],
        knownFailure: false,
        adapterReceiptRef: 'desktop:sent-before-crash',
      }),
    },
  });
  assert.deepEqual(first.runtime.store.exportView().sources[0].revisions.map(
    (entry) => entry.presentation_state,
  ), ['not_presented']);
  await first.runtime.stop();

  const identityFile = env.OMBRE_COMPAT_STEWARD_IDENTITY_FILE;
  const restarted = await createOmbreCompatRuntime({
    env: { ...env, ombreCompatRuntime: undefined },
    outbox,
    curatorImpl: curatorResult('catch-up', 'I recovered a sent terminal observation.'),
    reviewerImpl: async () => JSON.stringify({
      decision: 'accept',
      reason_code: 'grounded',
      claim_manifest: { claims: [] },
    }),
  });
  t.after(() => restarted.stop());
  assert.ok(fs.existsSync(identityFile));
  assert.deepEqual(restarted.store.exportView().sources[0].revisions.map(
    (entry) => entry.presentation_state,
  ), ['not_presented', 'presented']);
  assert.equal(restarted.store.listItems()[0].queue_item_state, 'published');
  assert.equal(upstream.callCount.mutate_applied, 1);
  assert.equal((await restarted.catchUp()).length, 0);
});

function curatorResult(title, text) {
  return async (request) => {
    const envelope = JSON.parse(request.body.messages[1].content);
    return JSON.stringify({
      candidates: [{
        candidate_kind: 'append_experience',
        title,
        first_person_text: text,
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
  };
}

test('enabled false has zero filesystem and upstream side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-disabled-'));
  try {
    const runtime = await createOmbreCompatRuntime({
      env: {
        NODE_ENV: 'test',
        RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
        RAN_AGENT_STATE_DIR: dir,
        OMBRE_COMPAT_ENABLED: 'false',
      },
      outbox: {},
    });
    assert.equal(runtime.active, false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('active runtime fails before identity or state creation when a real model stage lacks its key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-config-incomplete-'));
  try {
    await assert.rejects(createOmbreCompatRuntime({
      env: {
        NODE_ENV: 'test',
        RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
        RAN_AGENT_STATE_DIR: dir,
        OMBRE_COMPAT_ENABLED: 'true',
        OMBRE_COMPAT_TEST_MODE: 'true',
        HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
      },
      outbox: {
        get() { return null; },
        getTerminalReceipt() { return null; },
      },
    }), (error) => {
      assert.equal(error?.code, 'COMPAT_CONFIG_INCOMPLETE');
      assert.match(error?.message || '', /curator apiKey is required/);
      return true;
    });
    await assert.rejects(createOmbreCompatRuntime({
      env: {
        NODE_ENV: 'test',
        RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
        RAN_AGENT_STATE_DIR: dir,
        OMBRE_COMPAT_ENABLED: 'true',
        OMBRE_COMPAT_TEST_MODE: 'true',
        HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
      },
      outbox: {
        get() { return null; },
        getTerminalReceipt() { return null; },
      },
      curatorImpl: async () => '{"candidates":[]}',
    }), (error) => {
      assert.equal(error?.code, 'COMPAT_CONFIG_INCOMPLETE');
      assert.match(error?.message || '', /reviewer apiKey is required/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
