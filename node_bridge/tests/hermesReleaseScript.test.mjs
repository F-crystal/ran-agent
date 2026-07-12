import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
