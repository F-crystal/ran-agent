import fs from 'node:fs';

import { assertCoreCutoverCommitted } from './coreCutover.mjs';
import { openCoreDatabase } from './coreDb.mjs';
import { coreError } from './coreErrors.mjs';
import { createCoreContentHasher } from './packageB/packageBNodeDeliveryService.mjs';
import { resolveCoreDbPath } from './corePaths.mjs';

export async function openCommittedCoreRuntime(env = process.env) {
  if (env.RAN_AGENT_CORE_ENABLED !== 'true') return null;
  const dbPath = resolveCoreDbPath(env.RAN_AGENT_STATE_DIR);
  if (!fs.existsSync(dbPath)) {
    throw coreError('CORE_RUNTIME_DATABASE_MISSING', 'enabled Core runtime requires an existing database');
  }
  const core = openCoreDatabase({ dbPath });
  try {
    assertCoreCutoverCommitted(core);
    const hashContent = createCoreContentHasher({
      keyId: env.RAN_AGENT_CORE_HASH_KEY_ID,
      key: env.RAN_AGENT_CORE_HASH_KEY,
    });
    return Object.freeze({ core, hashContent });
  } catch (error) {
    await core.close();
    throw error;
  }
}

export function bindCoreChannelHub(channelHub, runtime) {
  if (!runtime) return channelHub;
  return (message, options = {}) => channelHub(message, {
    ...options,
    core: runtime.core,
    coreContentHasher: runtime.hashContent,
  });
}
