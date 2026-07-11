import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEgressPrivacyGate } from '../src/egressPrivacyGate.mjs';

test('removes private ids, runtime paths, policy dumps, and repair instructions', () => {
  const result = applyEgressPrivacyGate([
    '正常回复。',
    'operation_id: op_very_private_123',
    '文件在 /opt/ran_agent/state/private.json',
    'policy_dump={"capability":"owner.write","nonce":"abc"}',
    '[BRIDGE_REPAIR] repeat the success claim',
  ].join('\n'));

  assert.equal(result.text, '正常回复。');
  assert.deepEqual(result.redactions.sort(), [
    'bridge_instruction',
    'policy_dump',
    'private_id',
    'runtime_path',
  ]);
});

test('trusted technical diagnostics may retain internal details', () => {
  const text = 'operation_id: op_123\n文件在 /opt/ran_agent/state/private.json';
  assert.equal(applyEgressPrivacyGate(text, { technicalDiagnostics: true }).text, text);
});

test('an entirely private response becomes a neutral bridge notice', () => {
  const result = applyEgressPrivacyGate('receipt_id: receipt_private_123');
  assert.equal(result.text, '这条回复包含内部运行信息，已停止发送。');
  assert.equal(result.excludeFromHistory, true);
});
