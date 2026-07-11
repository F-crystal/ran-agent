#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? '--all';
const suites = Object.freeze({
  '--core': ['coreReliabilityJourney.test.mjs'],
  '--external': ['externalActivityJourney.test.mjs'],
  '--all': ['coreReliabilityJourney.test.mjs', 'externalActivityJourney.test.mjs'],
});
const files = suites[mode];
if (!files) {
  process.stderr.write('hermes-release-smoke: failed:invalid_mode\n');
  process.exitCode = 1;
} else {
  try {
    execFileSync(process.execPath, ['--test', ...files], {
      cwd: join(root, 'node_bridge', 'tests'),
      env: process.env,
      stdio: 'inherit',
    });
    process.stdout.write(`hermes-release-smoke: ${mode.slice(2)}-ok\n`);
  } catch {
    process.stderr.write(`hermes-release-smoke: failed:${mode.slice(2)}\n`);
    process.exitCode = 1;
  }
}
