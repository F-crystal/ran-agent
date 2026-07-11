import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

import { saveStickersFromInbox } from '../src/stickerCatalog.mjs';
import {
  buildStickerCatalogTools,
  handleStickerCatalogMcpRequest,
} from '../src/stickerCatalogMcpServer.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
}

function tempEnv(t) {
  const env = createIsolatedTestEnv(t, {}, 'sticker-catalog-mcp-', '.ran_agent_state');
  return {
    ...env,
    RAN_AGENT_ROOT: path.dirname(env.RAN_AGENT_STATE_DIR),
  };
}

function writeInboxFile(env, name, bytes = pngBytes()) {
  const inboxDir = path.join(env.RAN_AGENT_STATE_DIR, 'wechat', 'inbound');
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

async function seedCatalog(t) {
  const env = tempEnv(t);
  const happy = writeInboxFile(env, 'happy.png');
  const love = writeInboxFile(env, 'love.png', Buffer.concat([pngBytes(), Buffer.from([1])]));
  await saveStickersFromInbox({
    items: [
      { filePath: happy, tags: ['开心', '常用'], desc: '快乐小图' },
      { filePath: love, tags: ['喜欢'], desc: '心动贴纸' },
    ],
  }, { env });
  return env;
}

async function callTool(env, name, args = {}, options = {}) {
  return await handleStickerCatalogMcpRequest(
    {
      method: 'tools/call',
      params: { name, arguments: args },
    },
    { env, ...options }
  );
}

test('sticker catalog MCP exposes public and owner-only tool schemas', () => {
  const names = buildStickerCatalogTools().map((tool) => tool.name);

  assert.deepEqual(names, [
    'sticker_tags',
    'sticker_pick',
    'sticker_attach',
    'sticker_save_from_inbox',
    'sticker_update',
    'sticker_delete',
    'sticker_list',
  ]);
});

test('start_sticker_catalog_mcp.sh initialize exits after one response', async () => {
  const { stdout } = await execFileAsync(
    'bash',
    ['scripts/start_sticker_catalog_mcp.sh', 'initialize'],
    { cwd: PROJECT_ROOT, timeout: 1500 }
  );

  const response = JSON.parse(stdout.trim());
  assert.equal(response.result.serverInfo.name, 'ran-agent-sticker-catalog');
});

test('lite profile exposes chat sticker tools and explicit inbound save only', async (t) => {
  const env = await seedCatalog(t);
  const listed = await handleStickerCatalogMcpRequest(
    { method: 'tools/list', params: {} },
    { env: { ...env, STICKER_CATALOG_PROFILE_MODE: 'lite' } }
  );

  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'sticker_tags',
    'sticker_pick',
    'sticker_attach',
    'sticker_save_from_inbox',
  ]);

  for (const name of ['sticker_update', 'sticker_delete', 'sticker_list']) {
    const denied = await callTool(
      { ...env, STICKER_CATALOG_PROFILE_MODE: 'lite' },
      name,
      { owner_token: 'secret', items: [] },
      { ownerToken: 'secret' }
    );
    assert.equal(denied.isError, true, name);
    assert.equal(denied.structuredContent.error_code, 'STICKER_UNKNOWN_TOOL', name);
  }
});

test('lite profile can save explicitly requested trusted inbound stickers when runtime save is enabled', async (t) => {
  const env = tempEnv(t);
  const filePath = writeInboxFile(env, 'lite-save.png');

  const result = await callTool(
    {
      ...env,
      STICKER_CATALOG_PROFILE_MODE: 'lite',
      STICKER_CATALOG_ALLOW_RUNTIME_SAVE: 'true',
    },
    'sticker_save_from_inbox',
    { items: [{ filePath, tags: ['常用'], desc: 'lite save', source: 'wechat' }] }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.saved[0].stickerId, 'stk_001');
  assert.doesNotMatch(JSON.stringify(result), /filePath|\/wechat\/inbound|\.ran_agent_state/);
});

test('lite profile refuses runtime save when runtime save is disabled', async (t) => {
  const env = tempEnv(t);
  const filePath = writeInboxFile(env, 'lite-denied.png');

  const denied = await callTool(
    { ...env, STICKER_CATALOG_PROFILE_MODE: 'lite' },
    'sticker_save_from_inbox',
    { items: [{ filePath, tags: ['常用'] }] }
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error_code, 'STICKER_PERMISSION_DENIED');
});

test('sticker_tags returns tags and usage without exposing tag index internals', async (t) => {
  const env = await seedCatalog(t);

  const result = await callTool(env, 'sticker_tags');

  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.tags, ['开心', '常用', '喜欢']);
  assert.match(result.structuredContent.usage, /stronger emotional reaction/i);
  assert.equal('tagIndex' in result.structuredContent, false);
  assert.equal('ids' in JSON.parse(result.content[0].text), false);
  assert.doesNotMatch(result.content[0].text, /stk_001/);
});

test('sticker_pick returns public candidates without paths', async (t) => {
  const env = await seedCatalog(t);

  const result = await callTool(env, 'sticker_pick', { tag: '喜欢', limit: 5 });

  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.candidates, [
    {
      stickerId: 'stk_002',
      tags: ['喜欢'],
      desc: '心动贴纸',
      mime: 'image/png',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /filePath|path|assets|\.ran_agent_state/);
});

test('sticker_attach returns a RAN_MEDIA stickerId marker without paths', async (t) => {
  const env = await seedCatalog(t);

  const result = await callTool(env, 'sticker_attach', { stickerId: 'stk_001', caption: '太开心了' });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.marker, 'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"太开心了"}');
  assert.equal(result.content[0].text, result.structuredContent.marker);
  assert.doesNotMatch(JSON.stringify(result), /filePath|assets|\.ran_agent_state/);
});

test('sticker_attach canonicalizes legacy sticker ids in RAN_MEDIA markers', async (t) => {
  const env = await seedCatalog(t);

  const result = await callTool(env, 'sticker_attach', { stickerId: 'stk001' });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.marker, 'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":""}');
});

test('sticker_attach returns structured not-found errors without leaking paths', async (t) => {
  const env = await seedCatalog(t);

  const result = await callTool(env, 'sticker_attach', { stickerId: 'stk_missing' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error_code, 'STICKER_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(result), /\/|\\|assets|\.ran_agent_state/);
});

test('owner-only sticker management tools reject non-owner calls', async (t) => {
  const env = await seedCatalog(t);

  for (const name of ['sticker_save_from_inbox', 'sticker_update', 'sticker_delete', 'sticker_list']) {
    const result = await callTool(env, name, {});
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error_code, 'STICKER_PERMISSION_DENIED', name);
  }
});

test('owner-only sticker_save_from_inbox saves trusted inbound files without leaking paths', async (t) => {
  const env = tempEnv(t);
  const filePath = writeInboxFile(env, 'candidate.png');

  const result = await callTool(env, 'sticker_save_from_inbox', {
    items: [{ filePath, tags: ['开心'], desc: '明确保存的表情包', source: 'wechat' }],
  }, { trustedOwner: true });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.saved.length, 1);
  assert.equal(result.structuredContent.saved[0].stickerId, 'stk_001');
  assert.equal(result.structuredContent.saved[0].fileName, 'stk_001.png');
  assert.equal(result.structuredContent.saved[0].source, 'wechat');
  assert.doesNotMatch(JSON.stringify(result), /filePath|\/wechat\/inbound|\.ran_agent_state/);
});

test('owner-only sticker_save_from_inbox rejects untrusted source paths without leaking them', async (t) => {
  const env = tempEnv(t);
  const outsideDir = path.join(env.RAN_AGENT_ROOT, 'uploads');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsidePath = path.join(outsideDir, 'candidate.png');
  fs.writeFileSync(outsidePath, pngBytes());

  const result = await callTool(env, 'sticker_save_from_inbox', {
    owner_token: 'secret',
    items: [{ filePath: outsidePath, tags: ['开心'] }],
  }, { ownerToken: 'secret' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'STICKER_TOOL_ERROR');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(outsidePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(result), /uploads\/candidate/);
});
