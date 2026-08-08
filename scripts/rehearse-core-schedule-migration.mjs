#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { rehearseCoreScheduleMigration } from '../node_bridge/src/core/coreScheduleMigration.mjs';

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
for (const required of ['manifest', 'legacy-db', 'state-dir', 'core-db', 'watermark', 'output']) {
  if (!args[required]) throw new Error(`--${required} is required`);
}

const outputPath = path.resolve(args.output);
if (fs.existsSync(outputPath)) throw new Error('output must not already exist');
const result = await rehearseCoreScheduleMigration({
  manifestPath: path.resolve(args.manifest),
  legacyDbPath: path.resolve(args['legacy-db']),
  stateDir: path.resolve(args['state-dir']),
  coreDbPath: path.resolve(args['core-db']),
  watermark: args.watermark,
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  status: result.status,
  componentCount: result.componentCount,
  cutoverBlockers: result.cutoverBlockers,
  output: outputPath,
})}\n`);
