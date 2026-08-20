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

test('owner bootstrap command accepts a protected Telegram owner identity', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-telegram-');
  const identityMapPath = join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const trustedIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'telegram-owner.json');
  const trustedIdentity = {
    platform: 'telegram',
    senderId: 'telegram-private-owner-id',
    globalUserId: 'user:ran',
    provenance: 'confirmed_botfather_owner',
  };
  writeFileSync(trustedIdentityPath, JSON.stringify(trustedIdentity));
  chmodSync(trustedIdentityPath, 0o600);

  const output = run(['--identity-file', trustedIdentityPath], {
    ...isolated,
    RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath,
  });

  assert.match(output, /owner-bootstrap: ok bindings=1/);
  assert.equal(output.includes(trustedIdentity.senderId), false);
  assert.equal(output.includes(trustedIdentity.globalUserId), false);
  assert.equal(
    getIdentityBinding({ platform: 'telegram', sender_id: trustedIdentity.senderId }, {
      env: { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath },
    }).owner,
    true,
  );
});

test('owner bootstrap command accepts only an explicit protected identity file and emits no raw identity', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-command-');
  const identityMapPath = join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const trustedIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'trusted-owner.json');
  const trustedIdentity = {
    platform: 'feishu',
    senderId: 'ou-private-owner-id',
    globalUserId: 'user:ran',
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
  const feishuKey = getAccountBindingKey({ platform: 'feishu', sender_id: trustedIdentity.senderId });
  const feishuBinding = structuredClone(JSON.parse(stored).bindings[feishuKey]);
  assert.equal(stored.includes(trustedIdentity.senderId), false);
  assert.equal(existsSync(trustedIdentityPath), true);

  const wechatIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'wechat-owner.json');
  writeFileSync(wechatIdentityPath, JSON.stringify({
    platform: 'wechat', senderId: 'wx-private-owner-id', globalUserId: 'user:ran', provenance: 'trusted_bridge_operator_export',
  }));
  chmodSync(wechatIdentityPath, 0o600);
  assert.match(run(['--identity-file', wechatIdentityPath], env), /owner-bootstrap: ok bindings=2/);
  assert.deepEqual(JSON.parse(readFileSync(identityMapPath, 'utf8')).bindings[feishuKey], feishuBinding);
  const afterAddition = readFileSync(identityMapPath, 'utf8');
  assert.match(run(['--identity-file', wechatIdentityPath], env), /owner-bootstrap: ok bindings=2/);
  assert.equal(readFileSync(identityMapPath, 'utf8'), afterAddition);

  const conflictingIdentityPath = join(isolated.RAN_AGENT_STATE_DIR, 'conflicting-owner.json');
  writeFileSync(conflictingIdentityPath, JSON.stringify({
    platform: 'wechat', senderId: 'wx-private-owner-id', globalUserId: 'user:other', provenance: 'trusted_bridge_operator_export',
  }));
  chmodSync(conflictingIdentityPath, 0o600);
  assert.throws(
    () => run(['--identity-file', conflictingIdentityPath], env),
    /Command failed/,
  );
  assert.equal(getIdentityBinding({ platform: 'wechat', sender_id: 'wx-private-owner-id' }, { env }).globalUserId, 'user:ran');
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
