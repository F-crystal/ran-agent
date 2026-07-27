import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const readProjectFile = (path) => readFileSync(join(root, path), 'utf8');

test('all current Hermes profile sources select DeepSeek V4 Pro', () => {
  for (const path of [
    'hermes/profile/config.yaml',
    'hermes/profile/config.lite.yaml',
    'hermes/profile/config.template.yaml',
    'hermes/profile/config.pro.template.yaml',
  ]) {
    const text = readProjectFile(path);
    assert.match(text, /provider:\s*deepseek/);
    assert.match(text, /default:\s*deepseek-v4-pro/);
    assert.doesNotMatch(text, /default:\s*deepseek-v4-flash/);
  }
});

function applyModelPolicy(model) {
  const dir = mkdtempSync(join(tmpdir(), `hermes-${model}-`));
  const fullHome = join(dir, 'full');
  const liteHome = join(dir, 'lite');
  const nodeEnv = join(dir, 'node.env');
  const bridgeEnv = join(dir, 'bridge.env');
  const configs = [
    [join(fullHome, 'config.yaml'), 'hermes/profile/config.yaml'],
    [join(fullHome, 'profiles', 'ran-assistant', 'config.yaml'), 'hermes/profile/config.yaml'],
    [join(liteHome, 'config.yaml'), 'hermes/profile/config.lite.yaml'],
    [join(liteHome, 'profiles', 'ran-assistant-lite', 'config.yaml'), 'hermes/profile/config.lite.yaml'],
  ];
  for (const [target, source] of configs) {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readProjectFile(source));
  }
  for (const path of [
    nodeEnv, bridgeEnv,
    join(fullHome, '.env'), join(fullHome, 'profiles', 'ran-assistant', '.env'),
    join(liteHome, '.env'), join(liteHome, 'profiles', 'ran-assistant-lite', '.env'),
  ]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'UNRELATED_SECRET=must-survive\nHERMES_DEFAULT_MODEL=stale\n');
  }
  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export RAN_AGENT_REPO_ROOT=${JSON.stringify(root)}`,
    `export RAN_AGENT_DEPLOY_HERMES_MODEL=${JSON.stringify(model)}`,
    `export HERMES_HOME=${JSON.stringify(fullHome)}`,
    `export HERMES_LITE_HOME=${JSON.stringify(liteHome)}`,
    `export RAN_AGENT_NODE_ENV_FILE=${JSON.stringify(nodeEnv)}`,
    `export RAN_AGENT_NODE_BRIDGE_ENV_FILE=${JSON.stringify(bridgeEnv)}`,
    'source scripts/apply-hermes-runtime-split.sh',
    'install_deepseek_provider_plugin',
    'select_installed_profile_models',
    'write_model_policy_env',
    'verify_model_policy',
  ].join('\n')], { cwd: root, stdio: 'pipe' });
  return { fullHome, liteHome, nodeEnv, bridgeEnv, configs };
}

test('Lite and Full install the same provider policy and Pro model contract', () => {
  const fixture = applyModelPolicy('deepseek-v4-pro');
  for (const [path] of fixture.configs) {
    assert.match(readFileSync(path, 'utf8'), /default:\s*deepseek-v4-pro/);
  }
  const fullPlugin = readFileSync(join(fixture.fullHome, 'plugins/model-providers/deepseek/__init__.py'), 'utf8');
  const litePlugin = readFileSync(join(fixture.liteHome, 'plugins/model-providers/deepseek/__init__.py'), 'utf8');
  assert.equal(fullPlugin, litePlugin);
  assert.match(fullPlugin, /"thinking": \{"type": "disabled"\}/);
  for (const path of [fixture.nodeEnv, fixture.bridgeEnv]) {
    const env = readFileSync(path, 'utf8');
    assert.match(env, /^HERMES_DEFAULT_MODEL=deepseek-v4-pro$/m);
    assert.match(env, /^HERMES_DEEPSEEK_THINKING_MODE=disabled$/m);
    assert.match(env, /^UNRELATED_SECRET=must-survive$/m);
  }
});

test('manual rollback changes Lite and Full together to Flash and keeps non-thinking', () => {
  const fixture = applyModelPolicy('deepseek-v4-flash');
  for (const [path] of fixture.configs) {
    assert.match(readFileSync(path, 'utf8'), /default:\s*deepseek-v4-flash/);
  }
  for (const path of [fixture.nodeEnv, fixture.bridgeEnv]) {
    const env = readFileSync(path, 'utf8');
    assert.match(env, /^HERMES_DEFAULT_MODEL=deepseek-v4-flash$/m);
    assert.match(env, /^HERMES_DEEPSEEK_THINKING_MODE=disabled$/m);
  }
});

test('O1 provider canary and final HTTP body proof are both blocking acceptance', () => {
  const accept = readProjectFile('scripts/accept-hermes-release.sh');
  assert.match(accept, /hermesProviderBoundaryCanary\.mjs/);
  assert.match(accept, /diagnose-hermes-provider-boundary\.sh/);
  assert.match(accept, /lite_provider_http_body_proof_failed/);
  assert.match(accept, /full_provider_http_body_proof_failed/);
});

test('model rollback is an input to the existing O1 release transaction', () => {
  const deploy = readProjectFile('scripts/deploy-hermes-release.sh');
  assert.match(deploy, /RAN_AGENT_DEPLOY_HERMES_MODEL="\$DEPLOY_MODEL"/);
  assert.match(deploy, /RAN_AGENT_EXPECTED_HERMES_MODEL="\$DEPLOY_MODEL"/);
  assert.match(deploy, /deepseek-v4-pro\|deepseek-v4-flash/);
  assert.match(deploy, /trap 'rollback_transaction \$\?' EXIT/);
});
