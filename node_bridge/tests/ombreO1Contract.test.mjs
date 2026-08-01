import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const PYTHON = process.env.RAN_AGENT_PYTHON_BIN || 'python3';
const CONTRACT = path.join(ROOT, 'scripts', 'ombre_o1_contract.py');
const PIN = '0e83d4671ce1629e03ad36bb9160235bf60dbd34';

function run(args, env = {}) {
  const result = spawnSync(PYTHON, [CONTRACT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  return result;
}

function config(url = 'http://127.0.0.1:18002/mcp', extras = '') {
  return `
platform_toolsets:
  cli: [mcp-ombre_memory]
  gateway: [mcp-ombre_memory]
mcp_servers:
  ombre_memory:
    url: "${url}"
${extras}`;
}

function validateText(text, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-config-'));
  const target = path.join(directory, 'config.yaml');
  fs.writeFileSync(target, text);
  return run(['validate-config', target], env);
}

test('semantic config validator accepts only the exact local recall adapter', () => {
  assert.equal(validateText(config()).status, 0);
  assert.equal(validateText(config('http://localhost:18002/mcp')).status, 0);
  assert.equal(validateText(config('http://[::1]:18002/mcp')).status, 0);
  assert.equal(validateText(config('${OMBRE_RECALL_URL}'), {
    OMBRE_RECALL_URL: 'http://127.0.0.1:18002/mcp',
  }).status, 0);
});

for (const [name, document, env] of [
  ['literal raw URL', config('http://127.0.0.1:18001/mcp'), {}],
  ['localhost raw URL', config('http://localhost:18001/mcp'), {}],
  ['IPv6 raw URL', config('http://[::1]:18001/mcp'), {}],
  ['expanded IPv6 raw URL', config('http://[0:0:0:0:0:0:0:1]:18001/mcp'), {}],
  ['raw endpoint environment alias', config('${OMBRE_ALIAS}'), { OMBRE_ALIAS: 'http://127.0.0.1:18001/mcp' }],
  ['localhost environment alias', config('${OMBRE_ALIAS}'), { OMBRE_ALIAS: 'http://localhost:18001/mcp' }],
  ['comment placeholder with wrong actual URL', `# http://127.0.0.1:18002/mcp\n${config('http://127.0.0.1:18001/mcp')}`, {}],
  ['different server name pointing upstream', config(undefined, '  shadow_memory:\n    url: "http://127.0.0.1:18001/mcp"\n'), {}],
  ['different server name pointing to localhost upstream', config(undefined, '  shadow_memory:\n    url: "http://localhost:18001/mcp"\n'), {}],
  ['adapter alias', config(undefined, '  shadow_memory:\n    url: "http://127.0.0.1:18002/mcp"\n'), {}],
  ['multiple equivalent adapter entries', config(undefined, '  shadow_memory:\n    url: "http://[::1]:18002/mcp"\n'), {}],
  ['unknown upstream hostname', config('http://ombre.internal:18001/mcp'), {}],
  ['implicit adapter port', config('http://localhost/mcp'), {}],
  ['abnormal adapter path', config('http://localhost:18002/mcp/'), {}],
  ['adapter userinfo', config('http://user@localhost:18002/mcp'), {}],
  ['adapter query', config('http://localhost:18002/mcp?mode=read'), {}],
  ['duplicate ombre_memory key', `${config()}\n  ombre_memory:\n    url: "http://127.0.0.1:18002/mcp"\n`, {}],
]) {
  test(`semantic config validator rejects ${name}`, () => {
    const result = validateText(document, env);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /OMBRE_O1_CONTRACT_INVALID/);
  });
}

function runnerEnv(overrides = {}) {
  return {
    OMBRE_BRAIN_RUNNER: 'source',
    OMBRE_BRAIN_COMMIT: PIN,
    OMBRE_BIND_HOST: '127.0.0.1',
    OMBRE_MCP_REQUIRE_AUTH: 'false',
    OMBRE_BRAIN_MCP_URL: 'http://127.0.0.1:18001/mcp',
    OMBRE_BRAIN_HEALTH_URL: 'http://127.0.0.1:18001/health',
    OMBRE_RECALL_MCP_URL: 'http://127.0.0.1:18002/mcp',
    OMBRE_RECALL_HEALTH_URL: 'http://127.0.0.1:18002/health',
    ...overrides,
  };
}

test('runner validator accepts the pinned source/loopback/auth contract', () => {
  assert.equal(run(['validate-runner'], runnerEnv()).status, 0);
});

for (const [name, overrides] of [
  ['docker', { OMBRE_BRAIN_RUNNER: 'docker' }],
  ['external', { OMBRE_BRAIN_RUNNER: 'external' }],
  ['unknown runner', { OMBRE_BRAIN_RUNNER: 'magic' }],
  ['IPv4 wildcard', { OMBRE_BIND_HOST: '0.0.0.0' }],
  ['IPv6 wildcard', { OMBRE_BIND_HOST: '::' }],
  ['LAN IP', { OMBRE_BIND_HOST: '192.168.1.4' }],
  ['hostname', { OMBRE_BIND_HOST: 'localhost' }],
  ['mixed URL', { OMBRE_RECALL_MCP_URL: 'http://127.0.0.1:18001/mcp' }],
  ['wrong commit', { OMBRE_BRAIN_COMMIT: '1'.repeat(40) }],
]) {
  test(`runner validator rejects ${name}`, () => {
    assert.notEqual(run(['validate-runner'], runnerEnv(overrides)).status, 0);
  });
}

test('runner validator rejects a missing explicit auth setting', () => {
  const env = runnerEnv();
  delete env.OMBRE_MCP_REQUIRE_AUTH;
  const clean = { ...process.env };
  delete clean.OMBRE_MCP_REQUIRE_AUTH;
  const result = spawnSync(PYTHON, [CONTRACT, 'validate-runner'], {
    cwd: ROOT,
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
});

test('release projection contract publishes and verifies the complete graph as the Hermes runtime identity', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const publish = source.indexOf('run_as_runtime_identity \\\n    "$node_bin" "$REPO_ROOT/node_bridge/src/hermesIdentityProjection.mjs"');
  const verify = source.indexOf('verify-runtime "$output" "$REPO_ROOT" "$RUNTIME_UID" "$RUNTIME_GID"');
  const lite = source.indexOf('"${SUDO[@]}" systemctl restart ran-agent-hermes.service');
  assert.ok(publish >= 0);
  assert.ok(verify > publish);
  assert.ok(lite > verify);
  assert.match(source, /verify_gateway_runtime_identity\n/);
  assert.match(source, /Group=\$RUNTIME_GROUP/);
  assert.doesNotMatch(source, /chown_if_user_exists "\$output(?:\.publication-state\.json)?"/);
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function snapshotFixture(overrides = {}, rawState = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-retention-'));
  const transactionId = 'tx-accepted-001';
  const directory = path.join(root, transactionId);
  fs.mkdirSync(directory);
  const manifest = 'artifact  sha256:abc\n';
  const services = 'ran-agent-ombre-brain.service\tloaded\tactive\tenabled\n';
  fs.writeFileSync(path.join(directory, 'manifest'), manifest);
  fs.writeFileSync(path.join(directory, 'services'), services);
  const state = {
    schema_version: 1,
    transaction_id: transactionId,
    candidate_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    status: 'accepted',
    acceptance_state: 'accepted',
    rollback_state: 'not_used',
    rollbackable: true,
    current_production_identity: `transaction:${overrides.transaction_id || transactionId}`,
    completed_at: '2026-07-24T00:00:00Z',
    manifest_digest: sha256(manifest),
    service_state_digest: sha256(services),
    ...overrides,
  };
  fs.writeFileSync(
    path.join(directory, 'transaction-state.json'),
    rawState ?? JSON.stringify(state),
  );
  return { root, directory, transactionId };
}

function classify(item, current = '', production = '') {
  const result = run([
    'classify-snapshot',
    item.directory,
    '--current-transaction', current,
    '--production-transaction', production,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('retention schema yields eligible only for fully verified accepted rollback point', () => {
  const item = snapshotFixture();
  assert.equal(classify(item).decision, 'ELIGIBLE');
  assert.equal(classify(item, item.transactionId).decision, 'KEEP');
  assert.equal(classify(item, '', item.transactionId).decision, 'KEEP');
});

for (const [name, overrides] of [
  ['unsupported schema', { schema_version: 999 }],
  ['unknown field', { future_field: true }],
  ['bad candidate', { candidate_sha: 'HEAD' }],
  ['transaction mismatch', { transaction_id: 'wrong-directory-id' }],
  ['empty completed time', { completed_at: '' }],
  ['manifest checksum mismatch', { manifest_digest: '0'.repeat(64) }],
  ['contradictory rollback failed', { rollback_state: 'rollback_failed' }],
  ['rollback used', { status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used' }],
  ['resumable', { status: 'resumable', acceptance_state: 'not_accepted', rollback_state: 'not_used' }],
]) {
  test(`retention schema skips uncertain ${name}`, () => {
    const item = snapshotFixture(overrides);
    assert.equal(classify(item).decision, 'SKIP_UNCERTAIN');
  });
}

test('retention schema rejects duplicate JSON keys and damaged state', () => {
  const item = snapshotFixture({}, '{"schema_version":1,"schema_version":1}');
  assert.equal(classify(item).decision, 'SKIP_UNCERTAIN');
  fs.writeFileSync(path.join(item.directory, 'transaction-state.json'), '{');
  assert.equal(classify(item).decision, 'SKIP_UNCERTAIN');
});

test('retention schema skips empty manifest and service evidence', () => {
  for (const name of ['manifest', 'services']) {
    const item = snapshotFixture();
    fs.writeFileSync(path.join(item.directory, name), '');
    assert.equal(classify(item).decision, 'SKIP_UNCERTAIN');
  }
});
