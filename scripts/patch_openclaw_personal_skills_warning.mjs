#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const targetFile = path.join(rootDir, 'node_modules', 'openclaw', 'dist', 'skills-CDh2H_rr.js');
const patchMarker = 'Skipping personal agent skill path that resolves outside root.';

if (!fs.existsSync(targetFile)) {
  console.log(`[patch-openclaw-skills-warning] skip: target not found ${targetFile}`);
  process.exit(0);
}

let source;
try {
  source = fs.readFileSync(targetFile, 'utf8');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[patch-openclaw-skills-warning] read failed: ${message}`);
  process.exit(1);
}

if (source.includes(patchMarker)) {
  console.log('[patch-openclaw-skills-warning] already patched');
  process.exit(0);
}

const before = [
  'function warnEscapedSkillPath(params) {',
  '\tskillsLogger$1.warn("Skipping skill path that resolves outside its configured root.", {',
  '\t\tsource: params.source,',
  '\t\trootDir: params.rootDir,',
  '\t\tpath: params.candidatePath,',
  '\t\trealPath: params.candidateRealPath',
  '\t});',
  '}'
].join('\n');

const after = [
  'function warnEscapedSkillPath(params) {',
  '\tif (params.source === "agents-skills-personal") {',
  '\t\tskillsLogger$1.debug("Skipping personal agent skill path that resolves outside root.", {',
  '\t\t\tsource: params.source,',
  '\t\t\trootDir: params.rootDir,',
  '\t\t\tpath: params.candidatePath,',
  '\t\t\trealPath: params.candidateRealPath',
  '\t\t});',
  '\t\treturn;',
  '\t}',
  '\tskillsLogger$1.warn("Skipping skill path that resolves outside its configured root.", {',
  '\t\tsource: params.source,',
  '\t\trootDir: params.rootDir,',
  '\t\tpath: params.candidatePath,',
  '\t\trealPath: params.candidateRealPath',
  '\t});',
  '}'
].join('\n');

if (!source.includes(before)) {
  console.error('[patch-openclaw-skills-warning] expected snippet not found; OpenClaw version may have changed');
  process.exit(1);
}

const patched = source.replace(before, after);
try {
  fs.writeFileSync(targetFile, patched, 'utf8');
  console.log('[patch-openclaw-skills-warning] patch applied');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[patch-openclaw-skills-warning] write failed: ${message}`);
  process.exit(1);
}
