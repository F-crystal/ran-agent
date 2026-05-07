import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '../runtimeState.mjs';

const DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function resolveMediaCacheDir(env = process.env) {
  const configured = String(env.PERSONAL_AGENT_MEDIA_CACHE_DIR || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(resolveStateDir(env), 'media-reader');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function jsonRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function jsonWrite(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export function createCacheStore(env = process.env) {
  const rootDir = resolveMediaCacheDir(env);
  const ttlSeconds = Number(env.PERSONAL_AGENT_MEDIA_CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);

  function pathFor(...parts) {
    return path.join(rootDir, ...parts);
  }

  function isFresh(payload) {
    const createdAt = Date.parse(String(payload?.created_at || ''));
    if (!Number.isFinite(createdAt)) {
      return false;
    }
    const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds * 1000
      : DEFAULT_CACHE_TTL_SECONDS * 1000;
    return Date.now() - createdAt <= ttlMs;
  }

  return {
    rootDir,
    buildTemporaryUrlKey(normalizedUrl) {
      return sha256Hex(String(normalizedUrl || ''));
    },
    rawMetaPath(temporaryUrlKey) {
      return pathFor('raw', 'by-url', `${temporaryUrlKey}.json`);
    },
    rawContentPath(contentSha256, extension = 'bin') {
      const safeExtension = String(extension || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
      return pathFor('raw', 'by-sha', `${contentSha256}.${safeExtension}`);
    },
    readRawMeta(temporaryUrlKey) {
      const payload = jsonRead(this.rawMetaPath(temporaryUrlKey));
      return payload && isFresh(payload) ? payload : null;
    },
    writeRawMeta(temporaryUrlKey, payload) {
      jsonWrite(this.rawMetaPath(temporaryUrlKey), {
        ...payload,
        created_at: new Date().toISOString(),
      });
    },
    writeRawContent(contentSha256, extension, bytes) {
      const filePath = this.rawContentPath(contentSha256, extension);
      ensureDir(path.dirname(filePath));
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, bytes);
      }
      return filePath;
    },
    analysisKey({ contentSha256, provider = '', model = '', params = {}, promptHash = '' }) {
      return sha256Hex(JSON.stringify({
        content_sha256: contentSha256,
        provider,
        model,
        params,
        prompt_hash: promptHash,
      }));
    },
    analysisPath(kind, provider, model, analysisKey) {
      return pathFor(kind, provider || 'none', model || 'none', `${analysisKey}.json`);
    },
    readAnalysis(kind, provider, model, analysisKey) {
      const payload = jsonRead(this.analysisPath(kind, provider, model, analysisKey));
      return payload && isFresh(payload) ? payload : null;
    },
    writeAnalysis(kind, provider, model, analysisKey, payload) {
      jsonWrite(this.analysisPath(kind, provider, model, analysisKey), {
        ...payload,
        created_at: new Date().toISOString(),
      });
    },
  };
}
