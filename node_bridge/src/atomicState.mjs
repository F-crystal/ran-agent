import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export function readJsonState(target, options = {}) {
  const fsImpl = options.fsImpl || fs;
  let text;
  try {
    text = fsImpl.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return options.missingValue;
    throw error;
  }

  try {
    const value = JSON.parse(text);
    assertValid(value, options.validate);
    return value;
  } catch (cause) {
    try {
      quarantineCorruptState(target, cause instanceof SyntaxError ? 'json' : 'schema', { fsImpl });
    } catch (quarantineError) {
      throw stateError('RAN_AGENT_STATE_CORRUPT', 'critical state is invalid and could not be quarantined', quarantineError);
    }
    if (options.critical === false) return options.missingValue;
    throw stateError('RAN_AGENT_STATE_CORRUPT', 'critical state is invalid and was quarantined', cause);
  }
}

export function writeJsonAtomic(target, value, options = {}) {
  assertValid(value, options.validate);
  return writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function writeFileAtomic(target, content, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const mode = Number.isInteger(options.mode) ? options.mode : DEFAULT_MODE;
  const directory = path.dirname(target);
  fsImpl.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, 'wx', mode);
    fsImpl.writeFileSync(descriptor, content);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.chmodSync(temporary, mode);
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(directory, fsImpl);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    try { fsImpl.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return target;
}

export function appendJsonLine(target, value, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const mode = Number.isInteger(options.mode) ? options.mode : DEFAULT_MODE;
  assertValid(value, options.validate);
  const directory = path.dirname(target);
  fsImpl.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  let descriptor;
  try {
    descriptor = fsImpl.openSync(target, 'a', mode);
    const line = `${JSON.stringify(value)}\n`;
    fsImpl.writeSync(descriptor, line, null, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.chmodSync(target, mode);
    fsyncDirectory(directory, fsImpl);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    throw error;
  }
  return target;
}

export function quarantineCorruptState(target, reason = 'invalid', options = {}) {
  const fsImpl = options.fsImpl || fs;
  const safeReason = String(reason || 'invalid')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'invalid';
  const suffix = `${safeReason}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const quarantined = path.join(path.dirname(target), `${path.basename(target)}.corrupt-${suffix}`);
  fsImpl.renameSync(target, quarantined);
  fsyncDirectory(path.dirname(target), fsImpl);
  return quarantined;
}

function assertValid(value, validate) {
  if (typeof validate !== 'function') return;
  let valid = false;
  try {
    valid = validate(value) === true;
  } catch (cause) {
    throw stateError('RAN_AGENT_STATE_INVALID', 'state schema validation failed', cause);
  }
  if (!valid) throw stateError('RAN_AGENT_STATE_INVALID', 'state schema validation failed');
}

function fsyncDirectory(directory, fsImpl) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(directory, 'r');
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
  }
}

function stateError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
