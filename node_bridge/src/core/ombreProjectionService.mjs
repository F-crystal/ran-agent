import { createHash, randomUUID } from 'node:crypto';

import { coreError } from './coreErrors.mjs';

const PROJECTOR_ID = 'ombre-derived-v1';
const EVENT_MODES = new Map([
  ['personal_learning_confirmed', 'hold'],
  ['core_relationship_summary_confirmed', 'grow'],
]);
const IN_FLIGHT = new WeakMap();

function digest(value, length = 24) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function requireText(value, code, message, maxLength = 30_000) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /\0/.test(text)) throw coreError(code, message);
  return text;
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coreError('CORE_OMBRE_CLOCK_INVALID', 'Ombre projector clock is invalid');
  return date;
}

function idsFromResult(value) {
  return [...new Set([...String(value || '').matchAll(/\[bucket_id:([A-Za-z0-9._:-]{1,128})\]/g)]
    .map((match) => match[1]))];
}

function matchedIdsFromResult(value, { activeOnly = false } = {}) {
  return [...new Set(String(value || '').split('\n')
    .filter((line) => line.includes('[bucket_id:')
      && !line.includes('[联想浮现·非检索命中]')
      && (!activeOnly || !line.includes('[query 命中·已删除到档案]')))
    .flatMap((line) => idsFromResult(line)))];
}

function contentMarkerIds(value, marker) {
  const text = String(value || '');
  const matches = [...text.matchAll(/\[bucket_id:([A-Za-z0-9._:-]{1,128})\]/g)];
  return matches.flatMap((match, index) => {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', match.index) < 0 ? text.length : text.indexOf('\n', match.index));
    const end = matches[index + 1]?.index ?? text.length;
    return !line.includes('[联想浮现·非检索命中]') && text.slice(match.index, end).includes(marker)
      ? [match[1]] : [];
  });
}

async function findProjection(callTool, marker, { tag = '', activeOnly = false, contentMarker = false } = {}) {
  const result = await callTool('breath_advanced', {
    query: marker,
    max_results: 50,
    ...(tag ? { tags: tag } : {}),
  });
  return contentMarker ? contentMarkerIds(result, marker) : matchedIdsFromResult(result, { activeOnly });
}

async function applyProjection(callTool, { mode, content, marker, scopeTag, tags }) {
  let bucketIds = await findProjection(callTool, marker, { tag: marker });
  if (bucketIds.length === 0 && mode === 'grow') {
    bucketIds = await findProjection(callTool, marker, { contentMarker: true });
  }
  if (bucketIds.length > 0) {
    if (mode === 'grow') {
      for (const bucketId of bucketIds) {
        await callTool('trace', {
          bucket_id: bucketId,
          tags: [...tags, 'ran-agent-projection', scopeTag, marker].join(','),
          old_str: `\n\n[${marker}]`,
          new_str: '',
        });
      }
    }
    return { disposition: 'already_projected', bucketIds };
  }

  if (mode === 'hold') {
    await callTool('hold', {
      content,
      tags: [...tags, 'ran-agent-projection', scopeTag, marker].join(','),
      importance: 7,
      pinned: false,
      feel: false,
      why_remembered: 'Derived from a confirmed Core event; erasable and rebuildable.',
    });
  } else {
    await callTool('grow', { items: [`${content}\n\n[${marker}]`] });
  }

  bucketIds = await findProjection(callTool, marker, { tag: marker });
  if (bucketIds.length === 0 && mode === 'grow') {
    bucketIds = await findProjection(callTool, marker, { contentMarker: true });
  }
  if (bucketIds.length === 0) {
    throw coreError('CORE_OMBRE_RECEIPT_MISSING', 'Ombre projection completed without a discoverable receipt');
  }
  if (mode === 'grow') {
    for (const bucketId of bucketIds) {
      await callTool('trace', {
        bucket_id: bucketId,
        tags: [...tags, 'ran-agent-projection', scopeTag, marker].join(','),
        old_str: `\n\n[${marker}]`,
        new_str: '',
      });
    }
  }
  return { disposition: 'projected', bucketIds };
}

export function createOfficialOmbreToolCaller({
  url = 'http://127.0.0.1:18001/mcp',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch {
    throw coreError('CORE_OMBRE_ENDPOINT_INVALID', 'Ombre projector requires the loopback MCP endpoint');
  }
  if (endpoint.protocol !== 'http:' || endpoint.pathname !== '/mcp'
    || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw coreError('CORE_OMBRE_ENDPOINT_INVALID', 'Ombre projector requires the loopback MCP endpoint');
  }
  return async (name, args) => {
    const id = `ran-agent-projection-${randomUUID()}`;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw coreError('CORE_OMBRE_TRANSPORT_FAILED', 'Ombre projection transport failed');
    }
    if (!response?.ok) throw coreError('CORE_OMBRE_HTTP_FAILED', 'Ombre projection endpoint rejected the request');
    let payload;
    try { payload = await response.json(); } catch {
      throw coreError('CORE_OMBRE_RESPONSE_INVALID', 'Ombre projection response is invalid');
    }
    const result = payload?.result;
    const text = result?.structuredContent?.result;
    if (payload?.jsonrpc !== '2.0' || payload?.id !== id || payload?.error
      || result?.isError !== false || typeof text !== 'string') {
      throw coreError('CORE_OMBRE_RESPONSE_INVALID', 'Ombre projection response is invalid');
    }
    return text;
  };
}

export function createOmbreProjectionService({ core, callTool, hashContent, now = () => new Date() } = {}) {
  if (!core?.writer || !core?.reader || typeof callTool !== 'function' || typeof hashContent !== 'function') {
    throw coreError('CORE_OMBRE_PROJECTOR_REQUIRED', 'Core and the governed Ombre tool caller are required');
  }
  const active = IN_FLIGHT.get(core) || new Map();
  IN_FLIGHT.set(core, active);

  async function projectConfirmedEvent({ sourceEventId, sourceRevision = 0, targetScope, payload } = {}) {
    const eventId = requireText(sourceEventId, 'CORE_OMBRE_SOURCE_REQUIRED', 'Confirmed source event is required', 180);
    const scope = requireText(targetScope, 'CORE_OMBRE_SCOPE_REQUIRED', 'Ombre target scope is required', 120);
    const event = core.reader.journalEvent(eventId);
    const mode = EVENT_MODES.get(event?.event_type);
    if (!event || mode === undefined || Number(event.revision) !== Number(sourceRevision)) {
      throw coreError('CORE_OMBRE_SOURCE_UNCONFIRMED', 'Only current confirmed learning events may project to Ombre');
    }
    const content = requireText(payload?.content, 'CORE_OMBRE_CONTENT_INVALID', 'Ombre projection content is invalid');
    const sourceRef = requireText(payload?.sourceRef, 'CORE_OMBRE_SOURCE_REF_INVALID', 'Ombre source reference is invalid', 180);
    const payloadId = requireText(payload?.payloadId, 'CORE_OMBRE_PAYLOAD_REQUIRED', 'Confirmed source payload is required', 180);
    const sourcePayload = core.reader.journalPayload(payloadId);
    if (sourceRef !== event.source_ref || sourcePayload?.journal_event_id !== eventId
      || sourcePayload.payload_ref !== sourceRef || sourcePayload.erased_at !== null
      || sourcePayload.content_hash_token !== hashContent('ombre-projection', content)) {
      throw coreError('CORE_OMBRE_SOURCE_REF_MISMATCH', 'Ombre content does not match the confirmed source reference');
    }
    if (payload?.tags !== undefined && !Array.isArray(payload.tags)) {
      throw coreError('CORE_OMBRE_TAG_INVALID', 'Ombre projection tags are invalid');
    }
    const tags = [...new Set((payload?.tags || []).map((tag) => requireText(tag,
      'CORE_OMBRE_TAG_INVALID', 'Ombre projection tag is invalid', 64)))].slice(0, 12);
    const operationKey = `ombre:${digest(`${scope}\0${eventId}\0${sourceRevision}`)}`;
    const outboxId = `projection:ombre:${digest(operationKey)}`;
    const cursorId = `cursor:ombre:${digest(scope)}`;
    const inFlightKey = `${scope}\0${outboxId}`;
    if (active.has(inFlightKey)) return active.get(inFlightKey);

    const pending = (async () => {
      const createdAt = currentDate(now).toISOString();
      await core.writer.write((tx) => {
        tx.projections.createCursor({ cursorId, projectorId: PROJECTOR_ID, targetScope: scope, createdAt });
        tx.projections.reserve({
          outboxId, operationScope: `${PROJECTOR_ID}:${scope}`, operationKey,
          projectorId: PROJECTOR_ID, targetScope: scope, sourceEventId: eventId,
          sourceEntityType: 'journal_event', sourceEntityId: eventId,
          sourceRevision: Number(sourceRevision), payloadRef: `ombre:${digest(content, 32)}`, createdAt,
        });
      });
      const cursor = core.reader.projectorCursor(PROJECTOR_ID, scope);
      const outbox = core.reader.projectionOutbox(outboxId);
      if (outbox.state === 'completed') return { status: 'completed', disposition: 'already_committed', cursor, outbox };
      const claimedAt = currentDate(now);
      const claim = await core.writer.write((tx) => tx.projections.claim({
        cursorId, outboxId, expectedCursorRevision: Number(cursor.revision),
        expectedCursorFence: Number(cursor.fence_token), expectedOutboxRevision: Number(outbox.revision),
        leaseOwner: 'ombre-projector-local', leaseUntil: new Date(claimedAt.getTime() + 60_000).toISOString(),
        rotationOperationKey: `${operationKey}:claim:${Number(cursor.fence_token) + 1}`,
        updatedAt: claimedAt.toISOString(),
      }));
      if (!claim) return { status: 'busy', disposition: 'not_claimed' };
      const marker = `ran-agent-event-${digest(`${scope}\0${eventId}\0${sourceRevision}`, 32)}`;
      const scopeTag = `ran-agent-scope-${digest(scope, 24)}`;
      let receipt;
      try {
        receipt = await applyProjection(callTool, { mode, content, marker, scopeTag, tags });
      } catch (error) {
        const failedAt = currentDate(now).toISOString();
        await core.writer.write((tx) => tx.projections.recordFailure({
          cursorId, outboxId, expectedCursorRevision: Number(claim.cursor.revision),
          expectedOutboxRevision: Number(claim.outbox.revision), fenceToken: Number(claim.cursor.fence_token),
          leaseOwner: 'ombre-projector-local', nextAttemptAt: failedAt, updatedAt: failedAt,
        }));
        return { status: 'failed', disposition: 'retryable', errorCode: error?.code || 'CORE_OMBRE_PROJECT_FAILED' };
      }
      const committedAt = currentDate(now).toISOString();
      const committed = await core.writer.write((tx) => tx.projections.commitCursor({
        cursorId, outboxId, expectedCursorRevision: Number(claim.cursor.revision),
        expectedOutboxRevision: Number(claim.outbox.revision), fenceToken: Number(claim.cursor.fence_token),
        leaseOwner: 'ombre-projector-local', updatedAt: committedAt,
      }));
      return { status: committed?.outbox?.state || 'stale', disposition: committed?.disposition || 'not_committed', receipt };
    })().finally(() => active.delete(inFlightKey));
    active.set(inFlightKey, pending);
    return pending;
  }

  async function eraseScope(targetScope) {
    const scope = requireText(targetScope, 'CORE_OMBRE_SCOPE_REQUIRED', 'Ombre target scope is required', 120);
    const scopeTag = `ran-agent-scope-${digest(scope, 24)}`;
    const bucketIds = await findProjection(callTool, scopeTag, { tag: scopeTag, activeOnly: true });
    for (const bucketId of bucketIds) await callTool('trace', { bucket_id: bucketId, delete: true });
    return Object.freeze({ erased: bucketIds.length, bucketIds: Object.freeze(bucketIds) });
  }

  return Object.freeze({ projectConfirmedEvent, eraseScope });
}
