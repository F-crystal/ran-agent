#!/usr/bin/env node

import { runCoreWakeFromEnvironment } from '../node_bridge/src/core/coreWake.mjs';

try {
  const result = await runCoreWakeFromEnvironment();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: String(error?.code || 'CORE_WAKE_FAILED'),
  })}\n`);
  process.exitCode = 1;
}
