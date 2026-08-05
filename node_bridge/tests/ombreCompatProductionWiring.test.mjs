import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getOmbreCompatConfig } from '../src/ombreCompat/config.mjs';

const root = new URL('../..', import.meta.url).pathname;
const projectFile = (path) => readFileSync(join(root, path), 'utf8');

test('O2 defaults to the canonical Steward and existing tool-less DeepSeek provider', () => {
  const state = join(root, '.ran-agent-state-fixture');
  const config = getOmbreCompatConfig({
    RAN_AGENT_STATE_DIR: state,
    HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'shared-deepseek-key',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.stateDir, join(state, 'ombre-compat'));
  assert.equal(config.stewardIdentityFile, join(state, 'ombre-brain', 'steward-identity.v1.json'));
  assert.deepEqual(config.curator, {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKey: 'shared-deepseek-key',
    timeoutMs: 30000,
  });
  assert.deepEqual(config.reviewer, config.curator);

  const provider = projectFile('hermes/profile/plugins/model-providers/deepseek/__init__.py');
  assert.match(provider, /env_vars=\("DEEPSEEK_API_KEY",\)/);
  assert.match(provider, /base_url="https:\/\/api\.deepseek\.com\/v1"/);
  assert.match(provider, /"thinking": \{"type": "disabled"\}/);
  assert.match(provider, /"response_format": \{"type": "json_object"\}/);
});

test('O2 production auth prefers the shared provider key over stale stage-specific keys', () => {
  const sharedKey = 'shared-provider-key-fixture';
  const staleStageKey = 'stale-stage-key-fixture';
  const config = getOmbreCompatConfig({
    DEEPSEEK_API_KEY: sharedKey,
    OMBRE_COMPAT_CURATOR_API_KEY: staleStageKey,
    OMBRE_COMPAT_REVIEWER_API_KEY: staleStageKey,
  });
  assert.equal(config.curator.apiKey, sharedKey);
  assert.equal(config.reviewer.apiKey, sharedKey);
  assert.notEqual(config.curator.apiKey, staleStageKey);
  assert.notEqual(config.reviewer.apiKey, staleStageKey);
});

function writeManagedCompatEnv({ existing = '', existingRoot = existing, existingBridge = existing, deployEnabled } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-o2-env-'));
  const nodeEnv = join(dir, 'node.env');
  const bridgeEnv = join(dir, 'bridge.env');
  const state = join(dir, 'state');
  writeFileSync(nodeEnv, existingRoot);
  writeFileSync(bridgeEnv, existingBridge);
  const commands = [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export RAN_AGENT_REPO_ROOT=${JSON.stringify(root)}`,
    `export RAN_AGENT_DEPLOY_STATE_DIR=${JSON.stringify(state)}`,
    `export RAN_AGENT_STATE_DIR=${JSON.stringify(state)}`,
    `export RAN_AGENT_NODE_ENV_FILE=${JSON.stringify(nodeEnv)}`,
    `export RAN_AGENT_NODE_BRIDGE_ENV_FILE=${JSON.stringify(bridgeEnv)}`,
    ...(deployEnabled === undefined
      ? []
      : [`export RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED=${JSON.stringify(deployEnabled)}`]),
    'source scripts/apply-hermes-runtime-split.sh',
    'validate_ombre_compat_contract',
    'write_ombre_compat_env',
  ];
  execFileSync('bash', ['-lc', commands.join('\n')], { cwd: root, stdio: 'pipe' });
  return { node: readFileSync(nodeEnv, 'utf8'), bridge: readFileSync(bridgeEnv, 'utf8'), state };
}

test('official apply writes a runnable O2 contract while preserving safe operator values', () => {
  const initial = writeManagedCompatEnv({
    existing: 'UNRELATED_SECRET=keep\nHERMES_PROVIDER=deepseek\nOMBRE_COMPAT_CURATOR_BASE_URL=https://unsafe.invalid/v1\n',
  });
  for (const env of [initial.node, initial.bridge]) {
    assert.match(env, /^OMBRE_COMPAT_ENABLED=true$/m);
    assert.match(env, new RegExp(`^OMBRE_COMPAT_STATE_DIR=${initial.state}/ombre-compat$`, 'm'));
    assert.match(env, new RegExp(`^OMBRE_COMPAT_STEWARD_IDENTITY_FILE=${initial.state}/ombre-brain/steward-identity\\.v1\\.json$`, 'm'));
    assert.match(env, /^OMBRE_COMPAT_STEWARD_ENDPOINT=http:\/\/127\.0\.0\.1:18001\/internal\/ran-agent\/steward\/v1$/m);
    assert.match(env, /^OMBRE_COMPAT_CURATOR_BASE_URL=https:\/\/api\.deepseek\.com\/v1$/m);
    assert.match(env, /^OMBRE_COMPAT_CURATOR_MODEL=deepseek-v4-flash$/m);
    assert.match(env, /^OMBRE_COMPAT_REVIEWER_BASE_URL=https:\/\/api\.deepseek\.com\/v1$/m);
    assert.match(env, /^OMBRE_COMPAT_REVIEWER_MODEL=deepseek-v4-flash$/m);
    assert.match(env, /^UNRELATED_SECRET=keep$/m);
    assert.match(env, /^HERMES_PROVIDER=deepseek$/m);
    assert.doesNotMatch(env, /unsafe\.invalid/);
  }

  const rootDisabled = writeManagedCompatEnv({
    existingRoot: 'OMBRE_COMPAT_ENABLED=false\n',
    existingBridge: '',
  });
  for (const env of [rootDisabled.node, rootDisabled.bridge]) assert.match(env, /^OMBRE_COMPAT_ENABLED=false$/m);

  const bridgeWins = writeManagedCompatEnv({
    existingRoot: 'OMBRE_COMPAT_ENABLED=true\n',
    existingBridge: 'OMBRE_COMPAT_ENABLED=false\n',
  });
  for (const env of [bridgeWins.node, bridgeWins.bridge]) assert.match(env, /^OMBRE_COMPAT_ENABLED=false$/m);

  const overridden = writeManagedCompatEnv({
    existingRoot: 'OMBRE_COMPAT_ENABLED=false\n',
    existingBridge: 'OMBRE_COMPAT_ENABLED=false\n',
    deployEnabled: 'true',
  });
  for (const env of [overridden.node, overridden.bridge]) assert.match(env, /^OMBRE_COMPAT_ENABLED=true$/m);

  assert.throws(
    () => writeManagedCompatEnv({ existingRoot: 'OMBRE_COMPAT_ENABLED=maybe\n', existingBridge: '' }),
    /Command failed/,
  );
});

test('release defaults to Flash, manages O2 transactionally, and accepts it read-only', () => {
  const apply = projectFile('scripts/apply-hermes-runtime-split.sh');
  const deploy = projectFile('scripts/deploy-hermes-release.sh');
  const accept = projectFile('scripts/accept-hermes-release.sh');
  const diagnose = projectFile('scripts/diagnose-ombre-memory.sh');

  assert.match(apply, /MODEL_NAME="\$\{RAN_AGENT_DEPLOY_HERMES_MODEL:-deepseek-v4-flash\}"/);
  assert.match(deploy, /DEPLOY_MODEL="\$\{RAN_AGENT_DEPLOY_HERMES_MODEL:-deepseek-v4-flash\}"/);
  assert.match(accept, /EXPECTED_MODEL="\$\{RAN_AGENT_EXPECTED_HERMES_MODEL:-deepseek-v4-flash\}"/);
  assert.match(deploy, /Environment=OMBRE_COMPAT_ENABLED=false/);
  assert.match(deploy, /RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED="\$DEPLOY_OMBRE_COMPAT_ENABLED"/);
  assert.match(deploy, /rm -f -- "\$OMBRE_INGRESS_DROPIN"/);
  assert.match(deploy, /test -e "\$OMBRE_INGRESS_DROPIN" \|\| "\$\{SUDO\[@\]\}" test -L "\$OMBRE_INGRESS_DROPIN"/);
  const applyTransaction = deploy.slice(deploy.lastIndexOf('\nrequire_apply_prerequisites\n'));
  assert.ok(applyTransaction.indexOf('require_apply_prerequisites') < applyTransaction.indexOf('snapshot_runtime_state'));
  assert.match(apply, /Environment=OMBRE_COMPAT_STEWARD_IDENTITY_FILE=\$OMBRE_BRAIN_HOME_DEFAULT\/steward-identity\.v1\.json/);
  assert.match(diagnose, /managed O2 config: VALID/);
  assert.match(diagnose, /managed O2 config: DISABLED/);

  const dir = mkdtempSync(join(tmpdir(), 'ombre-o2-legacy-identity-'));
  const systemd = join(dir, 'systemd');
  const dropin = join(systemd, 'ran-agent-node.service.d', '99-ombre-steward-identity.conf');
  mkdirSync(join(dropin, '..'), { recursive: true });
  writeFileSync(dropin, '[Service]\nUser=ran-agent\nGroup=ran-agent\nEnvironment=OMBRE_COMPAT_ENABLED=true\n');
  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export RAN_AGENT_REPO_ROOT=${JSON.stringify(root)}`,
    `export SYSTEMD_DIR=${JSON.stringify(systemd)}`,
    'export RAN_AGENT_RUNTIME_USER=ubuntu',
    'export RAN_AGENT_RUNTIME_GROUP=ubuntu',
    'source scripts/apply-hermes-runtime-split.sh',
    'write_node_steward_identity_dropin',
  ].join('\n')], { cwd: root, stdio: 'pipe' });
  const rewrittenDropin = readFileSync(dropin, 'utf8');
  assert.match(rewrittenDropin, /^User=ubuntu$/m);
  assert.match(rewrittenDropin, /^Group=ubuntu$/m);
  assert.match(rewrittenDropin, /RAN_AGENT_STEWARD_TOKEN_FILE=/);
  assert.doesNotMatch(rewrittenDropin, /^(?:User|Group)=ran-agent$/m);
  rmSync(dir, { recursive: true, force: true });

  const acceptanceBody = accept.slice(
    accept.indexOf('release_ombre_compat_contract()'),
    accept.indexOf('release_steward_identity_contract()'),
  );
  assert.match(acceptanceBody, /\/proc\/\$pid_before\/environ/);
  assert.match(acceptanceBody, /stat -c/);
  assert.ok(acceptanceBody.indexOf('EXPECTED_OMBRE_COMPAT_ENABLED" = true') < acceptanceBody.indexOf('DEEPSEEK_API_KEY'));
  assert.doesNotMatch(acceptanceBody, /curl|chat\/completions|POST|--data/);
});

test('release residue guard rejects regular and broken-symlink rotation drop-ins', () => {
  const deploy = projectFile('scripts/deploy-hermes-release.sh');
  const helper = deploy.match(/require_ombre_ingress_dropin_absent\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const dir = mkdtempSync(join(tmpdir(), 'ombre-o2-residue-'));
  const dropin = join(dir, '98-ombre-steward-rotation.conf');
  const invokeGuard = () => execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'SUDO=(env)',
    `OMBRE_INGRESS_DROPIN=${JSON.stringify(dropin)}`,
    "fail() { printf 'failed:%s\\n' \"$1\" >&2; return 1; }",
    helper,
    'require_ombre_ingress_dropin_absent',
  ].join('\n')], { cwd: root, stdio: 'pipe' });

  invokeGuard();
  writeFileSync(dropin, 'unknown prior state\n');
  assert.throws(invokeGuard, /Command failed/);
  rmSync(dropin);
  symlinkSync(join(dir, 'missing-target'), dropin);
  assert.throws(invokeGuard, /Command failed/);
  rmSync(dir, { recursive: true, force: true });
});
