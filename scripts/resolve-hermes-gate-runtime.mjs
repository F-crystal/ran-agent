#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(reason) {
  process.stderr.write(`resolve-hermes-gate-runtime: failed:${reason}\n`);
  process.exit(1);
}

const [systemctlBin] = process.argv.slice(2);
if (!systemctlBin || !path.isAbsolute(systemctlBin)) fail('systemctl_required');
try {
  fs.accessSync(systemctlBin, fs.constants.X_OK);
} catch {
  fail('systemctl_unavailable');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = path.join(repoRoot, 'scripts', 'resolve-hermes-service-runtime.sh');

function run(command, args, reason) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', RAN_AGENT_SYSTEMCTL_BIN: systemctlBin },
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) fail(reason);
  return result.stdout.trim();
}

const lite = run('/bin/bash', [resolver, 'ran-agent-hermes.service'], 'lite_runtime_required');
const full = run('/bin/bash', [resolver, 'ran-agent-hermes-full.service'], 'full_runtime_required');
let liteReal;
let fullReal;
try {
  liteReal = fs.realpathSync(lite);
  fullReal = fs.realpathSync(full);
} catch {
  fail('runtime_unavailable');
}
if (liteReal !== fullReal) fail('runtime_mismatch');
if (!/^Hermes Agent v0\.13\./.test(run(liteReal, ['version'], 'version_probe_failed'))) {
  fail('Hermes_v0.13_required');
}
process.stdout.write(`${liteReal}\n`);
