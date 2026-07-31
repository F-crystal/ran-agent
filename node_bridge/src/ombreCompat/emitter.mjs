// Trusted compatibility final-turn emitter (§4). This module is deliberately
// mechanical: it reads an already-fixed legacy final gate result and binds
// stable ids, revisions, digests, scope, and receipt refs. It performs NO
// natural-language judgement — it never classifies importance, emotion,
// romantic content, or memory-worthiness, and it never branches on payload
// text (§4.1 "Node 不判断"). There is no NLP import and no keyword table here
// by design; semantic classification belongs to the Curator/Reviewer lane.

import path from 'node:path';

import { appendJsonLine } from '../atomicState.mjs';
import { canonicalDigest } from './canonical.mjs';
import { getOmbreCompatConfig } from './config.mjs';
import {
  COMPAT_EMITTER_ID,
  COMPAT_EMITTER_VERSION,
  COMPAT_SOURCE_EVENT_SCHEMA,
} from './constants.mjs';
import { deriveSourceEventId } from './queueStore.mjs';
import { validateFinalTurnSourceEvent } from './sourceEvent.mjs';

// Payload refs point at the existing legacy final-truth owner (the global
// timeline turn). The compatibility queue stores refs + digests only; it
// never copies payload text (§4.2).
export function userPayloadRef(conversationId, exchangeId) {
  return `global-timeline://turn/${conversationId}/${exchangeId}/user`;
}

export function assistantPayloadRef(conversationId, exchangeId) {
  return `global-timeline://turn/${conversationId}/${exchangeId}/assistant`;
}

// Builds and validates a compatibility.final-turn/v1 source event from typed
// inputs. Every field is bound mechanically; digests are computed over the
// final payload texts exactly as adopted by the legacy final gate.
export function buildCompatFinalTurnEvent({
  platform,
  conversationId,
  exchangeId,
  userText,
  assistantText,
  scopeEnvelope,
  sensitivity,
  trustedActionReceiptRefs,
  sourceGateReceiptRef,
  emittedAt,
  userFinalPayloadRef = null,
  assistantFinalPayloadRef = null,
  userFinalPayloadRevision = 0,
  assistantFinalPayloadRevision = 0,
  presentationState = 'not_presented',
  deliveryObservationRef = null,
  deliveryObservationDigest = null,
  lifecycleState = 'current',
  supersedesEventId = null,
  sourceRevision = 0,
}) {
  const user_final_payload_digest = canonicalDigest(String(userText ?? ''));
  const assistant_final_payload_digest = canonicalDigest(String(assistantText ?? ''));
  const receiptRefs = Array.isArray(trustedActionReceiptRefs) ? trustedActionReceiptRefs : [];
  const event = {
    schema_version: COMPAT_SOURCE_EVENT_SCHEMA,
    event_id: deriveSourceEventId({
      platform,
      conversation_id: conversationId,
      exchange_id: exchangeId,
    }),
    source_revision: sourceRevision,
    conversation_id: String(conversationId),
    exchange_id: String(exchangeId),
    user_final_payload_ref: userFinalPayloadRef || userPayloadRef(conversationId, exchangeId),
    user_final_payload_revision: userFinalPayloadRevision,
    user_final_payload_digest,
    assistant_final_payload_ref: assistantFinalPayloadRef || assistantPayloadRef(conversationId, exchangeId),
    assistant_final_payload_revision: assistantFinalPayloadRevision,
    assistant_final_payload_digest,
    final_content_digest: canonicalDigest({
      user_final_payload_digest,
      assistant_final_payload_digest,
    }),
    scope_envelope_ref: `scope://${platform}/${conversationId}`,
    scope_envelope_digest: canonicalDigest(scopeEnvelope),
    sensitivity,
    presentation_state: presentationState,
    delivery_observation_ref: deliveryObservationRef,
    delivery_observation_digest: deliveryObservationDigest,
    trusted_action_receipt_refs: receiptRefs,
    trusted_action_receipts_digest: canonicalDigest(receiptRefs),
    lifecycle_state: lifecycleState,
    supersedes_event_id: supersedesEventId || null,
    withdrawal_ref: null,
    withdrawal_revision: null,
    supersession_ref: null,
    supersession_revision: null,
    deletion_ref: null,
    deletion_revision: null,
    source_gate_receipt_ref: sourceGateReceiptRef,
    emitter_id: COMPAT_EMITTER_ID,
    emitter_version: COMPAT_EMITTER_VERSION,
    emitted_at: emittedAt,
  };
  return validateFinalTurnSourceEvent(event);
}

// Creates the trusted emitter. The caller owns the store lifecycle (open /
// close). Gate evidence is trusted runtime evidence that the legacy final
// gate completed — it is NOT a model receipt (§4.2 source_gate_receipt_ref).
export function createCompatEmitter({ env, store, clock = () => new Date() }) {
  const config = getOmbreCompatConfig(env);
  const gateEvidencePath = path.join(config.stateDir, 'gate-evidence.jsonl');

  function emitFinalTurn(input) {
    const emittedAt = toIso(clock());
    // Draft pass: binds the content digests the gate evidence must commit to.
    const draft = buildCompatFinalTurnEvent({
      ...input,
      emittedAt,
      sourceGateReceiptRef: 'gate-evidence:pending',
    });
    const evidence = {
      evidence_ref: canonicalDigest({
        final_content_digest: draft.final_content_digest,
        response_source: input.responseSource ?? null,
        suppress_send: Boolean(input.suppressSend),
        emitted_at: emittedAt,
      }),
      final_content_digest: draft.final_content_digest,
      response_source: input.responseSource ?? null,
      suppress_send: Boolean(input.suppressSend),
      emitted_at: emittedAt,
    };
    appendJsonLine(gateEvidencePath, evidence);
    const event = buildCompatFinalTurnEvent({
      ...input,
      emittedAt,
      sourceGateReceiptRef: evidence.evidence_ref,
    });
    const result = store.ingressSourceEvent(event);
    return {
      disposition: result.disposition,
      event_id: result.event_id,
      item_ids: result.item_ids,
    };
  }

  function emitLifecycle({ eventId, kind, ref, revision }) {
    return store.applySourceLifecycle({
      event_id: eventId,
      kind,
      ref,
      revision,
    });
  }

  return { emitFinalTurn, emitLifecycle, gateEvidencePath };
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}
