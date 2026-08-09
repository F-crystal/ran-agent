export function createAttentionFlushWorker({ valve, deliver } = {}) {
  if (!valve?.flush || !valve?.confirmFlushed || typeof deliver !== 'function') {
    throw Object.assign(new Error('attention flush requires one valve and idempotent delivery adapter'), {
      code: 'ATTENTION_FLUSH_DEPENDENCY_INVALID',
    });
  }
  return Object.freeze({
    async run() {
      const candidates = valve.flush();
      let delivered = 0;
      for (const candidate of candidates) {
        const result = await deliver(candidate, { idempotencyKey: candidate.fingerprint });
        if (!['scheduled', 'sent', 'ambiguous'].includes(result?.state)) break;
        valve.confirmFlushed(candidate.fingerprint);
        delivered += 1;
      }
      return Object.freeze({ candidates: candidates.length, delivered });
    },
  });
}
