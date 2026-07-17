import path from 'node:path';

import { coreError } from './coreErrors.mjs';

export const CORE_DIRECTORY_MODE = 0o700;
export const CORE_DATABASE_MODE = 0o600;
export const CORE_DATABASE_FILENAME = 'core-state.sqlite3';

export function resolveCoreDbPath(stateDir) {
  const value = String(stateDir || '').trim();
  if (!value) throw coreError('CORE_STATE_DIR_REQUIRED', 'RAN_AGENT_STATE_DIR is required');
  return path.join(path.resolve(value), 'core', CORE_DATABASE_FILENAME);
}
