import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { inspectS12Acceptance, registerS12Acceptance } from '../../src/core/coreS12Acceptance.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createCoreWorkRunWorker } from '../../src/core/coreWorkRunWorker.mjs';
import { createPackageBScheduledDeliveryHandler } from '../../src/core/packageB/packageBScheduledDeliveryService.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const AT = '2026-08-12T00:00:00.000Z';
const DUE = '2026-08-12T00:00:01.000Z';
const OWNER = 'owner';
const AUTH = 'owner-authorization:s12';
const CANDIDATE = 'a'.repeat(40);
const TRANSACTION = 's12-fixture';
const CONVERSATION = 'system-owner-conversation';
const BINDING = 'system-owner-binding';
const BINDING_DIGEST = `sha256:${'d'.repeat(64)}`;
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;

test('acceptance subordinate refuses invocation without the S12 transaction journal', () => {
  const script = path.resolve(new URL('../../../scripts/core-s12-acceptance.mjs', import.meta.url).pathname);
  const result = spawnSync(process.execPath, [script,
    '--mode', 'register', '--core-db', '/missing/core.sqlite3', '--transaction-id', TRANSACTION,
    '--candidate-sha', CANDIDATE, '--owner-id', OWNER, '--authorization-ref', AUTH,
    '--scheduled-at', DUE,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--s12-transaction or --s12-transaction-fd is required/);
});

test('acceptance subordinate refuses a forged phase without the durable phase chain', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's12-acceptance-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transactionDir = path.join(root, 's12-transactions', TRANSACTION);
  fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  const journal = path.join(transactionDir, 'transaction.json');
  fs.writeFileSync(journal, JSON.stringify({
    schemaVersion: 1, status: 'IN_PROGRESS', phase: 'P7_CORE_WAKE_ACTIVE',
    completedPhases: ['P7_CORE_WAKE_ACTIVE'], cutoverCommitted: true,
    transactionId: TRANSACTION, candidateSha: CANDIDATE, ownerId: OWNER,
    authorizationRef: AUTH, coreDb: path.join(root, 'core.sqlite3'),
    visibleBindingSha256: BINDING_DIGEST, committedAt: AT,
  }), { mode: 0o600 });
  const script = path.resolve(new URL('../../../scripts/core-s12-acceptance.mjs', import.meta.url).pathname);
  const result = spawnSync(process.execPath, [script,
    '--mode', 'register', '--core-db', path.join(root, 'core.sqlite3'), '--transaction-id', TRANSACTION,
    '--candidate-sha', CANDIDATE, '--owner-id', OWNER, '--authorization-ref', AUTH,
    '--scheduled-at', DUE,
    '--s12-transaction', journal,
  ], { encoding: 'utf8', env: { ...process.env, RAN_AGENT_RELEASE_ARTIFACT_ROOT: fs.realpathSync(root) } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not authorize acceptance/);
});

async function setup(t) {
  const { root, dbPath } = createTempCore(t, 'hermes-core-s12-acceptance-');
  let current = new Date(AT);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await commitCoreCutover({
    core,
    input: {
      ownerId: OWNER, authorizationRef: AUTH, candidateSha: CANDIDATE,
      watermark: AT, committedAt: AT,
      migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      visibleBindingDigest: BINDING_DIGEST,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => {
      tx.packageBTurn.createOrResolveConversation({
        conversationId: CONVERSATION, canonicalConversationKey: CONVERSATION,
        ownerId: OWNER, actorRef: 'actor:owner', platform: 'wechat', primaryFrontend: 'wechat',
        sourceInstanceId: 'wechat:owner', platformConversationBinding: 'wechat:owner', createdAt: AT,
      });
      tx.packageBPresentation.createOrReadBinding({
        operationKey: 'core-cutover:system-owner-binding', bindingId: BINDING,
        conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'wechat:owner',
        platform: 'wechat', destinationKind: 'user', destinationRef: 'wechat_owner',
        adapterMetadata: { protocol: 'core-system-schedule', receiptMode: 'typed', routeVersion: '1' },
        createdAt: AT,
      });
    },
  });
  return { core, dbPath, root, setNow(value) { current = new Date(value); } };
}

function input(overrides = {}) {
  return {
    transactionId: TRANSACTION, candidateSha: CANDIDATE, ownerId: OWNER,
    authorizationRef: AUTH, visibleBindingSha256: BINDING_DIGEST, committedAt: AT,
    scheduledAt: DUE, ...overrides,
  };
}

test('S12 acceptance registers one Core schedule and reaches one durable WeChat receipt', async (t) => {
  const { core, dbPath, root, setNow } = await setup(t);
  const registered = await registerS12Acceptance({ core, input: input() });
  assert.equal(registered.disposition, 'registered');
  assert.equal((await registerS12Acceptance({ core, input: input() })).disposition, 'already_registered');
  assert.equal(inspectS12Acceptance({ core, ...input() }).status, 'ENQUEUED');

  setNow(DUE);
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.wakeDue();
  let effects = 0;
  const routes = [];
  const handler = createPackageBScheduledDeliveryHandler({
    core, hashContent: () => TOKEN, now: () => new Date(DUE),
    decide: async () => ({ replyText: 'S12 Core cutover acceptance', provider: 'fixture', model: 'fixture' }),
    send: async (view) => {
      effects += 1;
      routes.push({ destinationKind: view.destinationKind, target: view.target });
      return { resultState: 'sent', evidenceRef: 'wechat:s12:accepted', evidenceHashToken: TOKEN };
    },
  });
  const worker = createCoreWorkRunWorker({
    core, hashContent: () => TOKEN, handlers: { scheduled_instruction: handler }, now: () => new Date(DUE),
  });
  await worker.runOnce();
  const terminal = inspectS12Acceptance({ core, ...input() });
  assert.equal(terminal.status, 'TERMINAL_RECEIPT');
  assert.equal(terminal.outboxId.startsWith('outbox:scheduled:'), true);
  assert.ok(terminal.receiptId);
  assert.deepEqual(routes, [{ destinationKind: 'user', target: 'wechat_owner' }]);
  await worker.runOnce();
  assert.equal(effects, 1);
  assert.equal(inspectS12Acceptance({ core, ...input() }).receiptId, terminal.receiptId);
  const durableBefore = {
    events: core.reader.journalEventCount(),
    outbox: core.reader.presentationOutboxById(terminal.outboxId),
    receipt: core.reader.presentationResultForOutbox(terminal.outboxId),
  };
  const phases = ['P0_VERIFIED', 'P1_SOURCE_APPLIED', 'P2_CORE_PREPARED', 'P3_LEGACY_RECONCILED',
    'P4_QUIESCED', 'P5_CORE_AUTHORITY_COMMITTED', 'P6_CORE_WORKER_ACTIVE', 'P7_CORE_WAKE_ACTIVE',
    'P8_ACCEPTANCE_EFFECT_COMMITTED', 'P9_ACCEPTANCE_RECEIPT_TERMINAL', 'P10_ACCEPTED'];
  const transactionDir = path.join(root, 's12-transactions', TRANSACTION);
  fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  const journal = path.join(transactionDir, 'transaction.json');
  fs.writeFileSync(journal, JSON.stringify({
    schemaVersion: 1, status: 'ACCEPTED', phase: phases.at(-1), completedPhases: phases,
    cutoverCommitted: true, transactionId: TRANSACTION, candidateSha: CANDIDATE,
    ownerId: OWNER, authorizationRef: AUTH, coreDb: dbPath,
    visibleBindingSha256: BINDING_DIGEST, committedAt: AT,
  }), { mode: 0o600 });
  const snapshot = (candidate) => {
    if (!fs.existsSync(candidate)) return null;
    const value = fs.statSync(candidate);
    return { sha256: createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'),
      dev: value.dev, ino: value.ino, size: value.size, mode: value.mode,
      uid: value.uid, gid: value.gid, mtimeMs: value.mtimeMs };
  };
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const script = path.resolve(new URL('../../../scripts/core-s12-acceptance.mjs', import.meta.url).pathname);
  const inspect = () => spawnSync(process.execPath, [script,
    '--mode', 'inspect', '--core-db', dbPath, '--transaction-id', TRANSACTION,
    '--candidate-sha', CANDIDATE, '--owner-id', OWNER, '--authorization-ref', AUTH,
    '--s12-transaction', journal,
  ], { encoding: 'utf8', env: { ...process.env, RAN_AGENT_RELEASE_ARTIFACT_ROOT: fs.realpathSync(root) } });
  const liveBefore = files.map(snapshot);
  const inspected = inspect();
  assert.equal(inspected.status, 0, inspected.stderr);
  const observed = JSON.parse(inspected.stdout);
  assert.equal(observed.status, 'TERMINAL_RECEIPT');
  assert.equal(observed.outboxId, terminal.outboxId);
  assert.equal(observed.receiptId, terminal.receiptId);
  const liveAfter = files.map(snapshot);
  assert.deepEqual(liveAfter.slice(0, 2), liveBefore.slice(0, 2));
  assert.ok(liveBefore[2]);
  for (const field of ['dev', 'ino', 'mode', 'uid', 'gid']) {
    assert.equal(liveAfter[2][field], liveBefore[2][field]);
  }
  assert.deepEqual({
    events: core.reader.journalEventCount(),
    outbox: core.reader.presentationOutboxById(terminal.outboxId),
    receipt: core.reader.presentationResultForOutbox(terminal.outboxId),
  }, durableBefore);
  await core.close();

  const noSidecarBefore = files.map(snapshot);
  const closedInspection = inspect();
  assert.equal(closedInspection.status, 0, closedInspection.stderr);
  assert.deepEqual(files.map(snapshot), noSidecarBefore);
  assert.equal(durableBefore.events > 0, true);
  assert.equal(durableBefore.outbox.state, 'sent');
  assert.equal(durableBefore.receipt.journal_event_id, terminal.receiptId);
  assert.equal(effects, 1);
});

test('S12 acceptance rejects different cutover authority and preserves the first replay time', async (t) => {
  const { core } = await setup(t);
  for (const conflict of [
    { candidateSha: 'd'.repeat(40) },
    { visibleBindingSha256: `sha256:${'e'.repeat(64)}` },
    { committedAt: '2026-08-12T00:00:02.000Z' },
  ]) {
    await assert.rejects(registerS12Acceptance({ core, input: input(conflict) }), {
      code: 'S12_ACCEPTANCE_AUTHORITY_MISMATCH',
    });
  }
  await registerS12Acceptance({ core, input: input() });
  const replay = await registerS12Acceptance({
    core, input: input({ scheduledAt: '2026-08-12T00:00:02.000Z' }),
  });
  assert.equal(replay.disposition, 'already_registered');
  assert.equal(core.reader.scheduleSpec(replay.scheduleSpecId).next_due_at, DUE);
  await core.close();
});
