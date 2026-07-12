import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const nodeBin = process.execPath;

function candidate() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function run(script, args = [], extraEnv = {}) {
  return execFileSync('bash', [join(root, 'scripts', script), ...args], {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_RELEASE_CANDIDATE: candidate(),
      ...extraEnv,
    },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredGatePython() {
  const pythonBin = process.env.RAN_AGENT_PYTHON_BIN || '';
  assert.match(
    pythonBin,
    /^\//,
    'RAN_AGENT_PYTHON_BIN test prerequisite missing: pass the parent gate-validated absolute Python path',
  );
  assert.doesNotThrow(
    () => accessSync(pythonBin, constants.X_OK),
    'RAN_AGENT_PYTHON_BIN test prerequisite invalid: path must be executable',
  );
  assert.doesNotThrow(
    () => execFileSync(pythonBin, ['-I', '-c', 'import pytest'], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'pipe',
    }),
    'RAN_AGENT_PYTHON_BIN test prerequisite invalid: pytest must import with the isolated PATH',
  );
  return pythonBin;
}

function makeBootstrapFixture({ corruptManifest = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ran-agent-bootstrap-'));
  const runGit = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  runGit(['init']);
  runGit(['config', 'user.email', 'release-test@example.invalid']);
  runGit(['config', 'user.name', 'release test']);
  mkdirSync(join(repo, 'node_bridge'), { recursive: true });
  mkdirSync(join(repo, 'src', 'personal_agent'), { recursive: true });
  writeFileSync(join(repo, 'node_bridge', 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(repo, 'src', 'personal_agent', 'service.py'), '# fixture\n');
  writeFileSync(join(repo, 'README.md'), 'production checkout without release entry\n');
  runGit(['add', '.']);
  runGit(['commit', '-m', 'old production']);
  const prior = runGit(['rev-parse', 'HEAD']).trim();

  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'governance'), { recursive: true });
  const frameworkFiles = ['bootstrap-hermes-release.sh', 'deploy-hermes-release.sh', 'resolve-hermes-service-node.sh'];
  for (const file of frameworkFiles) {
    copyFileSync(join(root, 'scripts', file), join(repo, 'scripts', file));
    chmodSync(join(repo, 'scripts', file), 0o755);
  }
  mkdirSync(join(repo, 'node_bridge', 'src'), { recursive: true });
  writeFileSync(join(repo, 'node_bridge', 'src', 'identityMap.mjs'), [
    'export function validateOwnerBindingPreflight() {',
    "  return { ok: process.env.TEST_OWNER_OK === '1' };",
    '}',
    '',
  ].join('\n'));
  copyFileSync(join(root, 'scripts', 'hermes-release-candidate-preflight.mjs'), join(repo, 'scripts', 'hermes-release-candidate-preflight.mjs'));
  chmodSync(join(repo, 'scripts', 'hermes-release-candidate-preflight.mjs'), 0o755);
  const manifest = frameworkFiles.map((file) => {
    const contents = readFileSync(join(repo, 'scripts', file));
    return `${corruptManifest ? '0'.repeat(64) : sha256(contents)}  scripts/${file}`;
  }).join('\n');
  writeFileSync(join(repo, 'docs', 'governance', 'hermes_release_bootstrap.v1.sha256'), `${manifest}\n`);
  runGit(['add', '.']);
  runGit(['commit', '-m', 'candidate framework']);
  const candidateSha = runGit(['rev-parse', 'HEAD']).trim();
  runGit(['checkout', '--detach', prior]);
  return { repo, prior, candidateSha, runGit };
}

function makeSystemctlFixture({ show = '', cat = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-systemctl-'));
  const path = join(dir, 'systemctl');
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  show) printf '%s\\n' '${show}' ;;\n  cat) printf '%s\\n' '${cat}' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

function makeDeployServiceFixture(initialStates = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-services-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const bin = join(dir, 'bin');
  const state = join(dir, 'systemctl-state');
  const log = join(dir, 'systemctl.log');
  const snapshot = join(dir, 'snapshot');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(snapshot, { recursive: true });

  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const footer = deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]');
  assert.ok(footer > 0, 'deploy function harness requires the transaction footer');
  writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, footer));
  copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
  chmodSync(join(scripts, 'resolve-hermes-service-node.sh'), 0o755);

  for (const [unit, values] of Object.entries(initialStates)) {
    writeFileSync(join(state, `${unit}.load`), `${values.load}\n`);
    writeFileSync(join(state, `${unit}.active`), `${values.active}\n`);
    writeFileSync(join(state, `${unit}.enabled`), `${values.enabled}\n`);
  }
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'set -eu',
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
    'unit=""',
    'for arg in "$@"; do unit="$arg"; done',
    'load_state() { cat "$SYSTEMCTL_STATE/$1.load" 2>/dev/null || printf "%s\\n" not-found; }',
    'require_loaded() {',
    '  [ "$(load_state "$1")" != not-found ] || { printf "Unit %s not loaded\\n" "$1" >&2; exit 5; }',
    '}',
    'case "$1" in',
    '  show) load_state "$2" ;;',
    '  is-active)',
    '    [ "$(cat "$SYSTEMCTL_STATE/$unit.active" 2>/dev/null || printf inactive)" = active ]',
    '    ;;',
    '  is-enabled) cat "$SYSTEMCTL_STATE/$unit.enabled" 2>/dev/null || printf "%s\\n" disabled ;;',
    '  daemon-reload) ;;',
    '  stop|restart|enable|disable|mask|unmask)',
    '    require_loaded "$unit"',
    '    case "$1" in',
    '      stop) printf "%s\\n" inactive > "$SYSTEMCTL_STATE/$unit.active" ;;',
    '      restart) printf "%s\\n" active > "$SYSTEMCTL_STATE/$unit.active" ;;',
    '      enable) printf "%s\\n" enabled > "$SYSTEMCTL_STATE/$unit.enabled" ;;',
    '      disable) printf "%s\\n" disabled > "$SYSTEMCTL_STATE/$unit.enabled" ;;',
    '      mask) printf "%s\\n" masked > "$SYSTEMCTL_STATE/$unit.enabled" ;;',
    '      unmask) printf "%s\\n" disabled > "$SYSTEMCTL_STATE/$unit.enabled" ;;',
    '    esac',
    '    ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'sudo'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  return { dir, repo, bin, state, log, snapshot };
}

function runDeployServiceFixture(fixture, commands) {
  return execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'set -- --rollback fixture-snapshot',
    `source ${JSON.stringify(join(fixture.repo, 'scripts', 'deploy-hermes-release.sh'))}`,
    `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
    'for unit in "${ALL_RUNTIME_UNITS[@]}"; do snapshot_service_state "$unit"; done',
    commands,
  ].join('\n')], {
    cwd: fixture.repo,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.dir, 'artifacts'),
      SYSTEMCTL_LOG: fixture.log,
      SYSTEMCTL_STATE: fixture.state,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function makeAcceptanceReadinessFixture({ liteEnv = 'HERMES_API_KEY=lite-key', fullEnv = 'HERMES_API_KEY=full-key' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-accept-readiness-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const envDir = join(dir, 'environ');
  const trace = join(dir, 'trace');
  const tmp = join(dir, 'tmp');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(trace, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(['init']); git(['config', 'user.email', 'release-test@example.invalid']); git(['config', 'user.name', 'release test']); git(['add', '.']); git(['commit', '-m', 'fixture']);
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  const footer = accept.indexOf('if [[ "$MODE" == "--dry-run" ]]');
  assert.ok(footer > 0, 'acceptance readiness fixture requires the acceptance footer');
  writeFileSync(join(scripts, 'accept-hermes-release.sh'), accept.slice(0, footer));
  writeFileSync(join(envDir, '111'), Buffer.from(`${liteEnv}\0`));
  writeFileSync(join(envDir, '222'), Buffer.from(`${fullEnv}\0`));
  for (const [unit, pid] of [['ran-agent-hermes.service', '111'], ['ran-agent-hermes-full.service', '222']]) {
    writeFileSync(join(state, `${unit}.active`), 'active\n');
    writeFileSync(join(state, `${unit}.pid`), `${pid}\n`);
  }
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh', 'set -eu', 'printf "%s\\n" "$*" >> "$MOCK_TRACE/systemctl"', 'unit=""; for arg in "$@"; do unit="$arg"; done',
    'case "$1" in',
    '  is-active) [ "$(cat "$MOCK_STATE/$unit.active")" = active ] ;;',
    '  show) cat "$MOCK_STATE/$2.pid" ;;',
    '  *) exit 1 ;;', 'esac', '',
  ].join('\n'));
  writeFileSync(join(bin, 'cat'), '#!/bin/sh\ncase "$1" in /proc/*/environ) pid=${1#/proc/}; pid=${pid%/environ}; exec /bin/cat "$MOCK_ENV/$pid" ;; esac\nexec /bin/cat "$@"\n');
  writeFileSync(join(bin, 'curl'), [
    '#!/bin/sh', 'set -eu', 'printf "%s\\n" "$*" >> "$MOCK_TRACE/curl"', 'header=""; target=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --header) header=${2#@}; shift 2;; *) target=$1; shift;; esac; done',
    'case "$target" in *:8642/*) name=lite; expected=${MOCK_EXPECTED_LITE_KEY:-};; *:8643/*) name=full; expected=${MOCK_EXPECTED_FULL_KEY:-};; *) exit 2;; esac',
    'if [ -n "$expected" ] && ! grep -Fqx "Authorization: Bearer $expected" "$header"; then printf 401; exit 0; fi',
    'if [ "${MOCK_BLOCK_CURL:-0}" = 1 ]; then /bin/sleep 30; exit 28; fi',
    'count_file="$MOCK_STATE/$name.count"; count=$(cat "$count_file" 2>/dev/null || printf 0); count=$((count + 1)); printf "%s\\n" "$count" > "$count_file"',
    'if [ "${MOCK_DROP_LITE_AFTER_CURL:-0}" = 1 ] && [ "$name" = lite ]; then printf inactive > "$MOCK_STATE/ran-agent-hermes.service.active"; fi',
    'if [ "$name" = lite ]; then sequence=${MOCK_lite_SEQUENCE:-200}; else sequence=${MOCK_full_SEQUENCE:-200}; fi; value=$(printf "%s" "$sequence" | cut -d, -f"$count"); [ -n "$value" ] || value=$(printf "%s" "$sequence" | awk -F, "{print \\$NF}")',
    'case "$value" in refused) exit 7;; timeout) exit 28;; *) printf "%s" "$value";; esac', '',
  ].join('\n'));
  for (const file of ['sudo', 'systemctl', 'cat', 'curl']) chmodSync(join(bin, file), 0o755);
  return { dir, repo, bin, state, envDir, trace };
}

function runAcceptanceReadiness(fixture, extraEnv = {}) {
  return execFileSync('bash', ['-c', [
    'set -euo pipefail', 'set -- --apply',
    `source ${JSON.stringify(join(fixture.repo, 'scripts', 'accept-hermes-release.sh'))}`,
    'release_bridge_synthetic_paths',
  ].join('\n')], {
    cwd: fixture.repo,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`, RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo, TMPDIR: join(fixture.dir, 'tmp'),
      MOCK_STATE: fixture.state, MOCK_ENV: fixture.envDir, MOCK_TRACE: fixture.trace,
      RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '4', RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS: '1',
      ...extraEnv,
    }, encoding: 'utf8', stdio: 'pipe',
  });
}

test('release scripts expose fixture-safe dry-run transactions and require an explicit apply transaction', () => {
  // The release gate deliberately executes copied sources without `.git`.
  // Candidate resolution is validated by this fixture in a real checkout; the
  // copied-source pass below still checks the non-mutating script contract.
  if (!existsSync(join(root, '.git'))) return;
  for (const script of ['deploy-hermes-release.sh', 'accept-hermes-release.sh']) {
    assert.equal(existsSync(join(root, 'scripts', script)), true, script);
    assert.match(run(script, ['--dry-run']), new RegExp(`^${script.replace('.sh', '')}: dry-run-ok candidate=[a-f0-9]{40} plan=server-local-`, 'm'));
    assert.throws(
      () => run(script),
      /Command failed/,
      `${script} must not mutate a host without an explicit apply path`,
    );
  }
});

test('dry-run executes the protected manifest digest under set -u without touching runtime state', () => {
  if (!existsSync(join(root, '.git'))) return;
  const output = run('deploy-hermes-release.sh', ['--dry-run']);
  assert.match(output, /deploy-hermes-release: dry-run-ok candidate=[a-f0-9]{40}/);
});

test('release apply is a server-only, rollback-capable transaction that preserves runtime shape', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');

  assert.match(deploy, /--dry-run\|--apply/);
  assert.match(accept, /--dry-run\|--apply/);
  assert.match(deploy, /\/opt\/ran_agent/);
  assert.doesNotMatch(deploy, /candidate_not_checked_out/);
  assert.match(deploy, /snapshot_runtime_state/);
  assert.match(deploy, /stage_candidate/);
  assert.match(deploy, /git -C .* archive/);
  assert.match(deploy, /restore_code_revision/);
  assert.match(deploy, /snapshot_state_migrations/);
  assert.match(deploy, /quiesce_runtime_services/);
  assert.match(deploy, /restore_state_migrations/);
  assert.match(deploy, /restore_runtime_files/);
  assert.match(deploy, /restore_service_state/);
  assert.match(deploy, /RAN_AGENT_RELEASE_SOURCE_ROOT="\$STAGE_DIR"/);
  assert.match(deploy, /RAN_AGENT_NODE_BIN="\$NODE_BIN"/);
  assert.match(deploy, /RAN_AGENT_PYTHON_BIN="\$PYTHON_BIN"/);
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env[\s\S]*RAN_AGENT_RELEASE_STAGED_CANDIDATE=1[\s\S]*\$STAGE_DIR\/scripts\/hermes-release-gate\.sh/);
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env[\s\S]*\$STAGE_DIR\/scripts\/apply-hermes-runtime-split\.sh/);
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env[\s\S]*\$STAGE_DIR\/scripts\/verify-hermes-release\.sh/);
  assert.match(deploy, /read -r expected_candidate expected_digest < <\("\$\{SUDO\[@\]\}" cat "\$STAGE_DIR\/candidate"\)/);
  assert.match(deploy, /protected_manifest_digest/);
  assert.match(deploy, /tee -a "\$SNAPSHOT_DIR\/manifest"/);
  assert.match(deploy, /done < <\("\$\{SUDO\[@\]\}" cat "\$SNAPSHOT_DIR\/manifest"\)/);
  assert.match(deploy, /\$STAGE_DIR\/scripts\/apply-hermes-runtime-split\.sh/);
  assert.match(deploy, /\$STAGE_DIR\/scripts\/verify-hermes-release\.sh/);
  assert.match(deploy, /ran-agent-ombre-brain\.service/);
  assert.match(deploy, /ran-agent-xhs-browse\.service/);
  assert.match(deploy, /ran-agent-xhs-public-sidecar\.service/);
  assert.ok(deploy.indexOf('restore_runtime_files || true') < deploy.indexOf('restore_state_migrations || true'));
  assert.ok(deploy.indexOf('restore_state_migrations || true') < deploy.indexOf('restore_service_state || true'));
  assert.ok(deploy.lastIndexOf('quiesce_runtime_services') < deploy.lastIndexOf('snapshot_state_migrations'));
  assert.match(deploy, /rollback/);
  assert.match(deploy, /RAN_AGENT_RELEASE_PRESERVE_RUNTIME_SHAPE=1/);
  assert.match(deploy, /node:sqlite/);
  assert.match(deploy, /owner_binding_required/);
  assert.match(deploy, /git -C .* diff --quiet/);
  assert.match(accept, /\/opt\/ran_agent/);
  assert.match(accept, /validateOwnerBindingPreflight/);
  assert.match(accept, /foreign_owner_binding_denied/);
  assert.match(accept, /semanticClaimVerifier/);
  assert.match(accept, /release_semantic_verifier_preflight/);
  assert.match(accept, /getSemanticVerifierConfig/);
  assert.doesNotMatch(accept, /verifierImpl:\s*async/);
  assert.match(accept, /release_bridge_synthetic_paths/);
  assert.match(accept, /release_broker_read_only_smoke/);
  assert.match(accept, /hermes-release-gate\.sh" --all/);
  assert.match(accept, /node_version_unsupported/);
  assert.match(accept, /systemctl is-active/);
  assert.doesNotMatch(deploy, /ssh |scp |rsync /);
  assert.doesNotMatch(accept, /ssh |scp |rsync /);
});

test('release scripts make an immutable staged candidate the only apply authority and validate dry-run prerequisites', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');

  assert.match(deploy, /require_apply_prerequisites/);
  assert.match(accept, /require_acceptance_prerequisites/);
  assert.match(deploy, /candidate_stage_digest_mismatch/);
  assert.match(deploy, /git -C "\$REPO_ROOT" rev-parse --verify HEAD/);
  assert.match(deploy, /git -C "\$REPO_ROOT" symbolic-ref -q HEAD/);
  assert.match(deploy, /git -C "\$REPO_ROOT" checkout --detach/);
  assert.doesNotMatch(deploy, /bash "\$REPO_ROOT\/scripts\/apply-hermes-runtime-split\.sh"/);
  assert.doesNotMatch(deploy, /bash "\$REPO_ROOT\/scripts\/accept-hermes-release\.sh" --apply/);
  assert.match(accept, /RAN_AGENT_RELEASE_SOURCE_ROOT/);
  assert.match(accept, /release_post_start_health/);
});

test('preserve mode cannot rewrite profiles or environment, or remove unrelated MCP units', () => {
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const preserveMain = apply.slice(apply.indexOf('main() {'));
  const preserveBlock = preserveMain.match(/if \[ "\$PRESERVE_RUNTIME_SHAPE" = "1" \]; then([\s\S]*?)\n  fi/);

  assert.ok(preserveBlock);
  assert.match(preserveBlock[1], /restart_services/);
  assert.match(preserveBlock[1], /return 0/);
  assert.doesNotMatch(preserveBlock[1], /write_runtime_env|write_systemd_units|install_profiles/);
  assert.match(apply, /if \[ "\$PRESERVE_RUNTIME_SHAPE" != "1" \]; then\n    cleanup_stale_lite_dropins/);
  assert.match(apply, /if \[ "\$PRESERVE_RUNTIME_SHAPE" != "1" \]; then\n    "\$\{SUDO\[@\]\}" rm -f "\$XHS_BROWSE_SERVICE"/);
  assert.match(deploy, /CORE_RUNTIME_UNITS=\(ran-agent-python\.service ran-agent-node\.service ran-agent-hermes\.service ran-agent-hermes-full\.service\)/);
  assert.match(deploy, /for unit in "\$\{ALL_RUNTIME_UNITS\[@\]\}"; do/);
});

test('acceptance waits for independently delayed authenticated lite and full gateways without leaking the key', () => {
  const fixture = makeAcceptanceReadinessFixture({
    liteEnv: 'HERMES_API_KEY=preferred-lite\0API_SERVER_KEY=wrong-lite',
    fullEnv: 'API_SERVER_KEY=fallback-full',
  });
  const secret = 'preferred-lite';
  try {
    const started = Date.now();
    assert.doesNotThrow(() => runAcceptanceReadiness(fixture, {
      MOCK_EXPECTED_LITE_KEY: secret,
      MOCK_EXPECTED_FULL_KEY: 'fallback-full',
      MOCK_lite_SEQUENCE: 'refused,200',
      MOCK_full_SEQUENCE: 'refused,200',
      RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '12',
    }));
    assert.ok(Date.now() - started < 15_000, 'delayed readiness success must remain bounded');
    const trace = `${readFileSync(join(fixture.trace, 'curl'), 'utf8')}${readFileSync(join(fixture.trace, 'systemctl'), 'utf8')}`;
    assert.doesNotMatch(trace, new RegExp(secret));
    assert.doesNotMatch(readdirSync(join(fixture.dir, 'tmp')).join('\n'), /ran-agent-release-gateway/, 'readiness headers must be removed after success');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('acceptance readiness fails closed for authentication, missing keys, service exit, and bounded timeout', () => {
  const cases = [
    { name: 'authentication', env: 'HERMES_API_KEY=secret-auth', extra: { MOCK_EXPECTED_LITE_KEY: 'different', MOCK_EXPECTED_FULL_KEY: 'full-key' }, expected: 'lite_bridge_authentication_failed' },
    { name: 'forbidden', env: 'HERMES_API_KEY=secret-forbidden', extra: { MOCK_EXPECTED_LITE_KEY: 'secret-forbidden', MOCK_EXPECTED_FULL_KEY: 'full-key', MOCK_lite_SEQUENCE: '403' }, expected: 'lite_bridge_authentication_failed' },
    { name: 'missing-key', env: 'UNRELATED=value', extra: { MOCK_EXPECTED_FULL_KEY: 'full-key' }, expected: 'lite_bridge_auth_key_missing' },
    { name: 'service-exit', env: 'HERMES_API_KEY=secret-exit', extra: { MOCK_EXPECTED_LITE_KEY: 'secret-exit', MOCK_EXPECTED_FULL_KEY: 'full-key', MOCK_DROP_LITE_AFTER_CURL: '1', MOCK_lite_SEQUENCE: 'refused' }, expected: 'lite_bridge_service_inactive' },
    { name: 'timeout', env: 'HERMES_API_KEY=secret-timeout', extra: { MOCK_EXPECTED_LITE_KEY: 'secret-timeout', MOCK_EXPECTED_FULL_KEY: 'full-key', MOCK_lite_SEQUENCE: '503', RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '1' }, expected: 'lite_bridge_ready_timeout' },
  ];
  for (const item of cases) {
    const fixture = makeAcceptanceReadinessFixture({ liteEnv: item.env, fullEnv: 'HERMES_API_KEY=full-key' });
    try {
      const started = Date.now();
      assert.throws(() => runAcceptanceReadiness(fixture, item.extra), new RegExp(item.expected));
      assert.ok(Date.now() - started < 4000, `${item.name} must be bounded`);
      const curlTrace = existsSync(join(fixture.trace, 'curl')) ? readFileSync(join(fixture.trace, 'curl'), 'utf8') : '';
      assert.doesNotMatch(curlTrace, /secret-(?:auth|exit|timeout)/);
      if (item.name === 'missing-key') assert.equal(curlTrace, '', 'missing key must not send an unauthenticated request');
      assert.doesNotMatch(readdirSync(join(fixture.dir, 'tmp')).join('\n'), /ran-agent-release-gateway/, `${item.name} must remove temporary headers`);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

test('acceptance removes an in-flight authenticated header when terminated', async () => {
  const fixture = makeAcceptanceReadinessFixture();
  const child = spawn('bash', ['-c', [
    'set -euo pipefail', 'set -- --apply',
    `source ${JSON.stringify(join(fixture.repo, 'scripts', 'accept-hermes-release.sh'))}`,
    'release_bridge_synthetic_paths',
  ].join('\n')], {
    cwd: fixture.repo,
    detached: true,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`, RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo, TMPDIR: join(fixture.dir, 'tmp'),
      MOCK_STATE: fixture.state, MOCK_ENV: fixture.envDir, MOCK_TRACE: fixture.trace,
      MOCK_EXPECTED_LITE_KEY: 'lite-key', MOCK_EXPECTED_FULL_KEY: 'full-key', MOCK_BLOCK_CURL: '1',
      RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '4', RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS: '1',
    }, stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 250 && !existsSync(join(fixture.trace, 'curl')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(join(fixture.trace, 'curl')), true, 'fixture must reach the authenticated curl call');
    process.kill(-child.pid, 'SIGTERM');
    await once(child, 'exit');
    assert.doesNotMatch(readdirSync(join(fixture.dir, 'tmp')).join('\n'), /ran-agent-release-gateway/);
  } finally {
    if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('preserve runtime shape restarts only core services when Hermes is absent from PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-preserve-no-cli-'));
  const bin = join(dir, 'bin');
  const trace = join(dir, 'systemctl.log');
  const state = join(dir, 'state');
  const debug = join(dir, 'debug');
  const config = join(dir, 'config.yaml');
  mkdirSync(bin, { recursive: true });
  writeFileSync(config, 'operator-owned-config\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_TRACE"',
    'case "$1" in',
    '  show) printf "%s\\n" loaded ;;',
    '  is-failed) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  for (const command of ['journalctl', 'pgrep', 'ss', 'openssl', 'sleep']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, command), 0o755);
  }
  chmodSync(join(bin, 'systemctl'), 0o755);

  try {
    assert.doesNotThrow(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_NO_SUDO: '1',
        RAN_AGENT_REPO_ROOT: root,
        RAN_AGENT_DEPLOY_STATE_DIR: state,
        RAN_AGENT_DEPLOY_DEBUG_DIR: debug,
        HERMES_HOME: join(dir, 'hermes-home'),
        HERMES_LITE_HOME: join(dir, 'hermes-home', 'lite'),
        SYSTEMCTL_TRACE: trace,
      },
      stdio: 'pipe',
    }));
    const log = readFileSync(trace, 'utf8');
    for (const unit of ['ran-agent-python.service', 'ran-agent-node.service', 'ran-agent-hermes.service', 'ran-agent-hermes-full.service']) {
      assert.match(log, new RegExp(`restart ${unit.replace('.', '\\.')}`));
    }
    assert.doesNotMatch(log, /ran-agent-ombre|ran-agent-xhs|\b(enable|disable)\b/);
    assert.equal(readFileSync(config, 'utf8'), 'operator-owned-config\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-preserve runtime split fails before mutation when Hermes is absent from PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-full-no-cli-'));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const trace = join(dir, 'systemctl.log');
  mkdirSync(bin, { recursive: true });
  try {
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh')], {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_NO_SUDO: '1',
        RAN_AGENT_REPO_ROOT: root,
        RAN_AGENT_DEPLOY_STATE_DIR: state,
        RAN_AGENT_DEPLOY_DEBUG_DIR: join(dir, 'debug'),
        SYSTEMCTL_TRACE: trace,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    }), /required command not found: hermes/);
    assert.equal(existsSync(state), false, 'missing Hermes must fail before runtime directories are changed');
    assert.equal(existsSync(trace), false, 'missing Hermes must fail before systemd mutation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optional unit absent before apply is recorded and skipped through rollback without systemctl errors', () => {
  const fixture = makeDeployServiceFixture({
    'ran-agent-python.service': { load: 'loaded', active: 'active', enabled: 'enabled' },
    'ran-agent-node.service': { load: 'loaded', active: 'active', enabled: 'enabled' },
    'ran-agent-hermes.service': { load: 'loaded', active: 'active', enabled: 'enabled' },
    'ran-agent-hermes-full.service': { load: 'loaded', active: 'active', enabled: 'enabled' },
    'ran-agent-ombre-brain.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    // Deliberately inconsistent to prove quiesce follows LoadState, not an
    // accidental active probe for an absent optional unit.
    'ran-agent-xhs-browse.service': { load: 'not-found', active: 'active', enabled: 'disabled' },
    'ran-agent-xhs-public-sidecar.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
  });
  try {
    const output = runDeployServiceFixture(fixture, 'quiesce_runtime_services 2>&1\nrestore_service_state 2>&1');
    const services = readFileSync(join(fixture.snapshot, 'services'), 'utf8');
    const log = readFileSync(fixture.log, 'utf8');
    assert.match(services, /^ran-agent-xhs-browse\.service\tactive\tdisabled\tnot-found$/m);
    assert.match(output, /optional unit absent; restore skipped/);
    assert.doesNotMatch(log, /(?:stop|restart|enable|disable|mask|unmask) ran-agent-xhs-browse\.service/);
    assert.doesNotMatch(output, /Unit .*not (?:found|loaded)/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('rollback restores present optional units to their snapshotted active and enabled states', () => {
  const fixture = makeDeployServiceFixture({
    'ran-agent-python.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-node.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes-full.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-ombre-brain.service': { load: 'loaded', active: 'active', enabled: 'enabled' },
    'ran-agent-xhs-browse.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-xhs-public-sidecar.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
  });
  try {
    runDeployServiceFixture(fixture, [
      'quiesce_runtime_services',
      'systemctl disable ran-agent-ombre-brain.service',
      'restore_service_state 2>&1',
    ].join('\n'));
    const log = readFileSync(fixture.log, 'utf8');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-ombre-brain.service.active'), 'utf8').trim(), 'active');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-ombre-brain.service.enabled'), 'utf8').trim(), 'enabled');
    assert.match(log, /restart ran-agent-ombre-brain\.service/);
    assert.match(log, /enable ran-agent-ombre-brain\.service/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('rollback keeps a present optional inactive disabled without starting it', () => {
  const fixture = makeDeployServiceFixture({
    'ran-agent-python.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-node.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes-full.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-ombre-brain.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-xhs-browse.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-xhs-public-sidecar.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
  });
  try {
    runDeployServiceFixture(fixture, 'restore_service_state');
    const log = readFileSync(fixture.log, 'utf8');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-xhs-public-sidecar.service.active'), 'utf8').trim(), 'inactive');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-xhs-public-sidecar.service.enabled'), 'utf8').trim(), 'disabled');
    assert.match(log, /disable ran-agent-xhs-public-sidecar\.service/);
    assert.match(log, /stop ran-agent-xhs-public-sidecar\.service/);
    assert.doesNotMatch(log, /restart ran-agent-xhs-public-sidecar\.service/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('rollback restores a present optional masked unit as masked and inactive', () => {
  const fixture = makeDeployServiceFixture({
    'ran-agent-python.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-node.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-hermes-full.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-ombre-brain.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
    'ran-agent-xhs-browse.service': { load: 'loaded', active: 'inactive', enabled: 'masked' },
    'ran-agent-xhs-public-sidecar.service': { load: 'loaded', active: 'inactive', enabled: 'disabled' },
  });
  try {
    runDeployServiceFixture(fixture, 'restore_service_state');
    const log = readFileSync(fixture.log, 'utf8');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-xhs-browse.service.active'), 'utf8').trim(), 'inactive');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-xhs-browse.service.enabled'), 'utf8').trim(), 'masked');
    assert.match(log, /mask ran-agent-xhs-browse\.service/);
    assert.doesNotMatch(log, /restart ran-agent-xhs-browse\.service/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('legacy three-column optional snapshot skips a currently absent retired unit', () => {
  const fixture = makeDeployServiceFixture({
    'ran-agent-xhs-browse.service': { load: 'not-found', active: 'inactive', enabled: 'disabled' },
  });
  try {
    writeFileSync(join(fixture.snapshot, 'services'), 'ran-agent-xhs-browse.service\tinactive\tdisabled\n');
    const output = execFileSync('bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture-snapshot',
      `source ${JSON.stringify(join(fixture.repo, 'scripts', 'deploy-hermes-release.sh'))}`,
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'restore_service_state 2>&1',
    ].join('\n')], {
      cwd: fixture.repo,
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.dir, 'artifacts'),
        SYSTEMCTL_LOG: fixture.log,
        SYSTEMCTL_STATE: fixture.state,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const log = readFileSync(fixture.log, 'utf8');
    assert.match(output, /optional unit absent; restore skipped/);
    assert.doesNotMatch(log, /(?:stop|restart|enable|disable|mask|unmask) ran-agent-xhs-browse\.service/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('release transaction keeps a redacted protected-capability evidence trail across snapshot, apply, and rollback', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');

  assert.match(deploy, /record_protected_capability_evidence before/);
  assert.match(deploy, /record_protected_capability_evidence after/);
  assert.match(deploy, /record_protected_capability_evidence rollback/);
  assert.match(deploy, /hermes_protected_capabilities\.v1\.json/);
  assert.match(deploy, /protected-capabilities\.evidence/);
  assert.match(deploy, /sha256sum/);
  assert.doesNotMatch(deploy, /cat .*hermes_protected_capabilities/);
});

test('server acceptance runs the staged configured broker journey without an injected transport', () => {
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  const journeyPath = join(root, 'scripts', 'hermes-release-runtime-journey.mjs');
  assert.equal(existsSync(journeyPath), true);
  const journey = readFileSync(journeyPath, 'utf8');

  assert.match(accept, /hermes-release-runtime-journey\.mjs/);
  assert.match(accept, /RAN_AGENT_RELEASE_SOURCE_ROOT/);
  assert.doesNotMatch(accept, /router:\s*\{\s*execute/);
  assert.match(journey, /listEnabledExternalMcpManifests/);
  assert.match(journey, /createExternalMcpAutonomyRuntime/);
  assert.match(journey, /redacted/);
  assert.doesNotMatch(journey, /transport:\s*\{/);
});

test('release dry-run refuses a candidate that is not an immutable local commit', () => {
  if (!existsSync(join(root, '.git'))) return;
  for (const script of ['deploy-hermes-release.sh', 'accept-hermes-release.sh']) {
    assert.throws(
      () => run(script, ['--dry-run'], { RAN_AGENT_RELEASE_CANDIDATE: 'not-a-commit' }),
      /Command failed/,
    );
  }
});

test('release scripts validate an immutable candidate and never load runtime env files', () => {
  for (const script of ['deploy-hermes-release.sh', 'accept-hermes-release.sh']) {
    const source = readFileSync(join(root, 'scripts', script), 'utf8');
    assert.match(source, /git(?: -C [^\n]+)? rev-parse --verify/);
    assert.match(source, /RAN_AGENT_RELEASE_CANDIDATE/);
    assert.doesNotMatch(source, /source .*\.env/);
    assert.doesNotMatch(source, /ssh |scp |rsync /);
  }
});

test('release smoke executes named core and external journey suites without selecting an MCP provider', () => {
  const source = readFileSync(join(root, 'scripts', 'hermes-release-smoke.mjs'), 'utf8');
  assert.match(source, /coreReliabilityJourney\.test\.mjs/);
  assert.match(source, /externalActivityJourney\.test\.mjs/);
  assert.match(source, /--core/);
  assert.match(source, /--external/);
  assert.match(source, /--all/);
  assert.doesNotMatch(source, /CedarToy|Discourse/);
});

test('release gate has an all mode that invokes the named smoke matrix after isolated suites', () => {
  const source = readFileSync(join(root, 'scripts', 'hermes-release-gate.sh'), 'utf8');
  assert.match(source, /--core\|--all\|--preflight-only/);
  assert.match(source, /hermes-release-smoke\.mjs/);
  assert.match(source, /--all/);
  assert.match(source, /RAN_AGENT_PYTHON_BIN="\$PYTHON_BIN"/);
  assert.ok(source.indexOf('chmod -R a-w') < source.indexOf('hermes-release-smoke.mjs'));
  for (const name of ['RAN_AGENT_STATE_DIR', 'RAN_AGENT_GLOBAL_TIMELINE_PATH', 'RAN_AGENT_TIMELINE_ARCHIVE_DIR']) {
    assert.match(source.match(/run_node_test\(\)[\s\S]*?\n\}/)?.[0] || '', new RegExp(name));
    assert.match(source.match(/run_node_smoke\(\)[\s\S]*?\n\}/)?.[0] || '', new RegExp(name));
  }
});

test('release gate executes a git-less staged candidate from its explicit immutable source root', () => {
  const pythonBin = requiredGatePython();
  const stage = mkdtempSync(join(tmpdir(), 'ran-agent-gitless-stage-'));
  try {
    mkdirSync(join(stage, 'scripts'), { recursive: true });
    mkdirSync(join(stage, 'node_bridge', 'tests'), { recursive: true });
    mkdirSync(join(stage, 'tests'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'hermes-release-gate.sh'), join(stage, 'scripts', 'hermes-release-gate.sh'));
    chmodSync(join(stage, 'scripts', 'hermes-release-gate.sh'), 0o755);
    writeFileSync(join(stage, 'node_bridge', 'tests', 'coreReliabilityJourney.test.mjs'), [
      "import test from 'node:test';",
      "test('gitless staged candidate fixture', () => {});",
      '',
    ].join('\n'));
    writeFileSync(join(stage, 'scripts', 'hermes-release-smoke.mjs'), 'process.exit(0);\n');
    writeFileSync(join(stage, 'tests', 'test_stage.py'), 'def test_gitless_stage():\n    assert True\n');

    const output = execFileSync('bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--core'], {
      cwd: stage,
      env: {
        PATH: '/usr/bin:/bin',
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_SOURCE_ROOT: stage,
        RAN_AGENT_RELEASE_STAGED_CANDIDATE: '1',
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(output, /hermes-release-gate: ok/);
    assert.throws(
      () => execFileSync('bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--core'], {
        cwd: stage,
        env: {
          PATH: '/usr/bin:/bin',
          RAN_AGENT_NODE_BIN: nodeBin,
          RAN_AGENT_PYTHON_BIN: '/definitely/missing/ran-agent-python',
          RAN_AGENT_RELEASE_SOURCE_ROOT: stage,
          RAN_AGENT_RELEASE_STAGED_CANDIDATE: '1',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
      /Command failed/,
      'git-less stage must fail closed for an invalid absolute Python path',
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('release transaction snapshots the live production checkout before activating an immutable candidate', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');

  assert.match(deploy, /CANDIDATE.*\^\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(deploy, /candidate_not_checked_out/);
  assert.match(deploy, /snapshot_node_durable_state/);
  assert.match(deploy, /snapshot_path "\$REPO_ROOT\/data" 901/);
  assert.match(deploy, /RAN_AGENT_RELEASE_ARTIFACT_ROOT/);
  assert.match(deploy, /activate_candidate_checkout/);
  assert.ok(deploy.indexOf('snapshot_runtime_state') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('snapshot_state_migrations') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('hermes-release-gate.sh" --all') < deploy.lastIndexOf('snapshot_runtime_state'));
  assert.ok(deploy.indexOf('snapshot_code_revision') < deploy.lastIndexOf('activate_candidate_checkout'));
  assert.match(deploy, /--rollback/);
  assert.match(deploy, /rollback-ok snapshot=/);
  assert.match(deploy, /trap 'rollback_transaction \$\?' EXIT/);
  assert.ok(deploy.indexOf('restore_code_revision || true') < deploy.indexOf('restore_runtime_files || true'));
  assert.ok(deploy.indexOf('restore_runtime_files || true') < deploy.indexOf('restore_state_migrations || true'));
  assert.ok(deploy.indexOf('restore_state_migrations || true') < deploy.indexOf('restore_service_state || true'));
  assert.match(deploy, /service_env_source_unavailable/);
  assert.match(deploy, /RAN_AGENT_INTERNAL_CONTROL_SECRET/);
  assert.match(deploy, /git -C "\$REPO_ROOT" diff --name-status "\$PRODUCTION_HEAD" "\$CANDIDATE"/);
  assert.doesNotMatch(deploy, /diff --name-status[^\n]*CANDIDATE\^/);
});

test('main and release-candidate entry points resolve remote refs to immutable commits without moving production first', () => {
  const main = readFileSync(join(root, 'scripts', 'deploy-hermes-main.sh'), 'utf8');
  const candidateEntry = readFileSync(join(root, 'scripts', 'deploy-hermes-candidate.sh'), 'utf8');

  assert.match(main, /git fetch --no-tags origin main/);
  assert.match(main, /refs\/remotes\/origin\/main/);
  assert.match(main, /RAN_AGENT_RELEASE_CANDIDATE="\$CANDIDATE"/);
  assert.match(main, /worktree_dirty/);
  assert.doesNotMatch(main, /git pull|git checkout|git switch/);
  assert.match(candidateEntry, /--branch\)[\s\S]*--commit\)/);
  assert.match(candidateEntry, /git fetch --no-tags origin/);
  assert.match(candidateEntry, /git check-ref-format --branch/);
  assert.match(candidateEntry, /RAN_AGENT_RELEASE_CANDIDATE="\$CANDIDATE"/);
  assert.match(candidateEntry, /worktree_dirty/);
  assert.doesNotMatch(candidateEntry, /git pull|git checkout|git switch/);
});

test('unified verification makes release acceptance blocking and keeps optional diagnostics non-blocking', () => {
  const verify = readFileSync(join(root, 'scripts', 'verify-hermes-release.sh'), 'utf8');

  assert.match(verify, /--release\|--specialized\|--all/);
  assert.match(verify, /accept-hermes-release\.sh" --apply/);
  assert.match(verify, /RAN_AGENT_PROACTIVE_DIAG_STRICT_ENV=1/);
  assert.match(verify, /diagnose-proactive-events\.sh/);
  assert.match(verify, /diagnose-lite-full\.sh diagnose-external-mcp-gateway\.sh diagnose-ombre-memory\.sh/);
  assert.match(verify, /specialized-warning/);
  assert.match(verify, />\/dev\/null 2>&1/);
});

test('first-release bootstrap runs an extracted immutable framework while the production checkout stays on its prior commit', () => {
  const fixture = makeBootstrapFixture();
  const extracted = join(fixture.repo, '..', `bootstrap-${fixture.candidateSha}.sh`);
  try {
    assert.equal(existsSync(join(fixture.repo, 'scripts', 'deploy-hermes-release.sh')), false);
    writeFileSync(extracted, execFileSync('git', ['show', `${fixture.candidateSha}:scripts/bootstrap-hermes-release.sh`], { cwd: fixture.repo, encoding: 'utf8' }));
    chmodSync(extracted, 0o755);
    const output = execFileSync('bash', [extracted, '--dry-run', fixture.candidateSha], {
      cwd: fixture.repo,
      env: {
        PATH: '/usr/bin:/bin',
        RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.repo, '..', 'release-artifacts'),
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(output, /bootstrap-ok candidate=[a-f0-9]{40}/);
    assert.equal(fixture.runGit(['rev-parse', 'HEAD']).trim(), fixture.prior);
    assert.equal(fixture.runGit(['status', '--short']).trim(), '');
    assert.doesNotThrow(() => fixture.runGit(['diff', '--quiet']));
  } finally {
    rmSync(extracted, { force: true });
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('bootstrap fails closed for an invalid candidate, digest mismatch, and a dirty production checkout', () => {
  const invalid = makeBootstrapFixture();
  const mismatch = makeBootstrapFixture({ corruptManifest: true });
  const dirty = makeBootstrapFixture();
  const bootstrap = join(root, 'scripts', 'bootstrap-hermes-release.sh');
  const runBootstrap = (fixture, sha) => execFileSync('bash', [bootstrap, '--dry-run', sha], {
    cwd: fixture.repo,
    env: {
      PATH: '/usr/bin:/bin',
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.repo, '..', 'release-artifacts'),
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  try {
    assert.throws(() => runBootstrap(invalid, 'not-a-commit'), /Command failed/);
    assert.throws(() => runBootstrap(mismatch, mismatch.candidateSha), /Command failed/);
    writeFileSync(join(dirty.repo, 'README.md'), 'dirty\n');
    assert.throws(() => runBootstrap(dirty, dirty.candidateSha), /Command failed/);
    assert.equal(dirty.runGit(['rev-parse', 'HEAD']).trim(), dirty.prior);
  } finally {
    for (const fixture of [invalid, mismatch, dirty]) rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('release node resolver uses explicit input, systemctl show, systemctl cat, and fails closed without an absolute node executable', () => {
  const resolver = join(root, 'scripts', 'resolve-hermes-service-node.sh');
  const byShow = makeSystemctlFixture({ show: `{ path=${nodeBin} ; argv[]=${nodeBin} /opt/ran_agent/node_bridge/src/index.mjs ; }` });
  const byCat = makeSystemctlFixture({ cat: `ExecStart=${nodeBin} /opt/ran_agent/node_bridge/src/index.mjs` });
  const unresolved = makeSystemctlFixture({ show: '{ path=/usr/bin/env ; argv[]=/usr/bin/env bash -lc node ; }', cat: 'ExecStart=/usr/bin/env bash -lc node' });
  const runResolver = (env) => execFileSync('bash', [resolver], {
    env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  try {
    assert.equal(runResolver({ RAN_AGENT_NODE_BIN: nodeBin, RAN_AGENT_SYSTEMCTL_BIN: '/missing/systemctl' }), nodeBin);
    assert.equal(runResolver({ RAN_AGENT_SYSTEMCTL_BIN: byShow.path }), nodeBin);
    assert.equal(runResolver({ RAN_AGENT_SYSTEMCTL_BIN: byCat.path }), nodeBin);
    assert.throws(() => runResolver({ RAN_AGENT_SYSTEMCTL_BIN: unresolved.path }), /Command failed/);
  } finally {
    for (const fixture of [byShow, byCat, unresolved]) rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('bootstrap manifest pins the exact candidate framework sources', () => {
  const manifest = readFileSync(join(root, 'docs', 'governance', 'hermes_release_bootstrap.v1.sha256'), 'utf8');
  const entries = new Map(manifest.trim().split('\n').map((line) => {
    const [digest, path] = line.split(/\s{2,}/);
    return [path, digest];
  }));

  for (const path of [
    'scripts/bootstrap-hermes-release.sh',
    'scripts/deploy-hermes-release.sh',
    'scripts/resolve-hermes-service-node.sh',
  ]) {
    assert.match(entries.get(path) || '', /^[0-9a-f]{64}$/);
    assert.equal(entries.get(path), sha256(readFileSync(join(root, path))));
  }
});

test('candidate owner preflight imports the immutable stage module, never a missing or incompatible old checkout module', () => {
  const fixture = makeBootstrapFixture();
  const stage = mkdtempSync(join(tmpdir(), 'ran-agent-candidate-stage-'));
  try {
    const oldModule = join(fixture.repo, 'node_bridge', 'src', 'identityMap.mjs');
    assert.equal(existsSync(oldModule), false);
    for (const path of [
      'node_bridge/src/identityMap.mjs',
      'scripts/hermes-release-candidate-preflight.mjs',
    ]) {
      const target = join(stage, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, execFileSync('git', ['show', `${fixture.candidateSha}:${path}`], { cwd: fixture.repo, encoding: 'utf8' }));
    }
    const preflight = join(stage, 'scripts', 'hermes-release-candidate-preflight.mjs');
    const output = execFileSync(nodeBin, [preflight, '--module-only'], { env: { TEST_OWNER_OK: '0' }, encoding: 'utf8' });
    assert.match(output, /candidate-preflight-ok mode=module/);
    assert.throws(
      () => execFileSync(nodeBin, [preflight, '--owner-binding'], { env: { TEST_OWNER_OK: '0' }, stdio: 'pipe' }),
      /Command failed/,
    );
    assert.match(execFileSync(nodeBin, [preflight, '--owner-binding'], { env: { TEST_OWNER_OK: '1' }, encoding: 'utf8' }), /candidate-preflight-ok mode=owner/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('deploy invokes candidate-only preflight from the verified stage for dry-run and apply prerequisites', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const dryRun = deploy.match(/require_plan_prerequisites\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const apply = deploy.match(/require_apply_prerequisites\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(deploy, /\$STAGE_DIR\/scripts\/hermes-release-candidate-preflight\.mjs/);
  assert.match(deploy, /--module-only/);
  assert.match(deploy, /--owner-binding/);
  assert.match(dryRun, /candidate_stage_preflight module/);
  assert.match(dryRun, /require_service_environment[\s\S]*candidate_stage_preflight owner/);
  assert.doesNotMatch(apply, /identityMap\.mjs|require_owner_binding/);
  assert.doesNotMatch(deploy, /from "\.\/node_bridge\/src\/identityMap\.mjs"/);
});
