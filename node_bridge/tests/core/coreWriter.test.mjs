import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, flushImmediate } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-16T00:00:00.000Z';

function setup(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-writer-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  return { core, dbPath, writer: core.writer };
}

function append(tx, id) {
  return tx.journal.append({
    eventId: id, eventType: 'writer_test', originRef: 'fixture',
    sourceKind: 'test', sourceRef: 'fixture', createdAt: AT,
  });
}

test('concurrent normal writes serialize and queued high runs before waiting normal', async (t) => {
  const { core, writer } = setup(t);
  const order = [];
  let high;
  const first = writer.write((tx) => {
    order.push('normal-1-start');
    append(tx, 'n1');
    high = writer.write((highTx) => {
      order.push('high');
      append(highTx, 'h');
    }, { priority: 'high' });
    order.push('normal-1-end');
  });
  const second = writer.write((tx) => {
    order.push('normal-2');
    append(tx, 'n2');
  });
  await first;
  await high;
  await second;
  assert.deepEqual(order, ['normal-1-start', 'normal-1-end', 'high', 'normal-2']);
  assert.equal(core.reader.journalEventCount(), 3);
  await core.close();
});

test('bounded high-priority burst does not starve accepted normal work', async (t) => {
  const { core, writer } = setup(t);
  const order = [];
  let releases;
  const starter = writer.write((tx) => {
    append(tx, 'starter');
    releases = Array.from({ length: 10 }, (_, index) => writer.write((highTx) => {
      order.push(`h${index}`);
      append(highTx, `h${index}`);
    }, { priority: 'high' }));
  });
  const normal = writer.write((tx) => {
    order.push('normal');
    append(tx, 'normal');
  });
  await starter;
  await Promise.all([...releases, normal]);
  assert.ok(order.indexOf('normal') >= 0 && order.indexOf('normal') < order.length - 1);
  await core.close();
});

test('failed transaction rolls back without poisoning later queue items', async (t) => {
  const { core, writer } = setup(t);
  const failed = writer.write((tx) => {
    append(tx, 'lost');
    throw new Error('expected failure');
  });
  const later = writer.write((tx) => append(tx, 'kept'));
  await assert.rejects(failed, { code: 'CORE_WRITE_FAILED', message: /expected failure/ });
  await later;
  assert.equal(core.reader.journalEvent('lost'), undefined);
  assert.equal(core.reader.journalEvent('kept').journal_event_id, 'kept');
  await core.close();
  await assert.rejects(writer.write(() => {}), { code: 'CORE_WRITER_CLOSED' });
});

test('second Core owner for the same canonical database is rejected until close', async (t) => {
  const { core, dbPath } = setup(t);
  assert.throws(() => openCoreDatabase({ dbPath }), { code: 'CORE_WRITER_ALREADY_ACTIVE' });
  await core.close();
  const replacement = openCoreDatabase({ dbPath });
  assert.equal(replacement.reader.schemaVersion(), 1);
  await replacement.close();
});

test('saved public write method cannot bypass close and accepted queue items drain first', async (t) => {
  const { core, dbPath, writer } = setup(t);
  const savedWrite = writer.write;
  const accepted = savedWrite((tx) => {
    append(tx, 'accepted-before-close');
    tx.projections.createCursor({
      cursorId: 'close-cursor', projectorId: 'close-test',
      targetScope: 'owner', createdAt: AT,
    });
  });
  const closing = core.close();
  await accepted;
  await closing;
  await assert.rejects(savedWrite((tx) => append(tx, 'after-close')), { code: 'CORE_WRITER_CLOSED' });
  const inspector = openCoreDatabase({ dbPath });
  assert.equal(inspector.reader.journalEventCount(), 1);
  assert.equal(inspector.reader.journalEvent('after-close'), undefined);
  assert.equal(inspector.reader.projectorCursor('close-test', 'owner').revision, 0);
  await inspector.close();
});

test('returned Promise rolls back immediately and cannot write after await', async (t) => {
  const { core, writer } = setup(t);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let escapedError;
  let finished;
  const detachedFinished = new Promise((resolve) => { finished = resolve; });
  const rejected = writer.write(async (tx) => {
    append(tx, 'before-await');
    await barrier;
    try { append(tx, 'after-await'); } catch (error) { escapedError = error; }
    finished();
  });
  await assert.rejects(rejected, { code: 'CORE_TRANSACTION_ASYNC_FORBIDDEN' });
  release();
  await detachedFinished;
  assert.equal(escapedError.code, 'CORE_TRANSACTION_CONTEXT_REVOKED');
  assert.equal(core.reader.journalEventCount(), 0);
  await core.close();
});

test('microtask, Promise.then and detached async escapes are deterministically revoked', async (t) => {
  const { core, writer } = setup(t);
  const escaped = [];
  const completions = [];
  await writer.write((tx) => {
    completions.push(new Promise((resolve) => queueMicrotask(() => {
      try { append(tx, 'microtask'); } catch (error) { escaped.push(error.code); }
      resolve();
    })));
    completions.push(Promise.resolve().then(() => {
      try { append(tx, 'promise-then'); } catch (error) { escaped.push(error.code); }
    }));
    completions.push((async () => {
      await Promise.resolve();
      try { append(tx, 'detached-async'); } catch (error) { escaped.push(error.code); }
    })());
  });
  await Promise.all(completions);
  assert.deepEqual(escaped, Array(3).fill('CORE_TRANSACTION_CONTEXT_REVOKED'));
  assert.equal(core.reader.journalEventCount(), 0);
  await core.close();
});

test('nextTick, setImmediate and setTimeout escapes are revoked without timing guesses', async (t) => {
  const { core, writer } = setup(t);
  const escaped = [];
  const completions = [];
  await writer.write((tx) => {
    completions.push(new Promise((resolve) => process.nextTick(() => {
      try { append(tx, 'next-tick'); } catch (error) { escaped.push(error.code); }
      resolve();
    })));
    completions.push(new Promise((resolve) => setImmediate(() => {
      try { append(tx, 'immediate'); } catch (error) { escaped.push(error.code); }
      resolve();
    })));
    completions.push(new Promise((resolve) => setTimeout(() => {
      try { append(tx, 'timeout'); } catch (error) { escaped.push(error.code); }
      resolve();
    }, 0)));
  });
  await Promise.all(completions);
  assert.deepEqual(escaped.sort(), Array(3).fill('CORE_TRANSACTION_CONTEXT_REVOKED'));
  assert.equal(core.reader.journalEventCount(), 0);
  await core.close();
});

test('custom thenable and throwing then getter roll back before any commit', async (t) => {
  const { core, writer } = setup(t);
  await assert.rejects(writer.write((tx) => {
    append(tx, 'thenable');
    return { then() {} };
  }), { code: 'CORE_TRANSACTION_ASYNC_FORBIDDEN' });
  await assert.rejects(writer.write((tx) => {
    append(tx, 'getter');
    return Object.defineProperty({}, 'then', { get() { throw new Error('getter exploded'); } });
  }), { code: 'CORE_TRANSACTION_THENABLE_INSPECTION_FAILED' });
  assert.equal(core.reader.journalEventCount(), 0);
  await core.close();
});

test('captured facade stays revoked after commit and rollback, and queue continues', async (t) => {
  const { core, writer } = setup(t);
  let committedTx;
  await writer.write((tx) => { committedTx = tx; append(tx, 'committed'); });
  assert.throws(() => append(committedTx, 'reuse-commit'), { code: 'CORE_TRANSACTION_CONTEXT_REVOKED' });
  let rolledTx;
  await assert.rejects(writer.write((tx) => {
    rolledTx = tx;
    append(tx, 'rolled');
    throw new Error('rollback');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.throws(() => append(rolledTx, 'reuse-rollback'), { code: 'CORE_TRANSACTION_CONTEXT_REVOKED' });
  await writer.write((tx) => append(tx, 'after-failures'));
  await flushImmediate();
  assert.equal(core.reader.journalEventCount(), 2);
  assert.equal(core.reader.journalEvent('rolled'), undefined);
  await core.close();
});
