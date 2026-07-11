import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalMcpAutonomyRuntime } from '../src/externalMcp/runtime.mjs';
import { createIsolatedTestEnv, registerTestCleanup } from './helpers/isolatedState.mjs';

const actor = Object.freeze({
  actorKey: 'actor:owner:release-journey',
  conversationKey: 'conversation:wechat:release-journey',
  platform: 'wechat',
});

test('external release journey routes a configured generic activity through the broker and keeps native arguments private', async (t) => {
  const calls = [];
  const runtime = createExternalMcpAutonomyRuntime({
    env: createIsolatedTestEnv(t),
    ...coreJobOptions(),
    listManifests: () => [{
      id: 'fixture-generic-server',
      activityKind: 'game',
      tools: [{
        name: 'advance', title: 'Advance', tier: 'T3', profileScope: 'full',
        proactiveAllowed: true, confirmationRequired: false, reason: 'fixture',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    }],
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0].actionId }; } },
    transport: {
      async call(request) {
        calls.push(request);
        return { content: [{ type: 'text', text: 'fixture checkpoint reached' }] };
      },
    },
  });
  registerTestCleanup(t, () => runtime.stop());

  const accepted = await runtime.facade.handle({
    requestRef: 'release-journey:external:1',
    command: 'start_or_resume',
    goal: '继续完成当前游戏关卡',
    environmentHint: 'game',
  }, actor);
  assert.equal(accepted.action, 'started');
  assert.doesNotMatch(JSON.stringify(accepted), /arguments|toolName|operationId/);

  const tick = await runtime.tick();
  assert.equal(tick.processed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverId, 'fixture-generic-server');
  assert.equal(calls[0].toolName, 'advance');
  assert.match(calls[0].operationId, /^operation_/);
});

function coreJobOptions() {
  const receipts = new Map();
  return {
    async createCoreJob(input) {
      const receipt = {
        jobId: `job_external_${input.goalDigest.slice(0, 24)}`,
        actorKey: input.actorKey,
        goalDigest: input.goalDigest,
        status: 'active',
        nextRunAt: input.nextRunAt,
        terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
      };
      receipts.set(receipt.jobId, receipt);
      return receipt;
    },
    async queryCoreJob(jobId) { return receipts.get(jobId); },
    async terminalizeCoreJob(jobId, input) {
      const receipt = { ...receipts.get(jobId), status: input.terminalState };
      receipts.set(jobId, receipt);
      return receipt;
    },
  };
}
