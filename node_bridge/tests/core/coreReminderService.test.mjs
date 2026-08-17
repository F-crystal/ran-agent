import assert from 'node:assert/strict';
import test from 'node:test';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreReminderService } from '../../src/core/coreReminderService.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T15:00:00.000Z';

async function setup(t, { withBinding = true } = {}) {
  const { dbPath } = createTempCore(t, 'hermes-core-reminder-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await commitCoreCutover({
    core,
    input: {
      ownerId: 'owner', authorizationRef: 'owner-approval:s12:test', watermark: START,
      committedAt: START, candidateSha: 'a'.repeat(40),
      migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => {
      tx.packageBTurn.createOrResolveConversation({
        conversationId: 'owner-conversation:feishu:cutover', canonicalConversationKey: 'owner-conversation:feishu:cutover',
        ownerId: 'owner', actorRef: 'owner:verified', platform: 'feishu', primaryFrontend: 'feishu',
        sourceInstanceId: 'node-channel-hub:feishu',
        platformConversationBinding: 'feishu:conversation:system-owner', createdAt: START,
      });
      if (withBinding) {
        tx.packageBPresentation.createOrReadBinding({
          operationKey: 'core-cutover:system-owner-binding', bindingId: 'owner-binding:feishu:cutover',
          conversationId: 'owner-conversation:feishu:cutover', ownerId: 'owner',
          sourceInstanceId: 'node-channel-hub:feishu', platform: 'feishu',
          destinationKind: 'conversation', destinationRef: 'owner-dm',
          adapterMetadata: { protocol: 'core-system-schedule', receiptMode: 'typed', routeVersion: '1' },
          createdAt: START,
        });
      }
    },
  });
  return { core, dbPath, setNow: (value) => { current = new Date(value); } };
}

test('explicit todo reminder becomes one replay-safe Core schedule', async (t) => {
  const fixture = await setup(t);
  const service = createCoreReminderService({ core: fixture.core, now: () => new Date('2026-08-08T15:00:30.000Z') });
  const first = await service.register({ todoId: 7, scheduledFor: '2026-08-08T16:00:00.000Z' });
  const replay = await service.register({ todoId: 7, scheduledFor: '2026-08-08T16:00:00.000Z' });
  assert.equal(first.disposition, 'registered');
  assert.equal(replay.disposition, 'already_registered');
  const inspector = openTestInspector(fixture.dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='core_reminder_registered'").get().count, 1);
  const revision = inspector.prepare('SELECT * FROM schedule_spec_revision WHERE schedule_spec_id=?').get(first.scheduleSpecId);
  assert.equal(revision.task_kind, 'scheduled_instruction');
  assert.equal(revision.payload_ref, 'legacy-todo:7');
  assert.equal(revision.presentation_binding_id, 'owner-binding:feishu:cutover');
  inspector.close();
  await fixture.core.close();
});

test('registration fails closed without the committed cutover owner binding', async (t) => {
  const fixture = await setup(t, { withBinding: false });
  const service = createCoreReminderService({ core: fixture.core, now: () => new Date('2026-08-08T15:00:30.000Z') });
  await assert.rejects(
    () => service.register({ todoId: 9, scheduledFor: '2026-08-08T16:00:00.000Z' }),
    (error) => error?.code === 'CORE_REMINDER_BINDING_MISSING',
  );
  const inspector = openTestInspector(fixture.dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='core_reminder_registered'").get().count, 0);
  inspector.close();
  await fixture.core.close();
});

test('a late todo is scheduled once at the next whole second and replay does not drift', async (t) => {
  const fixture = await setup(t);
  let current = new Date('2026-08-08T15:05:00.000Z');
  const service = createCoreReminderService({ core: fixture.core, now: () => current });
  const first = await service.register({ todoId: 8, scheduledFor: '2026-08-08T15:01:00.000Z' });
  current = new Date('2026-08-08T15:06:00.000Z');
  const replay = await service.register({ todoId: 8, scheduledFor: '2026-08-08T15:01:00.000Z' });
  assert.equal(first.scheduledFor, '2026-08-08T15:05:01.000Z');
  assert.equal(replay.scheduledFor, first.scheduledFor);
  await fixture.core.close();
});
