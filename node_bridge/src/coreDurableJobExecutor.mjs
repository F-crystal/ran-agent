import { createHash } from 'node:crypto';

import { createDurableJob } from './durableJobClient.mjs';

// The model selects only one of these already-registered maintenance jobs. It
// never supplies a job identity, a payload reference, a wake time, or an actor.
const CORE_JOB_KINDS = new Set([
  'core.memory-maintenance',
  'core.reflection',
  'core.night-cycle',
]);

export function createCoreDurableJobExecutor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const createJob = typeof options.createJob === 'function' ? options.createJob : createDurableJob;
  const clientOptions = options.clientOptions || { env: options.env || process.env, fetchImpl: options.fetchImpl };

  async function execute({ request, actorContext, currentMessage } = {}) {
    const actionType = String(request?.actionType || '');
    if (!CORE_JOB_KINDS.has(actionType)) return noReceipt('CORE_JOB_UNSUPPORTED');
    if (actorContext?.owner !== true || !trustedActor(actorContext)) return noReceipt('ACTOR_NOT_AUTHORIZED');

    const input = bridgeOwnedInput({ actionType, actorContext, currentMessage, now });
    let receipt;
    try {
      receipt = await createJob(input, clientOptions);
    } catch {
      return noReceipt('CORE_JOB_CREATE_FAILED');
    }
    if (!isMatchingActiveReceipt(receipt, input)) return noReceipt('CORE_JOB_RECEIPT_INVALID');
    return Object.freeze({
      ok: true,
      receipt: Object.freeze({
        requestRef: String(request.requestRef || ''),
        actionType,
        jobId: receipt.jobId,
        actorKey: receipt.actorKey,
        goalDigest: receipt.goalDigest,
        status: receipt.status,
        nextRunAt: receipt.nextRunAt,
      }),
    });
  }

  return Object.freeze({
    supports: (actionType) => CORE_JOB_KINDS.has(String(actionType || '')),
    execute,
  });
}

function bridgeOwnedInput({ actionType, actorContext, currentMessage, now }) {
  const trustedTurn = String(currentMessage?.text || '').trim();
  const goalDigest = digest([
    actorContext.actorKey,
    actorContext.platform,
    actorContext.conversationKey,
    actionType,
    trustedTurn,
  ].join('\u0000'));
  return Object.freeze({
    actorKey: actorContext.actorKey,
    goalDigest,
    jobKind: actionType,
    payloadRef: `payload:core:${digest(`${actorContext.actorKey}\u0000${actionType}\u0000${trustedTurn}`)}`,
    nextRunAt: validNow(now).toISOString(),
  });
}

function isMatchingActiveReceipt(receipt, input) {
  return receipt
    && typeof receipt === 'object'
    && String(receipt.actorKey || '') === input.actorKey
    && String(receipt.goalDigest || '') === input.goalDigest
    && String(receipt.status || '') === 'active'
    && String(receipt.nextRunAt || '') === input.nextRunAt
    && /^[A-Za-z0-9_.:-]{8,160}$/.test(String(receipt.jobId || ''));
}

function trustedActor(value) {
  return ['actorKey', 'platform', 'conversationKey'].every((field) => (
    typeof value[field] === 'string' && value[field].trim().length > 0
  ));
}

function validNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid bridge clock');
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function noReceipt(reason) {
  return Object.freeze({ ok: false, reason, receipt: null });
}
