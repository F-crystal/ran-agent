import assert from 'node:assert/strict';
import test from 'node:test';

import { handleOmbreRecallRpc } from '../../src/ombreRecallMcpServer.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import {
  createOfficialOmbreToolCaller,
  createOmbreProjectionService,
} from '../../src/core/ombreProjectionService.mjs';
import { createCoreContentHasher } from '../../src/core/packageB/packageBNodeDeliveryService.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const AT = '2026-08-08T00:00:00.000Z';
const hashContent = createCoreContentHasher({ keyId: 'test', key: 'ombre-projection-test-key' });

function setup(t, eventType = 'personal_learning_confirmed') {
  const { dbPath } = createTempCore(t, 'ombre-projection-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  t.after(() => core.close());
  return core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'learning-event-1', eventType, originRef: 'node:trusted-action-receipt',
      sourceKind: eventType.startsWith('personal_') ? 'personal_learning' : 'core',
      sourceRef: 'learning:reply-style', revision: 0, createdAt: AT,
    });
    tx.journal.appendPayload({
      payloadId: 'learning-payload-1', eventId: 'learning-event-1', storageKind: 'external_ref',
      payloadRef: 'learning:reply-style', contentHashToken: hashContent('ombre-projection',
        eventType === 'personal_learning_confirmed'
          ? '用户明确偏好回复先说结论。'
          : '这是一段经过 Core 确认、用于维持长期关系语境的完整摘要。'),
      sensitivity: 'sensitive', retentionClass: 'owner_directed', createdAt: AT,
    });
  }).then(() => core);
}

function fakeOmbre({ loseFirstMutationResponse = false } = {}) {
  const buckets = new Map();
  let mutationCalls = 0;
  let lost = false;
  const callTool = async (name, args) => {
    if (name === 'breath_advanced') {
      return [...buckets.entries()]
        .filter(([, bucket]) => bucket.content.includes(args.query) || bucket.tags.includes(args.query))
        .map(([id, bucket]) => `${bucket.archived ? '[query 命中·已删除到档案] ' : ''}[bucket_id:${id}]\n${bucket.content}`)
        .join('\n\n');
    }
    if (name === 'hold' || name === 'grow') {
      mutationCalls += 1;
      const id = `bucket-${mutationCalls}`;
      buckets.set(id, {
        content: name === 'hold' ? args.content : args.items[0],
        tags: name === 'hold' ? args.tags.split(',') : [],
        archived: false,
      });
      if (loseFirstMutationResponse && !lost) {
        lost = true;
        const error = new Error('response lost after commit');
        error.code = 'CORE_OMBRE_TRANSPORT_FAILED';
        throw error;
      }
      return `[bucket_id:${id}]`;
    }
    if (name === 'trace') {
      const bucket = buckets.get(args.bucket_id);
      if (!bucket) throw new Error('missing bucket');
      if (args.delete) bucket.archived = true;
      if (args.tags) bucket.tags = args.tags.split(',');
      if (args.old_str && bucket.content.includes(args.old_str)) {
        bucket.content = bucket.content.replace(args.old_str, args.new_str || '');
      }
      return `[bucket_id:${args.bucket_id}]`;
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return {
    callTool,
    get mutationCalls() { return mutationCalls; },
    activeBuckets: () => [...buckets.values()].filter((bucket) => !bucket.archived),
  };
}

const holdPayload = {
  sourceRef: 'learning:reply-style',
  payloadId: 'learning-payload-1',
  content: '用户明确偏好回复先说结论。',
  tags: ['preference'],
};

test('confirmed learning repeats and concurrent callers grow Ombre only once', async (t) => {
  const core = await setup(t);
  const ombre = fakeOmbre();
  const service = createOmbreProjectionService({ core, callTool: ombre.callTool, hashContent, now: () => new Date(AT) });

  const [first, concurrent] = await Promise.all([
    service.projectConfirmedEvent({ sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload }),
    service.projectConfirmedEvent({ sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload }),
  ]);
  const replay = await service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload,
  });

  assert.equal(first.status, 'completed');
  assert.equal(concurrent.status, 'completed');
  assert.equal(replay.disposition, 'already_committed');
  assert.equal(ombre.mutationCalls, 1);
  assert.equal(ombre.activeBuckets().length, 1);
});

test('lost hold response is retried by marker without a second Ombre mutation', async (t) => {
  const core = await setup(t);
  const ombre = fakeOmbre({ loseFirstMutationResponse: true });
  const service = createOmbreProjectionService({ core, callTool: ombre.callTool, hashContent, now: () => new Date(AT) });

  const failed = await service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(core.reader.journalEvent('learning-event-1').event_type, 'personal_learning_confirmed');

  const recovered = await service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload,
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.receipt.disposition, 'already_projected');
  assert.equal(ombre.mutationCalls, 1);
});

test('grow recovery removes its marker and does not duplicate a relationship summary', async (t) => {
  const core = await setup(t, 'core_relationship_summary_confirmed');
  const ombre = fakeOmbre({ loseFirstMutationResponse: true });
  const service = createOmbreProjectionService({ core, callTool: ombre.callTool, hashContent, now: () => new Date(AT) });
  const payload = {
    sourceRef: 'learning:reply-style',
    payloadId: 'learning-payload-1',
    content: '这是一段经过 Core 确认、用于维持长期关系语境的完整摘要。',
    tags: ['relationship'],
  };

  assert.equal((await service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload,
  })).status, 'failed');
  assert.equal((await service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload,
  })).status, 'completed');

  assert.equal(ombre.mutationCalls, 1);
  assert.equal(ombre.activeBuckets().length, 1);
  assert.doesNotMatch(ombre.activeBuckets()[0].content, /ran-agent-event-/);
});

test('projection scope is erasable and rebuilds from the unchanged Core event', async (t) => {
  const core = await setup(t);
  const ombre = fakeOmbre();
  const service = createOmbreProjectionService({ core, callTool: ombre.callTool, hashContent, now: () => new Date(AT) });

  await service.projectConfirmedEvent({ sourceEventId: 'learning-event-1', targetScope: 'owner:v1', payload: holdPayload });
  const erased = await service.eraseScope('owner:v1');
  assert.equal(erased.erased, 1);
  assert.equal(ombre.activeBuckets().length, 0);
  assert.equal((await service.eraseScope('owner:v1')).erased, 0);

  await service.projectConfirmedEvent({ sourceEventId: 'learning-event-1', targetScope: 'owner:v2', payload: holdPayload });
  assert.equal(ombre.mutationCalls, 2);
  assert.equal(ombre.activeBuckets().length, 1);
  assert.equal(core.reader.journalEvent('learning-event-1').event_type, 'personal_learning_confirmed');
});

test('unconfirmed sources and mismatched content references never reach Ombre', async (t) => {
  const core = await setup(t);
  const ombre = fakeOmbre();
  const service = createOmbreProjectionService({ core, callTool: ombre.callTool, hashContent });

  await assert.rejects(service.projectConfirmedEvent({
    sourceEventId: 'missing', targetScope: 'owner:v1', payload: holdPayload,
  }), { code: 'CORE_OMBRE_SOURCE_UNCONFIRMED' });
  await assert.rejects(service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1',
    payload: { ...holdPayload, sourceRef: 'learning:other' },
  }), { code: 'CORE_OMBRE_SOURCE_REF_MISMATCH' });
  await assert.rejects(service.projectConfirmedEvent({
    sourceEventId: 'learning-event-1', targetScope: 'owner:v1',
    payload: { ...holdPayload, content: '模型替换了已经确认的内容。' },
  }), { code: 'CORE_OMBRE_SOURCE_REF_MISMATCH' });
  assert.equal(ombre.mutationCalls, 0);

  const denied = handleOmbreRecallRpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: { content: 'x' } },
  });
  assert.equal(denied.error.code, -32001);
});

test('official caller accepts only correlated loopback MCP results', async () => {
  assert.throws(() => createOfficialOmbreToolCaller({ url: 'http://example.com/mcp' }), {
    code: 'CORE_OMBRE_ENDPOINT_INVALID',
  });
  const calls = [];
  const callTool = createOfficialOmbreToolCaller({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return {
        ok: true,
        async json() {
          return { jsonrpc: '2.0', id: request.id, result: { isError: false, structuredContent: { result: 'ok' } } };
        },
      };
    },
  });
  assert.equal(await callTool('hold', { content: 'x' }), 'ok');
  assert.equal(calls[0].params.name, 'hold');
});
