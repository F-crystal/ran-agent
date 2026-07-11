import { createHash } from 'node:crypto';

const CAPABILITIES = new WeakMap();
const RECEIPTS = new WeakMap();

export function digestExternalMcpOperationValue(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function createBridgeExternalMcpOperationCapability(input = {}) {
  const issuedAt = validDate(input.issuedAt) || new Date();
  const expiresAt = validDate(input.expiresAt);
  const context = operationContext(input);
  if (!expiresAt || expiresAt <= issuedAt || !isCompleteContext(context)) {
    throw new Error('external MCP operation context is invalid');
  }
  const capability = deepFreeze({
    ...context,
    scopeDigest: digestExternalMcpOperationValue(context.scope),
    riskDigest: digestExternalMcpOperationValue(context.risk),
    argumentsDigest: digestExternalMcpOperationValue(input.arguments || {}),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  CAPABILITIES.set(capability, {
    context,
    scopedGrant: input.scopedGrant || null,
    pendingAction: input.pendingAction || null,
  });
  return capability;
}

export function isTrustedExternalMcpOperationCapability(capability, { now } = {}) {
  const trusted = CAPABILITIES.get(capability);
  return Boolean(trusted && capability && validNow(capability, now));
}

export function getExternalMcpOperationAuthorization(capability) {
  const trusted = CAPABILITIES.get(capability);
  return trusted ? { scopedGrant: trusted.scopedGrant, pendingAction: trusted.pendingAction } : null;
}

export function createExternalMcpOperationReceipt(capability, input = {}) {
  if (!isTrustedExternalMcpOperationCapability(capability, { now: input.now })) {
    throw new Error('trusted external MCP operation capability is required');
  }
  const supplied = operationContext({ ...capability, ...input });
  const expected = CAPABILITIES.get(capability).context;
  if (!sameContext(expected, supplied)) throw new Error('operation context mismatch');
  const now = validDate(input.now) || new Date();
  const result = safeValue(input.result) || {};
  const receipt = deepFreeze({
    operationId: capability.operationId,
    actorKey: capability.actorKey,
    globalUserId: capability.globalUserId,
    serverId: capability.serverId,
    toolName: capability.toolName,
    sessionId: capability.sessionId,
    activityId: capability.activityId,
    actionId: capability.actionId,
    activityRevision: capability.activityRevision,
    leaseOwner: capability.leaseOwner,
    effect: capability.effect,
    profile: capability.profile,
    trigger: capability.trigger,
    watchScope: capability.watchScope,
    scopeDigest: capability.scopeDigest,
    riskDigest: capability.riskDigest,
    argumentsDigest: capability.argumentsDigest,
    outcome: normalizeOutcome(input.outcome),
    transport: text(input.transport),
    evidenceRef: text(input.evidenceRef || input.evidence_ref),
    result,
    resultDigest: digestExternalMcpOperationValue(result),
    issuedAt: now.toISOString(),
  });
  if (!receipt.outcome || !receipt.transport || !receipt.evidenceRef) throw new Error('operation receipt is invalid');
  RECEIPTS.set(receipt, { capability });
  return receipt;
}

export function verifyExternalMcpOperationReceipt(receipt, { capability, evidenceRef, now } = {}) {
  if (!isTrustedExternalMcpOperationCapability(capability, { now })) return { ok: false, reason: 'capability_required' };
  const trusted = RECEIPTS.get(receipt);
  if (!trusted || trusted.capability !== capability) return { ok: false, reason: 'receipt_binding_mismatch' };
  const mismatched = [
    'operationId', 'actorKey', 'globalUserId', 'serverId', 'toolName', 'sessionId', 'activityId',
    'actionId', 'activityRevision', 'leaseOwner', 'effect', 'profile', 'trigger', 'watchScope',
    'scopeDigest', 'riskDigest', 'argumentsDigest',
  ].some((key) => receipt[key] !== capability[key]);
  if (mismatched || receipt.resultDigest !== digestExternalMcpOperationValue(receipt.result)
    || (evidenceRef && receipt.evidenceRef !== evidenceRef)) {
    return { ok: false, reason: 'receipt_binding_mismatch' };
  }
  return { ok: true, receipt };
}

function operationContext(input = {}) {
  return {
    operationId: text(input.operationId), actorKey: text(input.actorKey), globalUserId: text(input.globalUserId),
    serverId: text(input.serverId), toolName: text(input.toolName), sessionId: text(input.sessionId),
    activityId: text(input.activityId), actionId: text(input.actionId),
    activityRevision: Number.isInteger(input.activityRevision) && input.activityRevision >= 0 ? input.activityRevision : 0,
    leaseOwner: text(input.leaseOwner), effect: text(input.effect), profile: text(input.profile), trigger: text(input.trigger),
    watchScope: text(input.watchScope), preferredTransport: text(input.preferredTransport),
    scope: safeValue(input.scope), risk: safeValue(input.risk),
  };
}

function isCompleteContext(context) {
  return Boolean(context.operationId && context.actorKey && context.globalUserId && context.serverId && context.toolName
    && context.sessionId && context.actionId && context.effect && context.profile && context.trigger
    && context.scope && context.risk);
}

function sameContext(left, right) {
  return Object.keys(left).every((key) => key === 'scope' || key === 'risk'
    ? digestExternalMcpOperationValue(left[key]) === digestExternalMcpOperationValue(right[key])
    : left[key] === right[key]);
}

function validNow(capability, now) {
  const current = validDate(now) || new Date();
  const issued = validDate(capability.issuedAt);
  const expires = validDate(capability.expiresAt);
  return Boolean(issued && expires && issued <= current && current < expires);
}

function validDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function safeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    return null;
  }
}

function normalizeOutcome(value) {
  const outcome = text(value).toLowerCase();
  return ['applied', 'not_applied', 'unknown'].includes(outcome) ? outcome : '';
}

function text(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 240);
}

function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
