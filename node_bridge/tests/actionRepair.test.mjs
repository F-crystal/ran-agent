import test from 'node:test';
import assert from 'node:assert/strict';

import { planRepairAction, repairActionContract } from '../src/actionRepair.mjs';

test('repair never derives a tool action from user or reply text', () => {
  const plan = planRepairAction({
    contract: { intent: 'none', contract_source: 'no_action', final_claims: ['media_generated'] },
    message: { text: '生成一张猫图' },
    finalReply: '图片已生成。',
  });
  assert.equal(plan.shouldRepair, false);
  assert.equal(plan.errorCode, 'NO_REPAIR_FOR_INTENT');
});

test('repair accepts only injected bounded retry work for a declared trusted action', async () => {
  const result = await repairActionContract({
    contract: { intent: 'typed_action', contract_source: 'typed_action_request', final_claims: ['external_sent'], request_id: 'request-1' },
    repairImpl: async (plan) => {
      assert.equal(plan.triggerSource, 'typed_action_failure');
      assert.equal(plan.sessionScope, 'task');
      return { ok: true, status: 'success' };
    },
  });
  assert.equal(result.repairAttempted, true);
  assert.equal(result.repairStatus, 'success');
});

test('repair without a trusted retry implementation is skipped rather than selecting an MCP tool', async () => {
  const result = await repairActionContract({
    contract: { intent: 'media_generate', contract_source: 'protected_compatibility', final_claims: ['media_generated'] },
  });
  assert.equal(result.repairAttempted, false);
  assert.equal(result.repairStatus, 'skipped');
  assert.equal(result.repairErrorCode, 'NO_TRUSTED_RETRY');
});

test('repair telemetry has a closed trigger and session-scope vocabulary', async () => {
  const result = await repairActionContract({
    contract: { intent: 'typed_action', contract_source: 'typed_action_request', final_claims: ['external_sent'] },
    repairImpl: async () => ({ ok: true, status: 'success', triggerSource: 'reply_text_regex', sessionScope: 'conversation' }),
  });
  assert.equal(result.repairTriggerSource, 'none');
  assert.equal(result.repairSessionScope, 'none');
  assert.equal(result.repairRecursiveBlocked, true);
});
