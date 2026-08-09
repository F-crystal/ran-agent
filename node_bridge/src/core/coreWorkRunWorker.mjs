import { coreError } from './coreErrors.mjs';
import { createCoreSchedulingService } from './coreScheduling.mjs';

function opaque(value) {
  return String(value || '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120) || 'unknown';
}

export function createCoreWorkRunWorker({
  core,
  handlers = {},
  hashContent,
  workerId = 'core-work-run-worker',
  batchSize = 16,
  leaseSeconds = 120,
  now = () => new Date(),
} = {}) {
  if (!core?.reader?.scheduledWorkQueue || !core?.reader?.expiredScheduledWorkRuns
    || typeof hashContent !== 'function'
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128
    || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw coreError('CORE_WORKER_DEPENDENCY_INVALID', 'Core Work Run worker dependencies are invalid');
  }
  const scheduling = createCoreSchedulingService({ core, batchSize });
  return Object.freeze({
    async runOnce() {
      const results = [];
      const at = now().toISOString();
      for (const work of core.reader.expiredScheduledWorkRuns(at, batchSize)) {
        await scheduling.recoverExpiredWorkRun({
          workRunId: work.work_run_id,
          expectedRevision: Number(work.revision),
          expectedFence: Number(work.fence_token),
          operationKey: `core-worker:recover:${work.work_run_id}:${work.revision}:${work.fence_token}`,
        });
      }
      for (const work of core.reader.scheduledWorkQueue(batchSize)) {
        const handler = handlers[work.task_kind];
        if (typeof handler !== 'function' || handler.canHandle?.(work) === false) continue;
        const claim = await scheduling.claimWorkRun({
          workRunId: work.work_run_id,
          expectedRevision: Number(work.revision),
          expectedFence: Number(work.fence_token),
          leaseOwner: workerId,
          leaseUntil: new Date(now().getTime() + leaseSeconds * 1_000).toISOString(),
          operationKey: `core-worker:claim:${work.work_run_id}:${work.revision}:${work.fence_token}`,
        });
        if (!claim) continue;
        const authority = Object.freeze({
          workRunId: claim.workRunId,
          expectedRevision: claim.revision,
          fenceToken: claim.fenceToken,
          leaseOwner: workerId,
          leaseId: claim.lease.lease_id,
        });
        let result;
        try {
          result = await handler(Object.freeze({ work, authority }));
          if (!result || typeof result.resultRef !== 'string' || !result.resultRef.trim()) {
            throw Object.assign(new Error('Work Run handler returned no result evidence'), { code: 'result_evidence_missing' });
          }
          result = { resultState: 'completed', ...result };
        } catch (error) {
          const failureClass = opaque(error?.code || error?.name || 'handler_failed');
          const resultRef = `core-worker-error:${failureClass}`;
          result = { resultState: 'failed', resultRef, failureClass,
            resultHashToken: hashContent('work-run-error', resultRef) };
        }
        if (!result.resultHashToken) {
          result.resultHashToken = hashContent('work-run-result', result.resultRef);
        }
        const terminal = await scheduling.completeWorkRun({
          operationKey: `core-worker:terminal:${work.work_run_id}:${claim.revision}:${claim.fenceToken}`,
          authority,
          resultState: result.resultState,
          resultRef: result.resultRef,
          resultHashToken: result.resultHashToken,
          failureClass: result.failureClass ?? null,
        });
        results.push(Object.freeze({ workRunId: work.work_run_id, state: terminal.workRun.state }));
      }
      return Object.freeze(results);
    },
  });
}
