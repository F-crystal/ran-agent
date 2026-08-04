import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, chmodSync, chownSync, closeSync, constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const nodeBin = process.execPath;
const pythonBin = process.env.RAN_AGENT_PYTHON_BIN || realpathSync(execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim());
const runtimeUser = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
const runtimeGroup = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
const linuxRoot = process.platform === 'linux' && process.geteuid?.() === 0;
const bootstrapFrameworkFiles = [
  'bootstrap-hermes-release.sh',
  'deploy-hermes-release.sh',
  'resolve-hermes-service-node.sh',
  'prune-hermes-release-artifacts.sh',
  'check-hermes-snapshot-capacity.py',
  'ombre_o1_contract.py',
];

function candidate() {
  const explicit = process.env.RAN_AGENT_RELEASE_CANDIDATE;
  if (explicit) {
    assert.match(explicit, /^[0-9a-f]{40}$/, 'explicit release candidate must be an immutable commit SHA');
    return explicit;
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function run(script, args = [], extraEnv = {}) {
  return execFileSync('bash', [join(root, 'scripts', script), ...args], {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
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

function identityFixturePrefix(name) {
  return linuxRoot ? `/tmp/${name}` : join(tmpdir(), name);
}

function runAsCheckoutOperator(command, args, options, fixtureRoot) {
  if (!linuxRoot) return execFileSync(command, args, options);
  const uid = execFileSync('id', ['-u', 'ubuntu'], { encoding: 'utf8' }).trim();
  const gid = execFileSync('id', ['-g', 'ubuntu'], { encoding: 'utf8' }).trim();
  execFileSync('chown', ['-R', `${uid}:${gid}`, fixtureRoot]);
  chmodSync(fixtureRoot, 0o755);
  const { env = {}, ...runOptions } = options;
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return execFileSync('/usr/sbin/runuser', [
    '--user', 'ubuntu', '--group', 'ubuntu', '--', '/usr/bin/env', '-i',
    'HOME=/tmp', 'TMPDIR=/tmp', ...assignments, command, ...args,
  ], runOptions);
}

test('Node runtime imports are direct, lock-synchronized production dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const expected = [
    '@mozilla/readability',
    'linkedom',
    'playwright-core',
    'qrcode-terminal',
    'silk-wasm',
    'undici',
    'weixin-agent-sdk',
  ];
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), expected);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/openclaw'), false);
});

function writeRetentionState(directory, overrides = {}) {
  const manifest = 'fixture manifest\n';
  const services = 'ran-agent-ombre-brain.service\tactive\tenabled\tloaded\n';
  writeFileSync(join(directory, 'prior-head'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  writeFileSync(join(directory, 'manifest'), manifest);
  writeFileSync(join(directory, 'services'), services);
  writeFileSync(join(directory, 'transaction-state.json'), JSON.stringify({
    schema_version: 1,
    transaction_id: directory.split('/').at(-1),
    candidate_sha: 'b'.repeat(40),
    base_sha: 'a'.repeat(40),
    status: 'accepted',
    acceptance_state: 'accepted',
    rollback_state: 'not_used',
    rollbackable: true,
    current_production_identity: `transaction:${directory.split('/').at(-1)}`,
    completed_at: '2026-07-24T00:00:00Z',
    manifest_digest: sha256(manifest),
    service_state_digest: sha256(services),
    ...overrides,
  }));
}

function secureArtifactLayout(artifactRoot) {
  for (const path of [artifactRoot, join(artifactRoot, 'snapshots'), join(artifactRoot, 'stages'), join(artifactRoot, 'archives')]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
}

function requiredGatePython() {
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
  for (const file of bootstrapFrameworkFiles) {
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
  const manifest = bootstrapFrameworkFiles.map((file) => {
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
  copyFileSync(join(root, 'scripts', 'ombre_o1_contract.py'), join(scripts, 'ombre_o1_contract.py'));
  copyFileSync(join(root, 'scripts', 'prune-hermes-release-artifacts.sh'), join(scripts, 'prune-hermes-release-artifacts.sh'));
  copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
  chmodSync(join(scripts, 'resolve-hermes-service-node.sh'), 0o755);

  for (const [unit, values] of Object.entries(initialStates)) {
    writeFileSync(join(state, `${unit}.load`), `${values.load}\n`);
    writeFileSync(join(state, `${unit}.active`), `${values.active}\n`);
    writeFileSync(join(state, `${unit}.enabled`), `${values.enabled}\n`);
  }
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n');
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
  chmodSync(join(bin, 'sha256sum'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  return { dir, repo, bin, state, log, snapshot };
}

function runDeployServiceFixture(fixture, commands, extraEnv = {}) {
  return execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'set -- --rollback fixture-snapshot',
    `source ${JSON.stringify(join(fixture.repo, 'scripts', 'deploy-hermes-release.sh'))}`,
    'SUDO=(sudo)',
    `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
    'for unit in "${ALL_RUNTIME_UNITS[@]}"; do snapshot_service_state "$unit"; done',
    '[ -f "$SNAPSHOT_DIR/prior-head" ] || printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$SNAPSHOT_DIR/prior-head"',
    '[ -f "$SNAPSHOT_DIR/manifest" ] || printf "%s\\n" fixture-manifest > "$SNAPSHOT_DIR/manifest"',
    commands,
  ].join('\n')], {
    cwd: fixture.repo,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.dir, 'artifacts'),
      RAN_AGENT_NO_SUDO: '1',
      SYSTEMCTL_LOG: fixture.log,
      SYSTEMCTL_STATE: fixture.state,
      ...extraEnv,
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
  const stewardVerify = readFileSync(join(root, 'scripts', 'verify-ombre-steward-runtime.py'), 'utf8');
  const preMutationGate = deploy.split('\n').find((line) => line.includes('hermes-release-gate.sh" --all')) || '';

  assert.match(deploy, /--dry-run\|--apply/);
  assert.match(accept, /--dry-run\|--apply/);
  assert.match(deploy, /\/opt\/ran_agent/);
  assert.doesNotMatch(deploy, /candidate_not_checked_out/);
  assert.match(deploy, /snapshot_runtime_state/);
  assert.match(deploy, /SUCCESSFUL_SNAPSHOT_RETENTION=2/);
  assert.match(deploy, /mark_snapshot_accepted/);
  assert.match(deploy, /prune_accepted_snapshots/);
  assert.doesNotMatch(deploy, /-name success/);
  assert.ok(deploy.lastIndexOf('mark_snapshot_accepted') < deploy.lastIndexOf('prune_accepted_snapshots'));
  assert.ok(deploy.lastIndexOf('verify-hermes-release.sh') < deploy.lastIndexOf('mark_snapshot_accepted'));
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
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env RAN_AGENT_RELEASE_SOURCE_ROOT="\$GATE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1[\s\S]*\$GATE_DIR\/scripts\/hermes-release-gate\.sh" --all/);
  assert.match(deploy, /runuser --user ran-agent --group ran-agent -- \/usr\/bin\/env -i[\s\S]*RAN_AGENT_RELEASE_SOURCE_ROOT="\$GATE_DIR" RAN_AGENT_RELEASE_STAGED_CANDIDATE=1[\s\S]*\$GATE_DIR\/scripts\/hermes-release-gate\.sh" --all/);
  assert.doesNotMatch(deploy, /bash "\$STAGE_DIR\/scripts\/hermes-release-gate\.sh"/);
  assert.match(deploy, /stage_gate_copy\(\) \{[\s\S]*mktemp -d \/tmp\/ran-agent-release-runtime-gate\.XXXXXX[\s\S]*diff -r "\$STAGE_DIR" "\$GATE_DIR"/);
  assert.match(deploy, /stage_gate_copy\(\) \{[\s\S]*find -P "\$GATE_DIR" -type l[\s\S]*chmod -R a=rX "\$GATE_DIR"/);
  assert.doesNotMatch(deploy, /RAN_AGENT_RELEASE_GATE_ROOT/);
  const gateRunner = deploy.match(/run_candidate_gates\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(gateRunner.indexOf('/usr/bin/test -r "$GATE_DIR/scripts/hermes-release-gate.sh"') > -1);
  assert.ok(gateRunner.indexOf('/usr/bin/test -r "$GATE_DIR/scripts/hermes-release-gate.sh"') < gateRunner.indexOf('/usr/bin/test -w "$GATE_DIR/scripts/hermes-release-gate.sh"'));
  assert.ok(gateRunner.indexOf('/usr/bin/test -w "$GATE_DIR/scripts/hermes-release-gate.sh"') < gateRunner.indexOf('bash "$GATE_DIR/scripts/hermes-release-gate.sh" --all'));
  assert.match(gateRunner, /candidate_gate_copy_unreadable/);
  assert.match(gateRunner, /candidate_gate_copy_writable/);
  assert.match(deploy, /require_gate_copy_capacity estimate "\$SCRIPT_ROOT" "\$PRE_STAGE_TREE_BYTES" "\$PRE_STAGE_TREE_INODES"/);
  assert.match(deploy, /require_gate_copy_capacity measured "\$STAGE_DIR"[\s\S]*project_gate_copy_node_modules/);
  assert.match(deploy, /project_gate_copy_node_modules\(\) \{[\s\S]*cp -a "\$STAGE_DIR\/node_modules" "\$GATE_DIR\/node_modules"[\s\S]*chmod -R a-w,go\+rX/);
  const cleanupBody = deploy.match(/cleanup_pretransaction_artifacts\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(cleanupBody, /"\$GATE_DIR" == \/tmp\/ran-agent-release-runtime-gate\.\*/);
  assert.match(cleanupBody, /rm -rf -- "\$GATE_DIR"/);
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env[\s\S]*\$STAGE_DIR\/scripts\/apply-hermes-runtime-split\.sh/);
  assert.match(deploy, /"\$\{SUDO\[@\]\}" env[\s\S]*\$STAGE_DIR\/scripts\/verify-hermes-release\.sh/);
  assert.match(deploy, /read -r expected_candidate expected_digest < <\("\$\{SUDO\[@\]\}" cat "\$STAGE_DIR\/candidate"\)/);
  assert.match(deploy, /protected_manifest_digest/);
  assert.match(deploy, /tee -a "\$SNAPSHOT_DIR\/manifest"/);
  assert.match(deploy, /done < <\("\$\{SUDO\[@\]\}" cat "\$SNAPSHOT_DIR\/manifest"\)/);
  assert.match(deploy, /\$STAGE_DIR\/scripts\/apply-hermes-runtime-split\.sh/);
  assert.match(deploy, /\$STAGE_DIR\/scripts\/verify-hermes-release\.sh/);
  assert.match(deploy, /ran-agent-ombre-brain\.service/);
  assert.match(deploy, /ran-agent-ombre-recall\.service/);
  assert.match(deploy, /ran-agent-xhs-browse\.service/);
  assert.match(deploy, /ran-agent-xhs-public-sidecar\.service/);
  assert.doesNotMatch(deploy, /restore_(?:runtime_files|state_migrations|service_state) \|\| true/);
  assert.match(deploy, /rollback-incomplete/);
  assert.match(deploy, /exit 70/);
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
  assert.match(accept, /ombreCompatPatchedProcess\.test\.mjs/);
  assert.match(accept, /verify-ombre-steward-real-process|RAN_AGENT_OMBRE_UPSTREAM_VENV/);
  assert.doesNotMatch(preMutationGate, /RAN_AGENT_OMBRE_UPSTREAM_(?:SOURCE_DIR|VENV)/);
  assert.match(deploy, /prune-hermes-release-artifacts\.sh" --apply[\s\S]*snapshot_runtime_state/);
  assert.match(accept, /RAN_AGENT_RELEASE_PREMUTATION_GATE[\s\S]*verify-ombre-steward-real-process\.sh/);
  assert.match(accept, /--source-dir "\$OMBRE_BRAIN_HOME\/upstream"/);
  assert.match(accept, /--venv "\$OMBRE_BRAIN_HOME\/\.venv"/);
  assert.match(accept, /--property=DropInPaths --value/);
  assert.match(accept, /--property=ExecStart --value/);
  assert.match(accept, /\/proc\/\$pid\/environ/);
  assert.match(stewardVerify, /apply_ombre_steward_patch\.py/);
  assert.match(stewardVerify, /--verify/);
  assert.match(accept, /hermes-release-gate\.sh" --all/);
  assert.match(accept, /node_version_unsupported/);
  assert.match(accept, /systemctl is-active/);
  assert.doesNotMatch(deploy, /ssh |scp |rsync /);
  assert.doesNotMatch(accept, /ssh |scp |rsync /);
});

test('Steward release separates staged source from canonical live state and invokes rotation', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const prepare = readFileSync(join(root, 'scripts', 'prepare-ombre-brain.sh'), 'utf8');
  const start = readFileSync(join(root, 'scripts', 'start_ombre_brain_service.sh'), 'utf8');
  const diagnose = readFileSync(join(root, 'scripts', 'diagnose-ombre-memory.sh'), 'utf8');

  assert.match(deploy, /CANONICAL_LIVE_STATE_DIR="\$\{RAN_AGENT_RELEASE_STATE_DIR:-\/opt\/ran_agent\/\.ran_agent_state\}"/);
  assert.match(deploy, /RAN_AGENT_REPO_ROOT="\$STAGE_DIR"/);
  assert.match(deploy, /RAN_AGENT_DEPLOY_STATE_DIR="\$CANONICAL_LIVE_STATE_DIR"/);
  assert.match(deploy, /RAN_AGENT_STATE_DIR="\$CANONICAL_LIVE_STATE_DIR"/);
  assert.match(deploy, /RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME="\$CANONICAL_LIVE_STATE_DIR\/ombre-brain"/);
  assert.match(deploy, /RAN_AGENT_ROTATE_STEWARD_TOKEN=1/);
  assert.match(apply, /RAN_AGENT_STATE_DIR="\$RUNTIME_STATE_DIR"/);
  assert.match(apply, /OMBRE_BRAIN_HOME_DEFAULT="\$RUNTIME_STATE_DIR\/ombre-brain"/);
  assert.match(apply, /Ombre Brain home must derive from the canonical live state directory/);
  assert.match(apply, /RAN_AGENT_ROTATE_STEWARD_TOKEN="\$\{RAN_AGENT_ROTATE_STEWARD_TOKEN:-0\}"/);
  assert.match(prepare, /RAN_AGENT_STATE_DIR="\$\{RAN_AGENT_STATE_DIR:-\/opt\/ran_agent\/\.ran_agent_state\}"/);
  assert.match(prepare, /token_args\+=\(--rotate\)/);
  assert.match(start, /CALLER_STATE_DIR="\$\{RAN_AGENT_STATE_DIR:-\}"/);
  assert.match(start, /\/opt\/ran_agent\/\.ran_agent_state/);
  assert.doesNotMatch(start, /prepare-ombre-brain\.sh/);
  assert.match(diagnose, /CALLER_STATE_DIR="\$\{RAN_AGENT_STATE_DIR:-\}"/);
  assert.match(diagnose, /\/opt\/ran_agent\/\.ran_agent_state/);
});

test('custom live state executes prepare and start without writing into the staged repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-custom-state-'));
  const stage = join(dir, 'stage-repo');
  const state = join(dir, 'custom-live-state');
  const home = join(state, 'ombre-brain');
  const source = join(home, 'upstream');
  const venv = join(home, '.venv');
  const bin = join(dir, 'bin');
  const token = join(state, 'ombre-compat', 'secrets', 'steward-api-token');
  mkdirSync(join(stage, 'scripts'), { recursive: true });
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(venv, 'bin'), { recursive: true });
  mkdirSync(bin);
  for (const name of ['prepare-ombre-brain.sh', 'start_ombre_brain_service.sh']) {
    copyFileSync(join(root, 'scripts', name), join(stage, 'scripts', name));
    chmodSync(join(stage, 'scripts', name), 0o755);
  }
  writeFileSync(join(source, 'src', 'server.py'), '# fixture\n');
  writeFileSync(join(source, 'requirements.lock.txt'), 'fixture==1 \\\n+    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  writeFileSync(join(venv, 'bin', 'python'), [
    '#!/bin/sh',
    'case "$*" in *"sys.version_info"*) printf "3.11\\n"; exit 0;; esac',
    'exit 1',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = clone ]; then',
    '  for target do :; done',
    '  mkdir -p "$target/src" "$target/.git"',
    '  printf "%s\\n" "# fixture" > "$target/src/server.py"',
    '  printf "%s\\n" "fixture==1 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" > "$target/requirements.lock.txt"',
    '  exit 0',
    'fi',
    'case "$*" in',
    '  *"rev-parse HEAD"*) printf "%s\\n" 0e83d4671ce1629e03ad36bb9160235bf60dbd34 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'patch-python'), [
    '#!/bin/sh',
    'case "$*" in *"sys.version_info"*) printf "3.12\\n"; exit 0;; *"-m pip check"*|*"-m pip install"*|*"import frontmatter"*) exit 0;; *"src/server.py"*) printf "runtime=%s|%s|%s\\n" "$RAN_AGENT_STATE_DIR" "$OMBRE_BRAIN_HOME" "$RAN_AGENT_STEWARD_TOKEN_FILE"; exit 0;; esac',
    'case "$1" in',
    '  -m)',
    '    [ "$2" = venv ] || exit 1',
    '    mkdir -p "$3/bin"',
    '    cp "$0" "$3/bin/python"',
    '    chmod 0755 "$3/bin/python"',
    '    : > "$3/.recreated-with-python312"',
    '    ;;',
    '  */install-ombre-steward-token.py)',
    '    shift; state=""',
    '    while [ "$#" -gt 0 ]; do case "$1" in --state-dir) state=$2; shift 2;; *) shift;; esac; done',
    '    mkdir -p "$state/ombre-compat/secrets"',
    '    printf "%064d\\n" 0 > "$state/ombre-compat/secrets/steward-api-token"',
    '    chmod 0600 "$state/ombre-compat/secrets/steward-api-token"',
    '    ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  for (const executable of [join(venv, 'bin', 'python'), join(bin, 'git'), join(bin, 'patch-python')]) {
    chmodSync(executable, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    NODE_ENV: 'test',
    RAN_AGENT_SKIP_ENV_FILE_LOAD: '1',
    RAN_AGENT_REPO_ROOT: stage,
    RAN_AGENT_STATE_DIR: state,
    RAN_AGENT_OMBRE_PATCH_PYTHON_BIN: join(bin, 'patch-python'),
    OMBRE_BRAIN_UPDATE_SOURCE: 'false',
    OMBRE_BUCKETS_DIR: join(dir, 'buckets'),
  };
  try {
    execFileSync('bash', [join(stage, 'scripts', 'prepare-ombre-brain.sh')], {
      env, encoding: 'utf8', stdio: 'pipe',
    });
    assert.equal(existsSync(join(venv, '.recreated-with-python312')), true);
    rmSync(source, { recursive: true, force: true });
    rmSync(venv, { recursive: true, force: true });
    execFileSync('bash', [join(stage, 'scripts', 'prepare-ombre-brain.sh')], {
      env, encoding: 'utf8', stdio: 'pipe',
    });
    const output = execFileSync('bash', [join(stage, 'scripts', 'start_ombre_brain_service.sh')], {
      env, encoding: 'utf8', stdio: 'pipe',
    });
    assert.equal(existsSync(token), true);
    assert.equal(existsSync(join(venv, '.recreated-with-python312')), true);
    assert.equal(existsSync(join(source, 'src', 'server.py')), true);
    assert.equal(existsSync(join(venv, '.requirements.lock.fingerprint')), true);
    assert.equal(existsSync(join(home, 'status.json')), true);
    assert.match(output, new RegExp(`runtime=${state.replaceAll('/', '\\/')}\\|${home.replaceAll('/', '\\/')}\\|${token.replaceAll('/', '\\/')}`));
    assert.equal(existsSync(join(stage, '.ran_agent_state')), false);
    assert.equal(existsSync(join(stage, 'ombre-brain')), false);
    assert.throws(() => execFileSync('bash', [join(stage, 'scripts', 'start_ombre_brain_service.sh')], {
      env: { ...env, OMBRE_BRAIN_HOME: '/opt/ran_agent/.ran_agent_state/ombre-brain' },
      encoding: 'utf8', stdio: 'pipe',
    }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node and Ombre use fixed ran-agent identity while Lite and Full keep their own runtime identity', () => {
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const identity = readFileSync(join(root, 'scripts', 'verify-ran-agent-runtime-identity.sh'), 'utf8');
  const nodeDropin = apply.match(/write_node_steward_identity_dropin\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const ombreUnit = apply.match(/write_ombre_brain_unit\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const systemdUnits = apply.match(/write_systemd_units\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(apply, /STEWARD_RUNTIME_USER=ran-agent/);
  assert.match(apply, /STEWARD_RUNTIME_GROUP=ran-agent/);
  assert.match(nodeDropin, /User=\$STEWARD_RUNTIME_USER/);
  assert.match(nodeDropin, /Group=\$STEWARD_RUNTIME_GROUP/);
  assert.match(nodeDropin, /Environment=RAN_AGENT_NODE_BIN=/);
  assert.match(readFileSync(join(root, 'node_bridge', 'start_node.sh'), 'utf8'), /exec "\$NODE_BIN" src\/index\.mjs/);
  assert.match(ombreUnit, /User=\$STEWARD_RUNTIME_USER/);
  assert.match(ombreUnit, /Group=\$STEWARD_RUNTIME_GROUP/);
  assert.match(systemdUnits, /User=\$RUNTIME_USER/);
  assert.match(systemdUnits, /Group=\$RUNTIME_GROUP/);
  assert.match(apply, /legacy runtime identity override must equal ran-agent/);
  assert.match(apply, /verify-ran-agent-runtime-identity\.sh/);
  assert.match(apply, /--ensure-account/);
  assert.match(apply, /--verify-process/);
  assert.doesNotMatch(apply, /RUNTIME_USER="\$\{RAN_AGENT_RUNTIME_USER:-ubuntu\}"/);
  assert.match(identity, /groupadd --system "\$STEWARD_GROUP"/);
  assert.match(identity, /useradd --system --gid "\$STEWARD_GROUP"/);
  assert.doesNotMatch(identity, /login\.defs|SYS_(?:UID|GID)_(?:MIN|MAX)/);
  assert.match(identity, /uid != 0/);
  assert.match(identity, /gid != 0/);
  assert.match(identity, /\/usr\/sbin\/nologin/);
  assert.match(identity, /\/opt\/ran_agent/);
  assert.match(identity, /process_uid_mismatch/);
  assert.match(identity, /process_gid_mismatch/);
  assert.match(identity, /main_pid_drift/);
});

test('ordinary release snapshot excludes Steward secrets and retains non-secret state', () => {
  const fixture = makeDeployServiceFixture();
  const liveState = join(fixture.dir, 'live-state');
  const token = join(liveState, 'ombre-compat', 'secrets', 'steward-api-token');
  const durable = join(liveState, 'ombre-compat', 'queue.jsonl');
  try {
    mkdirSync(join(token, '..'), { recursive: true });
    writeFileSync(token, `${'a'.repeat(64)}\n`);
    writeFileSync(durable, '{"state":"queued"}\n');
    mkdirSync(join(fixture.snapshot, 'files'), { recursive: true });
    writeFileSync(join(fixture.snapshot, 'manifest'), '');
    runDeployServiceFixture(fixture, [
      `STATE_DIR=${JSON.stringify(liveState)}`,
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'snapshot_node_durable_state',
    ].join('\n'));
    assert.equal(existsSync(join(fixture.snapshot, 'files', '900', 'ombre-compat', 'queue.jsonl')), true);
    assert.equal(existsSync(join(fixture.snapshot, 'files', '900', 'ombre-compat', 'secrets')), false);
    assert.doesNotMatch(readFileSync(join(fixture.snapshot, 'manifest'), 'utf8'), /steward-api-token|ombre-compat\/secrets/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('candidate Node dependency activation is rollback-complete', () => {
  const fixture = makeDeployServiceFixture();
  const stage = join(fixture.dir, 'stage');
  try {
    mkdirSync(join(stage, 'node_modules'), { recursive: true });
    mkdirSync(join(fixture.repo, 'node_modules'), { recursive: true });
    writeFileSync(join(stage, 'node_modules', 'candidate.txt'), 'candidate\n');
    writeFileSync(join(fixture.repo, 'node_modules', 'prior.txt'), 'prior\n');
    writeFileSync(join(fixture.bin, 'chown'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fixture.bin, 'chown'), 0o755);
    runDeployServiceFixture(fixture, [
      'SUDO=(/usr/bin/env)',
      `PYTHON_BIN=${JSON.stringify(pythonBin)}`,
      `STAGE_DIR=${JSON.stringify(stage)}`,
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'activate_candidate_node_dependencies',
    ].join('\n'));
    assert.equal(existsSync(join(fixture.repo, 'node_modules', 'candidate.txt')), true);
    assert.equal(existsSync(join(fixture.snapshot, 'node_modules.rollback', 'prior.txt')), true);
    runDeployServiceFixture(fixture, [
      'SUDO=(/usr/bin/env)',
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'restore_node_dependencies',
    ].join('\n'));
    assert.equal(existsSync(join(fixture.repo, 'node_modules', 'prior.txt')), true);
    assert.equal(existsSync(join(fixture.repo, 'node_modules', 'candidate.txt')), false);

    rmSync(join(fixture.repo, 'node_modules'), { recursive: true });
    mkdirSync(join(stage, 'node_modules'), { recursive: true });
    writeFileSync(join(stage, 'node_modules', 'candidate.txt'), 'candidate\n');
    runDeployServiceFixture(fixture, [
      'SUDO=(/usr/bin/env)',
      `PYTHON_BIN=${JSON.stringify(pythonBin)}`,
      `STAGE_DIR=${JSON.stringify(stage)}`,
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'activate_candidate_node_dependencies',
      'restore_node_dependencies',
    ].join('\n'));
    assert.equal(existsSync(join(fixture.repo, 'node_modules')), false);

    const sharedModules = join(fixture.dir, 'shared-node-modules');
    mkdirSync(sharedModules);
    mkdirSync(join(stage, 'node_modules'), { recursive: true });
    symlinkSync(sharedModules, join(fixture.repo, 'node_modules'), 'dir');
    assert.throws(() => runDeployServiceFixture(fixture, [
      'SUDO=(/usr/bin/env)',
      `PYTHON_BIN=${JSON.stringify(pythonBin)}`,
      `STAGE_DIR=${JSON.stringify(stage)}`,
      `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
      'activate_candidate_node_dependencies',
    ].join('\n')), /Command failed/);
    assert.equal(realpathSync(join(fixture.repo, 'node_modules')), realpathSync(sharedModules));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Steward rollback restores the token before services and always destroys the private copy', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const rollback = deploy.match(/rollback_transaction\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(deploy, /SECRET_ROLLBACK_ROOT="\$\{RAN_AGENT_RELEASE_SECRET_ROLLBACK_ROOT:-\/run\/ran-agent-release-secrets\}"/);
  assert.match(deploy, /block_ombre_ingress[\s\S]*quiesce_runtime_services[\s\S]*backup_steward_token/);
  assert.ok(rollback.indexOf('block_ombre_ingress') < rollback.indexOf('restore_service_state'));
  assert.ok(rollback.indexOf('restore_steward_token') < rollback.indexOf('restore_service_state'));
  assert.ok(rollback.indexOf('restore_service_state') < rollback.indexOf('destroy_secret_rollback'));
  assert.ok(deploy.indexOf('ran-agent-ombre-brain.service ran-agent-node.service') > 0);
  assert.match(deploy, /verify_restored_steward_service "\$unit"/);
  assert.match(deploy, /verify-ran-agent-runtime-identity\.sh"[\s\\\n]*--verify-process "\$unit"/);
  assert.match(deploy, /--state-dir "\$STATE_DIR"[\s\\\n]*--identity-file "\$STATE_DIR\/ombre-brain\/steward-identity\.v1\.json"/);
  assert.match(deploy, /steward-token-not-restored/);
  assert.match(deploy, /rollback-incomplete/);
});

test('Steward acceptance blocks on effective identity, process identity, path, snapshot and old-token rejection', () => {
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  for (const pattern of [
    /release_steward_identity_contract ran-agent-node\.service/,
    /release_steward_identity_contract ran-agent-ombre-brain\.service/,
    /verify-ran-agent-runtime-identity\.sh/,
    /--verify-process/,
    /steward_identity_pid_drift/,
    /steward_token_in_staged_checkout/,
    /steward_secret_in_release_snapshot/,
    /secret_rollback_identity_contract/,
    /--rejected-token-file/,
    /steward_token_bytes_in_release_artifacts/,
    /steward_token_bytes_in_journal/,
  ]) assert.match(accept, pattern);
});

test('Steward acceptance checks effective names and shared numeric MainPID identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-accept-identity-'));
  const bin = join(dir, 'bin');
  const proc = join(dir, 'proc');
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  const contract = accept.match(/release_steward_identity_contract\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  mkdirSync(bin);
  mkdirSync(join(proc, '123'), { recursive: true });
  writeFileSync(join(proc, '123', 'status'), 'Uid:\t999\t999\t999\t999\nGid:\t999\t999\t999\t999\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"--property=User"*) printf "%s\\n" "${MOCK_USER:-ran-agent}" ;;',
    '  *"--property=Group"*) printf "%s\\n" "${MOCK_GROUP:-ran-agent}" ;;',
    '  *"--property=MainPID"*) printf "%s\\n" 123 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'stat'), '#!/bin/sh\nprintf "%s\\n" "${MOCK_OWNER:-ran-agent:ran-agent}"\n');
  writeFileSync(join(bin, 'cat'), '#!/bin/sh\nprintf "RAN_AGENT_STEWARD_TOKEN_FILE=%s/ombre-compat/secrets/steward-api-token\\n" "$RAN_AGENT_STATE_DIR"\n');
  writeFileSync(join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u|-g) printf "%s\\n" 999;; ran-agent) exit 0;; *) exit 1;; esac\n');
  writeFileSync(join(bin, 'getent'), '#!/bin/sh\ncase "$1" in passwd) printf "ran-agent:x:999:999::/opt/ran_agent:/usr/sbin/nologin\\n";; group) printf "ran-agent:x:999:\\n";; *) exit 1;; esac\n');
  for (const command of ['systemctl', 'stat', 'cat', 'id', 'getent']) chmodSync(join(bin, command), 0o755);
  const source = [
    'set -euo pipefail',
    'fail() { printf "%s\\n" "$1" >&2; return 1; }',
    'SUDO=(env)',
    `SOURCE_ROOT=${JSON.stringify(root)}`,
    `export RAN_AGENT_STATE_DIR=${JSON.stringify(join(dir, 'live-state'))}`,
    contract,
    'release_steward_identity_contract ran-agent-node.service',
  ].join('\n');
  const runContract = (extra = {}) => execFileSync('bash', ['-c', source], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_PROC_ROOT: proc,
      ...extra,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  try {
    assert.doesNotThrow(() => runContract());
    assert.throws(() => runContract({ MOCK_USER: 'ubuntu' }), /Command failed/);
    writeFileSync(join(proc, '123', 'status'), 'Uid:\t999\t998\t999\t999\nGid:\t999\t999\t999\t999\n');
    assert.throws(() => runContract(), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed Ombre endpoint checks obtain cross-user socket ownership through the privilege seam', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-ombre-socket-'));
  const bin = join(dir, 'bin');
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  const waitContract = apply.match(/wait_for_managed_endpoint\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const failureContext = apply.match(/print_managed_endpoint_failure\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const acceptContract = accept.match(/release_managed_endpoint_health\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  mkdirSync(bin);
  assert.match(waitContract, /print_managed_endpoint_failure/);
  assert.match(failureContext, /ExecMainStatus/);
  assert.match(failureContext, /NRestarts/);
  assert.match(failureContext, /journalctl/);
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexport PRIVILEGED_SOCKET_PROBE=1\nexec "$@"\n');
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\ncase "$1" in show) printf "123\\n";; is-active) exit 0;; *) exit 1;; esac\n');
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nif [ "${PRIVILEGED_SOCKET_PROBE:-}" = 1 ]; then printf "LISTEN 0 128 127.0.0.1:18001 users:((x,pid=123,fd=3))\\n"; else printf "LISTEN 0 128 127.0.0.1:18001\\n"; fi\n');
  for (const command of ['curl', 'sleep']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n');
  for (const command of ['sudo', 'systemctl', 'ss', 'curl', 'sleep']) chmodSync(join(bin, command), 0o755);
  const source = [
    'set -euo pipefail',
    'SUDO=(sudo)',
    'OMBRE_HEALTH_TIMEOUT_SECONDS=0',
    'log() { :; }',
    'fail() { printf "%s\\n" "$1" >&2; return 1; }',
    waitContract,
    acceptContract,
    'wait_for_managed_endpoint ran-agent-ombre-brain.service http://127.0.0.1:18001/health 18001 upstream',
    'release_managed_endpoint_health ran-agent-ombre-brain.service 18001 http://127.0.0.1:18001/health upstream',
  ].join('\n');
  try {
    assert.doesNotThrow(() => execFileSync('bash', ['-c', source], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
      stdio: 'pipe',
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed Ombre startup failure reports bounded redacted process evidence immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-ombre-startup-failure-'));
  const bin = join(dir, 'bin');
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const failureContext = apply.match(/print_managed_endpoint_failure\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const waitContract = apply.match(/wait_for_managed_endpoint\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  mkdirSync(bin);
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"--property=MainPID --value"*) printf "0\\n" ;;',
    '  *"--property=ActiveState --value"*) printf "failed\\n" ;;',
    '  show*) printf "ActiveState=failed\\nResult=exit-code\\nExecMainStatus=1\\nNRestarts=3\\n" ;;',
    '  is-active*) exit 3 ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'journalctl'), '#!/bin/sh\nprintf "%s\\n" "API_KEY=must-not-leak" "Permission denied: .env.local"\n');
  for (const command of ['ss', 'curl', 'sleep']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 1\n');
  for (const command of ['sudo', 'systemctl', 'journalctl', 'ss', 'curl', 'sleep']) chmodSync(join(bin, command), 0o755);
  const source = [
    'set -euo pipefail',
    'SUDO=(sudo)',
    'OMBRE_HEALTH_TIMEOUT_SECONDS=90',
    'log() { :; }',
    failureContext,
    waitContract,
    'wait_for_managed_endpoint ran-agent-ombre-brain.service http://127.0.0.1:18001/health 18001 upstream',
  ].join('\n');
  try {
    let failure;
    try {
      execFileSync('bash', ['-c', source], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure?.stderr), /ExecMainStatus=1/);
  assert.match(String(failure?.stderr), /startup_hint=permission_denied/);
  assert.doesNotMatch(String(failure?.stderr), /Permission denied: \.env\.local/);
  assert.doesNotMatch(String(failure?.stderr), /API_KEY=/);
    assert.doesNotMatch(String(failure?.stderr), /must-not-leak/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction retention keeps current production and only deletes explicitly accepted rollbackable history', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const immutableStage = join(fixture.dir, 'immutable-stage');
  const older = join(snapshotRoot, 'release-transaction.older.fixture');
  const oldest = join(snapshotRoot, 'release-transaction.oldest.fixture');
  const newestPrior = join(snapshotRoot, 'release-transaction.prior.fixture');
  const current = join(snapshotRoot, 'release-transaction.current.fixture');
  try {
    mkdirSync(join(immutableStage, 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'ombre_o1_contract.py'), join(immutableStage, 'scripts', 'ombre_o1_contract.py'));
    for (const [snapshot, timestamp, sha] of [
      [oldest, '2026-07-20T00:00:00Z', '1111111111111111111111111111111111111111'],
      [older, '2026-07-21T00:00:00Z', '2222222222222222222222222222222222222222'],
      [newestPrior, '2026-07-23T00:00:00Z', '3333333333333333333333333333333333333333'],
      [current, '2026-07-19T00:00:00Z', candidate()],
    ]) {
      mkdirSync(snapshot, { recursive: true });
      writeRetentionState(snapshot, { candidate_sha: sha, completed_at: timestamp });
    }
    writeFileSync(join(snapshotRoot, 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: current.split('/').at(-1),
      candidate_sha: candidate(),
    }));
    runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      'CURRENT_PRODUCTION_POINTER="$SNAPSHOT_ROOT/current-production.json"',
      `SNAPSHOT_DIR=${JSON.stringify(current)}`,
      `REPO_ROOT=${JSON.stringify(root)}`,
      `STAGE_DIR=${JSON.stringify(immutableStage)}`,
      'SCRIPT_ROOT=/definitely/missing/old-bootstrap-root',
      'TRANSACTION_STARTED=0',
      'prune_accepted_snapshots',
    ].join('\n'));
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(newestPrior), true);
    assert.equal(existsSync(older), false);
    assert.equal(existsSync(oldest), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('rollback is fail-loud, continues later stages, and preserves incomplete evidence', () => {
  const fixture = makeDeployServiceFixture();
  try {
    let failure;
    try {
      runDeployServiceFixture(fixture, [
        'CANDIDATE=0123456789abcdef0123456789abcdef01234567',
        'TRANSACTION_STARTED=1',
        'quiesce_runtime_services() { return 0; }',
        'restore_code_revision() { return 0; }',
        'restore_runtime_files() { printf runtime-files-attempted >> "$SNAPSHOT_DIR/stages"; return 1; }',
        'restore_state_migrations() { printf state-attempted >> "$SNAPSHOT_DIR/stages"; return 1; }',
        'restore_service_state() { printf services-attempted >> "$SNAPSHOT_DIR/stages"; return 0; }',
        'record_protected_capability_evidence() { return 0; }',
        'rollback_transaction 23',
      ].join('\n'));
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 70);
    assert.match(String(failure?.stderr), /rollback-incomplete deployment_status=23/);
    assert.match(readFileSync(join(fixture.snapshot, 'stages'), 'utf8'), /runtime-files-attemptedstate-attemptedservices-attempted/);
    assert.equal(JSON.parse(readFileSync(join(fixture.snapshot, 'transaction-state.json'), 'utf8')).status, 'rollback_failed');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('interrupted explicit rollback preserves accepted authority for a retry', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.interrupted.fixture');
  const pointer = join(snapshotRoot, 'current-production.json');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '900'), 'payload\n');
    writeFileSync(join(snapshot, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(snapshot);
    writeFileSync(pointer, JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    secureArtifactLayout(join(fixture.dir, 'artifacts'));
    assert.throws(() => runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      `CURRENT_PRODUCTION_POINTER=${JSON.stringify(pointer)}`,
      `SNAPSHOT_DIR=${JSON.stringify(snapshot)}`,
      `CANDIDATE=${JSON.stringify('b'.repeat(40))}`,
      'EXPLICIT_ROLLBACK=1',
      'TRANSACTION_STARTED=1',
      'quiesce_runtime_services() { return 0; }',
      'restore_runtime_files() { kill -TERM "$$"; return 1; }',
      'restore_state_migrations() { return 0; }',
      'restore_steward_token() { return 0; }',
      'restore_code_revision() { return 0; }',
      'block_ombre_ingress() { return 0; }',
      'clear_ombre_ingress_block() { return 0; }',
      'restore_service_state() { return 0; }',
      'destroy_secret_rollback() { return 0; }',
      'record_protected_capability_evidence() { return 0; }',
      'rollback_transaction 0',
    ].join('\n')), (error) => error.status === 70);
    assert.equal(JSON.parse(readFileSync(join(snapshot, 'transaction-state.json'), 'utf8')).status, 'accepted');
    assert.doesNotThrow(() => runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      `CURRENT_PRODUCTION_POINTER=${JSON.stringify(pointer)}`,
      `load_rollback_snapshot ${JSON.stringify(snapshot)}`,
      'test "$ROLLBACK_METADATA_FINALIZE" -eq 0',
    ].join('\n')));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('completed rollback with a stale production pointer remains metadata-finalizable', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.finalize.fixture');
  const pointer = join(snapshotRoot, 'current-production.json');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '900'), 'payload\n');
    writeFileSync(join(snapshot, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(snapshot, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: 'transaction:prior-production',
    });
    writeFileSync(pointer, JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    secureArtifactLayout(join(fixture.dir, 'artifacts'));
    runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      `CURRENT_PRODUCTION_POINTER=${JSON.stringify(pointer)}`,
      `load_rollback_snapshot ${JSON.stringify(snapshot)}`,
      'test "$ROLLBACK_METADATA_FINALIZE" -eq 1',
      'clear_current_production_pointer 1',
    ].join('\n'));
    assert.equal(existsSync(pointer), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('successful rollback reports complete and records a non-retainable rolled-back state', () => {
  const fixture = makeDeployServiceFixture();
  const rollbackSnapshot = join(fixture.dir, 'artifacts', 'snapshots', 'release-transaction.rollback.fixture');
  const rollbackLog = join(fixture.dir, 'rollback.log');
  try {
    const output = runDeployServiceFixture(fixture, [
      `mkdir -p ${JSON.stringify(join(rollbackSnapshot, 'files'))}`,
      `printf payload > ${JSON.stringify(join(rollbackSnapshot, 'files', '900'))}`,
      `cp "$SNAPSHOT_DIR/services" ${JSON.stringify(join(rollbackSnapshot, 'services'))}`,
      `cp "$SNAPSHOT_DIR/manifest" ${JSON.stringify(join(rollbackSnapshot, 'manifest'))}`,
      `cp "$SNAPSHOT_DIR/prior-head" ${JSON.stringify(join(rollbackSnapshot, 'prior-head'))}`,
      `SNAPSHOT_DIR=${JSON.stringify(rollbackSnapshot)}`,
      'CANDIDATE=0123456789abcdef0123456789abcdef01234567',
      'TRANSACTION_STARTED=1',
      'quiesce_runtime_services() { return 0; }',
      'restore_code_revision() { return 0; }',
      'restore_runtime_files() { return 0; }',
      'restore_state_migrations() { return 0; }',
      'restore_service_state() { return 0; }',
      'record_protected_capability_evidence() { return 0; }',
      `rollback_transaction 0 2>${JSON.stringify(rollbackLog)}`,
    ].join('\n'));
    assert.equal(output, '');
    const state = JSON.parse(readFileSync(join(rollbackSnapshot, 'transaction-state.json'), 'utf8'));
    assert.equal(state.status, 'rollback_used');
    assert.equal(state.rollbackable, false);
    const rollbackEvidence = readFileSync(rollbackLog, 'utf8');
    assert.match(rollbackEvidence, /artifact-payload-cleanup result=ok/);
    assert.match(rollbackEvidence, /decision=PRUNE_PAYLOAD.*mode=apply/);
    assert.match(rollbackEvidence, /payloads=1/);
    assert.equal(existsSync(join(rollbackSnapshot, 'files')), false);
    assert.equal(existsSync(join(rollbackSnapshot, 'manifest')), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('runtime file owner/mode restoration failure is reported after attempting remaining files', () => {
  const fixture = makeDeployServiceFixture();
  const first = join(fixture.dir, 'restore-first');
  const second = join(fixture.dir, 'restore-second');
  try {
    mkdirSync(join(fixture.snapshot, 'files'), { recursive: true });
    writeFileSync(join(fixture.snapshot, 'files', '0'), 'first');
    writeFileSync(join(fixture.snapshot, 'files', '1'), 'second');
    writeFileSync(join(fixture.snapshot, 'manifest'), `present\t0\t${first}\npresent\t1\t${second}\n`);
    const output = runDeployServiceFixture(fixture, [
      'sudo() { if [[ "$1" == cp && "$4" == *"/files/0" ]]; then return 1; fi; command sudo "$@"; }',
      'if restore_runtime_files; then exit 9; else printf "restore-failed-loud\\n"; fi',
    ].join('\n'));
    assert.match(output, /restore-failed-loud/);
    assert.equal(readFileSync(second, 'utf8'), 'second');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Lite, Full, and Ombre service restoration failures are individually fail-loud', () => {
  const units = [
    'ran-agent-python.service',
    'ran-agent-node.service',
    'ran-agent-hermes.service',
    'ran-agent-hermes-full.service',
    'ran-agent-ombre-brain.service',
    'ran-agent-ombre-recall.service',
    'ran-agent-xhs-browse.service',
    'ran-agent-xhs-public-sidecar.service',
  ];
  const states = Object.fromEntries(units.map((unit) => [unit, {
    load: 'loaded', active: 'active', enabled: 'enabled',
  }]));
  for (const failedUnit of ['ran-agent-hermes.service', 'ran-agent-hermes-full.service', 'ran-agent-ombre-brain.service']) {
    const fixture = makeDeployServiceFixture(states);
    try {
      const output = runDeployServiceFixture(fixture, [
        `FAILED_UNIT=${JSON.stringify(failedUnit)}`,
        'sudo() { if [[ "$1" == systemctl && "$2" == restart && "$3" == "$FAILED_UNIT" ]]; then return 1; fi; command sudo "$@"; }',
        'if restore_service_state; then exit 9; else printf "service-restore-failed-loud\\n"; fi',
      ].join('\n'));
      assert.match(output, /service-restore-failed-loud/);
      const trace = readFileSync(fixture.log, 'utf8');
      assert.match(trace, /restart ran-agent-xhs-public-sidecar\.service/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

test('successful acceptance keeps Ombre dependencies active instead of restoring pre-deploy inactivity', () => {
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  assert.doesNotMatch(deploy, /restore_temporary_ombre_state_after_acceptance/);
  assert.match(deploy, /mark_snapshot_accepted[\s\S]*prune_accepted_snapshots/);
});

test('retention skips unfinished, rollback-failed, resumable, and unknown snapshots', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  try {
    for (const [name, status] of [
      ['unfinished', 'snapshot-created'],
      ['rollback-failed', 'rollback-incomplete'],
      ['resumable', 'deployment-started'],
    ]) {
      const directory = join(snapshotRoot, `release-transaction.${name}.fixture`);
      mkdirSync(directory, { recursive: true });
      writeRetentionState(directory, {
        status: status === 'rollback-incomplete' ? 'rollback_failed' : status === 'deployment-started' ? 'resumable' : 'in_progress',
        acceptance_state: 'not_accepted',
        rollback_state: status === 'rollback-incomplete' ? 'rollback_failed' : 'not_used',
        rollbackable: false,
        completed_at: '',
      });
    }
    const unknown = join(snapshotRoot, 'release-transaction.unknown.fixture');
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(snapshotRoot, 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: 'release-transaction.production.fixture',
      candidate_sha: 'f'.repeat(40),
    }));
    const output = runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      'CURRENT_PRODUCTION_POINTER="$SNAPSHOT_ROOT/current-production.json"',
      `REPO_ROOT=${JSON.stringify(root)}`,
      'TRANSACTION_STARTED=0',
      'prune_accepted_snapshots',
    ].join('\n'));
    assert.equal((output.match(/retention=SKIP_UNCERTAIN/g) || []).length, 4);
    for (const directory of readdirSync(snapshotRoot)) assert.equal(existsSync(join(snapshotRoot, directory)), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('artifact cleanup removes only verified rollback-used payloads and retains transaction evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-prune-'));
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const rolledBack = join(snapshotRoot, 'release-transaction.rolled-back.fixture');
  const damaged = join(snapshotRoot, 'release-transaction.damaged.fixture');
  const symlinked = join(snapshotRoot, 'release-transaction.symlinked.fixture');
  const stateSymlinked = join(snapshotRoot, 'release-transaction.state-symlinked.fixture');
  const outside = join(dir, 'outside-payload');
  const outsideState = join(dir, 'outside-state.json');
  try {
    for (const directory of [rolledBack, damaged]) {
      mkdirSync(join(directory, 'files'), { recursive: true });
      writeFileSync(join(directory, 'files', '900'), 'large restored payload\n');
      writeRetentionState(directory, {
        status: 'rollback_used',
        acceptance_state: 'not_accepted',
        rollback_state: 'rollback_used',
        rollbackable: false,
        current_production_identity: 'transaction:prior-production',
      });
    }
    const damagedState = JSON.parse(readFileSync(join(damaged, 'transaction-state.json'), 'utf8'));
    damagedState.manifest_digest = '0'.repeat(64);
    writeFileSync(join(damaged, 'transaction-state.json'), JSON.stringify(damagedState));
    mkdirSync(symlinked, { recursive: true });
    writeRetentionState(symlinked, {
      status: 'rollback_used',
      acceptance_state: 'not_accepted',
      rollback_state: 'rollback_used',
      rollbackable: false,
      current_production_identity: 'transaction:prior-production',
    });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'must survive\n');
    symlinkSync(outside, join(symlinked, 'files'));
    mkdirSync(join(stateSymlinked, 'files'), { recursive: true });
    writeFileSync(join(stateSymlinked, 'files', '900'), 'must survive\n');
    writeRetentionState(stateSymlinked, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: 'transaction:prior-production',
    });
    copyFileSync(join(stateSymlinked, 'transaction-state.json'), outsideState);
    rmSync(join(stateSymlinked, 'transaction-state.json'));
    symlinkSync(outsideState, join(stateSymlinked, 'transaction-state.json'));
    secureArtifactLayout(artifactRoot);

    const env = {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
    };
    const preview = run('prune-hermes-release-artifacts.sh', ['--dry-run'], env);
    assert.match(preview, /mode=dry-run/);
    assert.equal(existsSync(join(rolledBack, 'files', '900')), true);
    const output = run('prune-hermes-release-artifacts.sh', ['--apply'], env);
    assert.match(output, /decision=PRUNE_PAYLOAD/);
    assert.equal(existsSync(join(rolledBack, 'files')), false);
    assert.equal(existsSync(join(rolledBack, 'transaction-state.json')), true);
    assert.equal(existsSync(join(rolledBack, 'manifest')), true);
    assert.equal(existsSync(join(rolledBack, 'services')), true);
    assert.equal(existsSync(join(damaged, 'files', '900')), true);
    assert.equal(existsSync(join(outside, 'keep')), true);
    assert.equal(existsSync(join(symlinked, 'files')), true);
    assert.equal(existsSync(join(stateSymlinked, 'files', '900')), true);
    assert.match(output, /decision=SKIP_UNCERTAIN/);
    assert.match(readFileSync(join(root, 'scripts', 'prune-hermes-release-artifacts.sh'), 'utf8'), /\/proc\/self\/mountinfo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cleanup preserves the current production transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-prune-current-'));
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const current = join(snapshotRoot, 'release-transaction.current.fixture');
  try {
    mkdirSync(join(current, 'files'), { recursive: true });
    writeFileSync(join(current, 'files', '900'), 'must remain\n');
    writeRetentionState(current, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: `transaction:${current.split('/').at(-1)}`,
    });
    writeFileSync(join(snapshotRoot, 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: current.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    secureArtifactLayout(artifactRoot);
    const output = run('prune-hermes-release-artifacts.sh', ['--apply'], {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
    });
    assert.match(output, /decision=KEEP/);
    assert.equal(existsSync(join(current, 'files', '900')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cleanup bounds failed-release stages, archives, deltas, and state-less final snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-ephemera-'));
  const artifactRoot = join(dir, 'artifacts');
  const stage = join(artifactRoot, 'stages', 'release-stage.fixture');
  const archive = join(artifactRoot, 'archives', `release-candidate.${'a'.repeat(40)}.tar`);
  const delta = join(artifactRoot, 'archives', `release-delta.${'b'.repeat(40)}..${'a'.repeat(40)}.txt`);
  const incomplete = join(artifactRoot, 'snapshots', '.release-incomplete.fixture');
  const protectedIncomplete = join(artifactRoot, 'snapshots', '.release-incomplete.current.fixture');
  const unknownFinal = join(artifactRoot, 'snapshots', 'release-transaction.unknown-no-state.fixture');
  try {
    mkdirSync(stage, { recursive: true });
    mkdirSync(join(incomplete, 'files'), { recursive: true });
    mkdirSync(join(protectedIncomplete, 'files'), { recursive: true });
    mkdirSync(join(unknownFinal, 'files'), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(join(stage, 'payload'), 'stage residue\n');
    writeFileSync(join(incomplete, 'files', 'payload'), 'incomplete snapshot residue\n');
    writeFileSync(join(protectedIncomplete, 'files', 'payload'), 'pointer-protected residue\n');
    writeFileSync(join(unknownFinal, 'files', 'payload'), 'unknown final snapshot\n');
    writeFileSync(join(artifactRoot, 'snapshots', 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: protectedIncomplete.split('/').at(-1),
      candidate_sha: 'c'.repeat(40),
    }));
    writeFileSync(archive, 'archive residue\n');
    writeFileSync(delta, 'delta residue\n');
    secureArtifactLayout(artifactRoot);
    const env = { RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot, RAN_AGENT_NO_SUDO: '1' };
    const preview = run('prune-hermes-release-artifacts.sh', ['--dry-run'], env);
    assert.match(preview, /ephemera=3/);
    assert.match(preview, /incomplete=1/);
    assert.equal(existsSync(stage), true);
    const output = run('prune-hermes-release-artifacts.sh', ['--apply'], env);
    assert.match(output, /ephemera=3/);
    assert.match(output, /orphans=1/);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(archive), false);
    assert.equal(existsSync(delta), false);
    assert.equal(existsSync(incomplete), false);
    assert.equal(existsSync(protectedIncomplete), true);
    assert.equal(existsSync(unknownFinal), false);
    assert.match(run('prune-hermes-release-artifacts.sh', ['--apply'], env), /ephemera=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cleanup preserves a current production transaction whose legacy state is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-prune-current-orphan-'));
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const current = join(snapshotRoot, 'release-transaction.current-no-state.fixture');
  try {
    mkdirSync(join(current, 'files'), { recursive: true });
    writeFileSync(join(current, 'files', '900'), 'must remain\n');
    writeFileSync(join(snapshotRoot, 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: current.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    secureArtifactLayout(artifactRoot);
    const output = run('prune-hermes-release-artifacts.sh', ['--apply'], {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
    });
    assert.match(output, /decision=KEEP/);
    assert.equal(existsSync(join(current, 'files', '900')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed pre-transaction release removes only its own partial artifacts', () => {
  const fixture = makeDeployServiceFixture();
  const artifactRoot = join(fixture.dir, 'artifacts');
  const stage = join(artifactRoot, 'stages', 'release-stage.partial.fixture');
  const archive = join(artifactRoot, 'archives', `release-candidate.${'a'.repeat(40)}.tar`);
  const delta = join(artifactRoot, 'archives', `release-delta.${'b'.repeat(40)}..${'a'.repeat(40)}.txt`);
  const snapshot = join(artifactRoot, 'snapshots', '.release-incomplete.partial.fixture');
  try {
    assert.throws(() => runDeployServiceFixture(fixture, [
      `STAGE_DIR=${JSON.stringify(stage)}`,
      `CANDIDATE_ARCHIVE=${JSON.stringify(archive)}`,
      `DELTA_FILE=${JSON.stringify(delta)}`,
      `SNAPSHOT_DIR=${JSON.stringify(snapshot)}`,
      'SNAPSHOT_BUILD_ACTIVE=1',
      'mkdir -p "$STAGE_DIR" "$(dirname "$CANDIDATE_ARCHIVE")" "$SNAPSHOT_DIR/files"',
      'printf residue > "$STAGE_DIR/payload"',
      'printf residue > "$CANDIDATE_ARCHIVE"',
      'printf residue > "$DELTA_FILE"',
      'printf partial > "$SNAPSHOT_DIR/files/0"',
      'exit 28',
    ].join('\n')), /Command failed/);
    for (const path of [stage, archive, delta, snapshot]) assert.equal(existsSync(path), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a corrupt unpublished transaction state is cleaned without becoming rollback authority', () => {
  const fixture = makeDeployServiceFixture();
  const snapshot = join(fixture.dir, 'artifacts', 'snapshots', '.release-incomplete.corrupt.fixture');
  const marker = join(fixture.dir, 'rollback-boundary');
  try {
    assert.throws(() => runDeployServiceFixture(fixture, [
      `SNAPSHOT_DIR=${JSON.stringify(snapshot)}`,
      'SNAPSHOT_BUILD_ACTIVE=1',
      `SNAPSHOT_FINAL_DIR=${JSON.stringify(join(fixture.dir, 'artifacts', 'snapshots', 'release-transaction.never-published.fixture'))}`,
      'mkdir -p "$SNAPSHOT_DIR/files"',
      'printf prior > "$SNAPSHOT_DIR/prior-head"',
      'printf manifest > "$SNAPSHOT_DIR/manifest"',
      'printf services > "$SNAPSHOT_DIR/services"',
      'printf "{}" > "$SNAPSHOT_DIR/transaction-state.json"',
      `rollback_transaction() { printf '%s' "$1" > ${JSON.stringify(marker)}; stop_release_transaction_lock; exit "$1"; }`,
      'exit 28',
    ].join('\n')), /Command failed/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(snapshot), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('durable accepted state plus production pointer suppresses signal-window rollback', () => {
  const fixture = makeDeployServiceFixture();
  const snapshot = join(fixture.dir, 'artifacts', 'snapshots', 'release-transaction.accepted-window.fixture');
  const pointer = join(fixture.dir, 'artifacts', 'snapshots', 'current-production.json');
  const marker = join(fixture.dir, 'unexpected-rollback');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeRetentionState(snapshot, { candidate_sha: 'b'.repeat(40) });
    writeFileSync(pointer, JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    assert.throws(() => runDeployServiceFixture(fixture, [
      `SNAPSHOT_DIR=${JSON.stringify(snapshot)}`,
      `CURRENT_PRODUCTION_POINTER=${JSON.stringify(pointer)}`,
      `CANDIDATE=${JSON.stringify('b'.repeat(40))}`,
      'TRANSACTION_STARTED=1',
      'TRANSACTION_ACCEPTED=0',
      `rollback_transaction() { printf rollback > ${JSON.stringify(marker)}; exit 70; }`,
      'exit 28',
    ].join('\n')), /Command failed/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(pointer), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('artifact cleanup rejects snapshot mount boundaries and production-pointer symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-prune-boundary-'));
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.boundary.fixture');
  const mountinfo = join(dir, 'mountinfo');
  const outsidePointer = join(dir, 'outside-pointer.json');
  const pointer = join(snapshotRoot, 'current-production.json');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '900'), 'must remain\n');
    writeRetentionState(snapshot, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: 'transaction:prior-production',
    });
    secureArtifactLayout(artifactRoot);
    const encodedSnapshot = realpathSync(snapshot).replaceAll('\\', '\\134').replaceAll(' ', '\\040');
    writeFileSync(mountinfo, `36 25 0:32 / ${encodedSnapshot} rw,relatime - ext4 /dev/root rw\n`);
    run('prune-hermes-release-artifacts.sh', ['--apply'], {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_MOUNTINFO_FILE: mountinfo,
    });
    assert.equal(existsSync(join(snapshot, 'files', '900')), true, 'snapshot mount boundary must not be traversed');

    writeFileSync(mountinfo, '');
    writeFileSync(outsidePointer, JSON.stringify({
      schema_version: 1,
      transaction_id: 'release-transaction.other.fixture',
      candidate_sha: 'c'.repeat(40),
    }));
    symlinkSync(outsidePointer, pointer);
    assert.throws(() => run('prune-hermes-release-artifacts.sh', ['--apply'], {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
    }), /production_pointer_invalid/);
    assert.equal(existsSync(join(snapshot, 'files', '900')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cleanup rejects permissive or foreign release subroots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-layout-'));
  const artifactRoot = join(dir, 'artifacts');
  try {
    secureArtifactLayout(artifactRoot);
    chmodSync(join(artifactRoot, 'stages'), 0o755);
    assert.throws(() => run('prune-hermes-release-artifacts.sh', ['--dry-run'], {
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_NO_SUDO: '1',
    }), /artifact_layout_identity_invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post-prune capacity gate stops before snapshot, service stop, or checkout when headroom remains insufficient', () => {
  const fixture = makeDeployServiceFixture();
  const artifactRoot = join(fixture.dir, 'capacity-artifacts');
  const state = join(fixture.dir, 'capacity-state');
  const trace = join(fixture.dir, 'capacity-trace');
  const mutation = join(fixture.dir, 'capacity-mutation');
  try {
    mkdirSync(artifactRoot);
    mkdirSync(state);
    writeFileSync(join(state, 'live-state'), 'must remain\n');
    const commands = [
      'SUDO=(/usr/bin/env)',
      `ARTIFACT_ROOT=${JSON.stringify(artifactRoot)}`,
      `STATE_DIR=${JSON.stringify(state)}`,
      `STAGE_DIR=${JSON.stringify(root)}`,
      'service_env_files() { :; }',
      `printf '%s\n' prune >> ${JSON.stringify(trace)}`,
      `snapshot_runtime_state() { printf '%s\n' snapshot >> ${JSON.stringify(mutation)}; }`,
      `quiesce_runtime_services() { printf '%s\n' stop >> ${JSON.stringify(mutation)}; }`,
      `activate_candidate_checkout() { printf '%s\n' checkout >> ${JSON.stringify(mutation)}; }`,
      'snapshot_capacity_gate',
      'snapshot_runtime_state',
      'quiesce_runtime_services',
      'activate_candidate_checkout',
    ].join('\n');
    let failure;
    try {
      runDeployServiceFixture(fixture, commands, {
        RAN_AGENT_TEST_MODE: '1',
        RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: '0',
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(String(failure.stderr), /free_bytes=0 required_bytes=[1-9][0-9]*/);
    assert.match(String(failure.stderr), /snapshot_capacity_insufficient/);
    assert.equal(readFileSync(trace, 'utf8'), 'prune\n');
    assert.equal(existsSync(mutation), false);
    assert.equal(readFileSync(join(state, 'live-state'), 'utf8'), 'must remain\n');

    for (const file of ['prior-head', 'manifest', 'services']) {
      rmSync(join(fixture.snapshot, file), { force: true });
    }
    const output = runDeployServiceFixture(fixture, commands, {
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(10 * 1024 ** 4),
    });
    assert.match(output, /snapshot-capacity free_bytes=[0-9]+ required_bytes=[0-9]+/);
    assert.equal(readFileSync(mutation, 'utf8'), 'snapshot\nstop\ncheckout\n');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('capacity admission counts filesystem blocks, inodes, and fixed candidate reserves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-capacity-fixed-'));
  const helper = join(root, 'scripts', 'check-hermes-snapshot-capacity.py');
  try {
    const tiny = join(dir, 'tiny');
    mkdirSync(tiny);
    for (let index = 0; index < 8; index += 1) writeFileSync(join(tiny, String(index)), 'x');
    const output = execFileSync(pythonBin, ['-I', helper, '--artifact-root', dir, '--fixed-bytes', '4096'], {
      env: { PATH: '/usr/bin:/bin', RAN_AGENT_TEST_MODE: '1', RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(3 * 1024 ** 3) },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(output, new RegExp(`required_bytes=${2 * 1024 ** 3 + 4096}`));
    const allocated = execFileSync(pythonBin, ['-I', helper, '--artifact-root', dir, '--source', tiny], {
      env: { PATH: '/usr/bin:/bin', RAN_AGENT_TEST_MODE: '1', RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(3 * 1024 ** 3) },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const requiredBytes = Number(allocated.match(/required_bytes=(\d+)/)?.[1]);
    assert.ok(requiredBytes > 2 * 1024 ** 3 + 8, 'one-byte files must reserve allocated blocks, not only logical bytes');
    assert.throws(() => execFileSync(pythonBin, ['-I', helper, '--artifact-root', dir, '--fixed-inodes', '1'], {
      env: {
        PATH: '/usr/bin:/bin', RAN_AGENT_TEST_MODE: '1',
        RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(3 * 1024 ** 3),
        RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_INODES: '0',
      },
      stdio: 'pipe',
    }), /Command failed/);
    assert.throws(() => execFileSync(pythonBin, ['-I', helper, '--artifact-root', dir, '--fixed-bytes', '-1'], {
      env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe',
    }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial snapshot copies never become rollback-authoritative and live state plus service survive', () => {
  const core = [
    'ran-agent-python.service', 'ran-agent-node.service',
    'ran-agent-hermes.service', 'ran-agent-hermes-full.service',
  ];
  const fixture = makeDeployServiceFixture(Object.fromEntries(core.map((unit) => [unit, {
    load: 'loaded', active: unit === 'ran-agent-node.service' ? 'active' : 'inactive', enabled: 'enabled',
  }])));
  const state = join(fixture.dir, 'live-state');
  const runtimeFile = join(fixture.dir, 'runtime-config');
  try {
    mkdirSync(state);
    writeFileSync(join(state, 'sentinel'), 'complete-live-state\n');
    writeFileSync(runtimeFile, 'complete-runtime-config\n');
    writeFileSync(join(fixture.bin, 'cp'), [
      '#!/bin/sh',
      'for target do :; done',
      'mkdir -p "$(dirname "$target")"',
      'printf "%s\\n" partial > "$target"',
      'exit 28',
      '',
    ].join('\n'));
    writeFileSync(join(fixture.bin, 'tar'), [
      '#!/bin/sh',
      'extract=0; target=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in -C) target=$2; shift 2;; -xpf) extract=1; shift 2;; *) shift;; esac',
      'done',
      'if [ "$extract" = 1 ]; then mkdir -p "$target"; printf "%s\\n" partial > "$target/partial"; exit 28; fi',
      'printf "%s\\n" archive',
      '',
    ].join('\n'));
    chmodSync(join(fixture.bin, 'cp'), 0o755);
    chmodSync(join(fixture.bin, 'tar'), 0o755);

    runDeployServiceFixture(fixture, [
      `STATE_DIR=${JSON.stringify(state)}`,
      'mkdir -p "$SNAPSHOT_DIR/files"',
      `if snapshot_path ${JSON.stringify(runtimeFile)} 7; then exit 91; fi`,
      'systemctl stop ran-agent-node.service',
      'if snapshot_node_durable_state; then exit 92; fi',
      'restore_runtime_files',
      'restore_service_state',
    ].join('\n'));

    const manifest = readFileSync(join(fixture.snapshot, 'manifest'), 'utf8');
    assert.doesNotMatch(manifest, /\t(?:7|900)\t/);
    for (const path of ['7', '.7.incomplete', '900', '.900.incomplete']) {
      assert.equal(existsSync(join(fixture.snapshot, 'files', path)), false);
    }
    assert.equal(readFileSync(runtimeFile, 'utf8'), 'complete-runtime-config\n');
    assert.equal(readFileSync(join(state, 'sentinel'), 'utf8'), 'complete-live-state\n');
    assert.equal(readFileSync(join(fixture.state, 'ran-agent-node.service.active'), 'utf8'), 'active\n');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('explicit rollback refuses consumed or compacted transaction snapshots before mutation', () => {
  const fixture = makeDeployServiceFixture();
  const snapshot = join(fixture.dir, 'artifacts', 'snapshots', 'release-transaction.consumed.fixture');
  const consumedFixture = makeDeployServiceFixture();
  const consumed = join(consumedFixture.dir, 'artifacts', 'snapshots', 'release-transaction.consumed.fixture');
  const historicalFixture = makeDeployServiceFixture();
  const historical = join(historicalFixture.dir, 'artifacts', 'snapshots', 'release-transaction.historical.fixture');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '0'), 'payload\n');
    writeFileSync(join(snapshot, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(snapshot);
    writeFileSync(join(snapshot, '..', 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    assert.doesNotThrow(
      () => runDeployServiceFixture(fixture, `load_rollback_snapshot ${JSON.stringify(snapshot)}`),
    );
    mkdirSync(join(consumed, 'files'), { recursive: true });
    writeFileSync(join(consumed, 'files', '0'), 'payload\n');
    writeFileSync(join(consumed, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(consumed, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: 'transaction:prior-production',
    });
    writeFileSync(join(consumed, '..', 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: consumed.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    rmSync(join(consumed, 'files'), { recursive: true });
    assert.throws(
      () => runDeployServiceFixture(consumedFixture, `load_rollback_snapshot ${JSON.stringify(consumed)}`),
      /rollback_snapshot_not_eligible/,
    );
    mkdirSync(join(historical, 'files'), { recursive: true });
    writeFileSync(join(historical, 'files', '0'), 'payload\n');
    writeFileSync(join(historical, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(historical);
    writeFileSync(join(historical, '..', 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: 'release-transaction.other.fixture',
      candidate_sha: 'c'.repeat(40),
    }));
    assert.throws(
      () => runDeployServiceFixture(historicalFixture, `load_rollback_snapshot ${JSON.stringify(historical)}`),
      /rollback_snapshot_not_current_production/,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(consumedFixture.dir, { recursive: true, force: true });
    rmSync(historicalFixture.dir, { recursive: true, force: true });
  }
});

test('successful explicit rollback consumes its current-production pointer and payload', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.explicit.fixture');
  const pointer = join(snapshotRoot, 'current-production.json');
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '900'), 'payload\n');
    writeFileSync(join(snapshot, 'candidate'), `${'b'.repeat(40)}\n`);
    writeRetentionState(snapshot);
    writeFileSync(pointer, JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: 'b'.repeat(40),
    }));
    secureArtifactLayout(join(fixture.dir, 'artifacts'));
    runDeployServiceFixture(fixture, [
      `SNAPSHOT_DIR=${JSON.stringify(snapshot)}`,
      `CURRENT_PRODUCTION_POINTER=${JSON.stringify(pointer)}`,
      `CANDIDATE=${JSON.stringify('b'.repeat(40))}`,
      'STAGE_DIR="$SCRIPT_ROOT"',
      'EXPLICIT_ROLLBACK=1',
      'TRANSACTION_STARTED=1',
      'quiesce_runtime_services() { return 0; }',
      'restore_code_revision() { return 0; }',
      'restore_runtime_files() { return 0; }',
      'restore_state_migrations() { return 0; }',
      'restore_service_state() { return 0; }',
      'record_protected_capability_evidence() { return 0; }',
      'rollback_transaction 0',
    ].join('\n'));
    assert.equal(existsSync(pointer), false);
    assert.equal(existsSync(join(snapshot, 'files')), false);
    assert.equal(JSON.parse(readFileSync(join(snapshot, 'transaction-state.json'), 'utf8')).status, 'rollback_used');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('explicit rollback keeps immutable candidate helpers after checking out a prior commit without the pruner', () => {
  const dir = realpathSync(mkdtempSync(identityFixturePrefix('ran-agent-explicit-rollback-stage-')));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.explicit-stage.fixture');
  const pointer = join(snapshotRoot, 'current-production.json');
  const state = join(dir, 'state');
  const secretRoot = join(dir, 'secrets');
  const bin = join(dir, 'bin');
  const authorityMarker = join(dir, 'rollback-authority');
  try {
    mkdirSync(repo);
    mkdirSync(bin);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'rollback-stage@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'rollback stage'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'prior without release helpers\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'prior'], { cwd: repo, stdio: 'pipe' });
    const prior = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    mkdirSync(scripts);
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    const footer = deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, footer));
    for (const name of [
      'resolve-hermes-service-node.sh', 'prune-hermes-release-artifacts.sh',
      'ombre_o1_contract.py', 'install-ombre-steward-token.py', 'apply_ombre_steward_patch.py',
    ]) copyFileSync(join(root, 'scripts', name), join(scripts, name));
    for (const name of [
      'apply-hermes-runtime-split.sh', 'verify-hermes-release.sh',
      'hermes-release-candidate-preflight.mjs', 'verify-ran-agent-runtime-identity.sh',
      'verify-ombre-steward-real-process.sh',
    ]) writeFileSync(join(scripts, name), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(repo, 'node_bridge', 'tests'), { recursive: true });
    writeFileSync(join(repo, 'node_bridge', 'tests', 'ombreCompatPatchedProcess.test.mjs'), '// fixture\n');
    for (const name of readdirSync(scripts)) chmodSync(join(scripts, name), 0o755);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'candidate with immutable rollback helpers'], { cwd: repo, stdio: 'pipe' });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    mkdirSync(join(snapshot, 'files'), { recursive: true });
    mkdirSync(join(artifactRoot, 'stages'), { recursive: true });
    mkdirSync(join(artifactRoot, 'archives'), { recursive: true });
    mkdirSync(state);
    mkdirSync(secretRoot);
    secureArtifactLayout(artifactRoot);
    chmodSync(secretRoot, 0o700);
    writeFileSync(join(snapshot, 'files', '900'), 'payload\n');
    writeRetentionState(snapshot, {
      candidate_sha: candidateSha,
      base_sha: prior,
      current_production_identity: `transaction:${snapshot.split('/').at(-1)}`,
    });
    writeFileSync(join(snapshot, 'prior-head'), `${prior}\n`);
    writeFileSync(join(snapshot, 'candidate'), `${candidateSha}\n`);
    writeFileSync(pointer, JSON.stringify({
      schema_version: 1,
      transaction_id: snapshot.split('/').at(-1),
      candidate_sha: candidateSha,
    }));
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n');
    chmodSync(join(bin, 'sudo'), 0o755);
    chmodSync(join(bin, 'sha256sum'), 0o755);

    assert.throws(() => runAsCheckoutOperator('bash', ['-c', [
      'set -euo pipefail',
      `set -- --rollback ${JSON.stringify(snapshot)}`,
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SERVER_ROOT="$REPO_ROOT"',
      `CANONICAL_LIVE_STATE_DIR=${JSON.stringify(state)}`,
      'STATE_DIR="$CANONICAL_LIVE_STATE_DIR"',
      'SUDO=(sudo)',
      'require_artifact_layout() { return 0; }',
      `explicit_rollback --rollback ${JSON.stringify(snapshot)}`,
    ].join('\n')], {
      cwd: repo,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_CANDIDATE: prior,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
        RAN_AGENT_RELEASE_STATE_DIR: state,
        RAN_AGENT_NO_SUDO: '1',
      },
      stdio: 'pipe',
    }, dir), /rollback_controller_candidate_mismatch/);

    runAsCheckoutOperator('bash', ['-c', [
      'set -euo pipefail',
      `set -- --rollback ${JSON.stringify(snapshot)}`,
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SERVER_ROOT="$REPO_ROOT"',
      `CANONICAL_LIVE_STATE_DIR=${JSON.stringify(state)}`,
      'STATE_DIR="$CANONICAL_LIVE_STATE_DIR"',
      `SECRET_ROLLBACK_ROOT=${JSON.stringify(secretRoot)}`,
      'SUDO=(sudo)',
      'require_artifact_layout() { return 0; }',
      `require_candidate_bootstrap_authority() { printf verified > ${JSON.stringify(authorityMarker)}; }`,
      'backup_steward_token() { SECRET_ROLLBACK_DIR=""; STEWARD_TOKEN_HAD_PRIOR=0; STEWARD_TOKEN_RESTORED=1; }',
      'restore_steward_token() { STEWARD_TOKEN_RESTORED=1; return 0; }',
      'destroy_secret_rollback() { return 0; }',
      'quiesce_runtime_services() { return 0; }',
      'restore_runtime_files() { return 0; }',
      'restore_state_migrations() { return 0; }',
      'restore_service_state() { return 0; }',
      'record_protected_capability_evidence() { return 0; }',
      'block_ombre_ingress() { return 0; }',
      'clear_ombre_ingress_block() { return 0; }',
      `explicit_rollback --rollback ${JSON.stringify(snapshot)}`,
    ].join('\n')], {
      cwd: repo,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_CANDIDATE: candidateSha,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
        RAN_AGENT_RELEASE_STATE_DIR: state,
        RAN_AGENT_RELEASE_SECRET_ROLLBACK_ROOT: secretRoot,
        RAN_AGENT_NO_SUDO: '1',
      },
      stdio: 'pipe',
    }, dir);
    assert.equal(runAsCheckoutOperator('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }, dir).trim(), prior);
    assert.equal(readFileSync(authorityMarker, 'utf8'), 'verified');
    assert.equal(existsSync(join(repo, 'scripts', 'prune-hermes-release-artifacts.sh')), false);
    assert.equal(existsSync(join(snapshot, 'files')), false);
    assert.equal(existsSync(pointer), false);
  } finally {
    if (existsSync(dir)) execFileSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cleanup serializes destructive cleanup processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-release-prune-lock-'));
  const artifactRoot = join(dir, 'artifacts');
  const snapshotRoot = join(artifactRoot, 'snapshots');
  const snapshot = join(snapshotRoot, 'release-transaction.lock.fixture');
  let holder;
  try {
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    writeFileSync(join(snapshot, 'files', '900'), 'payload\n');
    writeRetentionState(snapshot, {
      status: 'rollback_used', acceptance_state: 'not_accepted', rollback_state: 'rollback_used',
      rollbackable: false, current_production_identity: 'transaction:prior-production',
    });
    secureArtifactLayout(artifactRoot);
    holder = spawn(pythonBin, ['-c', [
      'import fcntl,sys,time',
      'handle=open(sys.argv[1], "w")',
      'fcntl.flock(handle, fcntl.LOCK_EX)',
      'print("locked", flush=True)',
      'time.sleep(30)',
    ].join(';'), join(artifactRoot, '.payload-cleanup.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.race([
      once(holder.stdout, 'data'),
      once(holder, 'exit').then(([code]) => { throw new Error(`lock holder exited early: ${code}`); }),
    ]);
    assert.throws(
      () => run('prune-hermes-release-artifacts.sh', ['--apply'], {
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
        RAN_AGENT_NO_SUDO: '1',
      }),
      /cleanup_locked/,
    );
    assert.equal(existsSync(join(snapshot, 'files', '900')), true);
  } finally {
    if (holder && holder.exitCode === null) {
      const exited = once(holder, 'exit');
      holder.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release apply and rollback share one non-blocking transaction lock', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ran-agent-release-transaction-lock-')));
  const repo = join(dir, 'repo');
  const artifactRoot = join(dir, 'artifacts');
  let holder;
  try {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(artifactRoot);
    for (const name of ['deploy-hermes-release.sh', 'resolve-hermes-service-node.sh']) {
      copyFileSync(join(root, 'scripts', name), join(repo, 'scripts', name));
      chmodSync(join(repo, 'scripts', name), 0o755);
    }
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'release-lock@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'release lock'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const env = {
      ...process.env,
      PATH: '/usr/bin:/bin',
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
      RAN_AGENT_RELEASE_CANDIDATE: sha,
      RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_RELEASE_LOCK: '1',
      RAN_AGENT_TEST_RELEASE_LOCK_HOLD_SECONDS: '5',
    };
    holder = spawn('bash', [join(repo, 'scripts', 'deploy-hermes-release.sh'), '--apply'], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.throws(() => execFileSync('bash', [join(repo, 'scripts', 'deploy-hermes-release.sh'), '--rollback', join(dir, 'not-read-before-lock')], {
      cwd: repo,
      env: { ...env, RAN_AGENT_TEST_RELEASE_LOCK_HOLD_SECONDS: '0' },
      stdio: 'pipe',
    }), /release_transaction_locked/);
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'prune-hermes-release-artifacts.sh'), '--apply'], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
        RAN_AGENT_NO_SUDO: '1',
      },
      stdio: 'pipe',
    }), /release_transaction_locked/);
  } finally {
    if (holder?.exitCode === null) {
      holder.kill('SIGTERM');
      await once(holder, 'exit').catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback control path does not resolve Node before loading its snapshot', () => {
  const fixture = makeDeployServiceFixture();
  try {
    const output = runDeployServiceFixture(fixture, 'printf "rollback-node-independent\\n"', {
      RAN_AGENT_NODE_BIN: '',
      RAN_AGENT_SYSTEMCTL_BIN: '/definitely/missing/systemctl',
    });
    assert.match(output, /rollback-node-independent/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('release lock reports identity corruption separately from contention', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ran-agent-release-lock-identity-')));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const artifactRoot = join(dir, 'artifacts');
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(artifactRoot);
    mkdirSync(join(artifactRoot, '.release-transaction.lock'));
    for (const name of ['deploy-hermes-release.sh', 'resolve-hermes-service-node.sh']) {
      copyFileSync(join(root, 'scripts', name), join(scripts, name));
      chmodSync(join(scripts, name), 0o755);
    }
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'release-lock@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'release lock'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.throws(() => execFileSync('bash', [join(scripts, 'deploy-hermes-release.sh'), '--apply'], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CANDIDATE: sha,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifactRoot,
        RAN_AGENT_TEST_MODE: '1',
        RAN_AGENT_TEST_RELEASE_LOCK: '1',
      },
      stdio: 'pipe',
    }), /release_lock_identity_invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux root release gate proves cross-UID regular-file denial and FIFO readiness', {
  skip: process.platform !== 'linux' || process.geteuid?.() !== 0,
}, () => {
  const runuser = '/usr/sbin/runuser';
  assert.equal(existsSync(runuser), true, 'release host requires runuser');
  const uid = Number(execFileSync('id', ['-u', 'ran-agent'], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', 'ran-agent'], { encoding: 'utf8' }).trim());
  const protectedRegular = Number(readFileSync('/proc/sys/fs/protected_regular', 'utf8').trim());
  const regular = execFileSync(runuser, ['-u', 'ran-agent', '--', 'mktemp', '/tmp/ran-agent-release-lock-test.XXXXXX'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync('/tmp/ran-agent-release-fifo-test.');
  const fifo = join(dir, 'ready');
  try {
    if (protectedRegular > 0) {
      assert.throws(() => execFileSync('/usr/bin/python3', ['-I', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("locked\\n")', regular], { stdio: 'pipe' }));
    }
    chownSync(dir, uid, gid);
    chmodSync(dir, 0o700);
    execFileSync(runuser, ['-u', 'ran-agent', '--', 'mkfifo', '-m', '600', fifo]);
    const descriptor = openSync(fifo, 'r+');
    try {
      execFileSync('/usr/bin/python3', ['-I', '-c', 'import os,sys; fd=os.open(sys.argv[1], os.O_WRONLY|os.O_NOFOLLOW); os.write(fd,b"locked\\n"); os.close(fd)', fifo]);
      const value = Buffer.alloc(7);
      assert.equal(readSync(descriptor, value, 0, value.length, null), 7);
      assert.equal(value.toString(), 'locked\n');
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(regular, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  const cross = mkdtempSync('/tmp/ran-agent-release-cross-uid.');
  const repo = join(cross, 'repo');
  const artifactRoot = join(cross, 'artifacts');
  try {
    const ubuntuUid = Number(execFileSync('id', ['-u', 'ubuntu'], { encoding: 'utf8' }).trim());
    const ubuntuGid = Number(execFileSync('id', ['-g', 'ubuntu'], { encoding: 'utf8' }).trim());
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(artifactRoot);
    chmodSync(artifactRoot, 0o700);
    for (const name of ['deploy-hermes-release.sh', 'resolve-hermes-service-node.sh']) {
      copyFileSync(join(root, 'scripts', name), join(repo, 'scripts', name));
      chmodSync(join(repo, 'scripts', name), 0o755);
    }
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'lock@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'lock'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('chown', ['-R', `${ubuntuUid}:${ubuntuGid}`, repo]);
    chmodSync(cross, 0o755);
    const result = spawnSync(runuser, ['--user', 'ubuntu', '--group', 'ubuntu', '--', '/usr/bin/env',
      'PATH=/usr/bin:/bin', `RAN_AGENT_NODE_BIN=${nodeBin}`, `RAN_AGENT_PYTHON_BIN=${pythonBin}`,
      `RAN_AGENT_RELEASE_CANDIDATE=${sha}`, `RAN_AGENT_RELEASE_CONTROL_ROOT=${repo}`,
      `RAN_AGENT_RELEASE_ARTIFACT_ROOT=${artifactRoot}`, 'RAN_AGENT_TEST_MODE=1',
      'RAN_AGENT_TEST_RELEASE_LOCK=1', 'TMPDIR=/tmp',
      'bash', join(repo, 'scripts', 'deploy-hermes-release.sh'), '--apply'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /server_root_required/);
    assert.doesNotMatch(result.stderr, /release_(?:transaction_locked|lock_protocol_failed|lock_timeout)/);
    const lock = statSync(join(artifactRoot, '.release-transaction.lock'));
    assert.equal(lock.uid, 0);
    assert.equal(lock.gid, 0);
    assert.equal(lock.mode & 0o777, 0o600);
    assert.doesNotThrow(() => execFileSync('/usr/bin/python3', ['-I', '-c',
      'import fcntl,sys; f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)',
      join(artifactRoot, '.release-transaction.lock')], { stdio: 'pipe' }));
  } finally {
    rmSync(cross, { recursive: true, force: true });
  }
});

test('retention deletion failure warns without reversing an accepted deployment', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const doomed = join(snapshotRoot, 'release-transaction.doomed.fixture');
  try {
    for (const [index, completed] of [1, 2, 3].map((value) => [value, value])) {
      const directory = index === 1 ? doomed : join(snapshotRoot, `release-transaction.keep-${index}.fixture`);
      mkdirSync(directory, { recursive: true });
      writeRetentionState(directory, {
        candidate_sha: String(index).repeat(40),
        completed_at: `2026-07-2${completed}T00:00:00Z`,
      });
    }
    writeFileSync(join(snapshotRoot, 'current-production.json'), JSON.stringify({
      schema_version: 1,
      transaction_id: 'release-transaction.keep-3.fixture',
      candidate_sha: '3'.repeat(40),
    }));
    const output = runDeployServiceFixture(fixture, [
      `SNAPSHOT_ROOT=${JSON.stringify(snapshotRoot)}`,
      'CURRENT_PRODUCTION_POINTER="$SNAPSHOT_ROOT/current-production.json"',
      `REPO_ROOT=${JSON.stringify(root)}`,
      'TRANSACTION_STARTED=0',
      'sudo() { if [[ "$1" == rm ]]; then return 1; fi; command sudo "$@"; }',
      'prune_accepted_snapshots 2>&1',
    ].join('\n'));
    assert.match(output, /retention-warning.*delete-failed/);
    assert.equal(existsSync(doomed), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
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
  assert.match(accept, /release_ombre_recall_acceptance/);
  assert.match(accept, /ombre_recall_search/);
  assert.match(accept, /ombre_runtime_semantic_contract/);
  assert.match(accept, /ombre_o1_contract\.py/);
});

test('candidate staging fails closed on missing real-process assets and remains readable but immutable to ran-agent', () => {
  const dir = mkdtempSync(identityFixturePrefix('ran-agent-stage-completeness-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const bin = join(dir, 'bin');
  const artifacts = join(dir, 'artifacts');
  const runGit = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  let gateCopy = '';
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(repo, 'node_bridge', 'tests'), { recursive: true });
    mkdirSync(bin);
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    const footer = deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, footer));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    for (const name of [
      'apply-hermes-runtime-split.sh', 'verify-hermes-release.sh',
      'hermes-release-candidate-preflight.mjs', 'verify-ombre-steward-real-process.sh',
      'hermes-release-gate.sh',
    ]) writeFileSync(join(scripts, name), '#!/bin/sh\nexit 0\n');
    for (const name of [
      'check-hermes-snapshot-capacity.py', 'prune-hermes-release-artifacts.sh', 'ombre_o1_contract.py',
      'install-ombre-steward-token.py', 'verify-ran-agent-runtime-identity.sh',
      'apply_ombre_steward_patch.py',
    ]) writeFileSync(join(scripts, name), '# fixture\n');
    writeFileSync(join(repo, 'node_bridge', 'tests', 'ombreCompatPatchedProcess.test.mjs'), '// fixture\n');
    for (const name of [
      'deploy-hermes-release.sh', 'resolve-hermes-service-node.sh',
      'apply-hermes-runtime-split.sh', 'verify-hermes-release.sh',
      'hermes-release-candidate-preflight.mjs', 'verify-ombre-steward-real-process.sh',
      'hermes-release-gate.sh',
    ]) chmodSync(join(scripts, name), 0o755);
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n');
    chmodSync(join(bin, 'sha256sum'), 0o755);
    runGit(['init']);
    runGit(['config', 'user.email', 'stage-test@example.invalid']);
    runGit(['config', 'user.name', 'stage test']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'complete candidate']);
    const complete = runGit(['rev-parse', 'HEAD']).trim();
    const runStage = (sha) => execFileSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'MODE=--apply',
      'SUDO=(/usr/bin/env)',
      'STAGE_USE_SUDO=0',
      `CANDIDATE=${JSON.stringify(sha)}`,
      `STAGE_ROOT=${JSON.stringify(join(artifacts, 'stages'))}`,
      `ARCHIVE_ROOT=${JSON.stringify(join(artifacts, 'archives'))}`,
      'mkdir -p "$STAGE_ROOT" "$ARCHIVE_ROOT"',
      'stage_candidate',
      'verify_stage_candidate',
      'stage_gate_copy',
      'printf "%s\\n%s\\n" "$STAGE_DIR" "$GATE_DIR"',
    ].join('\n')], {
      cwd: repo,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifacts,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim().split('\n');
    const [completeStage, completeGateCopy] = runStage(complete);
    gateCopy = completeGateCopy;
    assert.equal(statSync(completeStage).mode & 0o777, 0o755);
    assert.equal(statSync(join(completeStage, 'scripts', 'verify-ombre-steward-real-process.sh')).mode & 0o222, 0);
    assert.equal(statSync(completeGateCopy).mode & 0o777, 0o555);
    assert.equal(statSync(join(completeGateCopy, 'scripts', 'hermes-release-gate.sh')).mode & 0o222, 0);
    assert.equal(
      readFileSync(join(completeGateCopy, 'candidate'), 'utf8'),
      readFileSync(join(completeStage, 'candidate'), 'utf8'),
      'gate copy must carry the verified candidate manifest byte-identically',
    );
    if (process.getuid?.() === 0 && existsSync('/usr/sbin/runuser')) {
      // Production topology: the artifact store stays root-private (0700), so
      // the ran-agent identity can never read the stage directly and must use
      // the traversable read-only gate copy instead.
      for (const path of [dir, artifacts, join(artifacts, 'stages')]) {
        chmodSync(path, 0o700);
        assert.equal(statSync(path).mode & 0o777, 0o700);
      }
      assert.throws(() => execFileSync('/usr/sbin/runuser', [
        '--user', 'ran-agent', '--group', 'ran-agent', '--',
        '/usr/bin/test', '-r', join(completeStage, 'node_bridge', 'tests', 'ombreCompatPatchedProcess.test.mjs'),
      ], { stdio: 'pipe' }), /Command failed/, 'private stage must stay unreadable to the ran-agent identity');
      assert.doesNotThrow(() => execFileSync('/usr/sbin/runuser', [
        '--user', 'ran-agent', '--group', 'ran-agent', '--',
        '/usr/bin/test', '-r', join(completeGateCopy, 'node_bridge', 'tests', 'ombreCompatPatchedProcess.test.mjs'),
      ], { stdio: 'pipe' }));
      assert.throws(() => execFileSync('/usr/sbin/runuser', [
        '--user', 'ran-agent', '--group', 'ran-agent', '--',
        '/usr/bin/test', '-w', join(completeGateCopy, 'scripts', 'hermes-release-gate.sh'),
      ], { stdio: 'pipe' }), /Command failed/, 'gate copy must stay read-only to the ran-agent identity');
    }

    runGit(['rm', 'scripts/verify-ombre-steward-real-process.sh']);
    runGit(['commit', '-m', 'incomplete candidate']);
    const incomplete = runGit(['rev-parse', 'HEAD']).trim();
    assert.throws(() => runStage(incomplete), /Command failed/);

    execFileSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SUDO=(/usr/bin/env)',
      `STAGE_DIR=${JSON.stringify(completeStage)}`,
      `GATE_DIR=${JSON.stringify(completeGateCopy)}`,
      `CANDIDATE_ARCHIVE=${JSON.stringify(join(artifacts, 'archives', `release-candidate.${complete}.tar`))}`,
      'cleanup_pretransaction_artifacts',
      'test ! -e "$GATE_DIR"',
      'test ! -e "$CANDIDATE_ARCHIVE"',
    ].join('\n')], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifacts,
      },
      stdio: 'pipe',
    });
  } finally {
    execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
    if (gateCopy && existsSync(gateCopy)) {
      execFileSync('chmod', ['-R', 'u+w', gateCopy], { stdio: 'ignore' });
      rmSync(gateCopy, { recursive: true, force: true });
    }
  }
});

test('Linux root gates execute the same read-only copy as root and ran-agent under the production 0700 artifact topology', {
  skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || !existsSync('/usr/sbin/runuser'),
}, () => {
  const dir = mkdtempSync(identityFixturePrefix('ran-agent-gate-copy-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const artifacts = join(dir, 'artifacts');
  const trace = join(dir, 'gate-trace');
  const runGit = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  let gateCopy = '';
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(repo, 'node_bridge', 'tests'), { recursive: true });
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]')));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    writeFileSync(join(scripts, 'hermes-release-gate.sh'), [
      '#!/bin/sh',
      'digest=$(/usr/bin/sha256sum "$RAN_AGENT_RELEASE_SOURCE_ROOT/candidate")',
      'printf \'%s %s\\n\' "$(/usr/bin/id -un)" "${digest%% *}" >> ' + JSON.stringify(trace),
      'exit 0',
    ].join('\n') + '\n');
    for (const name of [
      'apply-hermes-runtime-split.sh', 'verify-hermes-release.sh',
      'hermes-release-candidate-preflight.mjs', 'verify-ombre-steward-real-process.sh',
    ]) writeFileSync(join(scripts, name), '#!/bin/sh\nexit 0\n');
    for (const name of [
      'check-hermes-snapshot-capacity.py', 'prune-hermes-release-artifacts.sh', 'ombre_o1_contract.py',
      'install-ombre-steward-token.py', 'verify-ran-agent-runtime-identity.sh',
      'apply_ombre_steward_patch.py',
    ]) writeFileSync(join(scripts, name), '# fixture\n');
    writeFileSync(join(repo, 'node_bridge', 'tests', 'ombreCompatPatchedProcess.test.mjs'), '// fixture\n');
    for (const name of [
      'deploy-hermes-release.sh', 'resolve-hermes-service-node.sh', 'hermes-release-gate.sh',
      'apply-hermes-runtime-split.sh', 'verify-hermes-release.sh',
      'hermes-release-candidate-preflight.mjs', 'verify-ombre-steward-real-process.sh',
    ]) chmodSync(join(scripts, name), 0o755);
    runGit(['init']);
    runGit(['config', 'user.email', 'gate-copy@example.invalid']);
    runGit(['config', 'user.name', 'gate copy']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'gate copy candidate']);
    const complete = runGit(['rev-parse', 'HEAD']).trim();
    writeFileSync(trace, '');
    chmodSync(trace, 0o666);
    chmodSync(dir, 0o755);
    mkdirSync(artifacts);
    chmodSync(artifacts, 0o700);
    const fixtureEnv = {
      PATH: '/usr/bin:/bin',
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifacts,
    };
    const [completeStage, completeGateCopy] = execFileSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'MODE=--apply',
      'SUDO=()',
      'STAGE_USE_SUDO=1',
      `CANDIDATE=${JSON.stringify(complete)}`,
      `STAGE_ROOT=${JSON.stringify(join(artifacts, 'stages'))}`,
      `ARCHIVE_ROOT=${JSON.stringify(join(artifacts, 'archives'))}`,
      'mkdir -p "$STAGE_ROOT" "$ARCHIVE_ROOT"',
      'chmod 700 "$STAGE_ROOT" "$ARCHIVE_ROOT"',
      'stage_candidate',
      'verify_stage_candidate',
      'stage_gate_copy',
      'printf "%s\\n%s\\n" "$STAGE_DIR" "$GATE_DIR"',
    ].join('\n')], { cwd: repo, env: fixtureEnv, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
    gateCopy = completeGateCopy;
    assert.equal(statSync(completeStage).mode & 0o777, 0o755);
    assert.equal(statSync(completeGateCopy).mode & 0o777, 0o555);
    assert.equal(statSync(completeGateCopy).uid, 0);
    assert.equal(statSync(completeGateCopy).gid, 0);
    // The ran-agent identity can never traverse the root-private store into
    // the stage; it reads the traversable read-only gate copy instead.
    assert.throws(() => execFileSync('/usr/sbin/runuser', [
      '--user', 'ran-agent', '--group', 'ran-agent', '--',
      '/usr/bin/test', '-r', join(completeStage, 'scripts', 'hermes-release-gate.sh'),
    ], { stdio: 'pipe' }), /Command failed/, 'private stage must stay unreadable to the ran-agent identity');
    assert.doesNotThrow(() => execFileSync('/usr/sbin/runuser', [
      '--user', 'ran-agent', '--group', 'ran-agent', '--',
      '/usr/bin/test', '-r', join(completeGateCopy, 'scripts', 'hermes-release-gate.sh'),
    ], { stdio: 'pipe' }));
    assert.throws(() => execFileSync('/usr/sbin/runuser', [
      '--user', 'ran-agent', '--group', 'ran-agent', '--',
      '/usr/bin/test', '-w', join(completeGateCopy, 'scripts', 'hermes-release-gate.sh'),
    ], { stdio: 'pipe' }), /Command failed/, 'gate copy must stay read-only to the ran-agent identity');
    // Both gates succeed against the same read-only copy before any snapshot,
    // checkout, service stop, or runtime write.
    execFileSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'MODE=--apply',
      'SUDO=()',
      'STAGE_USE_SUDO=1',
      `CANDIDATE=${JSON.stringify(complete)}`,
      `STAGE_DIR=${JSON.stringify(completeStage)}`,
      `GATE_DIR=${JSON.stringify(completeGateCopy)}`,
      `NODE_BIN=${JSON.stringify(nodeBin)}`,
      'run_candidate_gates',
    ].join('\n')], { cwd: repo, env: fixtureEnv, stdio: 'pipe' });
    const gateRuns = readFileSync(trace, 'utf8').trim().split('\n').map((line) => line.split(' '));
    assert.equal(gateRuns.length, 2, 'root gate and ran-agent gate must both execute');
    assert.equal(gateRuns[0][0], 'root');
    assert.equal(gateRuns[1][0], 'ran-agent');
    assert.match(gateRuns[0][1], /^[a-f0-9]{64}$/);
    assert.equal(gateRuns[0][1], gateRuns[1][1], 'both gates must read the identical verified copy');
    // The copy is removed by the transaction cleanup on every outcome.
    execFileSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SUDO=()',
      `STAGE_ROOT=${JSON.stringify(join(artifacts, 'stages'))}`,
      `ARCHIVE_ROOT=${JSON.stringify(join(artifacts, 'archives'))}`,
      `STAGE_DIR=${JSON.stringify(completeStage)}`,
      `GATE_DIR=${JSON.stringify(completeGateCopy)}`,
      `CANDIDATE_ARCHIVE=${JSON.stringify(join(artifacts, 'archives', `release-candidate.${complete}.tar`))}`,
      'cleanup_pretransaction_artifacts',
      'test ! -e "$GATE_DIR"',
      'test ! -e "$STAGE_DIR"',
      'test ! -e "$CANDIDATE_ARCHIVE"',
    ].join('\n')], { cwd: repo, env: fixtureEnv, stdio: 'pipe' });
  } finally {
    execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
    if (gateCopy && existsSync(gateCopy)) {
      execFileSync('chmod', ['-R', 'u+w', gateCopy], { stdio: 'ignore' });
      rmSync(gateCopy, { recursive: true, force: true });
    }
  }
});

test('gate copy capacity gate budgets the gate filesystem before large copies and fails closed when full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ran-agent-gate-capacity-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const stage = join(dir, 'stage');
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(stage, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(stage, 'node_modules', 'pkg', 'index.mjs'), `export {};\n${'// payload\n'.repeat(512)}`);
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]')));
    copyFileSync(join(root, 'scripts', 'check-hermes-snapshot-capacity.py'), join(scripts, 'check-hermes-snapshot-capacity.py'));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    const runCapacity = (extraEnv, mode = 'measured') => spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SUDO=(/usr/bin/env)',
      `STAGE_DIR=${JSON.stringify(stage)}`,
      `require_gate_copy_capacity ${mode} "$SCRIPT_ROOT" 4096 16`,
    ].join('\n')], {
      env: {
        PATH: '/usr/bin:/bin',
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_TEST_MODE: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    const fullMeasured = runCapacity({ RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: '0' });
    assert.notEqual(fullMeasured.status, 0);
    assert.match(fullMeasured.stderr, /free_bytes=0 required_bytes=[1-9][0-9]*/);
    assert.match(fullMeasured.stderr, /gate_copy_capacity_insufficient/);
    const roomyMeasured = runCapacity({ RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(10 * 1024 ** 4) });
    assert.equal(roomyMeasured.status, 0, roomyMeasured.stderr);
    assert.match(roomyMeasured.stdout, /gate-copy-capacity free_bytes=/);
    const fullEstimate = runCapacity({ RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: '0' }, 'estimate');
    assert.notEqual(fullEstimate.status, 0);
    assert.match(fullEstimate.stderr, /gate_copy_capacity_insufficient/);
    const roomyEstimate = runCapacity({ RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: String(10 * 1024 ** 4) }, 'estimate');
    assert.equal(roomyEstimate.status, 0, roomyEstimate.stderr);
    const probeFailure = runCapacity({ RAN_AGENT_TEST_SNAPSHOT_CAPACITY_FREE_BYTES: 'not-a-number' });
    assert.notEqual(probeFailure.status, 0);
    assert.match(probeFailure.stderr, /gate_copy_capacity_probe_failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply rejects a missing Python 3.12 before snapshot or checkout side effects', () => {
  const dir = mkdtempSync(identityFixturePrefix('ran-agent-ombre-python-preflight-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const marker = join(dir, 'mutation-marker');
  try {
    mkdirSync(scripts, { recursive: true });
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    const footer = deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, footer));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    chmodSync(join(scripts, 'resolve-hermes-service-node.sh'), 0o755);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'preflight@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'preflight'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    let failure;
    try {
      runAsCheckoutOperator('/bin/bash', ['-c', [
        'set -euo pipefail',
        'set -- --rollback fixture',
        `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
        'SERVER_ROOT="$REPO_ROOT"',
        'require_ombre_ingress_dropin_absent() { :; }',
        'require_node_sqlite() { :; }',
        'require_python_runtime() { :; }',
        'project_checkout_permissions() { :; }',
        'require_candidate_bootstrap_authority() { :; }',
        'require_artifact_layout() { :; }',
        'require_service_environment() { :; }',
        'require_atomic_state() { :; }',
        `RAN_AGENT_OMBRE_PATCH_PYTHON_BIN=${JSON.stringify(join(dir, 'missing-python3.12'))}`,
        `snapshot_node_durable_state() { printf snapshot > ${JSON.stringify(marker)}; }`,
        `activate_candidate_checkout() { printf checkout > ${JSON.stringify(marker)}; }`,
        'require_apply_prerequisites',
        'snapshot_node_durable_state',
        'activate_candidate_checkout',
      ].join('\n')], {
        cwd: repo,
        env: {
          PATH: '/usr/bin:/bin',
          RAN_AGENT_NODE_BIN: nodeBin,
          RAN_AGENT_PYTHON_BIN: pythonBin,
          RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
          RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(dir, 'artifacts'),
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }, dir);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(String(failure.stderr), /ombre_python_3_12_required/);
    assert.equal(existsSync(marker), false);
    const applyFlow = deploy.slice(deploy.lastIndexOf('require_apply_prerequisites'));
    assert.ok(applyFlow.indexOf('require_apply_prerequisites') < applyFlow.indexOf('snapshot_node_durable_state'));
    assert.ok(applyFlow.indexOf('require_apply_prerequisites') < applyFlow.indexOf('activate_candidate_checkout'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkout permission projection reverses restrictive release umask without changing ownership', {
  skip: process.geteuid?.() === 0,
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'ran-agent-checkout-permissions-'));
  const scripts = join(repo, 'scripts');
  const nested = join(repo, 'node_bridge', 'src');
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(nested, { recursive: true });
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]')));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    for (const name of ['deploy-hermes-release.sh', 'resolve-hermes-service-node.sh']) chmodSync(join(scripts, name), 0o755);
    writeFileSync(join(nested, 'index.mjs'), 'export {};\n');
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'permissions@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'permissions'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    const owner = statSync(repo);
    assert.match(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }), /node_bridge\/src\/index\.mjs/);
    for (const path of [repo, join(repo, 'node_bridge'), nested]) chmodSync(path, 0o700);
    for (const path of [join(nested, 'index.mjs'), join(repo, 'run.sh')]) chmodSync(path, 0o600);
    execFileSync('bash', ['-c', [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'SUDO=()',
      'project_checkout_permissions repair',
      'project_checkout_permissions verify',
    ].join('\n')], {
      cwd: repo,
      env: {
        PATH: '/usr/bin:/bin',
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CONTROL_ROOT: repo,
        RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(repo, '..', 'permission-artifacts'),
      },
      stdio: 'pipe',
    });
    assert.equal(statSync(join(nested, 'index.mjs')).mode & 0o777, 0o644);
    assert.equal(statSync(join(repo, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(statSync(nested).mode & 0o777, 0o755);
    assert.equal(statSync(join(nested, 'index.mjs')).uid, owner.uid);
    assert.equal(statSync(join(nested, 'index.mjs')).gid, owner.gid);
    assert.match(readFileSync(join(root, 'node_bridge', 'start_node.sh'), 'utf8'), /\[ -r "\.env\.local" \]/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Linux root gate repairs only root-owned tracked paths back to the ubuntu checkout owner', {
  skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || !existsSync('/usr/sbin/runuser'),
}, () => {
  const dir = mkdtempSync(identityFixturePrefix('ran-agent-root-owned-checkout-'));
  const repo = join(dir, 'repo');
  const scripts = join(repo, 'scripts');
  const nested = join(repo, 'node_bridge', 'src');
  try {
    const uid = Number(execFileSync('id', ['-u', 'ubuntu'], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('id', ['-g', 'ubuntu'], { encoding: 'utf8' }).trim());
    assert.notEqual(gid, 0, 'ubuntu checkout group must be non-root');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(nested, { recursive: true });
    const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
    writeFileSync(join(scripts, 'deploy-hermes-release.sh'), deploy.slice(0, deploy.lastIndexOf('if [[ "$MODE" == --rollback ]]')));
    copyFileSync(join(root, 'scripts', 'resolve-hermes-service-node.sh'), join(scripts, 'resolve-hermes-service-node.sh'));
    writeFileSync(join(nested, 'index.mjs'), 'export {};\n');
    for (const file of [join(scripts, 'deploy-hermes-release.sh'), join(scripts, 'resolve-hermes-service-node.sh')]) chmodSync(file, 0o755);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'permissions@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'permissions'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
    execFileSync('chown', ['-R', `${uid}:${gid}`, dir]);
    chmodSync(dir, 0o755);
    chownSync(join(repo, 'node_bridge'), 0, gid);
    chmodSync(join(repo, 'node_bridge'), 0o700);
    chownSync(join(nested, 'index.mjs'), 0, 0);
    chmodSync(join(nested, 'index.mjs'), 0o600);
    const command = [
      'set -euo pipefail',
      'set -- --rollback fixture',
      `source ${JSON.stringify(join(scripts, 'deploy-hermes-release.sh'))}`,
      'project_checkout_permissions repair',
      'project_checkout_permissions verify',
    ].join('\n');
    const args = ['--user', 'ubuntu', '--group', 'ubuntu', '--', 'env',
      `RAN_AGENT_PYTHON_BIN=${pythonBin}`, `RAN_AGENT_RELEASE_CONTROL_ROOT=${repo}`,
      `RAN_AGENT_RELEASE_ARTIFACT_ROOT=${join(dir, 'artifacts')}`, 'PATH=/usr/bin:/bin',
      'bash', '-c', command];
    execFileSync('/usr/sbin/runuser', args, { stdio: 'pipe' });
    assert.equal(statSync(join(repo, 'node_bridge')).uid, uid);
    assert.equal(statSync(join(repo, 'node_bridge')).gid, gid);
    assert.equal(statSync(join(repo, 'node_bridge')).mode & 0o777, 0o755);
    assert.equal(statSync(join(nested, 'index.mjs')).uid, uid);
    assert.equal(statSync(join(nested, 'index.mjs')).gid, gid);
    assert.equal(statSync(join(nested, 'index.mjs')).mode & 0o777, 0o644);
    execFileSync('/usr/sbin/runuser', ['--user', 'ran-agent', '--group', 'ran-agent', '--',
      '/usr/bin/test', '-r', join(nested, 'index.mjs')], { stdio: 'pipe' });
    assert.throws(() => execFileSync('/usr/sbin/runuser', ['--user', 'ran-agent', '--group', 'ran-agent', '--',
      '/usr/bin/test', '-w', join(nested, 'index.mjs')], { stdio: 'pipe' }));
  } finally {
    execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserve mode changes only O1 identity and model policy without removing unrelated MCP units', () => {
  const apply = readFileSync(join(root, 'scripts', 'apply-hermes-runtime-split.sh'), 'utf8');
  const deploy = readFileSync(join(root, 'scripts', 'deploy-hermes-release.sh'), 'utf8');
  const preserveMain = apply.slice(apply.indexOf('main() {'));
  const preserveBlock = preserveMain.match(/if \[ "\$PRESERVE_RUNTIME_SHAPE" = "1" \]; then([\s\S]*?)\n  fi/);

  assert.ok(preserveBlock);
  assert.match(preserveBlock[1], /restart_services/);
  assert.match(preserveBlock[1], /install_deepseek_provider_plugin/);
  assert.match(preserveBlock[1], /select_installed_profile_models/);
  assert.match(preserveBlock[1], /write_model_policy_env/);
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
    {
      name: 'service-exit',
      env: 'HERMES_API_KEY=secret-exit',
      extra: {
        MOCK_EXPECTED_LITE_KEY: 'secret-exit',
        MOCK_EXPECTED_FULL_KEY: 'full-key',
        MOCK_DROP_LITE_AFTER_CURL: '1',
        MOCK_lite_SEQUENCE: 'refused',
        RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '12',
      },
      expected: 'lite_bridge_service_inactive',
      maxMs: 15_000,
    },
    { name: 'timeout', env: 'HERMES_API_KEY=secret-timeout', extra: { MOCK_EXPECTED_LITE_KEY: 'secret-timeout', MOCK_EXPECTED_FULL_KEY: 'full-key', MOCK_lite_SEQUENCE: '503', RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS: '1' }, expected: 'lite_bridge_ready_timeout' },
  ];
  for (const item of cases) {
    const fixture = makeAcceptanceReadinessFixture({ liteEnv: item.env, fullEnv: 'HERMES_API_KEY=full-key' });
    try {
      const started = Date.now();
      assert.throws(() => runAcceptanceReadiness(fixture, item.extra), new RegExp(item.expected));
      assert.ok(Date.now() - started < (item.maxMs || 5000), `${item.name} must be bounded`);
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

test('preserve runtime shape prepares Ombre and starts recall before lite and full without requiring Hermes CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-preserve-no-cli-'));
  chownSync(dir, process.getuid(), process.getgid());
  chmodSync(dir, 0o700);
  const bin = join(dir, 'bin');
  const trace = join(dir, 'systemctl.log');
  const state = join(dir, 'state');
  const debug = join(dir, 'debug');
  const config = join(dir, 'config.yaml');
  const fullHome = join(dir, 'hermes-home');
  const liteHome = join(fullHome, 'lite');
  const ombreHome = join(state, 'ombre-brain');
  const ombreSource = join(ombreHome, 'upstream');
  const ombreVenv = join(ombreHome, '.venv');
  mkdirSync(bin, { recursive: true });
  writeFileSync(config, 'operator-owned-config\n');
  const safeConfig = [
    'model:',
    '  provider: deepseek',
    '  default: deepseek-v4-flash',
    '  model: deepseek-v4-flash',
    'platform_toolsets:',
    '  cli: [mcp-ombre_memory]',
    '  gateway: [mcp-ombre_memory]',
    'mcp_servers:',
    '  ombre_memory:',
    '    url: "${OMBRE_RECALL_MCP_URL}"',
    '',
  ].join('\n');
  for (const target of [
    join(fullHome, 'config.yaml'),
    join(fullHome, 'profiles', 'ran-assistant', 'config.yaml'),
    join(liteHome, 'config.yaml'),
    join(liteHome, 'profiles', 'ran-assistant-lite', 'config.yaml'),
  ]) {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, safeConfig);
  }
  mkdirSync(join(ombreSource, 'src'), { recursive: true });
  mkdirSync(join(ombreVenv, 'bin'), { recursive: true });
  writeFileSync(join(ombreSource, 'src', 'server.py'), '# fixture\n');
  writeFileSync(join(ombreSource, 'requirements.lock.txt'), 'fixture==1 \\\n+    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  writeFileSync(join(ombreVenv, 'bin', 'python'), '#!/bin/sh\ncase "$*" in *"sys.version_info"*) printf "3.12\\n";; esac\nexit 0\n');
  chmodSync(join(ombreVenv, 'bin', 'python'), 0o755);
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse HEAD"*) printf "%s\\n" 0e83d4671ce1629e03ad36bb9160235bf60dbd34 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  mkdirSync(join(state, 'core'), { recursive: true });
  const proc = join(dir, 'proc');
  mkdirSync(join(proc, '123'), { recursive: true });
  writeFileSync(join(proc, '123', 'status'), 'Uid:\t999\t999\t999\t999\nGid:\t999\t999\t999\t999\n');
  const core = new DatabaseSync(join(state, 'core', 'core-state.sqlite3'));
  core.exec('CREATE TABLE activity (activity_id TEXT PRIMARY KEY, title TEXT NOT NULL, domain TEXT NOT NULL, state TEXT NOT NULL, contract_revision INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  core.close();
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_TRACE"',
    'case "$1" in',
    '  show) case "$*" in',
    '    *"--property=MainPID"*) printf "%s\\n" 123 ;;',
    '    *"--property=User"*) case "$2" in ran-agent-node.service|ran-agent-ombre-brain.service) printf "%s\\n" ran-agent ;; *) printf "%s\\n" "$MOCK_RUNTIME_USER" ;; esac ;;',
    '    *"--property=Group"*) case "$2" in ran-agent-node.service|ran-agent-ombre-brain.service) printf "%s\\n" ran-agent ;; *) printf "%s\\n" "$MOCK_RUNTIME_GROUP" ;; esac ;;',
    '    *) printf "%s\\n" loaded ;;',
    '  esac ;;',
    '  is-active) exit 0 ;;',
    '  is-enabled) printf "%s\\n" disabled ;;',
    '  is-failed) exit 1 ;;',
    '  restart) [ "${FAIL_RESTART_UNIT:-}" != "$2" ] ;;',
    'esac',
    '',
  ].join('\n'));
  for (const command of ['journalctl', 'pgrep', 'openssl', 'sleep', 'curl']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, command), 0o755);
  }
  writeFileSync(join(bin, 'chown'), '#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$SYSTEMCTL_TRACE"\nexit 0\n');
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nprintf "%s\\n" "LISTEN 0 128 127.0.0.1:18001 users:((x,pid=123,fd=3))" "LISTEN 0 128 127.0.0.1:18002 users:((x,pid=123,fd=3))" "LISTEN 0 128 127.0.0.1:8642 users:((x,pid=123,fd=3))" "LISTEN 0 128 127.0.0.1:8643 users:((x,pid=123,fd=3))"\n');
  writeFileSync(join(bin, 'provider-canary'), '#!/bin/sh\nprintf "canary %s\\n" "$1" >> "$SYSTEMCTL_TRACE"\n[ "${FAIL_CANARY_MODE:-}" != "$1" ]\n');
  writeFileSync(join(bin, 'ombre-patch-python'), '#!/bin/sh\ncase "$*" in *"sys.version_info"*) printf "3.12\\n";; esac\nexit 0\n');
  writeFileSync(join(bin, 'steward-verify'), '#!/bin/sh\nprintf "steward-verify\\n" >> "$SYSTEMCTL_TRACE"\nexit 0\n');
  writeFileSync(join(bin, 'id'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "ran-agent") exit 0 ;;',
    '  "-u ran-agent") printf "%s\\n" 999 ;;',
    '  "-g ran-agent") printf "%s\\n" 999 ;;',
    '  "-gn ran-agent") printf "%s\\n" ran-agent ;;',
    `  "-u ${runtimeUser}") printf "%s\\n" ${process.getuid()} ;;`,
    `  "-g ${runtimeUser}") printf "%s\\n" ${process.getgid()} ;;`,
    `  "-gn ${runtimeUser}") printf "%s\\n" ${JSON.stringify(runtimeGroup)} ;;`,
    `  "-u") printf "%s\\n" ${process.getuid()} ;;`,
    `  "-g") printf "%s\\n" ${process.getgid()} ;;`,
    '  *) exec /usr/bin/id "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'getent'), [
    '#!/bin/sh',
    'case "$1:$2" in',
    '  group:ran-agent) printf "%s\\n" "ran-agent:x:999:" ;;',
    '  passwd:ran-agent) printf "%s\\n" "ran-agent:x:999:999::/opt/ran_agent:/usr/sbin/nologin" ;;',
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'ss'), 0o755);
  chmodSync(join(bin, 'provider-canary'), 0o755);
  chmodSync(join(bin, 'ombre-patch-python'), 0o755);
  chmodSync(join(bin, 'steward-verify'), 0o755);
  chmodSync(join(bin, 'id'), 0o755);
  chmodSync(join(bin, 'getent'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(join(bin, 'chown'), 0o755);

  const baseEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    RAN_AGENT_NO_SUDO: '1',
    RAN_AGENT_HERMES_RUNTIME_USER: runtimeUser,
    RAN_AGENT_HERMES_RUNTIME_GROUP: runtimeGroup,
    RAN_AGENT_PYTHON_BIN: pythonBin,
    RAN_AGENT_OMBRE_PATCH_PYTHON_BIN: join(bin, 'ombre-patch-python'),
    RAN_AGENT_NODE_BIN: nodeBin,
    RAN_AGENT_TEST_MODE: '1',
    RAN_AGENT_TEST_PROC_ROOT: proc,
    RAN_AGENT_PROVIDER_CANARY_TEST_COMMAND: join(bin, 'provider-canary'),
    RAN_AGENT_STEWARD_VERIFY_TEST_COMMAND: join(bin, 'steward-verify'),
    RAN_AGENT_REPO_ROOT: root,
    RAN_AGENT_NODE_ENV_FILE: join(dir, 'node.env'),
    RAN_AGENT_NODE_BRIDGE_ENV_FILE: join(dir, 'bridge.env'),
    RAN_AGENT_DEPLOY_STATE_DIR: state,
    RAN_AGENT_DEPLOY_DEBUG_DIR: debug,
    HERMES_HOME: fullHome,
    HERMES_LITE_HOME: liteHome,
    SYSTEMD_DIR: join(dir, 'systemd'),
    RAN_AGENT_DEPLOY_OMBRE_BRAIN_RUNNER: 'source',
    RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME: ombreHome,
    RAN_AGENT_DEPLOY_OMBRE_BRAIN_SOURCE_DIR: ombreSource,
    RAN_AGENT_DEPLOY_OMBRE_BRAIN_VENV: ombreVenv,
    OMBRE_BRAIN_UPDATE_SOURCE: 'false',
    RAN_AGENT_DEPLOY_OMBRE_BUCKETS_DIR: join(dir, 'buckets'),
    SYSTEMCTL_TRACE: trace,
    MOCK_RUNTIME_USER: runtimeUser,
    MOCK_RUNTIME_GROUP: runtimeGroup,
  };
  try {
    assert.doesNotThrow(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: baseEnv,
      stdio: 'pipe',
    }));
    const log = readFileSync(trace, 'utf8');
    for (const unit of ['ran-agent-ombre-brain.service', 'ran-agent-ombre-recall.service', 'ran-agent-python.service', 'ran-agent-node.service', 'ran-agent-hermes.service', 'ran-agent-hermes-full.service']) {
      assert.match(log, new RegExp(`restart ${unit.replace('.', '\\.')}`));
    }
    assert.ok(log.indexOf('restart ran-agent-ombre-brain.service') < log.indexOf('restart ran-agent-ombre-recall.service'));
    assert.ok(log.indexOf('restart ran-agent-ombre-recall.service') < log.indexOf('restart ran-agent-hermes.service'));
    assert.ok(log.indexOf('restart ran-agent-hermes.service') < log.indexOf('canary lite'));
    assert.ok(log.indexOf('canary lite') < log.indexOf('restart ran-agent-hermes-full.service'));
    assert.ok(log.indexOf('restart ran-agent-hermes.service') < log.indexOf('restart ran-agent-hermes-full.service'));
    assert.ok(log.indexOf('restart ran-agent-hermes-full.service') < log.indexOf('canary full'));
    assert.ok(log.indexOf('canary full') < log.indexOf('restart ran-agent-node.service'));
    assert.doesNotMatch(log, /ran-agent-xhs|\bdisable\b/);
    assert.match(log, /enable ran-agent-ombre-brain\.service/);
    assert.match(log, /enable ran-agent-ombre-recall\.service/);
    assert.equal(existsSync(join(dir, 'systemd', 'ran-agent-ombre-brain.service')), true);
    assert.equal(existsSync(join(dir, 'systemd', 'ran-agent-ombre-recall.service')), true);
    const installedOmbreUnit = readFileSync(join(dir, 'systemd', 'ran-agent-ombre-brain.service'), 'utf8');
    const installedNodeDropin = readFileSync(join(dir, 'systemd', 'ran-agent-node.service.d', '99-ombre-steward-identity.conf'), 'utf8');
    for (const expected of [
      `Environment=RAN_AGENT_STATE_DIR=${state}`,
      `Environment=OMBRE_BRAIN_HOME=${ombreHome}`,
      'Environment=RAN_AGENT_MANAGED_OMBRE_RUNTIME=1',
      `Environment=RAN_AGENT_MANAGED_OMBRE_STATE_DIR=${state}`,
      `Environment=RAN_AGENT_MANAGED_OMBRE_BUCKETS_DIR=${join(dir, 'buckets')}`,
      `Environment=RAN_AGENT_STEWARD_TOKEN_FILE=${join(state, 'ombre-compat', 'secrets', 'steward-api-token')}`,
    ]) assert.match(installedOmbreUnit, new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(installedNodeDropin, new RegExp(`Environment=RAN_AGENT_STATE_DIR=${state}`.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(installedNodeDropin, new RegExp(`Environment=RAN_AGENT_NODE_BIN=${nodeBin}`.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(readFileSync(config, 'utf8'), 'operator-owned-config\n');
    const projection = join(state, 'hermes', 'published-memory-context.json');
    const pointer = JSON.parse(readFileSync(projection, 'utf8'));
    const manifestPath = join(`${projection}.manifests`, pointer.manifest_file);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const revisionPath = join(`${projection}.revisions`, manifest.revision_file);
    for (const directory of [join(state, 'hermes'), `${projection}.revisions`, `${projection}.manifests`]) {
      const metadata = statSync(directory);
      assert.equal(metadata.mode & 0o777, 0o700);
      assert.equal(metadata.uid, process.getuid());
      assert.equal(metadata.gid, process.getgid());
    }
    for (const file of [projection, `${projection}.publication-state.json`, manifestPath, revisionPath]) {
      const metadata = statSync(file);
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.equal(metadata.uid, process.getuid());
      assert.equal(metadata.gid, process.getgid());
    }
    assert.match(log, new RegExp(`chown ${runtimeUser}:${runtimeGroup} .*\\/hermes`));
    assert.match(log, new RegExp(
      `chown -R ran-agent:ran-agent ${ombreHome.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${join(dir, 'buckets').replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ));

    for (const mode of ['lite', 'full']) {
      writeFileSync(trace, '');
      assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
        cwd: root,
        env: { ...baseEnv, FAIL_CANARY_MODE: mode },
        stdio: 'pipe',
      }), /Command failed/);
      const canaryFailureLog = readFileSync(trace, 'utf8');
      if (mode === 'lite') {
        assert.match(canaryFailureLog, /canary lite/);
        assert.doesNotMatch(canaryFailureLog, /restart ran-agent-hermes-full\.service|restart ran-agent-node\.service/);
      } else {
        assert.match(canaryFailureLog, /canary full/);
        assert.doesNotMatch(canaryFailureLog, /restart ran-agent-node\.service/);
      }
    }

    writeFileSync(trace, '');
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: { ...baseEnv, MOCK_RUNTIME_USER: 'different-runtime-user' },
      stdio: 'pipe',
    }), /Command failed/);
    assert.doesNotMatch(
      readFileSync(trace, 'utf8'),
      /restart ran-agent-hermes(?:-full)?\.service|restart ran-agent-node\.service/,
    );

    const corruptingNode = join(bin, 'node-corrupt-projection-owner-shape');
    writeFileSync(corruptingNode, [
      '#!/bin/sh',
      'if [ "$1" = "$RAN_AGENT_REPO_ROOT/node_bridge/src/hermesIdentityProjection.mjs" ] && [ "${2:-}" != verify-runtime ]; then',
      '  "$REAL_NODE" "$@"',
      '  find "$3.manifests" -type f -exec chmod 0644 {} +',
      '  exit 0',
      'fi',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'));
    chmodSync(corruptingNode, 0o755);
    writeFileSync(trace, '');
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: { ...baseEnv, RAN_AGENT_NODE_BIN: corruptingNode, REAL_NODE: nodeBin },
      stdio: 'pipe',
    }), /Command failed/);
    const unreadableGraphLog = readFileSync(trace, 'utf8');
    assert.doesNotMatch(
      unreadableGraphLog,
      /restart ran-agent-hermes(?:-full)?\.service|restart ran-agent-node\.service/,
    );
    chmodSync(manifestPath, 0o600);

    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(trace, '');
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: {
        ...baseEnv,
        RAN_AGENT_DEPLOY_OMBRE_HEALTH_TIMEOUT_SECONDS: '0',
      },
      stdio: 'pipe',
    }), /Command failed/);
    const failedLog = readFileSync(trace, 'utf8');
    assert.match(failedLog, /restart ran-agent-ombre-brain\.service/);
    assert.doesNotMatch(failedLog, /restart ran-agent-hermes(?:-full)?\.service/);

    for (const unit of ['ran-agent-ombre-brain.service', 'ran-agent-node.service']) {
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'curl'), 0o755);
      writeFileSync(trace, '');
      assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
        cwd: root,
        env: { ...baseEnv, FAIL_RESTART_UNIT: unit },
        stdio: 'pipe',
      }), /Command failed/);
      assert.match(readFileSync(trace, 'utf8'), new RegExp(`restart ${unit.replace('.', '\\.')}`));
    }

    writeFileSync(join(proc, '123', 'status'), 'Uid:\t999\t998\t999\t999\nGid:\t999\t999\t999\t999\n');
    writeFileSync(trace, '');
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'apply-hermes-runtime-split.sh'), '--preserve-runtime-shape'], {
      cwd: root,
      env: baseEnv,
      stdio: 'pipe',
    }), /Command failed/);
    const numericIdentityFailureLog = readFileSync(trace, 'utf8');
    assert.match(numericIdentityFailureLog, /restart ran-agent-ombre-brain\.service/);
    assert.doesNotMatch(numericIdentityFailureLog, /restart ran-agent-ombre-recall\.service|restart ran-agent-hermes(?:-full)?\.service|restart ran-agent-node\.service/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projection publisher switches to a distinct validated runtime identity and fails closed without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projection-runtime-identity-'));
  const bin = join(dir, 'bin');
  const trace = join(dir, 'trace');
  const check = join(bin, 'check-runtime');
  mkdirSync(bin);
  writeFileSync(join(bin, 'id'), [
    '#!/bin/sh',
    'if [ "${MISSING_RUNTIME_USER:-0}" = 1 ] && [ "$#" -gt 1 ]; then exit 1; fi',
    'case "$1:$#" in',
    '  -u:1|-g:1) printf "%s\\n" 2000 ;;',
    '  -u:2|-g:2) printf "%s\\n" 1000 ;;',
    '  -gn:2) printf "%s\\n" runtime-group ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'runuser'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$RUNTIME_TRACE"',
    'while [ "$1" != -- ]; do shift; done',
    'shift',
    'MOCK_RUNTIME_EFFECTIVE=1 exec "$@"',
    '',
  ].join('\n'));
  writeFileSync(check, '#!/bin/sh\n[ "${MOCK_RUNTIME_EFFECTIVE:-0}" = 1 ]\n');
  for (const file of ['id', 'runuser', 'check-runtime']) chmodSync(join(bin, file), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    RAN_AGENT_NO_SUDO: '1',
    RAN_AGENT_HERMES_RUNTIME_USER: 'runtime-user',
    RAN_AGENT_HERMES_RUNTIME_GROUP: 'runtime-group',
    RUNTIME_TRACE: trace,
  };
  try {
    assert.doesNotThrow(() => execFileSync('bash', ['-c', [
      'source scripts/apply-hermes-runtime-split.sh',
      'resolve_runtime_identity',
      `run_as_runtime_identity ${JSON.stringify(check)}`,
    ].join('\n')], { cwd: root, env, stdio: 'pipe' }));
    assert.match(
      readFileSync(trace, 'utf8'),
      /--user runtime-user --group runtime-group -- .*check-runtime/,
    );

    assert.throws(() => execFileSync('bash', ['-c', [
      'source scripts/apply-hermes-runtime-split.sh',
      'resolve_runtime_identity',
      'command() { if [ "$1" = -v ] && [ "$2" = runuser ]; then return 1; fi; builtin command "$@"; }',
      `run_as_runtime_identity ${JSON.stringify(check)}`,
    ].join('\n')], { cwd: root, env, stdio: 'pipe' }), /Command failed/);

    assert.throws(() => execFileSync('bash', ['-c', [
      'source scripts/apply-hermes-runtime-split.sh',
      'resolve_runtime_identity',
    ].join('\n')], {
      cwd: root,
      env: { ...env, MISSING_RUNTIME_USER: '1' },
      stdio: 'pipe',
    }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('O1 dependency startup resets failed units, enables inactive units, and refuses masked policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-service-states-'));
  const systemctl = join(dir, 'systemctl');
  const log = join(dir, 'systemctl.log');
  writeFileSync(systemctl, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
    'case "$1" in',
    '  is-enabled) printf "%s\\n" "$SYSTEMCTL_ENABLED"; [ "$SYSTEMCTL_ENABLED" = enabled ] ;;',
    '  show) printf "%s\\n" loaded ;;',
    '  is-failed) [ "$SYSTEMCTL_FAILED" = 1 ] ;;',
    '  reset-failed|enable|restart) exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(systemctl, 0o755);
  const invoke = (enabled, failed) => {
    writeFileSync(log, '');
    try {
      execFileSync('bash', ['-c', [
        'set -euo pipefail',
        'source scripts/apply-hermes-runtime-split.sh',
        'start_o1_dependency ran-agent-ombre-brain.service',
      ].join('\n')], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${dir}:/usr/bin:/bin`,
          RAN_AGENT_NO_SUDO: '1',
          SYSTEMCTL_LOG: log,
          SYSTEMCTL_ENABLED: enabled,
          SYSTEMCTL_FAILED: failed ? '1' : '0',
        },
        stdio: 'pipe',
      });
      return { status: 0, trace: readFileSync(log, 'utf8') };
    } catch (error) {
      return { status: error.status, trace: readFileSync(log, 'utf8') };
    }
  };
  const failed = invoke('disabled', true);
  assert.equal(failed.status, 0);
  assert.match(failed.trace, /reset-failed ran-agent-ombre-brain\.service/);
  assert.match(failed.trace, /enable ran-agent-ombre-brain\.service/);
  assert.match(failed.trace, /restart ran-agent-ombre-brain\.service/);
  const inactive = invoke('disabled', false);
  assert.equal(inactive.status, 0);
  assert.doesNotMatch(inactive.trace, /reset-failed/);
  assert.match(inactive.trace, /enable ran-agent-ombre-brain\.service/);
  const masked = invoke('masked', false);
  assert.notEqual(masked.status, 0);
  assert.doesNotMatch(masked.trace, /unmask|restart ran-agent-ombre-brain/);
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
  const hermesResolver = readFileSync(join(root, 'scripts', 'resolve-hermes-gate-runtime.mjs'), 'utf8');
  const providerBoundary = readFileSync(join(root, 'node_bridge', 'tests', 'hermesGatewayProviderBoundary.integration.test.mjs'), 'utf8');
  const ombreContract = readFileSync(join(root, 'node_bridge', 'tests', 'ombreO1Contract.test.mjs'), 'utf8');
  assert.match(source, /--core\|--all\|--preflight-only/);
  assert.match(source, /hermes-release-smoke\.mjs/);
  assert.match(source, /--all/);
  assert.match(source, /run_ombre_real_process_gate/);
  assert.match(source, /verify-ombre-steward-real-process\.sh/);
  assert.match(source, /RAN_AGENT_OMBRE_UPSTREAM_VENV/);
  assert.ok(source.indexOf('run_ombre_real_process_gate') < source.indexOf('run_node_test()'));
  assert.match(source, /RAN_AGENT_PYTHON_BIN="\$PYTHON_BIN"/);
  assert.match(source, /tests\/test_hermes_deepseek_provider\.py[\s\S]*resolve_test_hermes_bin/);
  assert.match(source, /RAN_AGENT_HERMES_TEST_BIN="\$HERMES_TEST_BIN"[\s\S]*-m pytest/);
  assert.match(source, /RAN_AGENT_HERMES_TEST_PYTHON_BIN="\$HERMES_TEST_PYTHON_BIN"[\s\S]*-m pytest/);
  assert.doesNotMatch(source, /HERMES_TEST_PYTHON_BIN="\$project\/venv\/bin\/python"/);
  assert.match(source, /resolve-hermes-gate-runtime\.mjs/);
  assert.match(source, /STAGED_CANDIDATE.*RAN_AGENT_RELEASE_STAGED_CANDIDATE/);
  assert.match(source, /if \[\[ "\$STAGED_CANDIDATE" == 1 \]\]; then\s+PATH=\/usr\/bin:\/bin/);
  assert.ok(source.indexOf('STAGED_CANDIDATE=') < source.indexOf('SOURCE_ROOT_INPUT='));
  assert.match(source, /\/usr\/bin\/chgrp "\$\(\/usr\/bin\/id -g\)" "\$SANDBOX_ROOT"/);
  assert.ok(source.indexOf('/usr/bin/chgrp') < source.indexOf('mkdir -p "$SANDBOX_ROOT/home"'));
  assert.doesNotMatch(source, /(^|[^/])\benv -i/);
  assert.match(source, /run_clean "\$NODE_BIN" "\$resolver" \/usr\/bin\/systemctl/);
  assert.match(source, /if \[\[ "\$STAGED_CANDIDATE" == 1 \]\][\s\S]*\/usr\/bin\/systemctl[\s\S]*else\s+HERMES_TEST_BIN="\$\{RAN_AGENT_HERMES_TEST_BIN:-\$HOME\/\.local\/bin\/hermes\}"/);
  assert.match(source, /spawnSync\(process\.argv\[1\].*timeout: 10000/);
  assert.match(hermesResolver, /ran-agent-hermes\.service/);
  assert.match(hermesResolver, /ran-agent-hermes-full\.service/);
  assert.match(hermesResolver, /env: \{ PATH: '\/usr\/bin:\/bin', RAN_AGENT_SYSTEMCTL_BIN: systemctlBin \}/);
  assert.match(hermesResolver, /timeout: 10_000/);
  assert.match(hermesResolver, /fs\.realpathSync/);
  assert.match(hermesResolver, /liteReal !== fullReal/);
  assert.match(hermesResolver, /path\.join\(path\.dirname\(liteReal\), 'python'\)/);
  assert.doesNotMatch(hermesResolver, /process\.env\.RAN_AGENT_(?:HERMES_TEST_BIN|SYSTEMCTL_BIN)/);
  assert.match(source, /RAN_AGENT_HERMES_TEST_BIN="\$hermes_test_bin"/);
  assert.match(providerBoundary, /process\.env\.RAN_AGENT_HERMES_TEST_BIN/);
  assert.match(providerBoundary, /Hermes Agent v0\\\.13/);
  assert.match(providerBoundary, /timeout: 30_000/);
  assert.doesNotMatch(providerBoundary, /\/Users\/fengran/);
  assert.match(ombreContract, /process\.env\.RAN_AGENT_PYTHON_BIN/);
  assert.doesNotMatch(ombreContract, /\/Users\/fengran/);
  assert.ok(source.indexOf('chmod -R a-w') < source.indexOf('hermes-release-smoke.mjs'));
  for (const name of ['RAN_AGENT_STATE_DIR', 'RAN_AGENT_IDENTITY_MAP_PATH', 'RAN_AGENT_GLOBAL_TIMELINE_PATH', 'RAN_AGENT_TIMELINE_ARCHIVE_DIR']) {
    assert.match(source.match(/run_node_test\(\)[\s\S]*?\n\}/)?.[0] || '', new RegExp(name));
    assert.match(source.match(/run_node_smoke\(\)[\s\S]*?\n\}/)?.[0] || '', new RegExp(name));
  }
});

test('real Ombre gate rejects a requirements lock mutation staged in the upstream index', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ombre-real-gate-lock-')));
  const upstream = join(dir, 'upstream');
  const venv = join(dir, 'venv');
  try {
    mkdirSync(join(upstream, 'src'), { recursive: true });
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(upstream, 'src', 'server.py'), '# fixture\n');
    writeFileSync(join(upstream, 'requirements.lock.txt'), 'fixture==1 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    writeFileSync(join(venv, 'bin', 'python'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(venv, 'bin', 'python'), 0o755);
    execFileSync('git', ['init'], { cwd: upstream, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'ombre-lock@example.invalid'], { cwd: upstream });
    execFileSync('git', ['config', 'user.name', 'Ombre lock'], { cwd: upstream });
    execFileSync('git', ['add', '.'], { cwd: upstream });
    execFileSync('git', ['commit', '-m', 'official fixture'], { cwd: upstream, stdio: 'pipe' });
    const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
    writeFileSync(join(upstream, 'requirements.lock.txt'), 'tampered==1 --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
    execFileSync('git', ['add', 'requirements.lock.txt'], { cwd: upstream });
    assert.throws(() => execFileSync('bash', [join(root, 'scripts', 'verify-ombre-steward-real-process.sh')], {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        RAN_AGENT_RELEASE_SOURCE_ROOT: root,
        RAN_AGENT_OMBRE_UPSTREAM_SOURCE_DIR: upstream,
        RAN_AGENT_OMBRE_UPSTREAM_VENV: venv,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_TEST_MODE: '1',
        RAN_AGENT_TEST_OMBRE_COMMIT: expectedCommit,
        RAN_AGENT_TEST_OMBRE_EXPECTED_SOURCE_UID: String(process.getuid()),
      },
      stdio: 'pipe',
    }), /official_lock_worktree_dirty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    const poisonBin = join(stage, 'poison-bin');
    const poisonMarker = join(stage, 'poison-command-ran');
    mkdirSync(poisonBin, { recursive: true });
    for (const command of ['env', 'mktemp', 'mkdir', 'dirname']) {
      const executable = join(poisonBin, command);
      writeFileSync(executable, `#!/bin/sh\nprintf poison >> ${JSON.stringify(poisonMarker)}\nexit 99\n`);
      chmodSync(executable, 0o755);
    }

    const output = execFileSync('/bin/bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--core'], {
      cwd: stage,
      env: {
        PATH: poisonBin,
        RAN_AGENT_NODE_BIN: nodeBin,
        RAN_AGENT_PYTHON_BIN: pythonBin,
        RAN_AGENT_RELEASE_CANDIDATE: 'a'.repeat(40),
        RAN_AGENT_HERMES_TEST_BIN: '/attacker/hermes',
        RAN_AGENT_SYSTEMCTL_BIN: '/attacker/systemctl',
        RAN_AGENT_RELEASE_SOURCE_ROOT: stage,
        RAN_AGENT_RELEASE_STAGED_CANDIDATE: '1',
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(output, /hermes-release-gate: ok/);
    assert.equal(existsSync(poisonMarker), false, 'staged gate must fix PATH before invoking any external command');
    const phaseEnv = {
      PATH: poisonBin,
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
      RAN_AGENT_RELEASE_CANDIDATE: 'a'.repeat(40),
      RAN_AGENT_RELEASE_SOURCE_ROOT: stage,
      RAN_AGENT_RELEASE_STAGED_CANDIDATE: '1',
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_OMBRE_GATE_PHASE_ONLY: '1',
    };
    const codePhase = execFileSync('/bin/bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--all'], {
      cwd: stage,
      env: { ...phaseEnv, RAN_AGENT_OMBRE_REAL_PROCESS_GATE_PHASE: 'code-only' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(codePhase, /ombre-phase-ok/);
    assert.throws(() => execFileSync('/bin/bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--all'], {
      cwd: stage,
      env: { ...phaseEnv, RAN_AGENT_OMBRE_REAL_PROCESS_GATE_PHASE: 'required' },
      encoding: 'utf8',
      stdio: 'pipe',
    }), /ombre_real_process_inputs_required/);
    assert.throws(
      () => execFileSync('/bin/bash', [join(stage, 'scripts', 'hermes-release-gate.sh'), '--core'], {
        cwd: stage,
        env: {
          PATH: poisonBin,
          RAN_AGENT_NODE_BIN: nodeBin,
          RAN_AGENT_PYTHON_BIN: '/definitely/missing/ran-agent-python',
          RAN_AGENT_RELEASE_CANDIDATE: 'a'.repeat(40),
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
  const applyFlow = deploy.slice(deploy.lastIndexOf('require_apply_prerequisites'));

  assert.match(deploy, /CANDIDATE.*\^\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(deploy, /candidate_not_checked_out/);
  assert.match(deploy, /snapshot_node_durable_state/);
  assert.match(deploy, /snapshot_capacity_gate/);
  assert.match(deploy, /plugins\/model-providers\/deepseek/);
  assert.match(deploy, /snapshot_path "\$REPO_ROOT\/data" 901/);
  assert.match(deploy, /RAN_AGENT_RELEASE_ARTIFACT_ROOT/);
  assert.match(deploy, /activate_candidate_checkout/);
  assert.ok(deploy.indexOf('snapshot_runtime_state') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('snapshot_state_migrations') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('hermes-release-gate.sh" --all') < deploy.lastIndexOf('snapshot_runtime_state'));
  assert.ok(deploy.indexOf('prune_release_artifacts "$SCRIPT_ROOT"') < deploy.lastIndexOf('snapshot_capacity_gate "$STAGE_DIR" 0'));
  assert.ok(deploy.lastIndexOf('snapshot_capacity_gate "$STAGE_DIR" 0') < deploy.lastIndexOf('snapshot_runtime_state'));
  assert.ok(applyFlow.indexOf('prune_release_artifacts "$SCRIPT_ROOT"') < applyFlow.indexOf('snapshot_capacity_gate "$SCRIPT_ROOT" "$PRE_STAGE_RESERVE_BYTES"'));
  assert.ok(applyFlow.indexOf('snapshot_capacity_gate "$SCRIPT_ROOT" "$PRE_STAGE_RESERVE_BYTES"') < applyFlow.indexOf('report_release_delta'));
  assert.ok(applyFlow.indexOf('snapshot_capacity_gate "$SCRIPT_ROOT" "$PRE_STAGE_RESERVE_BYTES"') < applyFlow.indexOf('stage_candidate'));
  assert.match(deploy.match(/snapshot_runtime_state\(\) \{([\s\S]*?)\n\}/)?.[1] || '', /write_transaction_state snapshot-created false[\s\S]*TRANSACTION_STARTED=1/);
  const quiescedSnapshot = applyFlow.indexOf('snapshot_state_migrations');
  const resealedState = applyFlow.indexOf('write_transaction_state snapshot-created false', quiescedSnapshot);
  const resealedVerification = applyFlow.indexOf('verify_in_progress_snapshot "$SNAPSHOT_DIR"', resealedState);
  assert.ok(quiescedSnapshot < resealedState);
  assert.ok(resealedState < resealedVerification);
  assert.ok(resealedVerification < applyFlow.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('snapshot_code_revision') < deploy.lastIndexOf('activate_candidate_checkout'));
  assert.ok(applyFlow.indexOf('snapshot_capacity_gate "$SCRIPT_ROOT" "$PRE_STAGE_RESERVE_BYTES"') < applyFlow.indexOf('require_gate_copy_capacity estimate'));
  assert.ok(applyFlow.indexOf('require_gate_copy_capacity estimate') < applyFlow.indexOf('stage_candidate'));
  assert.ok(applyFlow.indexOf('prepare_candidate_node_dependencies') < applyFlow.indexOf('snapshot_runtime_state'));
  assert.ok(applyFlow.indexOf('candidate_stage_preflight owner') < applyFlow.indexOf('stage_gate_copy'));
  assert.ok(applyFlow.indexOf('stage_gate_copy') < applyFlow.indexOf('run_candidate_gates'));
  assert.ok(applyFlow.indexOf('run_candidate_gates') < applyFlow.indexOf('prepare_candidate_node_dependencies'));
  assert.ok(applyFlow.indexOf('run_candidate_gates') < applyFlow.indexOf('snapshot_runtime_state'));
  assert.ok(applyFlow.indexOf('run_candidate_gates') < applyFlow.indexOf('quiesce_runtime_services'));
  assert.ok(applyFlow.indexOf('run_candidate_gates') < applyFlow.indexOf('activate_candidate_checkout'));
  assert.ok(applyFlow.indexOf('prepare_candidate_node_dependencies') < applyFlow.indexOf('require_gate_copy_capacity measured'));
  assert.ok(applyFlow.indexOf('require_gate_copy_capacity measured') < applyFlow.indexOf('project_gate_copy_node_modules'));
  assert.ok(applyFlow.indexOf('project_gate_copy_node_modules') < applyFlow.indexOf('runtime_checkout_access "$GATE_DIR" modules'));
  assert.ok(applyFlow.indexOf('runtime_checkout_access "$GATE_DIR" modules') < applyFlow.indexOf('snapshot_runtime_state'));
  assert.ok(applyFlow.indexOf('activate_candidate_checkout') < applyFlow.indexOf('activate_candidate_node_dependencies'));
  assert.ok(applyFlow.indexOf('activate_candidate_node_dependencies') < applyFlow.indexOf('runtime_checkout_access "$REPO_ROOT" modules'));
  assert.match(deploy, /runtime_checkout_access "\$REPO_ROOT" files/);
  assert.match(deploy, /npm_config_engine_strict=true/);
  assert.match(deploy, /npm[^\n]* ci --omit=dev --ignore-scripts --prefix "\$STAGE_DIR"/);
  assert.match(deploy, /--rollback/);
  assert.match(deploy, /rollback-complete deployment_status=/);
  assert.match(deploy, /rollback-incomplete deployment_status=/);
  assert.match(deploy, /trap 'release_exit \$\?' EXIT/);
  assert.match(deploy, /for stage in quiesce_runtime_services restore_runtime_files restore_state_migrations restore_steward_token restore_node_dependencies restore_code_revision block_ombre_ingress clear_ombre_ingress_block restore_service_state/);
  assert.doesNotMatch(deploy, /restore_(?:code_revision|runtime_files|state_migrations|service_state) \|\| true/);
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
  assert.match(main, /git show "\$CANDIDATE:scripts\/bootstrap-hermes-release\.sh"/);
  assert.match(main, /worktree_dirty/);
  assert.doesNotMatch(main, /git pull|git checkout|git switch/);
  assert.match(candidateEntry, /--branch\)[\s\S]*--commit\)/);
  assert.match(candidateEntry, /git fetch --no-tags origin/);
  assert.match(candidateEntry, /git check-ref-format --branch/);
  assert.match(candidateEntry, /git show "\$CANDIDATE:scripts\/bootstrap-hermes-release\.sh"/);
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

test('rollback bootstrap re-extracts the candidate controller after checkout returned to the prior commit', () => {
  const fixture = makeBootstrapFixture();
  const extracted = join(fixture.repo, '..', `rollback-bootstrap-${fixture.candidateSha}.sh`);
  try {
    assert.equal(existsSync(join(fixture.repo, 'scripts', 'deploy-hermes-release.sh')), false);
    writeFileSync(extracted, execFileSync('git', ['show', `${fixture.candidateSha}:scripts/bootstrap-hermes-release.sh`], {
      cwd: fixture.repo,
      encoding: 'utf8',
    }));
    chmodSync(extracted, 0o755);
    let failure;
    try {
      execFileSync('bash', [extracted, '--rollback', fixture.candidateSha, join(fixture.repo, '..', 'snapshot')], {
        cwd: fixture.repo,
        env: {
          PATH: '/usr/bin:/bin',
          RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
          RAN_AGENT_NODE_BIN: nodeBin,
          RAN_AGENT_PYTHON_BIN: pythonBin,
          RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.repo, '..', 'release-artifacts'),
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure?.stderr), /deploy-hermes-release: failed:server_root_required/);
    assert.doesNotMatch(String(failure?.stderr), /bootstrap-hermes-release: failed/);
    assert.equal(fixture.runGit(['rev-parse', 'HEAD']).trim(), fixture.prior);
    assert.equal(fixture.runGit(['status', '--short']).trim(), '');
  } finally {
    rmSync(extracted, { force: true });
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('apply authority accepts only the complete candidate-extracted bootstrap root', () => {
  const fixture = makeBootstrapFixture();
  const bootstrapRoot = mkdtempSync(join(tmpdir(), 'ran-agent-release-bootstrap.'));
  const scripts = join(bootstrapRoot, 'scripts');
  const harness = join(fixture.repo, '..', `authority-harness-${fixture.candidateSha}.sh`);
  mkdirSync(scripts);
  chmodSync(bootstrapRoot, 0o700);
  for (const file of bootstrapFrameworkFiles) {
    writeFileSync(join(scripts, file), fixture.runGit(['show', `${fixture.candidateSha}:scripts/${file}`]));
  }
  writeFileSync(join(bootstrapRoot, 'manifest'), fixture.runGit(['show', `${fixture.candidateSha}:docs/governance/hermes_release_bootstrap.v1.sha256`]));
  const deploySource = readFileSync(join(scripts, 'deploy-hermes-release.sh'), 'utf8');
  writeFileSync(harness, deploySource.slice(0, deploySource.lastIndexOf('if [[ "$MODE" == --rollback ]]')));
  const verify = (authorityRoot) => execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'set -- --rollback fixture',
    `source ${JSON.stringify(harness)}`,
    `SCRIPT_ROOT=${JSON.stringify(bootstrapRoot)}`,
    `CANDIDATE=${JSON.stringify(fixture.candidateSha)}`,
    'require_candidate_bootstrap_authority',
  ].join('\n')], {
    cwd: fixture.repo,
    env: {
      PATH: '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      RAN_AGENT_NODE_BIN: nodeBin,
      RAN_AGENT_PYTHON_BIN: pythonBin,
      RAN_AGENT_RELEASE_CONTROL_ROOT: fixture.repo,
      RAN_AGENT_RELEASE_ARTIFACT_ROOT: join(fixture.repo, '..', 'release-artifacts'),
      RAN_AGENT_RELEASE_BOOTSTRAP_ROOT: authorityRoot,
    },
    stdio: 'pipe',
  });
  try {
    assert.doesNotThrow(() => verify(bootstrapRoot));
    assert.throws(() => verify(fixture.repo), /candidate_bootstrap_required/);
    writeFileSync(join(scripts, 'resolve-hermes-service-node.sh'), '\n# tampered after extraction\n', { flag: 'a' });
    assert.throws(() => verify(bootstrapRoot), /candidate_bootstrap_required/);
  } finally {
    rmSync(harness, { force: true });
    rmSync(bootstrapRoot, { recursive: true, force: true });
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
  const byEnvironment = makeSystemctlFixture({ show: `RAN_AGENT_NODE_BIN=${nodeBin}` });
  const byShow = makeSystemctlFixture({ show: `{ path=${nodeBin} ; argv[]=${nodeBin} /opt/ran_agent/node_bridge/src/index.mjs ; }` });
  const byCat = makeSystemctlFixture({ cat: `ExecStart=${nodeBin} /opt/ran_agent/node_bridge/src/index.mjs` });
  const unresolved = makeSystemctlFixture({ show: '{ path=/usr/bin/env ; argv[]=/usr/bin/env bash -lc node ; }', cat: 'ExecStart=/usr/bin/env bash -lc node' });
  const active = mkdtempSync(join(tmpdir(), 'ran-agent-active-node-'));
  const activeSystemctl = join(active, 'systemctl');
  const wrongNode = join(active, 'node');
  const ambiguousNode = join(active, 'other', 'node');
  mkdirSync(join(active, 'proc', '123', 'task', '123'), { recursive: true });
  mkdirSync(join(active, 'proc', '456', 'task', '456'), { recursive: true });
  symlinkSync('/bin/bash', join(active, 'proc', '123', 'exe'));
  symlinkSync(nodeBin, join(active, 'proc', '456', 'exe'));
  writeFileSync(join(active, 'proc', '123', 'task', '123', 'children'), '456\n');
  writeFileSync(join(active, 'proc', '456', 'task', '456', 'children'), '');
  symlinkSync('/bin/sh', wrongNode);
  writeFileSync(activeSystemctl, `#!/bin/sh
case "$*" in
  *--property=Environment*) printf '%s\\n' 'RAN_AGENT_NODE_BIN=${nodeBin}' ;;
  *--property=MainPID*) printf '%s\\n' 123 ;;
  *--property=ExecStart*) printf '%s\\n' '{ path=${nodeBin} ; }' ;;
  cat*) printf '%s\\n' 'ExecStart=${nodeBin} /opt/ran_agent/node_bridge/src/index.mjs' ;;
esac
`);
  chmodSync(activeSystemctl, 0o755);
  const runResolver = (env) => execFileSync('bash', [resolver], {
    env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  try {
    assert.equal(runResolver({ RAN_AGENT_NODE_BIN: nodeBin, RAN_AGENT_SYSTEMCTL_BIN: '/missing/systemctl' }), nodeBin);
    assert.equal(runResolver({ RAN_AGENT_SYSTEMCTL_BIN: byEnvironment.path }), nodeBin);
    assert.equal(runResolver({ RAN_AGENT_SYSTEMCTL_BIN: byShow.path }), nodeBin);
    assert.equal(runResolver({ RAN_AGENT_SYSTEMCTL_BIN: byCat.path }), nodeBin);
    assert.throws(() => runResolver({ RAN_AGENT_SYSTEMCTL_BIN: unresolved.path }), /Command failed/);
    assert.equal(runResolver({
      RAN_AGENT_SYSTEMCTL_BIN: activeSystemctl,
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_PROC_ROOT: join(active, 'proc'),
    }), nodeBin);
    assert.throws(() => runResolver({
      RAN_AGENT_NODE_BIN: wrongNode,
      RAN_AGENT_SYSTEMCTL_BIN: activeSystemctl,
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_PROC_ROOT: join(active, 'proc'),
    }), /node_service_(?:explicit_environment|process_environment)_mismatch/);
    mkdirSync(join(active, 'proc', '789', 'task', '789'), { recursive: true });
    mkdirSync(join(active, 'other'));
    writeFileSync(ambiguousNode, '#!/bin/sh\nexit 0\n');
    chmodSync(ambiguousNode, 0o755);
    symlinkSync(ambiguousNode, join(active, 'proc', '789', 'exe'));
    writeFileSync(join(active, 'proc', '789', 'task', '789', 'children'), '');
    writeFileSync(join(active, 'proc', '123', 'task', '123', 'children'), '456 789\n');
    assert.throws(() => runResolver({
      RAN_AGENT_SYSTEMCTL_BIN: activeSystemctl,
      RAN_AGENT_TEST_MODE: '1',
      RAN_AGENT_TEST_PROC_ROOT: join(active, 'proc'),
    }), /node_service_process_ambiguous/);
  } finally {
    for (const fixture of [byEnvironment, byShow, byCat, unresolved]) rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(active, { recursive: true, force: true });
  }
});

test('release Hermes resolver accepts only an executable service-managed v0.13 runtime', () => {
  const resolver = join(root, 'scripts', 'resolve-hermes-service-runtime.sh');
  const runtime = mkdtempSync(join(tmpdir(), 'ran-agent-hermes-runtime-'));
  const validBin = join(runtime, 'v013', 'hermes');
  const wrongVersionBin = join(runtime, 'v014', 'hermes');
  mkdirSync(join(runtime, 'v013'), { recursive: true });
  mkdirSync(join(runtime, 'v014'), { recursive: true });
  writeFileSync(validBin, '#!/bin/sh\nprintf "Hermes Agent v0.13.0\\n"\n');
  writeFileSync(wrongVersionBin, '#!/bin/sh\nprintf "Hermes Agent v0.14.0\\n"\n');
  chmodSync(validBin, 0o755);
  chmodSync(wrongVersionBin, 0o755);
  const valid = makeSystemctlFixture({ cat: `ExecStart=${validBin} gateway run` });
  const wrongVersion = makeSystemctlFixture({ cat: `ExecStart=${wrongVersionBin} gateway run` });
  const missing = makeSystemctlFixture({ cat: `ExecStart=${join(runtime, 'missing', 'hermes')} gateway run` });
  const runResolver = (fixture) => execFileSync('bash', [resolver, 'ran-agent-hermes.service'], {
    env: { PATH: '/usr/bin:/bin', RAN_AGENT_SYSTEMCTL_BIN: fixture.path },
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  try {
    assert.equal(runResolver(valid), validBin);
    assert.throws(() => runResolver(wrongVersion), /Command failed/);
    assert.throws(() => runResolver(missing), /Command failed/);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    for (const fixture of [valid, wrongVersion, missing]) rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('staged Hermes gate runtime binds the service venv and rejects Lite/Full drift', () => {
  const gateResolver = join(root, 'scripts', 'resolve-hermes-gate-runtime.mjs');
  const runtime = mkdtempSync(join(tmpdir(), 'ran-agent-hermes-gate-runtime-'));
  const makeHermes = (name, version, withPython = true) => {
    const bin = join(runtime, name, 'hermes');
    mkdirSync(join(runtime, name), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\nprintf "Hermes Agent ${version}\\n"\n`);
    chmodSync(bin, 0o755);
    if (withPython) {
      const python = join(runtime, name, 'python');
      writeFileSync(python, '#!/bin/sh\nexit 0\n');
      chmodSync(python, 0o755);
    }
    return bin;
  };
  const valid = makeHermes('valid', 'v0.13.0');
  const other = makeHermes('other', 'v0.13.1');
  const wrongVersion = makeHermes('wrong-version', 'v0.14.0');
  const missingPython = makeHermes('missing-python', 'v0.13.0', false);
  const missing = join(runtime, 'missing', 'hermes');
  const makeServiceMap = (lite, full) => {
    const dir = mkdtempSync(join(tmpdir(), 'ran-agent-hermes-gate-systemctl-'));
    const path = join(dir, 'systemctl');
    writeFileSync(path, `#!/bin/sh\ncase "$1:$2" in\n  show:*) exit 0 ;;\n  cat:ran-agent-hermes.service) printf '%s\\n' 'ExecStart=${lite} gateway run' ;;\n  cat:ran-agent-hermes-full.service) printf '%s\\n' 'ExecStart=${full} gateway run' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(path, 0o755);
    return { dir, path };
  };
  const same = makeServiceMap(valid, valid);
  const mismatch = makeServiceMap(valid, other);
  const badVersion = makeServiceMap(valid, wrongVersion);
  const badPython = makeServiceMap(missingPython, missingPython);
  const absent = makeServiceMap(valid, missing);
  const maliciousSystemctl = makeServiceMap(other, other);
  const runGateResolver = (fixture, env = {}) => execFileSync(nodeBin, [gateResolver, fixture.path], {
    env: { PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  try {
    assert.equal(runGateResolver(same, {
      PATH: join(runtime, 'attacker-bin'),
      RAN_AGENT_HERMES_TEST_BIN: other,
      RAN_AGENT_SYSTEMCTL_BIN: maliciousSystemctl.path,
    }), `${realpathSync(valid)}\t${join(dirname(realpathSync(valid)), 'python')}`);
    assert.throws(() => runGateResolver(mismatch), /Command failed/);
    assert.throws(() => runGateResolver(badVersion), /Command failed/);
    assert.throws(() => runGateResolver(badPython), /Command failed/);
    assert.throws(() => runGateResolver(absent), /Command failed/);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    for (const fixture of [same, mismatch, badVersion, badPython, absent, maliciousSystemctl]) {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
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
    'scripts/prune-hermes-release-artifacts.sh',
    'scripts/check-hermes-snapshot-capacity.py',
    'scripts/ombre_o1_contract.py',
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
