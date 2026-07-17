import { coreError } from './coreErrors.mjs';

const TOKEN_PATTERN = /^hmac-sha256:v1:([A-Za-z0-9._-]{1,64}):([0-9a-f]{64})$/;

export function isKeyedContentHashToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function assertKeyedContentHashToken(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!isKeyedContentHashToken(value)) {
    throw coreError('CORE_HASH_TOKEN_INVALID', 'content hash token must use the canonical keyed format');
  }
  return value;
}

export function formatKeyedContentHashToken({ keyId, digest }) {
  const value = `hmac-sha256:v1:${keyId}:${digest}`;
  return assertKeyedContentHashToken(value);
}

export function keyedContentHashSqlCheck(column, { nullable = false } = {}) {
  const value = `(${column})`;
  const suffix = `substr(${value}, 16)`;
  const separator = `instr(${suffix}, ':')`;
  const keyId = `substr(${value}, 16, ${separator} - 1)`;
  const digest = `substr(${value}, 16 + ${separator})`;
  const canonical = [
    `substr(${value}, 1, 15) = 'hmac-sha256:v1:'`,
    `${separator} BETWEEN 2 AND 65`,
    `${keyId} NOT GLOB '*[^A-Za-z0-9._-]*'`,
    `length(${digest}) = 64`,
    `${digest} NOT GLOB '*[^0-9a-f]*'`,
  ].join(' AND ');
  return nullable ? `(${column} IS NULL OR (${canonical}))` : `(${canonical})`;
}
