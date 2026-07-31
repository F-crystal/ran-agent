import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { createCompatPayloadStore } from '../src/ombreCompat/payloadStore.mjs';

const CLOCK = () => new Date('2026-07-30T00:00:00.000Z');

function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-registry-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  return { state, payloads: path.join(state, 'payloads') };
}

function put(store, owner = 'ocq_item_owner') {
  return store.put({
    kind: 'append_experience',
    body: 'only canonical payload contains this body',
    deletion_domain: 'compat_payload_default',
    owner_item: owner,
    source_ref: 'source://event/1',
    created_at: CLOCK(),
  });
}

function lines(journal) {
  return fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
}

function rewrite(journal, events) {
  fs.writeFileSync(journal, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function digestPath(target) {
  return `sha256:${createHash('sha256').update(path.resolve(target)).digest('hex')}`;
}

test('registry is metadata-only, hash-chained, and compatibility_delete invalidates the canonical body', (t) => {
  const { payloads } = fixture(t);
  const store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  const saved = put(store);
  assert.equal(store.get(saved.ref).body, 'only canonical payload contains this body');
  const result = store.compatibilityDelete({ owner_item: 'ocq_item_owner', lifecycle_revision: 4 });
  assert.deepEqual(result.deleted_refs, [saved.ref]);
  assert.equal(store.has(saved.ref), false);
  const journal = fs.readFileSync(store.journalPath, 'utf8');
  assert.equal(journal.includes('only canonical payload contains this body'), false);
  const events = lines(store.journalPath);
  for (let index = 0; index < events.length; index += 1) {
    const { event_digest, ...material } = events[index];
    assert.equal(event_digest, canonicalDigest(material));
    assert.equal(events[index].previous_event_digest, index ? events[index - 1].event_digest : null);
  }
  store.close();
});

test('only an unterminated tail fragment is quarantined and recovered', (t) => {
  const { payloads } = fixture(t);
  let store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  put(store);
  const journal = store.journalPath;
  store.close();
  fs.appendFileSync(journal, '{"unfinished":');
  store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  assert.equal(store.list().length, 1);
  assert.ok(lines(journal).some((event) => event.schema_version === 'compat.registry-torn-tail-recovered/v1'));
  assert.equal(fs.readdirSync(path.join(path.dirname(journal), 'quarantine')).length, 1);
  store.close();
});

test('complete corrupt line, hash-chain break, and epoch jump all fail closed', (t) => {
  for (const mode of ['complete-line', 'chain', 'epoch-jump']) {
    const root = path.join(fixture(t).state, mode);
    const payloads = path.join(root, 'payloads');
    let store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
    put(store);
    const journal = store.journalPath;
    store.close();
    if (mode === 'complete-line') fs.appendFileSync(journal, '{}\n');
    if (mode === 'chain') {
      const events = lines(journal);
      events[1].owner_item = 'tampered';
      rewrite(journal, events);
    }
    if (mode === 'epoch-jump') {
      store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
      store.close();
      const events = lines(journal);
      const last = events.at(-1);
      last.writer_epoch += 1;
      const { event_digest: _old, ...material } = last;
      last.event_digest = canonicalDigest(material);
      rewrite(journal, events);
    }
    assert.throws(
      () => createCompatPayloadStore({ dir: payloads, clock: CLOCK }),
      (error) => error.code === 'COMPAT_REGISTRY_CORRUPT',
      mode,
    );
  }
});

test('a writer whose durable epoch changes underneath it is rejected as stale', (t) => {
  const { payloads } = fixture(t);
  const store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  const events = lines(store.journalPath);
  const prior = events.at(-1);
  const material = {
    schema_version: 'compat.registry-writer-epoch-acquired/v1',
    event_id: 'ocq_registry_epoch_111111111111111111111111',
    registry_id: 'ombre-compat-payload-registry/1',
    previous_epoch: prior.writer_epoch,
    writer_epoch: prior.writer_epoch + 1,
    writer_instance_id: 'ocq_writer_222222222222222222222222',
    acquired_at: CLOCK().toISOString(),
    previous_event_digest: prior.event_digest,
  };
  fs.appendFileSync(store.journalPath, `${JSON.stringify({ ...material, event_digest: canonicalDigest(material) })}\n`);
  assert.throws(() => put(store), (error) => error.code === 'COMPAT_REGISTRY_WRITER_EPOCH_CONFLICT');
  store.close();
});

test('restart janitor removes a prior-epoch registered temp artifact', (t) => {
  const { payloads } = fixture(t);
  let store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  const journal = store.journalPath;
  const prior = lines(journal).at(-1);
  const payloadId = 'ocq_payload_333333333333333333333333';
  const token = '4444444444444444';
  const temporary = path.join(payloads, 'compat_payload_default', `.tmp.${payloadId}.${token}`);
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  fs.writeFileSync(temporary, '{}\n');
  const material = {
    schema_version: 'compat-payload-registry-event/1',
    event_id: 'ocq_registry_event_555555555555555555555555',
    event_type: 'artifact_registered',
    payload_ref: `compat-payload:${'6'.repeat(64)}`,
    payload_digest: `sha256:${'7'.repeat(64)}`,
    owner_item: 'ocq_item_crashed',
    source_ref: 'source://event/crashed',
    artifact_kind: 'temp',
    artifact_ref: `compat-artifact://temp/compat_payload_default/${payloadId}/${token}`,
    resolved_path_digest: digestPath(temporary),
    byte_length: 3,
    lifecycle_revision: 0,
    writer_epoch: prior.writer_epoch,
    state: 'registered',
    occurred_at: CLOCK().toISOString(),
    previous_event_digest: prior.event_digest,
  };
  fs.appendFileSync(journal, `${JSON.stringify({ ...material, event_digest: canonicalDigest(material) })}\n`);
  store.close();
  store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  assert.equal(fs.existsSync(temporary), false);
  assert.ok(lines(journal).some((event) => event.event_type === 'artifact_invalidated'
    && event.artifact_ref === material.artifact_ref));
  store.close();
});

test('safe-root and per-component symlink checks refuse deletion', (t) => {
  const { state, payloads } = fixture(t);
  const store = createCompatPayloadStore({ dir: payloads, clock: CLOCK });
  const saved = put(store);
  const active = lines(store.journalPath).findLast((event) => event.event_type === 'payload_active');
  const target = path.join(payloads, 'compat_payload_default', `${saved.ref.slice('compat-payload:'.length)}.json`);
  const outside = path.join(state, 'outside.json');
  fs.writeFileSync(outside, '{}\n');
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  assert.throws(() => store.erase(saved.ref), (error) => error.code === 'COMPAT_STORE_CORRUPT');
  assert.equal(fs.existsSync(outside), true);
  assert.ok(active.resolved_path_digest);
  store.close();
});
