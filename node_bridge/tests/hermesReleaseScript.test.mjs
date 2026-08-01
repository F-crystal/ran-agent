import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, chmodSync, chownSync, constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const nodeBin = process.execPath;
const pythonBin = process.env.RAN_AGENT_PYTHON_BIN || realpathSync(execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim());
const runtimeUser = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
const runtimeGroup = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();

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
  copyFileSync(join(root, 'scripts', 'ombre_o1_contract.py'), join(scripts, 'ombre_o1_contract.py'));
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
    'SUDO=(sudo)',
    `SNAPSHOT_DIR=${JSON.stringify(fixture.snapshot)}`,
    'for unit in "${ALL_RUNTIME_UNITS[@]}"; do snapshot_service_state "$unit"; done',
    'printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$SNAPSHOT_DIR/prior-head"',
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
  writeFileSync(join(venv, 'bin', 'python'), [
    '#!/bin/sh',
    'printf "runtime=%s|%s|%s\\n" "$RAN_AGENT_STATE_DIR" "$OMBRE_BRAIN_HOME" "$RAN_AGENT_STEWARD_TOKEN_FILE"',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse HEAD"*) printf "%s\\n" 0e83d4671ce1629e03ad36bb9160235bf60dbd34 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'patch-python'), [
    '#!/bin/sh',
    'case "$1" in',
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
    const output = execFileSync('bash', [join(stage, 'scripts', 'start_ombre_brain_service.sh')], {
      env, encoding: 'utf8', stdio: 'pipe',
    });
    assert.equal(existsSync(token), true);
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
  for (const key of ['SYS_UID_MIN', 'SYS_UID_MAX', 'SYS_GID_MIN', 'SYS_GID_MAX']) {
    assert.match(identity, new RegExp(key));
  }
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
  const loginDefs = join(dir, 'login.defs');
  const accept = readFileSync(join(root, 'scripts', 'accept-hermes-release.sh'), 'utf8');
  const contract = accept.match(/release_steward_identity_contract\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  mkdirSync(bin);
  mkdirSync(join(proc, '123'), { recursive: true });
  writeFileSync(loginDefs, 'SYS_UID_MIN 100\nSYS_UID_MAX 999\nSYS_GID_MIN 100\nSYS_GID_MAX 999\n');
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
      RAN_AGENT_TEST_LOGIN_DEFS_FILE: loginDefs,
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

test('transaction retention keeps current production and only deletes explicitly accepted rollbackable history', () => {
  const fixture = makeDeployServiceFixture();
  const snapshotRoot = join(fixture.dir, 'artifacts', 'snapshots');
  const older = join(snapshotRoot, 'release-transaction.older.fixture');
  const oldest = join(snapshotRoot, 'release-transaction.oldest.fixture');
  const newestPrior = join(snapshotRoot, 'release-transaction.prior.fixture');
  const current = join(snapshotRoot, 'release-transaction.current.fixture');
  try {
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

test('successful rollback reports complete and records a non-retainable rolled-back state', () => {
  const fixture = makeDeployServiceFixture();
  try {
    const output = runDeployServiceFixture(fixture, [
      'CANDIDATE=0123456789abcdef0123456789abcdef01234567',
      'TRANSACTION_STARTED=1',
      'quiesce_runtime_services() { return 0; }',
      'restore_code_revision() { return 0; }',
      'restore_runtime_files() { return 0; }',
      'restore_state_migrations() { return 0; }',
      'restore_service_state() { return 0; }',
      'record_protected_capability_evidence() { return 0; }',
      'rollback_transaction 0',
    ].join('\n'));
    assert.equal(output, '');
    const state = JSON.parse(readFileSync(join(fixture.snapshot, 'transaction-state.json'), 'utf8'));
    assert.equal(state.status, 'rollback_used');
    assert.equal(state.rollbackable, false);
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
  writeFileSync(join(ombreVenv, 'bin', 'python'), '#!/bin/sh\nexit 0\n');
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
  const loginDefs = join(dir, 'login.defs');
  mkdirSync(join(proc, '123'), { recursive: true });
  writeFileSync(join(proc, '123', 'status'), 'Uid:\t999\t999\t999\t999\nGid:\t999\t999\t999\t999\n');
  writeFileSync(loginDefs, 'SYS_UID_MIN 100\nSYS_UID_MAX 999\nSYS_GID_MIN 100\nSYS_GID_MAX 999\n');
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
  writeFileSync(join(bin, 'ombre-patch-python'), '#!/bin/sh\nexit 0\n');
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
    RAN_AGENT_TEST_LOGIN_DEFS_FILE: loginDefs,
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
      `Environment=RAN_AGENT_STEWARD_TOKEN_FILE=${join(state, 'ombre-compat', 'secrets', 'steward-api-token')}`,
    ]) assert.match(installedOmbreUnit, new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(installedNodeDropin, new RegExp(`Environment=RAN_AGENT_STATE_DIR=${state}`.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  assert.match(source, /RAN_AGENT_PYTHON_BIN="\$PYTHON_BIN"/);
  assert.match(source, /tests\/test_hermes_deepseek_provider\.py[\s\S]*resolve_test_hermes_bin/);
  assert.match(source, /RAN_AGENT_HERMES_TEST_BIN="\$HERMES_TEST_BIN"[\s\S]*-m pytest/);
  assert.match(source, /RAN_AGENT_HERMES_TEST_PYTHON_BIN="\$HERMES_TEST_PYTHON_BIN"[\s\S]*-m pytest/);
  assert.doesNotMatch(source, /HERMES_TEST_PYTHON_BIN="\$project\/venv\/bin\/python"/);
  assert.match(source, /resolve-hermes-gate-runtime\.mjs/);
  assert.match(source, /STAGED_CANDIDATE.*RAN_AGENT_RELEASE_STAGED_CANDIDATE/);
  assert.match(source, /if \[\[ "\$STAGED_CANDIDATE" == 1 \]\]; then\s+PATH=\/usr\/bin:\/bin/);
  assert.ok(source.indexOf('STAGED_CANDIDATE=') < source.indexOf('SOURCE_ROOT_INPUT='));
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

  assert.match(deploy, /CANDIDATE.*\^\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(deploy, /candidate_not_checked_out/);
  assert.match(deploy, /snapshot_node_durable_state/);
  assert.match(deploy, /plugins\/model-providers\/deepseek/);
  assert.match(deploy, /snapshot_path "\$REPO_ROOT\/data" 901/);
  assert.match(deploy, /RAN_AGENT_RELEASE_ARTIFACT_ROOT/);
  assert.match(deploy, /activate_candidate_checkout/);
  assert.ok(deploy.indexOf('snapshot_runtime_state') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('snapshot_state_migrations') < deploy.indexOf('activate_candidate_checkout'));
  assert.ok(deploy.indexOf('hermes-release-gate.sh" --all') < deploy.lastIndexOf('snapshot_runtime_state'));
  assert.ok(deploy.indexOf('snapshot_code_revision') < deploy.lastIndexOf('activate_candidate_checkout'));
  assert.match(deploy, /--rollback/);
  assert.match(deploy, /rollback-complete deployment_status=/);
  assert.match(deploy, /rollback-incomplete deployment_status=/);
  assert.match(deploy, /trap 'rollback_transaction \$\?' EXIT/);
  assert.match(deploy, /for stage in quiesce_runtime_services restore_runtime_files restore_state_migrations restore_steward_token restore_code_revision block_ombre_ingress clear_ombre_ingress_block restore_service_state/);
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
