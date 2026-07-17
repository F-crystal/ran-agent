import assert from 'node:assert/strict';
import test from 'node:test';

const MINIMUM_NODE = [22, 13, 0];

function versionTuple(version) {
  return String(version).replace(/^v/, '').split('.').map(Number);
}

test('Package A test subprocess uses the required Node runtime capabilities', () => {
  console.log(JSON.stringify({
    execPath: process.execPath,
    version: process.version,
    structuredClone: typeof structuredClone,
    fetch: typeof fetch,
  }));

  const actual = versionTuple(process.version);
  const comparison = actual[0] - MINIMUM_NODE[0]
    || actual[1] - MINIMUM_NODE[1]
    || actual[2] - MINIMUM_NODE[2];
  assert.ok(comparison >= 0, `Node ${process.version} does not meet >=22.13.0`);
  assert.equal(typeof structuredClone, 'function');
  assert.equal(typeof fetch, 'function');
});
