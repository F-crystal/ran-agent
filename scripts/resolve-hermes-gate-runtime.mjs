#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(reason) {
  process.stderr.write(`resolve-hermes-gate-runtime: failed:${reason}\n`);
  process.exit(1);
}

const [systemctlBin, runtimeUser, runtimeGroup, procRoot = '/proc'] = process.argv.slice(2);
if (!systemctlBin || !path.isAbsolute(systemctlBin)) fail('systemctl_required');
if (!runtimeUser || !runtimeGroup || /[\r\n]/.test(`${runtimeUser}${runtimeGroup}`)) fail('runtime_identity_required');
if (!path.isAbsolute(procRoot)) fail('proc_root_required');
try {
  fs.accessSync(systemctlBin, fs.constants.X_OK);
} catch {
  fail('systemctl_unavailable');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = path.join(repoRoot, 'scripts', 'resolve-hermes-service-runtime.sh');
const mutationPath = path.join(repoRoot, 'docs', 'governance', 'hermes_runtime_mutation.v1.json');
const artifactPath = path.join(repoRoot, 'docs', 'governance', 'hermes_runtime_artifact.v1.json');

function run(command, args, reason) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', RAN_AGENT_SYSTEMCTL_BIN: systemctlBin },
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) fail(reason);
  return result.stdout.trim();
}

function readContract(file, reason) {
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(reason);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(reason);
  }
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

const mutation = readContract(mutationPath, 'runtime_mutation_contract_invalid');
const artifact = readContract(artifactPath, 'runtime_artifact_contract_invalid');
const installRoot = mutation?.artifactManifest?.installRoot;
const expectedHermes = mutation?.artifactManifest?.executable;
const pythonVersion = artifact?.python?.version;
const expectedPythonDigest = artifact?.python?.executableSha256;
const gateways = mutation?.topology?.after?.gateways;
const retiredFull = mutation?.unitMutations?.find((item) => item?.unit === 'ran-agent-hermes-full.service');
if (mutation?.schemaVersion !== 1
    || mutation?.deploymentStatus !== 'DEPLOYED'
    || mutation?.artifactManifest?.path !== 'docs/governance/hermes_runtime_artifact.v1.json'
    || artifact?.schemaVersion !== 1
    || artifact?.source?.version !== '0.20.0'
    || artifact?.dependencies?.installed?.['hermes-agent'] !== '0.20.0'
    || mutation?.artifactManifest?.tarGzSha256 !== artifact?.artifact?.tarGzSha256
    || mutation?.artifactManifest?.treeSha256 !== artifact?.artifact?.treeSha256
    || !/^3\.12\.[0-9]+$/.test(pythonVersion || '')
    || !/^[0-9a-f]{64}$/.test(expectedPythonDigest || '')
    || !path.isAbsolute(installRoot || '')
    || expectedHermes !== path.join(installRoot, 'bin', 'hermes')
    || !Array.isArray(gateways)
    || gateways.length !== 1
    || gateways[0]?.unit !== 'ran-agent-hermes.service'
    || gateways[0]?.port !== 8642
    || retiredFull?.after !== 'inactive-disabled-and-condition-blocked') {
  fail('unified_runtime_contract_invalid');
}

if (run(systemctlBin, ['show', 'ran-agent-hermes.service', '--property=ActiveState', '--value'], 'unified_service_state_unavailable') !== 'active') {
  fail('unified_service_inactive');
}
if (run(systemctlBin, ['show', 'ran-agent-hermes-full.service', '--property=ActiveState', '--value'], 'retired_full_active_state_unavailable') !== 'inactive'
    || run(systemctlBin, ['show', 'ran-agent-hermes-full.service', '--property=UnitFileState', '--value'], 'retired_full_unit_state_unavailable') !== 'disabled') {
  fail('retired_full_service_runnable');
}
if (run(systemctlBin, ['show', 'ran-agent-hermes.service', '--property=User', '--value'], 'runtime_user_unavailable') !== runtimeUser
    || run(systemctlBin, ['show', 'ran-agent-hermes.service', '--property=Group', '--value'], 'runtime_group_unavailable') !== runtimeGroup) {
  fail('runtime_identity_mismatch');
}

const serviceHermes = run('/bin/bash', [resolver, 'ran-agent-hermes.service'], 'unified_runtime_required');
let hermesReal;
let expectedHermesReal;
let runtimePython;
let runtimePythonReal;
try {
  hermesReal = fs.realpathSync(serviceHermes);
  expectedHermesReal = fs.realpathSync(expectedHermes);
  runtimePython = path.join(installRoot, 'python', 'bin', `python${pythonVersion.split('.').slice(0, 2).join('.')}`);
  runtimePythonReal = fs.realpathSync(runtimePython);
} catch {
  fail('runtime_unavailable');
}
if (hermesReal !== expectedHermesReal) fail('service_runtime_contract_mismatch');
if (run(hermesReal, ['version'], 'version_probe_failed') !== 'Hermes Agent v0.20.0') {
  fail('Hermes_v0.20.0_required');
}
try {
  fs.accessSync(runtimePythonReal, fs.constants.X_OK);
} catch {
  fail('runtime_python_required');
}
if (sha256(runtimePythonReal) !== expectedPythonDigest) fail('runtime_python_identity_mismatch');
run(runtimePythonReal, ['-I', '-c', 'import gateway, hermes_cli, httpx, openai'], 'runtime_python_invalid');

const mainPid = run(systemctlBin, ['show', 'ran-agent-hermes.service', '--property=MainPID', '--value'], 'runtime_main_pid_unavailable');
if (!/^[0-9]+$/.test(mainPid) || Number(mainPid) <= 1) fail('runtime_main_pid_invalid');
let processPython;
try {
  processPython = fs.realpathSync(path.join(procRoot, mainPid, 'exe'));
} catch {
  fail('runtime_process_unavailable');
}
if (processPython !== runtimePythonReal) fail('runtime_process_contract_mismatch');

process.stdout.write(`${hermesReal}\t${runtimePythonReal}\n`);
