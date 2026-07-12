const HIGH_RISK_INTENTS = new Set(['memory_write', 'external_send', 'destructive_update']);
const REPAIR_TRIGGER_SOURCES = new Set([
  'typed_action_failure',
  'typed_claim_missing_request',
  'trusted_compatibility_partial',
  'trusted_delivery_retry',
  'none',
]);
const REPAIR_SESSION_SCOPES = new Set(['task', 'none']);

export async function repairActionContract({
  contract = {},
  message = {},
  response = {},
  finalReply = '',
  maxAttempts = 1,
  repairImpl = null,
  env = process.env,
  logger = console,
} = {}) {
  const plan = planRepairAction({ contract, message, finalReply, maxAttempts });
  if (!plan.shouldRepair) {
    return normalizeRepairResult({
      attempted: false,
      repairType: plan.repairType,
      status: plan.status,
      error_code: plan.errorCode,
    });
  }

  try {
    // NodeBridge never chooses a tool from user/reply text.  A caller may only
    // inject a bounded retry for an already grounded typed operation.
    if (typeof repairImpl !== 'function') {
      return normalizeRepairResult({ attempted: false, repairType: plan.repairType, status: 'skipped', error_code: 'NO_TRUSTED_RETRY', triggerSource: plan.triggerSource, sessionScope: plan.sessionScope });
    }
    const raw = await repairImpl(plan);
    return normalizeRepairResult({
      attempted: true,
      repairType: plan.repairType,
      triggerSource: plan.triggerSource,
      sessionScope: plan.sessionScope,
      ...raw,
    });
  } catch (error) {
    logger?.warn?.(`[hermes-action-repair] failed type=${plan.repairType} error=${sanitizeCode(error?.code || error?.message || 'REPAIR_FAILED')}`);
    return normalizeRepairResult({
      attempted: true,
      repairType: plan.repairType,
      ok: false,
      status: 'failed',
      error_code: 'REPAIR_EXCEPTION',
    });
  }
}

export function planRepairAction({ contract = {}, maxAttempts = 1 } = {}) {
  const intent = String(contract.intent || 'none');
  const repairType = intent;
  if (Number(maxAttempts) <= 0) {
    return { shouldRepair: false, repairType, status: 'max_attempts_exceeded', errorCode: 'MAX_ATTEMPTS_EXCEEDED' };
  }
  if (HIGH_RISK_INTENTS.has(intent)) {
    return { shouldRepair: false, repairType, status: 'blocked_high_risk', errorCode: 'HIGH_RISK_REPAIR_BLOCKED' };
  }
  const source = String(contract.contract_source || '');
  if (source !== 'typed_action_request' && source !== 'protected_compatibility') {
    return { shouldRepair: false, repairType, status: 'skipped', errorCode: 'NO_REPAIR_FOR_INTENT' };
  }
  if (!hasActionClaim(contract)) {
    return { shouldRepair: false, repairType, status: 'skipped', errorCode: 'NO_ACTION_CLAIM' };
  }
  return {
    shouldRepair: true,
    repairType,
    intent,
    requestId: String(contract.request_id || ''),
    finalClaims: Array.isArray(contract.final_claims) ? [...contract.final_claims] : [],
    missingEvidence: Array.isArray(contract.missing_evidence) ? [...contract.missing_evidence] : [],
    triggerSource: source === 'typed_action_request' ? 'typed_action_failure' : 'trusted_compatibility_partial',
    sessionScope: 'task',
  };
}

function normalizeRepairResult(result = {}) {
  const status = normalizeStatus(result.status, result.ok);
  const toolResults = [
    ...normalizeToolResults(result.toolResults),
    ...normalizeToolResults(result.toolResult ? [result.toolResult] : []),
  ];
  const repairedReply = String(result.repairedReply || '');
  return {
    repairAttempted: result.attempted === true,
    repairType: sanitizeCode(result.repairType || result.type || ''),
    repairStatus: status,
    ok: status === 'success' || status === 'partial_success',
    repairedReply,
    marker: String(result.marker || ''),
    media: result.media && typeof result.media === 'object' && !Array.isArray(result.media) ? result.media : null,
    toolResults,
    repairEvidenceAdded: summarizeRepairEvidence({ marker: result.marker, media: result.media, toolResults }),
    repairErrorCode: sanitizeCode(result.error_code || result.errorCode || result.error || ''),
    repairTriggerSource: normalizeRepairTriggerSource(result.triggerSource),
    repairSessionScope: normalizeRepairSessionScope(result.sessionScope),
    repairAttemptCount: result.attempted === true ? 1 : 0,
    repairRecursiveBlocked: true,
  };
}

function normalizeToolResults(items) {
  return Array.isArray(items) ? items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function normalizeStatus(status, ok) {
  const value = String(status || '').trim().toLowerCase();
  if (['success', 'partial_success', 'failed', 'blocked_high_risk', 'max_attempts_exceeded', 'skipped'].includes(value)) return value;
  return ok === true ? 'success' : ok === false ? 'failed' : 'skipped';
}

function summarizeRepairEvidence({ marker, media, toolResults }) {
  return [marker ? 'marker' : '', media && typeof media === 'object' ? 'artifact' : '', Array.isArray(toolResults) && toolResults.length ? 'tool_result' : ''].filter(Boolean);
}

function hasActionClaim(contract = {}) {
  return Array.isArray(contract.final_claims) && contract.final_claims.length > 0;
}

function normalizeRepairTriggerSource(value) {
  const source = sanitizeCode(value || 'none').toLowerCase();
  return REPAIR_TRIGGER_SOURCES.has(source) ? source : 'none';
}

function normalizeRepairSessionScope(value) {
  const scope = sanitizeCode(value || 'none').toLowerCase();
  return REPAIR_SESSION_SCOPES.has(scope) ? scope : 'none';
}

function sanitizeCode(value) {
  return String(value || '').trim().replace(/[^A-Z0-9_.:-]/gi, '_').slice(0, 80);
}
