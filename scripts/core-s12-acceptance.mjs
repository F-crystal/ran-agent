#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { openCoreDatabase } from '../node_bridge/src/core/coreDb.mjs';
import { inspectS12Acceptance, registerS12Acceptance } from '../node_bridge/src/core/coreS12Acceptance.mjs';

function argumentsByName(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('arguments must be --name value pairs');
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

const args = argumentsByName(process.argv.slice(2));
for (const required of ['mode', 'core-db', 'transaction-id', 'candidate-sha', 'owner-id', 'authorization-ref']) {
  if (!args[required]) throw new Error(`--${required} is required`);
}
if (!['register', 'inspect'].includes(args.mode)) throw new Error('--mode must be register or inspect');
if (args.mode === 'register' && (!args['conversation-id'] || !args['binding-id'] || !args['scheduled-at'])) {
  throw new Error('--mode register requires --conversation-id, --binding-id and --scheduled-at');
}
if (!args['s12-transaction'] && !args['s12-transaction-fd']) {
  throw new Error('--s12-transaction or --s12-transaction-fd is required');
}
let journal;
let journalValue;
let expectedUid;
if (args['s12-transaction-fd']) {
  const descriptor = Number(args['s12-transaction-fd']);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) throw new Error('S12 transaction journal FD is invalid');
  journalValue = fs.fstatSync(descriptor);
  journal = descriptor;
  expectedUid = 0;
} else {
  const artifactRoot = path.resolve(process.env.RAN_AGENT_RELEASE_ARTIFACT_ROOT || '/opt/ran_agent-release');
  const transactionRoot = path.join(artifactRoot, 's12-transactions');
  const journalPath = path.resolve(args['s12-transaction']);
  const journalParent = fs.realpathSync(path.dirname(journalPath));
  if (journalParent !== transactionRoot && !journalParent.startsWith(`${transactionRoot}${path.sep}`)) {
    throw new Error('S12 transaction journal is outside release authority');
  }
  journalValue = fs.lstatSync(journalPath);
  if (journalValue.isSymbolicLink()) throw new Error('S12 transaction journal identity/mode/link count is invalid');
  journal = journalPath;
  expectedUid = process.geteuid();
}
if (!journalValue.isFile() || journalValue.mode % 0o1000 !== 0o600
  || journalValue.nlink !== 1 || journalValue.uid !== expectedUid) {
  throw new Error('S12 transaction journal identity/mode/link count is invalid');
}
const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));
const phases = ['P0_VERIFIED', 'P1_SOURCE_APPLIED', 'P2_CORE_PREPARED', 'P3_LEGACY_RECONCILED',
  'P4_QUIESCED', 'P5_CORE_AUTHORITY_COMMITTED', 'P6_CORE_WORKER_ACTIVE', 'P7_CORE_WAKE_ACTIVE',
  'P8_ACCEPTANCE_EFFECT_COMMITTED', 'P9_ACCEPTANCE_RECEIPT_TERMINAL', 'P10_ACCEPTED'];
const phaseIndex = ['P7_CORE_WAKE_ACTIVE', 'P8_ACCEPTANCE_EFFECT_COMMITTED',
  'P9_ACCEPTANCE_RECEIPT_TERMINAL', 'P10_ACCEPTED'].indexOf(transaction.phase);
if (transaction.schemaVersion !== 1 || phaseIndex < 0
  || (args.mode === 'register' && transaction.phase !== 'P7_CORE_WAKE_ACTIVE')
  || !Array.isArray(transaction.completedPhases)
  || transaction.completedPhases.join('\0') !== phases.slice(0, phases.indexOf(transaction.phase) + 1).join('\0')
  || transaction.cutoverCommitted !== true
  || !['IN_PROGRESS', 'FORWARD_RECOVERY', 'FORWARD_RECOVERY_REQUIRED', 'ACCEPTED'].includes(transaction.status)
  || transaction.transactionId !== args['transaction-id'] || transaction.candidateSha !== args['candidate-sha']
  || transaction.ownerId !== args['owner-id'] || transaction.authorizationRef !== args['authorization-ref']
  || path.resolve(transaction.coreDb) !== path.resolve(args['core-db'])) {
  throw new Error('S12 transaction journal does not authorize acceptance');
}
const core = openCoreDatabase({ dbPath: path.resolve(args['core-db']),
  now: args['scheduled-at'] ? () => new Date(args['scheduled-at']) : undefined });
try {
  const authority = {
    transactionId: args['transaction-id'], candidateSha: args['candidate-sha'],
    ownerId: args['owner-id'], authorizationRef: args['authorization-ref'],
  };
  const result = args.mode === 'register'
    ? await registerS12Acceptance({ core, input: { ...authority,
      conversationId: args['conversation-id'], bindingId: args['binding-id'], scheduledAt: args['scheduled-at'] } })
    : inspectS12Acceptance({ core, ...authority });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await core.close();
}
