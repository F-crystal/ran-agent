import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendJsonLine,
  quarantineCorruptState,
  readJsonState,
  writeJsonAtomic,
} from '../src/atomicState.mjs';
import { registerTestCleanup } from './helpers/isolatedState.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atomic-state-'));
  registerTestCleanup(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const validState = (value) => value?.schemaVersion === 1 && Array.isArray(value.items);

test('readJsonState distinguishes missing from valid state', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  assert.deepEqual(readJsonState(target, { validate: validState, missingValue: { missing: true }, critical: true }), { missing: true });
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["ok"]}\n');
  assert.deepEqual(readJsonState(target, { validate: validState, missingValue: null, critical: true }), {
    schemaVersion: 1,
    items: ['ok'],
  });
});

test('critical corrupt or incompatible state is quarantined and never reset silently', (t) => {
  const dir = tempDir(t);
  for (const [name, content] of [['corrupt', '{'], ['incompatible', '{"schemaVersion":2,"items":[]}']]) {
    const target = path.join(dir, `${name}.json`);
    fs.writeFileSync(target, content);
    assert.throws(
      () => readJsonState(target, { validate: validState, missingValue: { schemaVersion: 1, items: [] }, critical: true }),
      (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readdirSync(dir).some((entry) => entry.startsWith(`${name}.json.corrupt-`)), true);
  }
});

test('noncritical corrupt state is quarantined before returning explicit fallback', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'cache.json');
  fs.writeFileSync(target, 'not json');
  assert.deepEqual(readJsonState(target, {
    validate: validState,
    missingValue: { schemaVersion: 1, items: [] },
    critical: false,
  }), { schemaVersion: 1, items: [] });
  assert.equal(fs.existsSync(target), false);
});

test('writeJsonAtomic validates and replaces through same-directory temp state', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["old"]}\n');
  writeJsonAtomic(target, { schemaVersion: 1, items: ['new'] }, { validate: validState });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['new'] });
  assert.equal(fs.readdirSync(dir).some((entry) => entry.includes('.tmp-')), false);
  assert.throws(
    () => writeJsonAtomic(target, { schemaVersion: 2, items: [] }, { validate: validState }),
    (error) => error?.code === 'RAN_AGENT_STATE_INVALID',
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['new'] });
});

test('writeJsonAtomic keeps the old target when rename fails and removes temp state', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["old"]}\n');
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = () => {
    const error = new Error('injected rename failure');
    error.code = 'EIO';
    throw error;
  };
  assert.throws(() => writeJsonAtomic(
    target,
    { schemaVersion: 1, items: ['new'] },
    { validate: validState, fsImpl },
  ), /injected rename failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['old'] });
  assert.equal(fs.readdirSync(dir).some((entry) => entry.includes('.tmp-')), false);
});

test('writeJsonAtomic replaces a read-only old target with the requested restrictive mode', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["old"]}\n', { mode: 0o400 });

  writeJsonAtomic(target, { schemaVersion: 1, items: ['new'] }, { validate: validState });

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['new'] });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('writeJsonAtomic preserves the old target when file flush fails', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["old"]}\n');
  const fsImpl = Object.create(fs);
  fsImpl.fsyncSync = () => {
    const error = new Error('injected file flush failure');
    error.code = 'EIO';
    throw error;
  };

  assert.throws(
    () => writeJsonAtomic(target, { schemaVersion: 1, items: ['new'] }, { validate: validState, fsImpl }),
    /injected file flush failure/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['old'] });
  assert.equal(fs.readdirSync(dir).some((entry) => entry.includes('.tmp-')), false);
});

test('writeJsonAtomic reports directory flush failure after an atomic replace', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"items":["old"]}\n');
  const fsImpl = Object.create(fs);
  let flushes = 0;
  fsImpl.fsyncSync = (descriptor) => {
    flushes += 1;
    if (flushes === 2) {
      const error = new Error('injected directory flush failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.fsyncSync(descriptor);
  };

  assert.throws(
    () => writeJsonAtomic(target, { schemaVersion: 1, items: ['new'] }, { validate: validState, fsImpl }),
    /injected directory flush failure/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, items: ['new'] });
  assert.equal(fs.readdirSync(dir).some((entry) => entry.includes('.tmp-')), false);
});

test('appendJsonLine validates and appends complete JSON records', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'events.jsonl');
  const validate = (value) => Number.isInteger(value?.sequence);
  appendJsonLine(target, { sequence: 1 }, { validate });
  appendJsonLine(target, { sequence: 2 }, { validate });
  assert.deepEqual(
    fs.readFileSync(target, 'utf8').trim().split('\n').map(JSON.parse),
    [{ sequence: 1 }, { sequence: 2 }],
  );
  assert.throws(
    () => appendJsonLine(target, { sequence: 'bad' }, { validate }),
    (error) => error?.code === 'RAN_AGENT_STATE_INVALID',
  );
});

test('quarantineCorruptState uses a sanitized unique sibling path', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, 'private payload');
  const quarantined = quarantineCorruptState(target, 'bad/path with secret-ish text');
  assert.equal(path.dirname(quarantined), dir);
  assert.match(path.basename(quarantined), /^state\.json\.corrupt-[a-z0-9_-]+-/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(quarantined, 'utf8'), 'private payload');
});
