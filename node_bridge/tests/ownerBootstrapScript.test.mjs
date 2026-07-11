import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { getAccountBindingKey, getIdentityBinding } from '../src/identityMap.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const root = new URL('../..', import.meta.url).pathname;
const script = join(root, 'scripts', 'bootstrap-owner-binding.mjs');

function run(args, env) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('owner bootstrap command accepts only an explicit protected identity file and emits no raw identity', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-command-');
  const identityMapPath = join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const trustedIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'trusted-owner.json');
  const trustedIdentity = {
    platform: 'feishu',
    senderId: 'ou-private-owner-id',
    globalUserId: 'user:private-owner',
    provenance: 'trusted_bridge_operator_export',
  };
  writeFileSync(trustedIdentityPath, JSON.stringify(trustedIdentity));
  chmodSync(trustedIdentityPath, 0o600);
  const env = { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath };

  const output = run(['--identity-file', trustedIdentityPath], env);

  assert.match(output, /owner-bootstrap: ok bindings=1/);
  assert.equal(output.includes(trustedIdentity.senderId), false);
  assert.equal(output.includes(trustedIdentity.globalUserId), false);
  assert.equal(getIdentityBinding({ platform: 'feishu', sender_id: trustedIdentity.senderId }, { env }).owner, true);
  const stored = readFileSync(identityMapPath, 'utf8');
  assert.equal(stored.includes(trustedIdentity.senderId), false);
  assert.equal(existsSync(trustedIdentityPath), true);

  const replacementIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'replacement-owner.json');
  writeFileSync(replacementIdentityPath, JSON.stringify({
    ...trustedIdentity,
    senderId: 'ou-replacement-owner-id',
  }));
  chmodSync(replacementIdentityPath, 0o600);
  assert.throws(
    () => run(['--identity-file', replacementIdentityPath], env),
    /Command failed/,
  );
  assert.equal(getIdentityBinding({ platform: 'feishu', sender_id: 'ou-replacement-owner-id' }, { env }).owner, false);
});

test('owner bootstrap command never derives an identity from fallback environment or missing input', (t) => {
  const isolated = createIsolatedTestEnv(t, {
    RAN_AGENT_DEFAULT_GLOBAL_USER_ID: 'user:fallback-must-not-bootstrap',
  }, 'ran-agent-owner-bootstrap-missing-');
  const identityMapPath = join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');

  assert.throws(
    () => run([], { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath }),
    /Command failed/,
  );
  assert.equal(existsSync(identityMapPath), false);
  assert.match(getAccountBindingKey({ platform: 'wechat', sender_id: 'unrelated' }), /^wechat:[a-f0-9]{16}$/);
});

test('owner bootstrap command rejects a symlink even when its target is protected', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-symlink-');
  const identityMapPath = join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const target = join(isolated.RAN_AGENT_STATE_DIR, 'trusted-owner.json');
  const link = join(isolated.RAN_AGENT_STATE_DIR, 'trusted-owner-link.json');
  writeFileSync(target, JSON.stringify({
    platform: 'wechat', senderId: 'wx-owner', globalUserId: 'user:owner', provenance: 'bridge',
  }));
  chmodSync(target, 0o600);
  symlinkSync(target, link);

  assert.throws(
    () => run(['--identity-file', link], { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath }),
    /Command failed/,
  );
  assert.equal(existsSync(identityMapPath), false);
});
