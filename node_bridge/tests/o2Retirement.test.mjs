import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtimeFiles = [
  '../src/channelHub.mjs',
  '../src/index.mjs',
  '../../scripts/apply-hermes-runtime-split.sh',
  '../../scripts/hermes-release-gate.sh',
  '../../scripts/start_ombre_brain_service.sh',
];

test('retired O2 has no Node or release-controller seam', () => {
  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ombreCompat|OMBRE_COMPAT|ombre-compat|steward/i, relativePath);
  }
});

test('release acceptance rejects O2 residue while migration scripts only remove it', () => {
  const accept = fs.readFileSync(new URL('../../scripts/accept-hermes-release.sh', import.meta.url), 'utf8');
  assert.match(accept, /retired_o2_process_environment_present/);
  assert.match(accept, /retired_o2_source_present/);

  const deploy = fs.readFileSync(new URL('../../scripts/deploy-hermes-release.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(deploy, /OMBRE_COMPAT|RAN_AGENT_STEWARD|ombreCompat/);
  assert.match(deploy, /--exclude='\.\/ombre-compat'/);

  const prepare = fs.readFileSync(new URL('../../scripts/prepare-ombre-brain.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(prepare, /OMBRE_COMPAT|RAN_AGENT_STEWARD|ombreCompat/);
  assert.match(prepare, /rm -f -- .*steward_api\.py/);
});
