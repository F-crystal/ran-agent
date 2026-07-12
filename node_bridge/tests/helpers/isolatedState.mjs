import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createIsolatedTestEnv(t, overrides = {}, prefix = 'ran-agent-test-', stateDirectory = 'state') {
  if (!t || typeof t !== 'object') {
    throw new TypeError('createIsolatedTestEnv requires a node:test context');
  }
  const tempRoot = fs.realpathSync(os.tmpdir());
  const testRoot = fs.mkdtempSync(path.join(tempRoot, prefix));
  const stateDir = path.join(testRoot, stateDirectory);
  fs.mkdirSync(stateDir);
  registerTestCleanup(t, () => fs.rmSync(testRoot, { recursive: true, force: true }));
  return {
    ...overrides,
    NODE_ENV: 'test',
    RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
    HERMES_SEMANTIC_VERIFIER_TEST_BYPASS: 'true',
    RAN_AGENT_STATE_DIR: stateDir,
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(stateDir, 'global-timeline.jsonl'),
    RAN_AGENT_TIMELINE_ARCHIVE_DIR: path.join(stateDir, 'timeline_archive'),
  };
}

// Node 22.13+ has no TestContext.after. The process-exit fallback keeps the
// release gate compatible with the production Node floor while its isolated
// test worker still owns every temporary path.
export function registerTestCleanup(t, cleanup) {
  if (typeof t?.after === 'function') return t.after(cleanup);
  process.once('exit', cleanup);
}
