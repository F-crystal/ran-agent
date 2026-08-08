import { createHash } from 'node:crypto';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { resolveStateDir } from './runtimeState.mjs';

const SCHEMA_VERSION = 1;
const DELIVERY_STATES = new Set(['reserved', 'sending', 'sent', 'failed', 'ambiguous']);
const COMPONENT_STATES = new Set(['sent', 'failed', 'ambiguous']);
const ATTACHMENT_TYPES = new Set(['image', 'audio', 'video', 'file', 'sticker']);
const PROJECTIONS = new Set(['timeline', 'backend']);
const RAW_MARKER = /(?:RAN_MEDIA|WECHAT_MEDIA)\s*:/i;
const RUNTIME_PATH = /(?:\/Users\/|\/private\/|\/opt\/ran_agent(?:\/|\b)|[A-Za-z]:\\)/;

export function createDurableOutbox(options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const target = options.path || path.join(resolveStateDir(env), 'core', 'durable-outbox.json');

  function reserve(input = {}) {
    const normalized = normalizeReservation(input);
    const state = load();
    const existing = state.items.find((item) => item.operationKey === normalized.operationKey);
    if (existing) {
      if (!reservationMatches(existing, normalized)) {
        throw outboxError('OUTBOX_OPERATION_CONFLICT', 'operation already has a different outbox payload');
      }
      return snapshot(existing);
    }
    if (normalized.jobResultKey) {
      const jobItem = state.items.find((item) => item.jobResultKey === normalized.jobResultKey);
      if (jobItem) throw outboxError('OUTBOX_JOB_RESULT_CONFLICT', 'job result already has an outbox item');
    }
    if (state.items.some((item) => item.outboxId === normalized.outboxId)) {
      throw outboxError('OUTBOX_OPERATION_CONFLICT', 'outbox id collision');
    }
    const timestamp = currentDate(now).toISOString();
    const item = {
      ...normalized,
      delivery: 'reserved',
      revision: 0,
      delivery_terminal_revision: 0,
      delivery_terminal_receipt_id: null,
      deliveryTerminalReceipts: [],
      attemptCount: 0,
      timelineProjection: 'pending',
      backendProjection: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.items.push(item);
    save(state);
    return snapshot(item);
  }

  function startSend(outboxId, { expectedRevision } = {}) {
    return mutate(outboxId, expectedRevision, (item) => {
      if (item.delivery !== 'reserved') throw outboxError('OUTBOX_INVALID_TRANSITION', 'only reserved delivery may start');
      if (item.attemptCount >= item.maxAttempts) throw outboxError('OUTBOX_RETRY_DENIED', 'delivery attempt limit reached');
      item.delivery = 'sending';
      item.attemptCount += 1;
      item.sendStartedAt = currentDate(now).toISOString();
    });
  }

  function completeSend(outboxId, { expectedRevision, result } = {}) {
    return mutate(outboxId, expectedRevision, (item) => {
      if (item.delivery !== 'sending') throw outboxError('OUTBOX_INVALID_TRANSITION', 'only sending delivery may complete');
      const adapterResult = normalizeAdapterResult(item, result);
      item.delivery = classifyDelivery(adapterResult);
      item.adapterResult = adapterResult;
      item.deliveryCommittedAt = currentDate(now).toISOString();
      appendTerminalReceipt(item);
    });
  }

  function retryFailed(outboxId, { expectedRevision } = {}) {
    return mutate(outboxId, expectedRevision, (item) => {
      if (
        item.delivery !== 'failed'
        || item.adapterResult?.knownFailure !== true
        || item.idempotent !== true
        || item.attemptCount >= item.maxAttempts
      ) {
        throw outboxError('OUTBOX_RETRY_DENIED', 'only bounded known failed idempotent delivery may retry');
      }
      item.delivery = 'reserved';
      item.retryReservedAt = currentDate(now).toISOString();
      delete item.adapterResult;
      delete item.deliveryCommittedAt;
      delete item.sendStartedAt;
    });
  }

  function commitProjection(outboxId, projection, { expectedRevision } = {}) {
    if (!PROJECTIONS.has(projection)) throw outboxError('OUTBOX_PROJECTION_INVALID', 'unknown projection');
    return mutate(outboxId, expectedRevision, (item) => {
      if (item.delivery !== 'sent') throw outboxError('OUTBOX_INVALID_TRANSITION', 'only sent delivery may project');
      const field = `${projection}Projection`;
      if (item[field] !== 'pending') throw outboxError('OUTBOX_INVALID_TRANSITION', 'projection is already committed');
      item[field] = 'committed';
      item[`${projection}ProjectedAt`] = currentDate(now).toISOString();
    });
  }

  async function projectPending(options = {}) {
    for (const listed of list()) {
      if (listed.delivery !== 'sent') continue;
      await projectItem(listed.outboxId, options);
    }
    return list();
  }

  async function deliver(input, options = {}) {
    await inject(options, 'before_reserve');
    let item = reserve(input);
    await inject(options, 'after_reserve', item);
    if (item.delivery === 'sent') {
      await projectItem(item.outboxId, options);
      return get(item.outboxId);
    }
    if (item.delivery === 'sending' || item.delivery === 'ambiguous') {
      throw outboxError('OUTBOX_DELIVERY_UNCERTAIN', 'delivery outcome is not safe to resend');
    }
    if (item.delivery === 'failed') {
      if (options.retry !== true) throw outboxError('OUTBOX_RETRY_REQUIRED', 'known failed delivery requires explicit retry');
      item = retryFailed(item.outboxId, { expectedRevision: item.revision });
    }
    if (typeof options.send !== 'function') throw outboxError('OUTBOX_ADAPTER_REQUIRED', 'delivery adapter is required');
    item = startSend(item.outboxId, { expectedRevision: item.revision });
    await inject(options, 'after_send_start', item);
    let result;
    try {
      result = await options.send(adapterView(item));
    } catch (error) {
      item = completeSend(item.outboxId, {
        expectedRevision: item.revision,
        result: unknownAdapterResult(item),
      });
      if (typeof options.onTerminal === 'function') await options.onTerminal(currentTerminal(item));
      throw error;
    }
    await inject(options, 'after_adapter_return', item);
    try {
      item = completeSend(item.outboxId, { expectedRevision: item.revision, result });
    } catch (error) {
      if (error?.code !== 'OUTBOX_ADAPTER_RESULT_INVALID') throw error;
      item = completeSend(item.outboxId, {
        expectedRevision: item.revision,
        result: unknownAdapterResult(item),
      });
      if (typeof options.onTerminal === 'function') await options.onTerminal(currentTerminal(item));
      throw error;
    }
    if (typeof options.onTerminal === 'function') await options.onTerminal(currentTerminal(item));
    if (item.delivery === 'sent') {
      await inject(options, 'after_sent_commit', item);
      await projectItem(item.outboxId, options);
    }
    return get(item.outboxId);
  }

  async function recover(options = {}) {
    for (const listed of list()) {
      if (listed.delivery !== 'sending') continue;
      const recovered = mutate(listed.outboxId, listed.revision, (item) => {
        item.delivery = 'ambiguous';
        item.adapterResult = unknownAdapterResult(item);
        item.deliveryCommittedAt = currentDate(now).toISOString();
        item.recoveredAt = item.deliveryCommittedAt;
        appendTerminalReceipt(item);
      });
      if (typeof options.onTerminal === 'function') await options.onTerminal(currentTerminal(recovered));
    }
    await inject(options, 'after_restart_recovery');
    await projectPending(options);
    return list();
  }

  function get(outboxId) {
    const item = load().items.find((entry) => entry.outboxId === outboxId);
    return item ? snapshot(item) : null;
  }

  function list() {
    return load().items.map(snapshot);
  }

  function getTerminalReceipt(receiptId) {
    for (const item of load().items) {
      const receipt = item.deliveryTerminalReceipts.find((entry) => entry.delivery_terminal_receipt_id === receiptId);
      if (receipt) return snapshot(receipt);
    }
    return null;
  }

  async function projectItem(outboxId, options) {
    let item = get(outboxId);
    if (!item || item.delivery !== 'sent') return item;
    for (const projection of ['timeline', 'backend']) {
      const callback = options[projection];
      const field = `${projection}Projection`;
      if (item[field] !== 'pending' || typeof callback !== 'function') continue;
      await callback(projectionView(item));
      await inject(options, `after_${projection}_projection`, item);
      item = commitProjection(item.outboxId, projection, { expectedRevision: item.revision });
    }
    return item;
  }

  function mutate(outboxId, expectedRevision, update) {
    const state = load();
    const item = state.items.find((entry) => entry.outboxId === outboxId);
    if (!item) throw outboxError('OUTBOX_NOT_FOUND', 'outbox item was not found');
    if (!Number.isInteger(expectedRevision) || expectedRevision !== item.revision) {
      throw outboxError('OUTBOX_STALE_REVISION', 'outbox revision does not match');
    }
    update(item);
    item.revision += 1;
    item.updatedAt = currentDate(now).toISOString();
    save(state);
    return snapshot(item);
  }

  function load() {
    const state = readJsonState(target, {
      validate: validateCompatibleState,
      missingValue: { schemaVersion: SCHEMA_VERSION, items: [] },
      critical: true,
    });
    if (upgradeLegacyState(state)) save(state);
    return state;
  }

  function save(state) {
    writeJsonAtomic(target, state, { validate: validateState });
  }

  return Object.freeze({
    target,
    reserve,
    startSend,
    completeSend,
    retryFailed,
    commitProjection,
    projectPending,
    deliver,
    recover,
    get,
    list,
    getTerminalReceipt,
  });

}

function normalizeReservation(input) {
  if (!isPlainObject(input)) throw outboxError('OUTBOX_CONTENT_INVALID', 'outbox request must be an object');
  const operationKey = boundedIdentifier(input.operationKey, 'operationKey');
  const jobResultKey = input.jobResultKey ? boundedIdentifier(input.jobResultKey, 'jobResultKey') : '';
  const route = normalizeRoute(input.route);
  if (typeof input.text !== 'string') throw outboxError('OUTBOX_CONTENT_INVALID', 'validated text must be a string');
  const text = input.text.trim();
  if (text.length > 32_000 || RAW_MARKER.test(text) || RUNTIME_PATH.test(text)) {
    throw outboxError('OUTBOX_CONTENT_INVALID', 'validated text contains private media data');
  }
  const attachments = normalizeAttachments(input.attachments || []);
  if (!text && attachments.length === 0) throw outboxError('OUTBOX_CONTENT_INVALID', 'outbox content is empty');
  const idempotent = input.idempotent === true;
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts, idempotent);
  const platform = boundedIdentifier(
    input.platform || (['wechat', 'feishu', 'desktop'].includes(route.adapterKey) ? route.adapterKey : 'desktop'),
    'platform',
    80,
  );
  if (!['wechat', 'feishu', 'desktop'].includes(platform)) {
    throw outboxError('OUTBOX_CONTENT_INVALID', 'platform is invalid');
  }
  const conversation_id = boundedIdentifier(input.conversation_id || route.destinationRef, 'conversation_id', 512);
  const exchange_id = boundedIdentifier(input.exchange_id || operationKey, 'exchange_id', 512);
  const content = {
    operationKey,
    jobResultKey,
    platform,
    conversation_id,
    exchange_id,
    route,
    text,
    attachments,
    idempotent,
    maxAttempts,
  };
  return {
    outboxId: `outbox_${hash(operationKey).slice(0, 32)}`,
    ...content,
    contentDigest: `sha256:${hash(JSON.stringify(content))}`,
  };
}

function normalizeRoute(value) {
  if (!isPlainObject(value)) throw outboxError('OUTBOX_CONTENT_INVALID', 'trusted route is required');
  return {
    adapterKey: boundedIdentifier(value.adapterKey, 'adapterKey', 80),
    destinationRef: boundedIdentifier(value.destinationRef, 'destinationRef'),
  };
}

function normalizeAttachments(values) {
  if (!Array.isArray(values) || values.length > 16) throw outboxError('OUTBOX_CONTENT_INVALID', 'attachments are invalid');
  const refs = new Set();
  return values.map((value) => {
    if (!isPlainObject(value) || !ATTACHMENT_TYPES.has(value.type)) {
      throw outboxError('OUTBOX_CONTENT_INVALID', 'attachment type is invalid');
    }
    const ref = boundedReference(value.ref);
    if (refs.has(ref)) throw outboxError('OUTBOX_CONTENT_INVALID', 'attachment reference is duplicated');
    refs.add(ref);
    return { type: value.type, ref };
  });
}

function normalizeAdapterResult(item, result) {
  if (!isPlainObject(result)) throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter result must be typed');
  const textStatus = String(result.textStatus || '');
  if (item.text ? !COMPONENT_STATES.has(textStatus) : textStatus !== 'not_requested') {
    throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter text result does not match requested text');
  }
  if (!Array.isArray(result.attachments) || result.attachments.length !== item.attachments.length) {
    throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter must report every attachment');
  }
  const byRef = new Map();
  for (const value of result.attachments) {
    if (!isPlainObject(value) || !COMPONENT_STATES.has(value.status) || byRef.has(value.ref)) {
      throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter attachment result is invalid');
    }
    byRef.set(value.ref, value.status);
  }
  const attachments = item.attachments.map((attachment) => {
    const status = byRef.get(attachment.ref);
    if (!status) throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter attachment result does not match request');
    return { ...attachment, status };
  });
  const adapterResult = {
    textStatus,
    attachments,
    knownFailure: result.knownFailure === true,
    adapterReceiptRef: boundedAdapterReference(result.adapterReceiptRef),
  };
  const delivery = classifyDelivery(adapterResult);
  if ((delivery === 'failed') !== adapterResult.knownFailure) {
    throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'known failure classification is inconsistent');
  }
  return adapterResult;
}

function classifyDelivery(result) {
  const states = [
    ...(result.textStatus === 'not_requested' ? [] : [result.textStatus]),
    ...result.attachments.map((item) => item.status),
  ];
  if (states.every((status) => status === 'sent')) return 'sent';
  if (states.includes('ambiguous') || states.includes('sent')) return 'ambiguous';
  return 'failed';
}

function unknownAdapterResult(item) {
  return {
    textStatus: item.text ? 'ambiguous' : 'not_requested',
    attachments: item.attachments.map((attachment) => ({ ...attachment, status: 'ambiguous' })),
    knownFailure: false,
    adapterReceiptRef: 'recovery:unknown-outcome',
  };
}

function adapterView(item) {
  return snapshot({
    outboxId: item.outboxId,
    operationKey: item.operationKey,
    route: item.route,
    text: item.text,
    attachments: item.attachments,
    idempotencyKey: item.idempotent ? item.outboxId : '',
    attempt: item.attemptCount,
  });
}

function projectionView(item) {
  return snapshot({
    outboxId: item.outboxId,
    text: item.adapterResult.textStatus === 'sent' ? item.text : '',
    attachments: item.adapterResult.attachments
      .filter((attachment) => attachment.status === 'sent')
      .map(({ type, ref }) => ({ type, ref })),
    partial: item.adapterResult.textStatus !== (item.text ? 'sent' : 'not_requested')
      || item.adapterResult.attachments.some((attachment) => attachment.status !== 'sent'),
    sentAt: item.deliveryCommittedAt,
  });
}

function validateState(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.items)) return false;
  const ids = new Set();
  const operations = new Set();
  const jobs = new Set();
  for (const item of value.items) {
    try {
      if (!isPlainObject(item) || !DELIVERY_STATES.has(item.delivery)) return false;
      if (ids.has(item.outboxId) || operations.has(item.operationKey)) return false;
      ids.add(item.outboxId);
      operations.add(item.operationKey);
      if (item.jobResultKey && jobs.has(item.jobResultKey)) return false;
      if (item.jobResultKey) jobs.add(item.jobResultKey);
      const normalized = normalizeReservation(item);
      if (normalized.outboxId !== item.outboxId
        || (normalized.contentDigest !== item.contentDigest && legacyContentDigest(item) !== item.contentDigest)) return false;
      if (!Number.isInteger(item.revision) || item.revision < 0) return false;
      if (!Number.isInteger(item.delivery_terminal_revision) || item.delivery_terminal_revision < 0) return false;
      if (!Array.isArray(item.deliveryTerminalReceipts)
        || item.deliveryTerminalReceipts.length !== item.delivery_terminal_revision) return false;
      if (item.delivery_terminal_receipt_id !== null
        && !item.deliveryTerminalReceipts.some((entry) => entry.delivery_terminal_receipt_id === item.delivery_terminal_receipt_id)) return false;
      if (!Number.isInteger(item.attemptCount) || item.attemptCount < 0 || item.attemptCount > item.maxAttempts) return false;
      if (!['pending', 'committed'].includes(item.timelineProjection)) return false;
      if (!['pending', 'committed'].includes(item.backendProjection)) return false;
      if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) return false;
      if (['sent', 'failed', 'ambiguous'].includes(item.delivery)) {
        normalizeAdapterResult(item, item.adapterResult);
        if (!Number.isFinite(Date.parse(item.deliveryCommittedAt))) return false;
        const receipt = currentTerminal(item);
        if (!receipt || receipt.delivery !== item.delivery || receipt.content_digest !== item.contentDigest) return false;
        const { receipt_digest: digest, ...material } = receipt;
        if (digest !== `sha256:${hash(canonicalStringify(material))}`) return false;
      }
      if (item.delivery !== 'sent' && (item.timelineProjection !== 'pending' || item.backendProjection !== 'pending')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validateCompatibleState(value) {
  try {
    const copy = structuredClone(value);
    upgradeLegacyState(copy);
    return validateState(copy);
  } catch {
    return false;
  }
}

function upgradeLegacyState(state) {
  let changed = false;
  for (const item of state.items || []) {
    if (!item.platform) {
      item.platform = ['wechat', 'feishu', 'desktop'].includes(item.route?.adapterKey)
        ? item.route.adapterKey : 'desktop';
      changed = true;
    }
    if (!item.conversation_id) {
      item.conversation_id = item.route?.destinationRef;
      changed = true;
    }
    if (!item.exchange_id) {
      item.exchange_id = item.operationKey;
      changed = true;
    }
    if (!Number.isInteger(item.delivery_terminal_revision)) {
      item.delivery_terminal_revision = 0;
      changed = true;
    }
    if (!Array.isArray(item.deliveryTerminalReceipts)) {
      item.deliveryTerminalReceipts = [];
      changed = true;
    }
    if (!Object.hasOwn(item, 'delivery_terminal_receipt_id')) {
      item.delivery_terminal_receipt_id = null;
      changed = true;
    }
    if (['sent', 'failed', 'ambiguous'].includes(item.delivery)
      && item.deliveryTerminalReceipts.length === 0) {
      appendTerminalReceipt(item);
      changed = true;
    }
  }
  return changed;
}

function appendTerminalReceipt(item) {
  item.delivery_terminal_revision += 1;
  const material = {
    schema_version: 'durable-outbox.delivery-terminal-receipt/1',
    outbox_id: item.outboxId,
    operation_key: item.operationKey,
    platform: item.platform,
    conversation_id: item.conversation_id,
    exchange_id: item.exchange_id,
    delivery_terminal_revision: item.delivery_terminal_revision,
    delivery: item.delivery,
    text_status: item.adapterResult.textStatus,
    attachment_states: item.adapterResult.attachments,
    known_failure: item.adapterResult.knownFailure,
    adapter_receipt_ref: item.adapterResult.adapterReceiptRef,
    delivery_committed_at: item.deliveryCommittedAt,
    content_digest: item.contentDigest,
    route: item.route,
  };
  const delivery_terminal_receipt_id = `dtr_${hash(canonicalStringify({
    outbox_id: item.outboxId,
    delivery_terminal_revision: item.delivery_terminal_revision,
    delivery: item.delivery,
    content_digest: item.contentDigest,
  })).slice(0, 32)}`;
  const receipt = {
    ...material,
    delivery_terminal_receipt_id,
  };
  receipt.receipt_digest = `sha256:${hash(canonicalStringify(receipt))}`;
  item.deliveryTerminalReceipts.push(receipt);
  item.delivery_terminal_receipt_id = delivery_terminal_receipt_id;
}

function legacyContentDigest(item) {
  const content = {
    operationKey: item.operationKey,
    jobResultKey: item.jobResultKey,
    route: item.route,
    text: item.text,
    attachments: item.attachments,
    idempotent: item.idempotent,
    maxAttempts: item.maxAttempts,
  };
  return `sha256:${hash(JSON.stringify(content))}`;
}

function reservationMatches(existing, normalized) {
  return existing.contentDigest === normalized.contentDigest
    || (existing.contentDigest === legacyContentDigest(existing)
      && existing.platform === normalized.platform
      && existing.conversation_id === normalized.conversation_id
      && existing.exchange_id === normalized.exchange_id
      && legacyContentDigest(normalized) === existing.contentDigest);
}

async function inject(options, stage, item) {
  if (typeof options.injectFault === 'function') await options.injectFault(stage, item ? snapshot(item) : null);
}

function normalizeMaxAttempts(value, idempotent) {
  const fallback = idempotent ? 2 : 1;
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 5 || (!idempotent && number !== 1)) {
    throw outboxError('OUTBOX_CONTENT_INVALID', 'delivery attempt limit is invalid');
  }
  return number;
}

function boundedIdentifier(value, name, maxLength = 180) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) {
    throw outboxError('OUTBOX_CONTENT_INVALID', `${name} is invalid`);
  }
  return text;
}

function boundedReference(value) {
  const text = String(value || '').trim();
  const match = /^([A-Za-z][A-Za-z0-9_.-]{0,31}):([A-Za-z0-9][A-Za-z0-9_.:-]{0,239})$/.exec(text);
  if (!match || ['http', 'https', 'file'].includes(match[1].toLowerCase())) {
    throw outboxError('OUTBOX_CONTENT_INVALID', 'private attachment reference is invalid');
  }
  return text;
}

function boundedAdapterReference(value) {
  try {
    return boundedReference(value);
  } catch (error) {
    if (error?.code !== 'OUTBOX_CONTENT_INVALID') throw error;
    throw outboxError('OUTBOX_ADAPTER_RESULT_INVALID', 'adapter receipt reference is invalid');
  }
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function currentTerminal(item) {
  if (!item?.delivery_terminal_receipt_id || !Array.isArray(item.deliveryTerminalReceipts)) return null;
  return item.deliveryTerminalReceipts.find(
    (entry) => entry.delivery_terminal_receipt_id === item.delivery_terminal_receipt_id,
  ) || null;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw outboxError('OUTBOX_CLOCK_INVALID', 'outbox clock is invalid');
  return date;
}

function snapshot(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function outboxError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
