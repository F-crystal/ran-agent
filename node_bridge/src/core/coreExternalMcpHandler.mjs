import { createHash } from 'node:crypto';

import { createAttentionFlushWorker } from '../attentionFlushWorker.mjs';
import { createCoreExternalPollService } from './coreExternalPoll.mjs';
import { coreError } from './coreErrors.mjs';

const AGGREGATE_POLL_REF = 'external-poll:external-mcp-runtime';

function stableValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1_000);
  }
  if (typeof value !== 'object' || depth > 8) return null;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => stableValue(item, depth + 1, seen));
  return Object.fromEntries(Object.keys(value).sort().slice(0, 50)
    .map((key) => [key, stableValue(value[key], depth + 1, seen)]));
}

function fingerprint(value) {
  return `sha256:v1:${createHash('sha256').update(value).digest('hex')}`;
}

export function createCoreExternalMcpHandler({
  core, runtime, hashContent, attentionValve, notificationService,
} = {}) {
  if (!runtime?.tick || !runtime?.store?.get || typeof hashContent !== 'function'
    || !attentionValve?.evaluate || !attentionValve?.flush || !notificationService?.register) {
    throw coreError('CORE_EXTERNAL_MCP_DEPENDENCY_INVALID', 'external MCP runtime dependencies are invalid');
  }
  const facts = createCoreExternalPollService({ core });
  let activeAuthority = null;
  let recorded = 0;

  async function submitCandidate(candidate, context = {}) {
    if (!activeAuthority) {
      throw coreError('CORE_EXTERNAL_POLL_AUTHORITY_STALE', 'external MCP candidate requires an active Core Work Run');
    }
    const activity = runtime.store.get(context.activityId);
    const serverId = String(activity?.scope?.serverId || '').trim();
    const revision = Number(context.revision);
    if (!serverId || activity?.activityId !== context.activityId || activity?.status !== 'active'
      || !Number.isSafeInteger(revision) || revision < 0
      || revision !== Number(activity.revision)
      || candidate?.kind !== 'core_external_activity_narration_candidate'
      || candidate?.status !== 'ready') {
      throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', 'external MCP candidate context is invalid');
    }
    const checkpointDigest = String(context.checkpointDigest || '');
    if (checkpointDigest !== String(activity.checkpoint?.stateDigest || '')) {
      throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', 'external MCP candidate checkpoint is stale');
    }
    const sanitizedCandidate = stableValue(candidate);
    const canonical = JSON.stringify(stableValue({
      candidate: sanitizedCandidate,
      context: { activityId: activity.activityId, checkpointDigest, revision },
      serverId,
    }));
    const result = await facts.recordFact({
      authority: activeAuthority,
      serverId,
      sourceFingerprint: fingerprint(canonical),
      payloadRef: `external-mcp:/activity/${context.activityId}/revision/${revision}`,
      contentHashToken: hashContent('external-mcp-candidate', canonical),
    });
    if (result.disposition !== 'recorded') return result;
    recorded += 1;
    if (activity.notifyTarget) {
      const payloadRef = `external-mcp-task:${context.activityId}:${revision}`;
      const summary = (Array.isArray(sanitizedCandidate?.facts) ? sanitizedCandidate.facts : [])
        .map((item) => String(item?.summary || '').trim()).filter(Boolean).slice(0, 3).join('\n');
      const admission = attentionValve.evaluate({
        contentClass: 'timely', fingerprint: `external-mcp:${context.activityId}`,
        summary, payloadRef, causationId: result.eventId,
      });
      if (admission.disposition === 'deliver_now') {
        await notificationService.register({ payloadRef, causationId: result.eventId });
      }
    }
    return result;
  }

  async function handler({ work, authority }) {
    if (work?.work_run_id !== authority?.workRunId || work?.task_kind !== 'external_poll'
      || work?.payload_ref !== AGGREGATE_POLL_REF || activeAuthority) {
      throw coreError('CORE_EXTERNAL_POLL_AUTHORITY_STALE', 'external MCP poll Work Run is invalid');
    }
    activeAuthority = await facts.assertAuthority({ authority, expectedPayloadRef: AGGREGATE_POLL_REF });
    recorded = 0;
    try {
      const result = await runtime.tick();
      if (result?.skipped && result.reason === 'tick_failed') {
        throw coreError('CORE_EXTERNAL_MCP_TICK_FAILED', 'external MCP poll failed');
      }
      const resultRef = `core-external-mcp-poll:${work.work_run_id}:${recorded}`;
      return { resultRef, resultHashToken: hashContent('external-mcp-poll-result', resultRef) };
    } finally {
      activeAuthority = null;
      recorded = 0;
    }
  }
  handler.canHandle = (work) => work?.payload_ref === AGGREGATE_POLL_REF;
  const flushWorker = createAttentionFlushWorker({
    valve: attentionValve,
    deliver: async (candidate) => {
      await notificationService.register({
        payloadRef: candidate.payloadRef, causationId: candidate.causationId,
      });
      return { state: 'scheduled' };
    },
  });
  const attentionFlushHandler = async ({ work }) => {
    const result = await flushWorker.run();
    const resultRef = `core-attention-flush:${work.work_run_id}:${result.delivered}`;
    return { resultRef, resultHashToken: hashContent('attention-flush-result', resultRef) };
  };
  attentionFlushHandler.canHandle = (work) => work?.payload_ref === 'system-task:attention-flush';
  return Object.freeze({ handler, submitCandidate, attentionFlushHandler });
}
