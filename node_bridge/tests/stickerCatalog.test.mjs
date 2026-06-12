import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertStickerFileAllowed,
  atomicWriteJson,
  deleteStickers,
  ensureStickerCatalog,
  listStickerTags,
  listStickers,
  pickStickers,
  readStickerHashes,
  readStickerIndex,
  readStickerTags,
  resolveStickerAsset,
  resolveStickerCatalogPaths,
  saveStickersFromInbox,
  sniffStickerMime,
  updateStickers,
} from '../src/stickerCatalog.mjs';

const pngBytes = () => Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const gifBytes = () => Buffer.from('GIF89a0000', 'ascii');
const webpBytes = () => Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
]);

function tempEnv(t, extra = {}) {
  const base = path.join(process.cwd(), '.tmp-test-stickers');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    try {
      fs.rmdirSync(base);
    } catch {
      // Other tests may still own sibling temp dirs.
    }
  });
  return {
    RAN_AGENT_ROOT: root,
    RAN_AGENT_STATE_DIR: path.join(root, '.ran_agent_state'),
    ...extra,
  };
}

function writeInboxFile(env, name, bytes, platform = 'wechat') {
  const inboxDir = path.join(env.RAN_AGENT_STATE_DIR, platform, 'inbound');
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

test('initializes an empty sticker catalog', (t) => {
  const env = tempEnv(t);
  const paths = ensureStickerCatalog(env);

  assert.equal(paths.root, path.join(env.RAN_AGENT_STATE_DIR, 'stickers'));
  assert.equal(fs.statSync(paths.assetsDir).isDirectory(), true);
  assert.equal(fs.statSync(paths.trashDir).isDirectory(), true);
  assert.deepEqual(readStickerIndex(env), {});
  assert.deepEqual(readStickerTags(env), {});
  assert.deepEqual(readStickerHashes(env), {});
});

test('atomicWriteJson leaves a valid final JSON file', (t) => {
  const env = tempEnv(t);
  const { indexFile } = ensureStickerCatalog(env);

  atomicWriteJson(indexFile, { first: true });
  atomicWriteJson(indexFile, { second: { ok: true } });

  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), { second: { ok: true } });
  assert.deepEqual(fs.readdirSync(path.dirname(indexFile)).filter((name) => name.includes('.tmp-')), []);
});

test('accepts supported image magic bytes and rejects unsafe or unknown content', () => {
  assert.equal(sniffStickerMime(pngBytes()), 'image/png');
  assert.equal(sniffStickerMime(jpegBytes()), 'image/jpeg');
  assert.equal(sniffStickerMime(gifBytes()), 'image/gif');
  assert.equal(sniffStickerMime(webpBytes()), 'image/webp');

  assert.throws(() => sniffStickerMime(Buffer.from('<svg><script /></svg>', 'utf8')), /unsupported sticker mime/i);
  assert.throws(() => sniffStickerMime(Buffer.from('<html><body>x</body></html>', 'utf8')), /unsupported sticker mime/i);
  assert.throws(() => sniffStickerMime(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), /unsupported sticker mime/i);
});

test('rejects files over the configured sticker byte limit', (t) => {
  const env = tempEnv(t, { STICKER_MAX_BYTES: '8' });
  const filePath = writeInboxFile(env, 'too-large.png', pngBytes());

  assert.throws(() => assertStickerFileAllowed(filePath, env), /exceeds sticker byte limit/i);
});

test('saves stickers with generated filenames and ignores source filenames', async (t) => {
  const env = tempEnv(t);
  const sourcePath = writeInboxFile(env, 'user chosen name.svg', pngBytes());

  const result = await saveStickersFromInbox({
    items: [{ filePath: sourcePath, tags: ['开心'], desc: '描述', source: 'manual' }],
  }, { env });

  assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].stickerId, 'stk_001');
  assert.equal(result.saved[0].fileName, 'stk_001.png');
  assert.equal(result.saved[0].mime, 'image/png');
  assert.equal(path.basename(result.saved[0].fileName), result.saved[0].fileName);
  assert.equal(fs.existsSync(path.join(resolveStickerCatalogPaths(env).assetsDir, 'stk_001.png')), true);
});

test('deduplicates saved stickers by sha256', async (t) => {
  const env = tempEnv(t);
  const first = writeInboxFile(env, 'first.png', pngBytes());
  const second = writeInboxFile(env, 'second.gif', pngBytes());

  const one = await saveStickersFromInbox({ items: [{ filePath: first, tags: ['开心'] }] }, { env });
  const two = await saveStickersFromInbox({ items: [{ filePath: second, tags: ['快乐'] }] }, { env });

  assert.equal(one.saved[0].stickerId, 'stk_001');
  assert.equal(two.saved.length, 0);
  assert.equal(two.duplicates[0].stickerId, 'stk_001');
  assert.equal(Object.keys(readStickerIndex(env)).length, 1);
  assert.equal(Object.keys(readStickerHashes(env)).length, 1);
});

test('saves explicitly requested stickers from Feishu inbound media', async (t) => {
  const env = tempEnv(t);
  const sourcePath = writeInboxFile(env, 'feishu-funny.gif', gifBytes(), 'feishu');

  const result = await saveStickersFromInbox({
    items: [{ filePath: sourcePath, tags: ['飞书'], desc: '飞书入站表情', source: 'feishu' }],
  }, { env });

  assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].stickerId, 'stk_001');
  assert.equal(result.saved[0].mime, 'image/gif');
  assert.equal(result.saved[0].source, 'feishu');
  assert.equal(fs.existsSync(path.join(resolveStickerCatalogPaths(env).assetsDir, 'stk_001.gif')), true);
});

test('lists tags and picks stickers by tag or query without absolute paths', async (t) => {
  const env = tempEnv(t);
  const happy = writeInboxFile(env, 'happy.png', pngBytes());
  const shrug = writeInboxFile(env, 'shrug.gif', gifBytes());
  await saveStickersFromInbox({
    items: [
      { filePath: happy, tags: ['开心', '常用'], desc: '快乐小图' },
      { filePath: shrug, tags: ['无语'], desc: '摊手表情' },
    ],
  }, { env });

  assert.deepEqual(listStickerTags({ env }), [
    { tag: '开心', count: 1 },
    { tag: '常用', count: 1 },
    { tag: '无语', count: 1 },
  ]);

  const byTag = pickStickers({ tag: '开心', limit: 5 }, { env });
  const byQuery = pickStickers({ query: '摊手', limit: 5 }, { env });

  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].stickerId, 'stk_001');
  assert.equal(byQuery[0].stickerId, 'stk_002');
  for (const sticker of [...byTag, ...byQuery, ...listStickers({}, { env })]) {
    assert.equal('filePath' in sticker, false);
    assert.equal(path.isAbsolute(sticker.fileName), false);
  }
});

test('updates sticker tags and description', async (t) => {
  const env = tempEnv(t);
  const filePath = writeInboxFile(env, 'happy.png', pngBytes());
  await saveStickersFromInbox({ items: [{ filePath, tags: ['旧'], desc: 'old' }] }, { env });

  const result = updateStickers({
    items: [{ stickerId: 'stk_001', tags: ['新', '常用'], desc: 'new desc' }],
  }, { env });

  assert.equal(result.updated.length, 1);
  const entry = readStickerIndex(env).stk_001;
  assert.deepEqual(entry.tags, ['新', '常用']);
  assert.equal(entry.desc, 'new desc');
  assert.deepEqual(readStickerTags(env), { '常用': ['stk_001'], '新': ['stk_001'] });
});

test('soft deletes stickers into trash by default', async (t) => {
  const env = tempEnv(t);
  const filePath = writeInboxFile(env, 'happy.png', pngBytes());
  await saveStickersFromInbox({ items: [{ filePath, tags: ['开心'] }] }, { env });
  const paths = resolveStickerCatalogPaths(env);

  const result = deleteStickers({ items: [{ stickerId: 'stk_001' }] }, { env });

  assert.deepEqual(result.deleted, ['stk_001']);
  assert.equal(fs.existsSync(path.join(paths.assetsDir, 'stk_001.png')), false);
  assert.equal(fs.existsSync(path.join(paths.trashDir, 'stk_001.png')), true);
  assert.equal(readStickerIndex(env).stk_001.status, 'deleted');
  assert.equal(readStickerHashes(env)[result.deleted[0]], undefined);
});

test('refuses to resolve catalog assets outside the assets directory', (t) => {
  const env = tempEnv(t);
  const paths = ensureStickerCatalog(env);
  const outside = path.join(env.RAN_AGENT_ROOT, 'outside.png');
  fs.writeFileSync(outside, pngBytes());
  atomicWriteJson(paths.indexFile, {
    stk_001: {
      stickerId: 'stk_001',
      tags: [],
      desc: '',
      fileName: '../outside.png',
      mime: 'image/png',
      sha256: 'x',
      bytes: pngBytes().length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'manual',
    },
  });

  assert.throws(() => resolveStickerAsset('stk_001', { env }), /outside sticker assets/i);
});

test('rejects save from paths outside trusted inbound directories', async (t) => {
  const env = tempEnv(t);
  const outsideDir = path.join(env.RAN_AGENT_ROOT, 'uploads');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsidePath = path.join(outsideDir, 'sticker.png');
  fs.writeFileSync(outsidePath, pngBytes());

  await assert.rejects(
    () => saveStickersFromInbox({ items: [{ filePath: outsidePath, tags: ['开心'] }] }, { env }),
    /outside trusted inbound media directories/i
  );
});

test('enforces save and delete batch limits', async (t) => {
  const env = tempEnv(t);
  const items = Array.from({ length: 11 }, (_, index) => ({
    filePath: writeInboxFile(env, `file-${index}.png`, Buffer.concat([pngBytes(), Buffer.from([index])])),
  }));
  assert.rejects(() => saveStickersFromInbox({ items }, { env }), /at most 10/i);

  const deleteItems = Array.from({ length: 51 }, (_, index) => ({ stickerId: `stk_${String(index).padStart(3, '0')}` }));
  assert.throws(() => deleteStickers({ items: deleteItems }, { env }), /at most 50/i);
});
