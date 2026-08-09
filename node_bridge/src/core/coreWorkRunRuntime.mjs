export function createCoreWorkRunRuntime({ worker, intervalMs = 5_000, logger = console } = {}) {
  if (!worker?.runOnce || !Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    throw Object.assign(new Error('Core Work Run runtime is invalid'), { code: 'CORE_WORK_RUNTIME_INVALID' });
  }
  let timer = null;
  let running = null;
  const poll = () => {
    if (running) return running;
    running = worker.runOnce()
      .catch((error) => logger.error?.(`[core-work-run] ${error?.code || 'failed'}`))
      .finally(() => { running = null; });
    return running;
  };
  return Object.freeze({
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  });
}
