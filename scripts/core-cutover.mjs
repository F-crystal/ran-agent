#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { executeCoreCutover } from '../node_bridge/src/core/coreCutoverCommand.mjs';

function argumentsByName(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('arguments must be --name value pairs');
    values[name.slice(2)] = value;
  }
  return values;
}

const args = argumentsByName(process.argv.slice(2));
for (const required of ['core-db', 'snapshot', 'system-manifest', 'visible-binding', 'candidate-sha', 'committed-at']) {
  if (!args[required]) throw new Error(`--${required} is required`);
}
const mode = args.mode || 'verify';
if (!['verify', 'apply'].includes(mode)) throw new Error('--mode must be verify or apply');
if (mode === 'apply' && (!args['owner-id'] || !args['authorization-ref'])) {
  throw new Error('--mode apply requires --owner-id and --authorization-ref');
}
if (mode === 'apply') {
  if (!args['s12-transaction'] && !args['s12-transaction-fd']) {
    throw new Error('--mode apply requires --s12-transaction or --s12-transaction-fd');
  }
  let journal;
  let value;
  let expectedUid;
  if (args['s12-transaction-fd']) {
    const descriptor = Number(args['s12-transaction-fd']);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) throw new Error('S12 transaction journal FD is invalid');
    value = fs.fstatSync(descriptor);
    journal = descriptor;
    expectedUid = 0;
  } else {
    const artifactRoot = path.resolve(process.env.RAN_AGENT_RELEASE_ARTIFACT_ROOT || '/opt/ran_agent-release');
    const transactionRoot = path.join(artifactRoot, 's12-transactions');
    const journalPath = path.resolve(args['s12-transaction']);
    const parent = fs.realpathSync(path.dirname(journalPath));
    if (parent !== transactionRoot && !parent.startsWith(`${transactionRoot}${path.sep}`)) {
      throw new Error('S12 transaction journal is outside release authority');
    }
    value = fs.lstatSync(journalPath);
    if (value.isSymbolicLink()) throw new Error('S12 transaction journal identity/mode/link count is invalid');
    journal = journalPath;
    expectedUid = process.geteuid();
  }
  if (!value.isFile() || value.mode % 0o1000 !== 0o600 || value.nlink !== 1 || value.uid !== expectedUid) {
    throw new Error('S12 transaction journal identity/mode/link count is invalid');
  }
  const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));
  const completed = transaction.completedPhases;
  if (transaction.schemaVersion !== 1 || transaction.status !== 'IN_PROGRESS'
    || transaction.phase !== 'P4_QUIESCED' || !Array.isArray(completed)
    || completed.join('\0') !== [
      'P0_VERIFIED', 'P1_SOURCE_APPLIED', 'P2_CORE_PREPARED', 'P3_LEGACY_RECONCILED', 'P4_QUIESCED',
    ].join('\0')
    || transaction.cutoverCommitted !== false || transaction.candidateSha !== args['candidate-sha']
    || transaction.ownerId !== args['owner-id'] || transaction.authorizationRef !== args['authorization-ref']
    || path.resolve(transaction.coreDb) !== path.resolve(args['core-db'])) {
    throw new Error('S12 transaction journal does not authorize Core cutover');
  }
}
const result = await executeCoreCutover({
  mode,
  coreDbPath: path.resolve(args['core-db']),
  snapshotPath: path.resolve(args.snapshot),
  systemManifestPath: path.resolve(args['system-manifest']),
  visibleBindingPath: path.resolve(args['visible-binding']),
  candidateSha: args['candidate-sha'],
  committedAt: args['committed-at'],
  ownerId: args['owner-id'],
  authorizationRef: args['authorization-ref'],
});
process.stdout.write(`${JSON.stringify(result)}\n`);
