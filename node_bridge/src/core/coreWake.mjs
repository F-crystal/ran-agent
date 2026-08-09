import fs from 'node:fs';

import { assertCoreCutoverCommitted } from './coreCutover.mjs';
import { openCoreDatabase } from './coreDb.mjs';
import { coreError } from './coreErrors.mjs';
import { resolveCoreDbPath } from './corePaths.mjs';
import { createCoreSchedulingService } from './coreScheduling.mjs';

export async function wakeCommittedCore({ core, batchSize = 32 } = {}) {
  assertCoreCutoverCommitted(core);
  const results = await createCoreSchedulingService({ core, batchSize }).wakeDue();
  return Object.freeze({
    checked: true,
    schedules: results.length,
    occurrences: results.reduce((count, item) => count + (item.occurrences?.length || 0), 0),
    occurrenceIds: Object.freeze(results.flatMap((item) => item.occurrences || [])
      .map((item) => item.wake_occurrence_id)),
  });
}

export async function runCoreWakeFromEnvironment(env = process.env) {
  if (env.RAN_AGENT_CORE_WAKE_ENABLED !== 'true') {
    throw coreError('CORE_WAKE_DISABLED', 'managed Core wake is disabled');
  }
  const dbPath = resolveCoreDbPath(env.RAN_AGENT_STATE_DIR);
  if (!fs.existsSync(dbPath)) {
    throw coreError('CORE_WAKE_DATABASE_MISSING', 'managed Core wake requires an existing database');
  }
  const core = openCoreDatabase({ dbPath });
  try {
    return await wakeCommittedCore({ core });
  } finally {
    await core.close();
  }
}
