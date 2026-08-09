import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreExternalNotificationService } from '../../src/core/coreExternalNotificationService.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const NOW = '2026-08-08T10:00:00.000Z';

test('an admitted external fact creates one replay-safe scheduled instruction on the owner binding', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-external-notification-');
  const core = openCoreDatabase({ dbPath, now: () => new Date(NOW) });
  core.migrate();
  await core.writer.write((tx) => {
    tx.packageBTurn.createOrResolveConversation({
      conversationId: 'system-owner-conversation', canonicalConversationKey: 'system-owner-conversation',
      ownerId: 'owner', actorRef: 'owner:verified', platform: 'feishu', primaryFrontend: 'feishu',
      sourceInstanceId: 'node-channel-hub:feishu',
      platformConversationBinding: 'feishu:conversation:system-owner', createdAt: NOW,
    });
    tx.packageBPresentation.createOrReadBinding({
      operationKey: 'fixture:binding', bindingId: 'system-owner-binding',
      conversationId: 'system-owner-conversation', ownerId: 'owner',
      sourceInstanceId: 'node-channel-hub:feishu', platform: 'feishu',
      destinationKind: 'conversation', destinationRef: 'conversation:system-owner',
      adapterMetadata: { protocol: 'test', receiptMode: 'typed', routeVersion: '1' }, createdAt: NOW,
    });
    tx.journal.append({
      eventId: 'external-fact-1', eventType: 'external_poll_fact_observed', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'external_mcp', sourceRef: 'fingerprint', createdAt: NOW,
    });
  });
  const service = createCoreExternalNotificationService({ core, now: () => new Date(NOW) });
  const input = { payloadRef: 'external-mcp-task:activity-1:3', causationId: 'external-fact-1' };
  const registered = await service.register(input);
  assert.equal(registered.disposition, 'registered');
  assert.equal((await service.register(input)).disposition, 'already_registered');
  const schedule = core.reader.scheduleSpec(registered.scheduleSpecId);
  assert.equal(schedule?.next_due_at, '2026-08-08T10:00:01.000Z');
  await core.close();
  const inspect = openTestInspector(dbPath);
  const revision = inspect.prepare(`SELECT task_kind,payload_ref FROM schedule_spec_revision
    WHERE schedule_spec_id=?`).get(registered.scheduleSpecId);
  assert.equal(revision.task_kind, 'scheduled_instruction');
  assert.equal(revision.payload_ref, input.payloadRef);
  inspect.close();
});
