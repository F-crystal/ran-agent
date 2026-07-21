import { createActionReceiptAuthority } from './actionReceipt.mjs';

export function createTrustedExecutorAdapters({ ledger, adapters = [], now } = {}) {
  if (!ledger || typeof ledger.claim !== 'function' || !Array.isArray(adapters)) {
    throw executorError('EXECUTOR_REGISTRY_INVALID', 'operation ledger and adapter list are required');
  }
  const authority = createActionReceiptAuthority({ ledger, ...(now ? { now } : {}) });
  const byActionType = new Map();

  for (const adapter of adapters) {
    if (!adapter || typeof adapter.execute !== 'function') {
      throw executorError('EXECUTOR_REGISTRATION_INVALID', 'executor adapter must provide execute');
    }
    if (!Array.isArray(adapter.actionTypes) || adapter.actionTypes.length === 0) {
      throw executorError('EXECUTOR_REGISTRATION_INVALID', 'executor adapter action types are required');
    }
    const actionTypes = [...new Set(adapter.actionTypes.map((item) => String(item || '').trim()))];
    for (const actionType of actionTypes) {
      if (!actionType) throw executorError('EXECUTOR_REGISTRATION_INVALID', 'executor action type is invalid');
      if (byActionType.has(actionType)) {
        throw executorError('EXECUTOR_DUPLICATE', `multiple executors registered for ${actionType}`);
      }
    }
    const issuerHandle = authority.registerIssuer({ ...adapter, actionTypes });
    const registration = Object.freeze({ execute: adapter.execute, issuerHandle });
    for (const actionType of actionTypes) byActionType.set(actionType, registration);
  }

  async function execute(operation, options = {}) {
    const registration = byActionType.get(String(operation?.actionType || ''));
    if (!registration) throw executorError('EXECUTOR_UNSUPPORTED', 'no trusted executor is registered for this action');
    const claimed = ledger.claim(operation);
    let result;
    try {
      result = await registration.execute(Object.freeze({
        operation: claimed,
        signal: options.signal,
        payload: options.payload,
      }));
    } catch (cause) {
      try { ledger.reject({ operationId: claimed.operationId, code: 'executor_call_failed' }); } catch {}
      throw executorError('EXECUTOR_CALL_FAILED', 'trusted executor did not return a verifiable result', cause);
    }
    return authority.issue({ issuerHandle: registration.issuerHandle, operation: claimed, result });
  }

  return Object.freeze({
    execute,
    supports: (actionType) => byActionType.has(String(actionType || '')),
    verifyReceipt: authority.verify,
  });
}

function executorError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
