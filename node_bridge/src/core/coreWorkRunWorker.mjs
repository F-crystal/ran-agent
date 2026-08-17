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
    || !core?.reader?.workRun || !core?.reader?.journalEvent
    || !core?.reader?.terminalWorkRunsPendingPostTerminal
    || typeof hashContent !== 'function'
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128
    || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw coreError('CORE_WORKER_DEPENDENCY_INVALID', 'Core Work Run worker dependencies are invalid');
  }
  const scheduling = createCoreSchedulingService({ core, batchSize });
  const completePostTerminal = async (handler, work, outcome = null) => {
    if (typeof handler?.afterTerminal !== 'function') return;
    const eventId = `core-worker:post-terminal:${work.work_run_id}`;
    if (core.reader.journalEvent(eventId)) return;
    const terminal = core.reader.workRun(work.work_run_id);
    if (terminal?.state !== 'completed') {
      throw coreError('CORE_WORKER_POST_TERMINAL_EARLY', 'post-terminal work requires a durably completed Work Run');
    }
    const completed = await handler.afterTerminal(Object.freeze({ work, terminal, outcome }));
    if (completed === false) return;
    await core.writer.write((tx) => tx.journal.event(eventId) || tx.journal.append({
      eventId,
      eventType: 'core_work_run_post_terminal_completed',
      actorRef: workerId,
      originRef: `core-worker:post-terminal:${work.task_kind}`,
      sourceKind: 'core-work-run-post-terminal',
      sourceRef: work.payload_ref,
      revision: Number(terminal.revision),
      causationId: work.causation_id,
      correlationId: work.work_run_id,
      createdAt: now().toISOString(),
    }));
  };
  return Object.freeze({
    async runOnce() {
      const results = [];
      const at = now().toISOString();
      for (const [taskKind, handler] of Object.entries(handlers)) {
        if (typeof handler?.afterTerminal !== 'function') continue;
        for (const work of core.reader.terminalWorkRunsPendingPostTerminal(taskKind, batchSize)) {
          await completePostTerminal(handler, work);
        }
      }
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
        if (terminal.workRun.state === 'completed') {
          await completePostTerminal(handler, work, result.deliveryOutcome ?? null);
        }
        results.push(Object.freeze({ workRunId: work.work_run_id, state: terminal.workRun.state }));
      }
      return Object.freeze(results);
    },
  });
}
