#!/usr/bin/env node

import { validateOwnerBindingPreflight } from '../node_bridge/src/identityMap.mjs';

const mode = process.argv[2];
if (!['--module-only', '--owner-binding'].includes(mode)) {
  process.stderr.write('candidate-preflight-invalid-mode\n');
  process.exit(2);
}
if (typeof validateOwnerBindingPreflight !== 'function') {
  process.stderr.write('candidate-owner-preflight-incompatible\n');
  process.exit(1);
}
if (mode === '--owner-binding' && !validateOwnerBindingPreflight().ok) {
  process.stderr.write('owner-binding-required\n');
  process.exit(1);
}
process.stdout.write(`candidate-preflight-ok mode=${mode === '--module-only' ? 'module' : 'owner'}\n`);
