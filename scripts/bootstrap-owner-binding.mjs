#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootstrapOwnerBinding, validateOwnerBindingPreflight } from '../node_bridge/src/identityMap.mjs';

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--identity-file' || !argv[1]?.trim()) {
    throw codedError('OWNER_BOOTSTRAP_IDENTITY_FILE_REQUIRED');
  }
  return { identityFile: resolve(argv[1]) };
}

function readTrustedIdentity(identityFile) {
  let stat;
  try {
    stat = lstatSync(identityFile);
  } catch {
    throw codedError('OWNER_BOOTSTRAP_IDENTITY_FILE_UNREADABLE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw codedError('OWNER_BOOTSTRAP_IDENTITY_FILE_PROTECTION_REQUIRED');
  }
  try {
    const value = JSON.parse(readFileSync(identityFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    const platform = String(value.platform || '').trim().toLowerCase();
    if (!['wechat', 'feishu', 'desktop'].includes(platform)) {
      throw new Error('invalid platform');
    }
    return {
      platform,
      senderId: String(value.senderId || value.sender_id || '').trim(),
      globalUserId: String(value.globalUserId || value.global_user_id || '').trim(),
      provenance: String(value.provenance || '').trim(),
    };
  } catch {
    throw codedError('OWNER_BOOTSTRAP_TRUSTED_IDENTITY_INVALID');
  }
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function printHelp() {
  process.stdout.write('usage: bootstrap-owner-binding.mjs --identity-file <protected-json-file>\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (validateOwnerBindingPreflight().ok) {
    throw codedError('OWNER_BOOTSTRAP_ALREADY_PRESENT');
  }
  const result = bootstrapOwnerBinding({ trustedIdentity: readTrustedIdentity(args.identityFile) });
  process.stdout.write(`owner-bootstrap: ok bindings=${result.ownerBindingCount}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`owner-bootstrap: failed:${error?.code || 'OWNER_BOOTSTRAP_FAILED'}\n`);
  process.exitCode = 1;
}
