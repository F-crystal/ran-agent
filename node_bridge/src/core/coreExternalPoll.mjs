import { coreError } from './coreErrors.mjs';

export function createCoreExternalPollService({ core } = {}) {
  if (!core?.writer?.write) {
    throw coreError('CORE_EXTERNAL_POLL_DEPENDENCY_INVALID', 'Core writer is required');
  }
  return Object.freeze({
    assertAuthority: (input) => core.writer.write((tx) => tx.externalPoll.assertAuthority(input)),
    recordFact: (input) => core.writer.write((tx) => tx.externalPoll.recordFact(input)),
  });
}
