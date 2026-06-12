import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from './runtimeState.mjs';
import { isPathInsideRoot, resolveProjectRoot } from './trustedMediaPaths.mjs';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_SAVE_ITEMS = 10;
const MAX_DELETE_ITEMS = 50;
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_STICKER_SOURCE_DIRS = [
  '.ran_agent_state/wechat/inbound',
  '.ran_agent_state/feishu/inbound',
  '.ran_agent_state/ran-agent-weixin/media',
  'debug/wechat/inbound',
];
const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const VALID_SOURCES = new Set(['manual', 'wechat', 'feishu', 'import']);

function parsePositiveInteger(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeTags(tags) {
  const seen = new Set();
  const normalized = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isActiveSticker(entry) {
  return entry && entry.status !== 'deleted';
}

function publicSticker(entry) {
  const payload = {
    stickerId: entry.stickerId,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    desc: String(entry.desc || ''),
    fileName: path.basename(String(entry.fileName || '')),
    mime: entry.mime,
    sha256: entry.sha256,
    bytes: entry.bytes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    source: entry.source,
  };
  if (entry.status) {
    payload.status = entry.status;
  }
  return payload;
}

function buildTags(index) {
  const tags = {};
  for (const entry of Object.values(index)) {
    if (!isActiveSticker(entry)) {
      continue;
    }
    for (const tag of normalizeTags(entry.tags)) {
      if (!tags[tag]) {
        tags[tag] = [];
      }
      tags[tag].push(entry.stickerId);
    }
  }
  return tags;
}

function buildHashes(index) {
  const hashes = {};
  for (const entry of Object.values(index)) {
    if (isActiveSticker(entry) && entry.sha256) {
      hashes[entry.sha256] = entry.stickerId;
    }
  }
  return hashes;
}

function writeCatalogJson(paths, index) {
  atomicWriteJson(paths.indexFile, index);
  atomicWriteJson(paths.tagsFile, buildTags(index));
  atomicWriteJson(paths.hashesFile, buildHashes(index));
}

function nextStickerId(index) {
  let max = 0;
  for (const stickerId of Object.keys(index)) {
    const match = /^stk_(\d+)$/.exec(stickerId);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `stk_${String(max + 1).padStart(3, '0')}`;
}

function assertInsideDirectory(childPath, parentDir, message) {
  const realChild = fs.realpathSync(childPath);
  const realParent = fs.realpathSync(parentDir);
  const parentPrefix = realParent.endsWith(path.sep) ? realParent : `${realParent}${path.sep}`;
  if (realChild !== realParent && !realChild.startsWith(parentPrefix)) {
    throw new Error(message);
  }
  return realChild;
}

function writeEmptyJsonIfMissing(filePath) {
  if (!fs.existsSync(filePath)) {
    atomicWriteJson(filePath, {});
  }
}

function normalizeAllowedSourceDirs(env = process.env) {
  const projectRoot = resolveProjectRoot(env);
  const configured = String(env.STICKER_INBOX_ALLOWED_DIRS || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const entries = configured.length > 0 ? configured : DEFAULT_STICKER_SOURCE_DIRS;
  const seen = new Set();
  return entries
    .map((entry) => path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(projectRoot, entry))
    .filter((dir) => isPathInsideRoot(dir, projectRoot))
    .filter((dir) => {
      if (seen.has(dir)) {
        return false;
      }
      seen.add(dir);
      return true;
    });
}

function assertTrustedStickerSourcePath(filePath, env = process.env) {
  const realPath = fs.realpathSync(filePath);
  const allowedDirs = normalizeAllowedSourceDirs(env)
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => fs.realpathSync(dir));
  if (!allowedDirs.some((dir) => isPathInsideRoot(realPath, dir))) {
    throw new Error('sticker source file is outside trusted inbound media directories');
  }
  return realPath;
}

export function resolveStickerCatalogPaths(env = process.env) {
  const root = path.join(resolveStateDir(env), 'stickers');
  return {
    root,
    assetsDir: path.join(root, 'assets'),
    trashDir: path.join(root, 'trash'),
    indexFile: path.join(root, 'index.json'),
    tagsFile: path.join(root, 'tags.json'),
    hashesFile: path.join(root, 'hashes.json'),
  };
}

export function ensureStickerCatalog(env = process.env) {
  const paths = resolveStickerCatalogPaths(env);
  fs.mkdirSync(paths.assetsDir, { recursive: true });
  fs.mkdirSync(paths.trashDir, { recursive: true });
  writeEmptyJsonIfMissing(paths.indexFile);
  writeEmptyJsonIfMissing(paths.tagsFile);
  writeEmptyJsonIfMissing(paths.hashesFile);
  return paths;
}

export function readStickerIndex(env = process.env) {
  return readJsonFile(ensureStickerCatalog(env).indexFile, {});
}

export function readStickerTags(env = process.env) {
  return readJsonFile(ensureStickerCatalog(env).tagsFile, {});
}

export function readStickerHashes(env = process.env) {
  return readJsonFile(ensureStickerCatalog(env).hashesFile, {});
}

export function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function sniffStickerMime(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('unsupported sticker mime: input must be a buffer');
  }
  const textPrefix = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (textPrefix.startsWith('<svg') || textPrefix.startsWith('<?xml') || textPrefix.startsWith('<!doctype html') || textPrefix.startsWith('<html')) {
    throw new Error('unsupported sticker mime: text markup is not allowed');
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('unsupported sticker mime: unknown or unsafe binary content');
}

export function assertStickerFileAllowed(filePath, env = process.env) {
  const rawPath = normalizeText(filePath);
  if (!rawPath) {
    throw new Error('sticker file path is required');
  }
  if (!fs.existsSync(rawPath)) {
    throw new Error('sticker file does not exist');
  }
  const realPath = fs.realpathSync(rawPath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error('sticker path must point to a file');
  }
  const maxBytes = parsePositiveInteger(env.STICKER_MAX_BYTES, DEFAULT_MAX_BYTES);
  if (stat.size > maxBytes) {
    throw new Error(`sticker file exceeds sticker byte limit: ${stat.size} > ${maxBytes}`);
  }
  const buffer = fs.readFileSync(realPath);
  const mime = sniffStickerMime(buffer);
  if (!ALLOWED_MIMES.has(mime)) {
    throw new Error(`unsupported sticker mime: ${mime}`);
  }
  return { filePath: realPath, mime, bytes: stat.size, buffer };
}

export async function saveStickersFromInbox({ items } = {}, options = {}) {
  const env = options.env || process.env;
  const requestedItems = Array.isArray(items) ? items : [];
  if (requestedItems.length > MAX_SAVE_ITEMS) {
    throw new Error(`saveStickersFromInbox accepts at most ${MAX_SAVE_ITEMS} items`);
  }
  const paths = ensureStickerCatalog(env);
  const index = readStickerIndex(env);
  const hashes = buildHashes(index);
  const saved = [];
  const duplicates = [];

  for (const item of requestedItems) {
    const allowed = assertStickerFileAllowed(item?.filePath, env);
    assertTrustedStickerSourcePath(allowed.filePath, env);
    const sha256 = crypto.createHash('sha256').update(allowed.buffer).digest('hex');
    const existingId = hashes[sha256];
    if (existingId && isActiveSticker(index[existingId])) {
      duplicates.push(publicSticker(index[existingId]));
      continue;
    }

    const stickerId = nextStickerId(index);
    const extension = MIME_EXTENSIONS[allowed.mime];
    const fileName = `${stickerId}.${extension}`;
    const assetPath = path.join(paths.assetsDir, fileName);
    fs.copyFileSync(allowed.filePath, assetPath);
    assertInsideDirectory(assetPath, paths.assetsDir, 'catalog asset resolved outside sticker assets directory');

    const now = new Date().toISOString();
    const entry = {
      stickerId,
      tags: normalizeTags(item?.tags),
      desc: normalizeText(item?.desc),
      fileName,
      mime: allowed.mime,
      sha256,
      bytes: allowed.bytes,
      createdAt: now,
      updatedAt: now,
      source: VALID_SOURCES.has(item?.source) ? item.source : 'manual',
    };
    index[stickerId] = entry;
    hashes[sha256] = stickerId;
    saved.push(publicSticker(entry));
  }

  writeCatalogJson(paths, index);
  return { saved, duplicates };
}

export function listStickerTags(options = {}) {
  const env = options.env || process.env;
  const tags = readStickerTags(env);
  return Object.entries(tags).map(([tag, ids]) => ({
    tag,
    count: Array.isArray(ids) ? ids.length : 0,
  }));
}

export function pickStickers({ tag = '', query = '', limit = 10 } = {}, options = {}) {
  return listStickers({ tag, query, limit }, options);
}

export function updateStickers({ items } = {}, options = {}) {
  const env = options.env || process.env;
  const paths = ensureStickerCatalog(env);
  const index = readStickerIndex(env);
  const updated = [];
  for (const item of Array.isArray(items) ? items : []) {
    const stickerId = normalizeText(item?.stickerId);
    const entry = index[stickerId];
    if (!isActiveSticker(entry)) {
      continue;
    }
    if ('tags' in item) {
      entry.tags = normalizeTags(item.tags);
    }
    if ('desc' in item) {
      entry.desc = normalizeText(item.desc);
    }
    entry.updatedAt = new Date().toISOString();
    updated.push(publicSticker(entry));
  }
  writeCatalogJson(paths, index);
  return { updated };
}

export function deleteStickers({ items, hardDelete = false } = {}, options = {}) {
  const env = options.env || process.env;
  const requestedItems = Array.isArray(items) ? items : [];
  if (requestedItems.length > MAX_DELETE_ITEMS) {
    throw new Error(`deleteStickers accepts at most ${MAX_DELETE_ITEMS} items`);
  }
  const paths = ensureStickerCatalog(env);
  const index = readStickerIndex(env);
  const deleted = [];

  for (const item of requestedItems) {
    const stickerId = normalizeText(item?.stickerId || item);
    const entry = index[stickerId];
    if (!isActiveSticker(entry)) {
      continue;
    }

    const assetPath = path.join(paths.assetsDir, path.basename(String(entry.fileName || '')));
    if (fs.existsSync(assetPath)) {
      assertInsideDirectory(assetPath, paths.assetsDir, 'catalog asset resolved outside sticker assets directory');
      if (hardDelete) {
        fs.unlinkSync(assetPath);
      } else {
        let trashPath = path.join(paths.trashDir, path.basename(assetPath));
        if (fs.existsSync(trashPath)) {
          trashPath = path.join(paths.trashDir, `${stickerId}-${Date.now()}-${path.basename(assetPath)}`);
        }
        fs.renameSync(assetPath, trashPath);
        assertInsideDirectory(trashPath, paths.trashDir, 'deleted sticker resolved outside sticker trash directory');
      }
    }

    if (hardDelete) {
      delete index[stickerId];
    } else {
      entry.status = 'deleted';
      entry.deletedAt = new Date().toISOString();
      entry.updatedAt = entry.deletedAt;
    }
    deleted.push(stickerId);
  }

  writeCatalogJson(paths, index);
  return { deleted };
}

export function listStickers({ tag = '', query = '', status = 'active', limit = 50 } = {}, options = {}) {
  const env = options.env || process.env;
  const normalizedTag = normalizeText(tag);
  const normalizedQuery = normalizeText(query).toLowerCase();
  const normalizedStatus = normalizeText(status) || 'active';
  const normalizedLimit = Math.max(0, parsePositiveInteger(limit, 50));
  const index = readStickerIndex(env);
  const results = [];

  for (const entry of Object.values(index)) {
    const active = isActiveSticker(entry);
    if (normalizedStatus === 'active' && !active) {
      continue;
    }
    if (normalizedStatus === 'deleted' && active) {
      continue;
    }
    if (normalizedStatus === 'all') {
      // Include all entries.
    } else if (!['active', 'deleted'].includes(normalizedStatus)) {
      continue;
    }
    const tags = normalizeTags(entry.tags);
    if (normalizedTag && !tags.includes(normalizedTag)) {
      continue;
    }
    if (normalizedQuery) {
      const haystack = `${entry.stickerId} ${entry.desc || ''} ${tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        continue;
      }
    }
    results.push(publicSticker(entry));
    if (results.length >= normalizedLimit) {
      break;
    }
  }
  return results;
}

export function resolveStickerAsset(stickerId, options = {}) {
  const env = options.env || process.env;
  const paths = ensureStickerCatalog(env);
  const entry = readStickerIndex(env)[normalizeText(stickerId)];
  if (!isActiveSticker(entry)) {
    throw new Error('sticker not found');
  }
  const fileName = path.basename(String(entry.fileName || ''));
  if (!fileName || fileName !== entry.fileName) {
    throw new Error('catalog asset resolved outside sticker assets directory');
  }
  const filePath = path.join(paths.assetsDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error('sticker asset file does not exist');
  }
  const realPath = assertInsideDirectory(filePath, paths.assetsDir, 'catalog asset resolved outside sticker assets directory');
  return {
    ...publicSticker(entry),
    filePath: realPath,
  };
}
