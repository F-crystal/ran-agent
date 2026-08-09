import fs from 'node:fs';
import path from 'node:path';

import { coreError } from './coreErrors.mjs';

export function loadCoreManagedWakeManifest(manifestPath, { repoRoot } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const job = manifest?.job;
  const valid = manifest?.schemaVersion === 1 && manifest?.status === 'CURRENT'
    && manifest.runtime?.provider === 'hermes-cron'
    && manifest.runtime?.home === '/home/ubuntu/.hermes-ran-agent/lite'
    && Number.isSafeInteger(manifest.runtime?.scriptTimeoutSeconds)
    && manifest.runtime.scriptTimeoutSeconds > 0 && manifest.runtime.scriptTimeoutSeconds <= 60
    && job?.name === 'ran-agent-core-wake' && job.schedule === 'every 1m'
    && job.script === 'core-wake.sh'
    && job.scriptTarget === `${manifest.runtime.home}/scripts/${job.script}`
    && job.workdir === '/opt/ran_agent' && job.no_agent === true
    && job.deliver === 'local' && job.enabled === false && job.state === 'paused'
    && job.pauseReason === 'awaiting-owner-s12-production-authorization';
  if (!valid) {
    throw coreError('CORE_WAKE_MANIFEST_INVALID', 'managed Core wake manifest is invalid or not fail-closed');
  }
  if (repoRoot) {
    const source = path.resolve(repoRoot, job.scriptSource || '');
    const root = `${path.resolve(repoRoot)}${path.sep}`;
    if (!source.startsWith(root) || !fs.statSync(source).isFile()) {
      throw coreError('CORE_WAKE_SCRIPT_SOURCE_INVALID', 'managed Core wake script source is unavailable');
    }
  }
  return Object.freeze(manifest);
}
