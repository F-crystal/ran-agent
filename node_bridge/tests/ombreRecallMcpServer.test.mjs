import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  callOmbreRecallTool,
  handleOmbreRecallRpc,
} from '../src/ombreRecallMcpServer.mjs';
import {
  OMBRE_RECALL_TOOL_NAMES,
  OMBRE_UPSTREAM_TOOL_REGISTRY,
} from '../src/ombreRecallPolicy.mjs';

function call(name, args = {}) {
  return handleOmbreRecallRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

test('discovery exposes only local side-effect-free recall tools', () => {
  const result = handleOmbreRecallRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(result.result.tools.map(({ name }) => name), OMBRE_RECALL_TOOL_NAMES);
  assert.deepEqual(OMBRE_RECALL_TOOL_NAMES, ['ombre_recall_search', 'ombre_recall_read']);
  for (const name of OMBRE_UPSTREAM_TOOL_REGISTRY) assert.equal(result.result.tools.some((t) => t.name === name), false);
});

test('every raw upstream tool, including mutating and mixed tools, fails closed', () => {
  for (const name of OMBRE_UPSTREAM_TOOL_REGISTRY) {
    assert.equal(call(name).error.code, -32001, name);
  }
});

test('unknown and newly-added upstream tools do not acquire permission', () => {
  assert.equal(call('future_upstream_tool').error.code, -32001);
  assert.throws(() => callOmbreRecallTool('future_upstream_tool', {}), /tool_not_allowed/);
});

test('local search and read are confined to regular Markdown bucket files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-recall-'));
  fs.writeFileSync(path.join(root, 'memory.md'), 'The Empress prefers deterministic evidence.');
  fs.writeFileSync(path.join(root, 'SECRET.MD'), 'UPPERCASE_SENTINEL deterministic');
  fs.writeFileSync(path.join(root, 'mixed.Md'), 'MIXED_SENTINEL deterministic');
  fs.writeFileSync(path.join(root, 'mixed.mD'), 'OTHER_MIXED_SENTINEL deterministic');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'deterministic');
  fs.mkdirSync(path.join(root, 'directory.md'));
  const outside = `${root}-outside.md`;
  fs.writeFileSync(outside, 'SYMLINK_SENTINEL deterministic');
  fs.symlinkSync(outside, path.join(root, 'linked.md'));
  fs.symlinkSync(root, path.join(root, 'linked-directory'));
  const result = callOmbreRecallTool('ombre_recall_search', { query: 'deterministic' }, { bucketRoot: root });
  assert.deepEqual(result.items.map(({ path: itemPath }) => itemPath), ['memory.md']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|MIXED|SYMLINK_SENTINEL/);
  assert.match(callOmbreRecallTool('ombre_recall_read', { path: 'memory.md' }, { bucketRoot: root }).content, /Empress/);
  for (const denied of ['SECRET.MD', 'mixed.Md', 'mixed.mD', 'directory.md', 'linked.md']) {
    assert.throws(() => callOmbreRecallTool('ombre_recall_read', { path: denied }, { bucketRoot: root }));
  }
  assert.throws(() => callOmbreRecallTool('ombre_recall_read', { path: '../outside.md' }, { bucketRoot: root }));
  assert.throws(() => callOmbreRecallTool('ombre_recall_search', { query: 'deterministic', future: true }, { bucketRoot: root }));
  assert.equal(call('ombre_recall_search', { user_text: 'deterministic', response_mode: 'chat' }).error.code, -32002);
  assert.equal(call('ombre_recall_search', { query: 'x', limit: 21 }).error.code, -32002);
});

test('recall read rejects every symlink component and canonical path escape', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-recall-containment-'));
  const root = path.join(parent, 'bucket');
  const outside = path.join(parent, 'bucket-similar-prefix');
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'nested', 'memory.md'), 'safe nested memory');
  fs.writeFileSync(path.join(outside, 'outside.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'outside-link'), 'dir');
  fs.symlinkSync(path.join(root, 'nested'), path.join(root, 'inside-link'), 'dir');
  fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'final-link.md'), 'file');

  assert.match(
    callOmbreRecallTool('ombre_recall_read', { path: 'nested/memory.md' }, { bucketRoot: root }).content,
    /safe nested/,
  );
  for (const denied of [
    'outside-link/outside.md',
    'inside-link/memory.md',
    'final-link.md',
    '../bucket-similar-prefix/outside.md',
    path.join(outside, 'outside.md'),
    'nested/missing.md',
    'nested',
    '%2e%2e/outside.md',
    'NESTED/memory.md',
  ]) {
    assert.throws(
      () => callOmbreRecallTool('ombre_recall_read', { path: denied }, { bucketRoot: root }),
      denied,
    );
  }
});
