import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..');

const DEFAULT_TRUSTED_MEDIA_DIRS = [
  'debug/wechat/inbound',
  'debug/mimo_inbound',
  '.openclaw_state/wechat/inbound',
  '.openclaw_state/openclaw-weixin/media',
];

export function resolveProjectRoot(env = process.env) {
  const explicit = String(env.RAN_AGENT_ROOT || env.PROJECT_ROOT || '').trim();
  return explicit ? path.resolve(explicit) : DEFAULT_PROJECT_ROOT;
}

export function isPathInsideRoot(filePath, rootPath) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(String(filePath || ''));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

export function trustedMediaDirs(env = process.env) {
  const root = resolveProjectRoot(env);
  const configured = String(env.NODE_BRIDGE_TRUSTED_MEDIA_DIRS || env.PERSONAL_AGENT_TRUSTED_MEDIA_DIRS || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const entries = configured.length > 0 ? configured : DEFAULT_TRUSTED_MEDIA_DIRS;
  const seen = new Set();
  return entries
    .map((entry) => path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(root, entry))
    .filter((dir) => isPathInsideRoot(dir, root))
    .filter((dir) => {
      if (seen.has(dir)) {
        return false;
      }
      seen.add(dir);
      return true;
    });
}

export function isTrustedLocalMediaPath(filePath, env = process.env) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    return false;
  }
  return trustedMediaDirs(env).some((dir) => isPathInsideRoot(raw, dir));
}

export function trustedMediaDirsDescription(env = process.env) {
  return trustedMediaDirs(env).join(', ');
}
