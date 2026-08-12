import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import {
  loadCoreSystemScheduleManifest,
  seedCoreSystemSchedules,
} from '../../src/core/coreSystemSchedules.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'docs/governance/core_system_schedules.v1.json');
const WATERMARK = '2026-08-08T15:00:00.000Z';
const COMMITTED_AT = '2026-08-08T15:01:00.000Z';

test('cutover seeds every replacement schedule active with first due after the watermark', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-system-schedules-');
  const core = openCoreDatabase({ dbPath, now: () => new Date(COMMITTED_AT) });
  core.migrate();
  const manifest = loadCoreSystemScheduleManifest(MANIFEST_PATH);
  assert.equal(manifest.schedules.length, 13);
  assert.equal(new Set(manifest.schedules.map((item) => item.source)).has('python.scheduler.brain_loop'), false);
  assert.deepEqual(manifest.schedules.filter((item) => item.id === 'attention-flush'), [{
    id: 'attention-flush', source: 'node.attention_valve.flush', title: 'Attention backlog flush',
    taskKind: 'system_maintenance', visible: false,
    recurrence: { kind: 'interval', everySeconds: 60 },
  }]);

  await commitCoreCutover({
    core,
    input: {
      ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
      watermark: WATERMARK, committedAt: COMMITTED_AT,
      candidateSha: 'a'.repeat(40), migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => seedCoreSystemSchedules(tx, {
      manifest, ownerId: 'owner', watermark: WATERMARK, createdAt: COMMITTED_AT,
      visibleBinding: {
        conversationId: 'system-owner-conversation', canonicalConversationKey: 'system-owner-conversation',
        actorRef: 'owner:verified', platform: 'feishu', sourceInstanceId: 'node-channel-hub:feishu',
        platformConversationBinding: 'feishu:conversation:system-owner',
        bindingId: 'system-owner-binding', destinationKind: 'user', destinationRef: 'ou-owner-fixture',
      },
    }),
  });
  const inspector = openTestInspector(dbPath);
  const schedules = inspector.prepare('SELECT * FROM schedule_spec ORDER BY schedule_spec_id').all();
  assert.equal(schedules.length, manifest.schedules.length);
  assert.ok(schedules.every((row) => row.state === 'enabled' && Date.parse(row.next_due_at) > Date.parse(WATERMARK)));
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM schedule_spec_revision WHERE task_kind='scheduled_instruction'").get().count, 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM schedule_spec_revision WHERE task_kind='external_poll'").get().count, 1);
  assert.equal(inspector.prepare("SELECT payload_ref FROM schedule_spec_revision WHERE task_kind='external_poll'").get().payload_ref, 'external-poll:external-mcp-runtime');
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM schedule_spec_revision WHERE payload_ref='system-task:attention-flush'").get().count, 1);
  assert.equal(inspector.prepare("SELECT source_kind FROM journal_event WHERE event_type='package_b_presentation_binding_created'").get().source_kind,
    'package_b_presentation_binding_destination:user');
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM wake_occurrence').get().count, 0);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM work_run').get().count, 0);
  inspector.close();
  await core.close();
});
