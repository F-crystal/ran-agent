import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCoreManagedWakeManifest } from '../../src/core/coreManagedWakeManifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST = path.join(REPO_ROOT, 'docs/governance/core_managed_wake.v1.json');

test('managed wake projection is one paused local no-agent Hermes job', () => {
  const manifest = loadCoreManagedWakeManifest(MANIFEST, { repoRoot: REPO_ROOT });
  assert.equal(manifest.job.enabled, false);
  assert.equal(manifest.job.no_agent, true);
  assert.equal(manifest.job.deliver, 'local');
  assert.match(fs.readFileSync(path.join(REPO_ROOT, manifest.job.scriptSource), 'utf8'),
    /node-v22\.22\.2-linux-x64\/bin\/node \/opt\/ran_agent\/scripts\/core-wake\.mjs/);
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'hermes/profile/config.companion.yaml'), 'utf8'),
    /cron:\n  script_timeout_seconds: 30/);
});
