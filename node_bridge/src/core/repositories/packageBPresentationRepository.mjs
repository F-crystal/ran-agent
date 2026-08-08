import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import { assertScheduledWorkAuthority } from '../coreScheduling.mjs';
import {
  finalCommitOperationDigest,
  presentationBindingOperationDigest,
  presentationClaimOperationDigest,
  presentationDispatchStartOperationDigest,
  presentationResultOperationDigest,
} from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertPackageBOperationKey,
  assertPackageBReceipt,
  findPackageBReceipt,
  findPackageBReceiptByOperationKey,
  frozen,
  packageBReceiptEventId,
  readVerifiedConversationIdentity,
} from './packageBRepositorySupport.mjs';

const FINAL_KIND = 'final_semantic_committed';
const ENQUEUED_KIND = 'presentation_enqueued';
const CLAIM_KIND = 'presentation_claimed';
const CLAIM_RECOVERY_KIND = 'presentation_claim_recovered_ambiguous';
const DISPATCH_STARTED_KIND = 'presentation_dispatch_started';
const RESULT_KIND = 'presentation_result_recorded';
const RECONCILE_KIND = 'presentation_reconciled';
const IDENTITY_KIND = 'conversation_identity_bound';
const BINDING_KIND = 'presentation_binding_created';
const METADATA_KEYS = new Set(['protocol', 'receiptMode', 'routeVersion']);

function finalScope(conversationId, exchangeId) { return `final:${conversationId}:${exchangeId}`; }
function outboxScope(outboxId) { return `presentation:${outboxId}`; }
function bindingScope(bindingId) { return `presentation_binding:${bindingId}`; }

function destinationKind(binding) {
  const prefix = 'package_b_presentation_binding_destination:';
  if (!binding.binding_source_kind?.startsWith(prefix)) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'presentation binding lacks destination kind');
  }
  return binding.binding_source_kind.slice(prefix.length);
}

function receiptResult(receipt, disposition, dispatchAuthorized = false) {
  return frozen({ disposition, resultId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no),
    outboxId: receipt.correlation_id, fenceToken: Number(receipt.revision), operationDigest: receipt.source_ref,
    dispatchAuthorized });
}

function claimResult(audit, disposition = 'applied') {
  if (!audit) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'presentation claim fence receipt is missing');
  return frozen({ disposition, auditId: audit.fence_id, outboxId: audit.presentation_outbox_id,
    revision: Number(audit.new_revision), fenceToken: Number(audit.new_fence), state: audit.resulting_state,
    operationDigest: audit.operation_semantic_digest, committedAt: audit.committed_at, dispatchAuthorized: disposition === 'applied' });
}

function routeSnapshot(binding, item) {
  return frozen({
    ...item, target: binding.destination_ref, platform: binding.platform, destinationKind: destinationKind(binding),
    routeRevision: Number(binding.revision), routeSourceInstanceId: binding.source_instance_id,
    routePlatform: binding.platform, routeDestinationRef: binding.destination_ref,
  });
}

function finalResult(get, all, receipt, disposition) {
  const turn = get(`SELECT * FROM semantic_turn WHERE semantic_turn_id=? AND conversation_id=? AND exchange_id=? AND role='assistant'`,
    receipt.correlation_id, receipt.conversation_id, receipt.exchange_id);
  if (!turn?.active_revision_id) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'final assistant result is missing');
  const enqueued = all(`SELECT event.*, payload.payload_ref, payload.content_hash_token,
      outbox.presentation_binding_id, outbox.target AS destination_ref, outbox.source_revision,
      substr(binding_receipt.source_kind,length('package_b_presentation_binding_destination:')+1) AS destination_kind,
      binding.source_instance_id AS route_source_instance_id,
      binding.revision AS route_revision
    FROM journal_event event JOIN journal_payload payload ON payload.journal_event_id=event.journal_event_id
    JOIN presentation_outbox outbox ON outbox.presentation_outbox_id=event.correlation_id
    JOIN presentation_binding binding ON binding.presentation_binding_id=outbox.presentation_binding_id
    JOIN journal_event binding_receipt ON binding_receipt.event_type='package_b_presentation_binding_created'
      AND binding_receipt.correlation_id=binding.presentation_binding_id
    WHERE event.event_type=? AND event.causation_id=? ORDER BY event.revision,event.sequence_no`,
  `package_b_${ENQUEUED_KIND}`, receipt.journal_event_id);
  if (enqueued.length === 0 || enqueued.some((event, index) => Number(event.revision) !== index + 1)) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'final ordered presentation result is incomplete');
  }
  return frozen({
    disposition, resultId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no),
    assistantTurnId: receipt.correlation_id, assistantRevisionId: turn.active_revision_id,
    outboxIds: frozen(enqueued.map((event) => event.correlation_id)),
    presentations: frozen(enqueued.map((event) => frozen({
      outboxId: event.correlation_id, order: Number(event.revision),
      kind: event.source_kind.slice('package_b_presentation_enqueued:'.length),
      payloadRef: event.payload_ref, payloadHashToken: event.content_hash_token,
      bindingId: event.presentation_binding_id, destinationKind: event.destination_kind,
      destinationRef: event.destination_ref, routeSourceInstanceId: event.route_source_instance_id,
      routeRevision: Number(event.route_revision), sourceRevision: Number(event.source_revision),
    }))),
    operationDigest: receipt.source_ref,
  });
}

function assertCrossScopeKey(get, kind, operationKey, operationScope, parentId) {
  const elsewhere = findPackageBReceiptByOperationKey(get, kind, operationKey);
  if (elsewhere && elsewhere.correlation_id !== parentId) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', `${kind} operation key targets another parent`);
  }
  return findPackageBReceipt(get, kind, operationKey, operationScope);
}

function appendPayload(run, receipt, payloadRef, hashToken, createdAt, retentionClass = 'diagnostic') {
  run(`INSERT INTO journal_payload(
    journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,sensitivity,retention_class,created_at
  ) VALUES (?,?,'external_ref',?,?,'normal',?,?)`, `${receipt.journal_event_id}:payload`, receipt.journal_event_id,
  payloadRef, assertKeyedContentHashToken(hashToken), retentionClass, createdAt);
}

function canonicalAdapterMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coreError('CORE_PRESENTATION_METADATA_INVALID', 'adapter metadata must be a typed object');
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, item] of entries) {
    if (!METADATA_KEYS.has(key) || typeof item !== 'string') {
      throw coreError('CORE_PRESENTATION_METADATA_INVALID', 'adapter metadata contains a non-allowlisted field');
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
}

export function createPackageBPresentationRepositories({ get, all, run }) {
  function createOrReadBinding(input) {
    for (const [field, value] of [
      ['bindingId', input.bindingId], ['conversationId', input.conversationId], ['ownerId', input.ownerId],
      ['sourceInstanceId', input.sourceInstanceId], ['platform', input.platform],
      ['destinationKind', input.destinationKind],
      ['destinationRef', input.destinationRef], ['createdAt', input.createdAt],
    ]) assertNonEmptyString(value, field);
    assertPackageBOperationKey(input.operationKey);
    const identity = get(`SELECT * FROM journal_event WHERE event_type=? AND conversation_id=? AND owner_id=?`,
      `package_b_${IDENTITY_KIND}`, input.conversationId, input.ownerId);
    if (!identity) throw coreError('CORE_CONVERSATION_NOT_FOUND', 'presentation binding requires a validated Conversation identity');
    const metadata = canonicalAdapterMetadata(input.adapterMetadata);
    const digest = presentationBindingOperationDigest({ ...input, adapterMetadataCanonical: metadata });
    const operationScope = bindingScope(input.bindingId);
    const elsewhere = findPackageBReceiptByOperationKey(get, BINDING_KIND, input.operationKey);
    if (elsewhere && (elsewhere.conversation_id !== input.conversationId || elsewhere.correlation_id !== input.bindingId)) {
      throw coreError('CORE_OPERATION_KEY_CONFLICT', 'presentation binding operation key targets another parent');
    }
    const prior = findPackageBReceipt(get, BINDING_KIND, input.operationKey, operationScope);
    if (prior) {
      assertPackageBReceipt(prior, digest, 'presentation binding');
      const binding = get('SELECT * FROM presentation_binding WHERE presentation_binding_id=? AND conversation_id=?',
        input.bindingId, input.conversationId);
      if (!binding) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'presentation binding result is missing');
      return frozen({ disposition: 'already_applied', binding, resultId: prior.journal_event_id,
        journalSequence: Number(prior.sequence_no), operationDigest: prior.source_ref });
    }
    const existing = get(`SELECT * FROM presentation_binding WHERE source_instance_id=? AND platform=? AND destination_ref=?`,
      input.sourceInstanceId, input.platform, input.destinationRef);
    if (existing) {
      if (existing.conversation_id !== input.conversationId || existing.adapter_metadata_json !== metadata
        || existing.presentation_binding_id !== input.bindingId) {
        throw coreError('CORE_PRESENTATION_BINDING_CONFLICT', 'presentation route belongs to a different Conversation or metadata');
      }
      throw coreError('CORE_OPERATION_KEY_CONFLICT', 'presentation binding exists without this operation receipt');
    }
    run(`INSERT INTO presentation_binding(
      presentation_binding_id,conversation_id,source_instance_id,platform,destination_ref,
      adapter_metadata_json,state,revision,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,'active',0,?,?)`, input.bindingId, input.conversationId, input.sourceInstanceId,
    input.platform, input.destinationRef, metadata, input.createdAt, input.createdAt);
    const receipt = appendPackageBReceipt(run, get, {
      kind: BINDING_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
      resultId: input.bindingId, ownerId: input.ownerId, conversationId: input.conversationId,
      actorRef: input.sourceInstanceId, sourceKind: `package_b_presentation_binding_destination:${input.destinationKind}`,
      createdAt: input.createdAt,
    });
    return frozen({ disposition: 'applied', binding: get('SELECT * FROM presentation_binding WHERE presentation_binding_id=?', input.bindingId),
      resultId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no), operationDigest: receipt.source_ref });
  }
  function appendAssistantFinal(input) {
    run(`INSERT INTO semantic_turn(
      semantic_turn_id,conversation_id,exchange_id,actor_ref,role,active_revision_id,commit_state,visibility,created_at
    ) VALUES (?,?,?,?, 'assistant',NULL,'committed','visible',?)`, input.assistantTurnId, input.conversationId,
    input.exchangeId, input.assistantActorRef, input.committedAt);
    run(`INSERT INTO turn_revision(
      turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,content_hash_token,source_event_id,supersedes_revision_id,created_at
    ) VALUES (?,?,1,'initial',?,?,?,NULL,?)`, input.assistantRevisionId, input.assistantTurnId,
    input.finalPayloadRef, input.finalPayloadHashToken, input.providerAttemptReceiptId, input.committedAt);
    const activated = run(`UPDATE semantic_turn SET active_revision_id=? WHERE semantic_turn_id=? AND active_revision_id IS NULL`,
      input.assistantRevisionId, input.assistantTurnId);
    if (activated.changes !== 1) throw coreError('CORE_TURN_REVISION_STALE', 'assistant final revision cannot be activated');
  }

  function enqueue(input) {
    run(`INSERT INTO presentation_outbox(
      presentation_outbox_id,operation_scope,operation_key,conversation_id,semantic_turn_id,source_revision,
      presentation_binding_id,target,payload_ref,state,revision,attempt_count,next_attempt_at,lease_owner,lease_until,
      fence_token,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,0,NULL,NULL,NULL,0,?,?)`, input.outboxId, input.operationScope,
    input.operationKey, input.conversationId, input.semanticTurnId, 1, input.bindingId, input.target,
    input.payloadRef, input.committedAt, input.committedAt);
  }

  const finalRepository = frozen({
    commit(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedExchangeRevision, 'expected Exchange revision');
      assertNonNegativeInteger(input.expectedProviderEpochRevision, 'expected provider epoch revision');
      assertNonNegativeInteger(input.providerAttempt, 'provider attempt');
      assertKeyedContentHashToken(input.finalPayloadHashToken);
      if (!Array.isArray(input.presentations) || input.presentations.length === 0) {
        throw coreError('CORE_PRESENTATION_REQUIRED', 'final commit requires at least one presentation');
      }
      const exchange = get('SELECT * FROM exchange WHERE exchange_id=? AND conversation_id=?', input.exchangeId, input.conversationId);
      const source = get(`SELECT turn.active_revision_id,turn.role,revision.revision FROM semantic_turn turn
        JOIN turn_revision revision ON revision.turn_revision_id=turn.active_revision_id
        WHERE turn.semantic_turn_id=? AND turn.exchange_id=? AND turn.conversation_id=?`,
      input.sourceTurnId, input.exchangeId, input.conversationId);
      const epoch = get('SELECT * FROM provider_epoch WHERE provider_epoch_id=? AND conversation_id=?', input.providerEpochId, input.conversationId);
      const attempt = get(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND correlation_id=?
        AND exchange_id=? AND actor_ref=? AND revision=?`, input.providerAttemptReceiptId, `package_b_provider_attempt_recorded`,
      input.providerEpochId, input.exchangeId, input.sourceTurnId, input.providerAttempt);
      const presentations = input.presentations.map((item) => {
        for (const [field, value] of [['outboxId', item.outboxId], ['operationScope', item.operationScope],
          ['operationKey', item.operationKey], ['bindingId', item.bindingId], ['kind', item.kind], ['payloadRef', item.payloadRef]]) {
          assertNonEmptyString(value, field);
        }
        for (const [field, value] of [['target', item.target], ['platform', item.platform],
          ['destinationKind', item.destinationKind], ['routeSourceInstanceId', item.routeSourceInstanceId]]) {
          if (value !== undefined) assertNonEmptyString(value, field);
        }
        assertPackageBOperationKey(item.operationKey);
        assertKeyedContentHashToken(item.payloadHashToken);
        const binding = get(`SELECT binding.*, receipt.source_kind AS binding_source_kind FROM presentation_binding binding
          JOIN journal_event receipt ON receipt.event_type=? AND receipt.correlation_id=binding.presentation_binding_id
          WHERE binding.presentation_binding_id=? AND binding.conversation_id=? AND binding.state='active'`,
          `package_b_${BINDING_KIND}`,
          item.bindingId, input.conversationId);
        if (!binding) throw coreError('CORE_PRESENTATION_BINDING_INVALID', 'final presentation binding is missing or inactive');
        if ((item.target !== undefined && item.target !== binding.destination_ref)
          || (item.platform !== undefined && item.platform !== binding.platform)
          || (item.destinationKind !== undefined && item.destinationKind !== destinationKind(binding))
          || (item.routeSourceInstanceId !== undefined && item.routeSourceInstanceId !== binding.source_instance_id)
          || (item.routeRevision !== undefined && item.routeRevision !== Number(binding.revision))) {
          throw coreError('CORE_PRESENTATION_BINDING_CONFLICT', 'presentation route assertion differs from its binding');
        }
        return routeSnapshot(binding, item);
      });
      const digest = finalCommitOperationDigest({ ...input, presentations });
      const operationScope = finalScope(input.conversationId, input.exchangeId);
      const prior = assertCrossScopeKey(get, FINAL_KIND, input.operationKey, operationScope, input.assistantTurnId);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'final semantic commit');
        return finalResult(get, all, prior, 'already_applied');
      }
      if (source?.role === 'system') {
        const authority = assertScheduledWorkAuthority(get, input.workRunAuthority, {
          exchangeId: input.exchangeId,
          sourceTurnId: input.sourceTurnId,
          activeAt: input.committedAt,
        });
        if (epoch?.active_speculative_work_run_id !== authority.workRunId) {
          throw coreError('CORE_FINAL_SOURCE_STALE', 'scheduled final is not bound to its provider Work Run');
        }
      } else if (source?.role !== 'user' || input.workRunAuthority !== undefined
        || epoch?.active_speculative_work_run_id !== null) {
        throw coreError('CORE_FINAL_SOURCE_STALE', 'final source role and Work Run authority disagree');
      }
      if (!exchange || Number(exchange.revision) !== input.expectedExchangeRevision || exchange.root_instruction_turn_id !== input.sourceTurnId
        || !source || Number(source.revision) !== input.sourceRevision || !epoch || Number(epoch.revision) !== input.expectedProviderEpochRevision || !attempt) {
        throw coreError('CORE_FINAL_SOURCE_STALE', 'final commit source, exchange, epoch or attempt is stale');
      }
      if (get('SELECT 1 AS found FROM semantic_turn WHERE semantic_turn_id=?', input.assistantTurnId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'assistant turn identity is already used');
      }
      for (const item of presentations) {
        if (get(`SELECT 1 AS found FROM presentation_outbox WHERE presentation_outbox_id=? OR (operation_scope=? AND operation_key=?)`,
          item.outboxId, item.operationScope, item.operationKey)) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'presentation identity is already used');
        }
      }
      appendAssistantFinal(input);
      for (const item of presentations) enqueue({ ...item, conversationId: input.conversationId, semanticTurnId: input.assistantTurnId, committedAt: input.committedAt });
      const finalReceiptId = packageBReceiptEventId(FINAL_KIND, input.operationKey, operationScope);
      for (const [index, item] of presentations.entries()) {
        const receipt = appendPackageBReceipt(run, get, {
          kind: ENQUEUED_KIND, operationKey: `${input.operationKey}:enqueue:${index + 1}`,
          operationScope, operationDigest: digest, resultId: item.outboxId, conversationId: input.conversationId,
          exchangeId: input.exchangeId, actorRef: input.assistantTurnId, revision: index + 1,
          causationId: finalReceiptId, sourceKind: `package_b_presentation_enqueued:${item.kind}`, createdAt: input.committedAt,
        });
        appendPayload(run, receipt, item.payloadRef, item.payloadHashToken, input.committedAt, 'canonical');
      }
      const receipt = appendPackageBReceipt(run, get, {
        kind: FINAL_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assistantTurnId, conversationId: input.conversationId, exchangeId: input.exchangeId,
        actorRef: input.assistantActorRef, revision: 1, causationId: input.providerAttemptReceiptId, createdAt: input.committedAt,
      });
      return finalResult(get, all, receipt, 'applied');
    },
  });

  function recordTerminal(input, { kind = RESULT_KIND, expectedState = 'reserved' } = {}) {
    assertPackageBOperationKey(input.operationKey);
    if (!['sent', 'failed', 'ambiguous'].includes(input.resultState)) throw coreError('CORE_PRESENTATION_RESULT_INVALID', 'presentation result state is invalid');
    assertKeyedContentHashToken(input.evidenceHashToken);
    const outbox = get('SELECT * FROM presentation_outbox WHERE presentation_outbox_id=?', input.outboxId);
    if (!outbox) return null;
    const digest = presentationResultOperationDigest({ ...input, leaseOwner: input.leaseOwner ?? outbox.lease_owner });
    const operationScope = outboxScope(input.outboxId);
    const prior = assertCrossScopeKey(get, kind, input.operationKey, operationScope, input.outboxId);
    if (prior) {
      assertPackageBReceipt(prior, digest, 'presentation result');
      return receiptResult(prior, 'already_applied');
    }
    if (outbox.state !== expectedState || Number(outbox.fence_token) !== input.fenceToken) return null;
    if (expectedState === 'reserved') {
      if (outbox.lease_owner !== input.leaseOwner || outbox.lease_until <= input.recordedAt || Number(outbox.revision) !== input.expectedRevision) return null;
      const started = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND revision=?`,
        `package_b_${DISPATCH_STARTED_KIND}`, input.outboxId, input.fenceToken);
      if (!started || started.actor_ref !== input.leaseOwner) throw coreError('CORE_PRESENTATION_DISPATCH_NOT_STARTED', 'presentation result requires a durable dispatch-start boundary');
    }
    const updated = expectedState === 'reserved'
      ? run(`UPDATE presentation_outbox SET state=?,lease_owner=NULL,lease_until=NULL,attempt_count=attempt_count+1,revision=revision+1,updated_at=?
        WHERE presentation_outbox_id=? AND state='reserved' AND revision=? AND fence_token=? AND lease_owner=?`,
      input.resultState, input.recordedAt, input.outboxId, input.expectedRevision, input.fenceToken, input.leaseOwner)
      : run(`UPDATE presentation_outbox SET state=?,revision=revision+1,updated_at=?
        WHERE presentation_outbox_id=? AND state='ambiguous' AND revision=? AND fence_token=?`,
      input.resultState, input.recordedAt, input.outboxId, input.expectedRevision, input.fenceToken);
    if (updated.changes !== 1) return null;
    const receipt = appendPackageBReceipt(run, get, {
      kind, operationKey: input.operationKey, operationScope, operationDigest: digest, resultId: input.outboxId,
      conversationId: outbox.conversation_id, actorRef: input.leaseOwner ?? null, revision: input.fenceToken,
      causationId: input.claimOperationKey, sourceKind: `package_b_presentation_result:${input.resultState}`, createdAt: input.recordedAt,
    });
    appendPayload(run, receipt, input.evidenceRef, input.evidenceHashToken, input.recordedAt);
    return receiptResult(receipt, 'applied');
  }

  const presentationRepository = frozen({
    createOrReadBinding,

    claim(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedRevision, 'expected presentation revision');
      assertNonNegativeInteger(input.expectedFence, 'expected presentation fence');
      if (input.workerId !== input.leaseOwner || input.leaseUntil <= input.claimedAt) throw coreError('CORE_PRESENTATION_CLAIM_INVALID', 'claim requires matching worker ownership and future lease');
      const outbox = get('SELECT * FROM presentation_outbox WHERE presentation_outbox_id=?', input.outboxId);
      if (!outbox) return null;
      const digest = presentationClaimOperationDigest({ ...input, assistantTurnId: outbox.semantic_turn_id,
        sourceRevision: Number(outbox.source_revision), bindingId: outbox.presentation_binding_id, target: outbox.target });
      const operationScope = outboxScope(input.outboxId);
      const prior = assertCrossScopeKey(get, CLAIM_KIND, input.operationKey, operationScope, input.outboxId);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'presentation claim');
        const audit = get(`SELECT * FROM fence WHERE domain='presentation_outbox' AND presentation_outbox_id=? AND operation_key=?`,
          input.outboxId, input.operationKey);
        const result = claimResult(audit, 'already_applied');
        return frozen({ ...result, resultId: prior.journal_event_id, dispatchAuthorized: false });
      }
      const recovered = findPackageBReceipt(get, CLAIM_RECOVERY_KIND, input.operationKey, operationScope);
      if (recovered) {
        assertPackageBReceipt(recovered, digest, 'presentation claim recovery');
        return frozen({ disposition: 'already_applied', resultId: recovered.journal_event_id, outboxId: input.outboxId,
          revision: Number(outbox.revision), fenceToken: Number(recovered.revision), operationDigest: recovered.source_ref,
          dispatchAuthorized: false });
      }
      if (['sent', 'failed', 'ambiguous', 'cancelled'].includes(outbox.state)) {
        return frozen({ disposition: 'terminal_not_claimable', outboxId: input.outboxId,
          revision: Number(outbox.revision), fenceToken: Number(outbox.fence_token), state: outbox.state,
          operationDigest: digest, dispatchAuthorized: false });
      }
      if (outbox.state === 'reserved' && outbox.lease_until <= input.claimedAt) {
        const started = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND revision=?`,
          `package_b_${DISPATCH_STARTED_KIND}`, input.outboxId, input.expectedFence);
        if (started) {
          const ambiguous = run(`UPDATE presentation_outbox SET state='ambiguous',lease_owner=NULL,lease_until=NULL,attempt_count=attempt_count+1,revision=revision+1,updated_at=?
            WHERE presentation_outbox_id=? AND state='reserved' AND revision=? AND fence_token=?`, input.claimedAt,
          input.outboxId, input.expectedRevision, input.expectedFence);
          if (ambiguous.changes !== 1) return null;
          const receipt = appendPackageBReceipt(run, get, {
            kind: CLAIM_RECOVERY_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
            resultId: input.outboxId, conversationId: outbox.conversation_id, actorRef: input.leaseOwner,
            revision: input.expectedFence, causationId: started.journal_event_id,
            sourceKind: 'package_b_presentation_recovery:ambiguous', createdAt: input.claimedAt,
          });
          return frozen({ disposition: 'dispatch_state_ambiguous', resultId: receipt.journal_event_id, outboxId: input.outboxId,
            revision: input.expectedRevision + 1, fenceToken: input.expectedFence, operationDigest: digest, dispatchAuthorized: false });
        }
      }
      const updated = run(`UPDATE presentation_outbox SET state='reserved',lease_owner=?,lease_until=?,revision=revision+1,
        fence_token=fence_token+1,fence_reason_code='presentation_claim',fence_causation_id=?,fence_operation_key=?,
        fence_operation_digest=?,fence_committed_at=?,updated_at=?
        WHERE presentation_outbox_id=? AND revision=? AND fence_token=? AND (state='pending' OR (state='reserved' AND lease_until<=?))`,
      input.leaseOwner, input.leaseUntil, input.causationEventId, input.operationKey, digest, input.claimedAt, input.claimedAt,
      input.outboxId, input.expectedRevision, input.expectedFence, input.claimedAt);
      if (updated.changes !== 1) return null;
      const audit = get(`SELECT * FROM fence WHERE domain='presentation_outbox' AND presentation_outbox_id=? AND operation_key=?`,
        input.outboxId, input.operationKey);
      const receipt = appendPackageBReceipt(run, get, {
        kind: CLAIM_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest, resultId: input.outboxId,
        conversationId: outbox.conversation_id, actorRef: input.leaseOwner, revision: Number(audit.new_fence), causationId: input.causationEventId,
        sourceKind: 'package_b_presentation_claim:reserved', createdAt: input.claimedAt,
      });
      return frozen({ ...claimResult(audit), resultId: receipt.journal_event_id });
    },

    markDispatchStarted(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedRevision, 'expected presentation revision');
      const outbox = get('SELECT * FROM presentation_outbox WHERE presentation_outbox_id=?', input.outboxId);
      if (!outbox) return null;
      const operationScope = outboxScope(input.outboxId);
      const claim = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND revision=?`,
        `package_b_${CLAIM_KIND}`, input.outboxId, input.fenceToken);
      const claimDigest = outbox.fence_operation_digest;
      const digest = presentationDispatchStartOperationDigest({ ...input, claimOperationDigest: claimDigest });
      const prior = assertCrossScopeKey(get, DISPATCH_STARTED_KIND, input.operationKey, operationScope, input.outboxId);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'presentation dispatch start');
        return receiptResult(prior, 'already_applied', false);
      }
      if (!claim || claim.origin_ref !== input.claimOperationKey || !claimDigest
        || outbox.state !== 'reserved' || Number(outbox.revision) !== input.expectedRevision
        || Number(outbox.fence_token) !== input.fenceToken || outbox.lease_owner !== input.leaseOwner
        || outbox.lease_until <= input.startedAt || outbox.fence_operation_key !== input.claimOperationKey) return null;
      const started = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND revision=?`,
        `package_b_${DISPATCH_STARTED_KIND}`, input.outboxId, input.fenceToken);
      if (started) return receiptResult(started, 'already_applied', false);
      const receipt = appendPackageBReceipt(run, get, {
        kind: DISPATCH_STARTED_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.outboxId, conversationId: outbox.conversation_id, actorRef: input.leaseOwner,
        revision: input.fenceToken, causationId: claim.journal_event_id, sourceKind: 'package_b_presentation_dispatch:started', createdAt: input.startedAt,
      });
      return receiptResult(receipt, 'applied', true);
    },

    recordResult: (input) => recordTerminal(input),
    reconcile(input) {
      if (!['sent', 'failed'].includes(input.resultState)) throw coreError('CORE_PRESENTATION_RECONCILIATION_INVALID', 'reconciliation must resolve ambiguous to sent or failed');
      return recordTerminal(input, { kind: RECONCILE_KIND, expectedState: 'ambiguous' });
    },
  });

  return frozen({ finalRepository, presentationRepository });
}

export function createPackageBPresentationReader({ read, all }) {
  return frozen({
    binding: ({ identity, conversationId, bindingId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT binding.*,
        substr(receipt.source_kind,length('package_b_presentation_binding_destination:')+1) AS destination_kind
        FROM presentation_binding binding JOIN journal_event receipt ON receipt.event_type=?
          AND receipt.correlation_id=binding.presentation_binding_id
        WHERE binding.presentation_binding_id=? AND binding.conversation_id=?`,
      `package_b_${BINDING_KIND}`, bindingId, conversationId),
    bindingReceipt: ({ identity, conversationId, bindingId, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND correlation_id=? AND source_ref=?`, packageBReceiptEventId(BINDING_KIND, operationKey, bindingScope(bindingId)),
      `package_b_${BINDING_KIND}`, conversationId, bindingId, operationDigest),
    outbox: ({ identity, conversationId, outboxId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT outbox.*, event.revision AS stable_item_order,
      substr(event.source_kind,length('package_b_presentation_enqueued:')+1) AS presentation_kind,
      payload.content_hash_token AS payload_hash_token,
      substr(binding_receipt.source_kind,length('package_b_presentation_binding_destination:')+1) AS destination_kind,
      binding.destination_ref AS destination_ref, binding.source_instance_id AS route_source_instance_id,
      binding.platform AS route_platform, binding.revision AS route_revision
      FROM presentation_outbox outbox
      JOIN journal_event event ON event.event_type=? AND event.correlation_id=outbox.presentation_outbox_id
      JOIN journal_payload payload ON payload.journal_event_id=event.journal_event_id
      JOIN presentation_binding binding ON binding.presentation_binding_id=outbox.presentation_binding_id
      JOIN journal_event binding_receipt ON binding_receipt.event_type='package_b_presentation_binding_created'
        AND binding_receipt.correlation_id=binding.presentation_binding_id
      WHERE outbox.presentation_outbox_id=? AND outbox.conversation_id=?`,
    `package_b_${ENQUEUED_KIND}`, outboxId, conversationId),
    byAssistantTurn: ({ identity, conversationId, exchangeId, turnId }) => readVerifiedConversationIdentity(read, identity, conversationId) ? all(`SELECT outbox.*,
      event.revision AS stable_item_order,
      substr(event.source_kind,length('package_b_presentation_enqueued:')+1) AS presentation_kind,
      payload.content_hash_token AS payload_hash_token,
      substr(binding_receipt.source_kind,length('package_b_presentation_binding_destination:')+1) AS destination_kind,
      binding.destination_ref AS destination_ref, binding.source_instance_id AS route_source_instance_id,
      binding.platform AS route_platform, binding.revision AS route_revision
      FROM presentation_outbox outbox
      JOIN semantic_turn turn ON turn.semantic_turn_id=outbox.semantic_turn_id
      JOIN journal_event event ON event.event_type=? AND event.correlation_id=outbox.presentation_outbox_id
      JOIN journal_payload payload ON payload.journal_event_id=event.journal_event_id
      JOIN presentation_binding binding ON binding.presentation_binding_id=outbox.presentation_binding_id
      JOIN journal_event binding_receipt ON binding_receipt.event_type='package_b_presentation_binding_created'
        AND binding_receipt.correlation_id=binding.presentation_binding_id
      WHERE outbox.semantic_turn_id=? AND outbox.conversation_id=? AND turn.exchange_id=?
      ORDER BY event.revision,event.sequence_no`,
    `package_b_${ENQUEUED_KIND}`, turnId, conversationId, exchangeId) : [],
    claimReceipt: ({ identity, conversationId, outboxId, operationKey, operationDigest, fenceToken }) => Number.isSafeInteger(fenceToken)
      && readVerifiedConversationIdentity(read, identity, conversationId)
      && (read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND correlation_id=? AND source_ref=? AND revision=?`,
    packageBReceiptEventId(CLAIM_KIND, operationKey, outboxScope(outboxId)), `package_b_${CLAIM_KIND}`,
    conversationId, outboxId, operationDigest, fenceToken)
      ?? read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND correlation_id=? AND source_ref=? AND revision=?`, packageBReceiptEventId(CLAIM_RECOVERY_KIND, operationKey, outboxScope(outboxId)),
      `package_b_${CLAIM_RECOVERY_KIND}`, conversationId, outboxId, operationDigest, fenceToken)),
    dispatchStarted: ({ identity, conversationId, outboxId, operationKey, operationDigest, fenceToken }) => Number.isSafeInteger(fenceToken)
      && readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND correlation_id=? AND source_ref=? AND revision=?`,
    packageBReceiptEventId(DISPATCH_STARTED_KIND, operationKey, outboxScope(outboxId)),
    `package_b_${DISPATCH_STARTED_KIND}`, conversationId, outboxId, operationDigest, fenceToken),
    resultReceipt: ({ identity, conversationId, outboxId, operationKey, operationDigest, fenceToken }) => {
      if (!Number.isSafeInteger(fenceToken) || !readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
      const scope = outboxScope(outboxId);
      return read(`SELECT * FROM journal_event
        WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND correlation_id=? AND source_ref=? AND revision=?`,
      packageBReceiptEventId(RESULT_KIND, operationKey, scope), `package_b_${RESULT_KIND}`,
      conversationId, outboxId, operationDigest, fenceToken)
        ?? read(`SELECT * FROM journal_event
          WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND correlation_id=? AND source_ref=? AND revision=?`,
        packageBReceiptEventId(RECONCILE_KIND, operationKey, scope), `package_b_${RECONCILE_KIND}`,
        conversationId, outboxId, operationDigest, fenceToken);
    },
    enqueueReceipt: ({ identity, conversationId, exchangeId, outboxId, finalOperationKey, itemOrder, operationDigest }) => {
      if (!readVerifiedConversationIdentity(read, identity, conversationId)
        || !Number.isSafeInteger(itemOrder) || itemOrder < 1) return undefined;
      const operationScope = finalScope(conversationId, exchangeId);
      const finalId = packageBReceiptEventId(FINAL_KIND, finalOperationKey, operationScope);
      return read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND exchange_id=? AND correlation_id=? AND causation_id=? AND revision=? AND source_ref=?`,
      packageBReceiptEventId(ENQUEUED_KIND, `${finalOperationKey}:enqueue:${itemOrder}`, operationScope),
      `package_b_${ENQUEUED_KIND}`, conversationId, exchangeId, outboxId, finalId, itemOrder, operationDigest);
    },
  });
}

export function createPackageBFinalReader({ read, all }) {
  return frozen({
    byOperation: ({ identity, conversationId, exchangeId, operationKey, operationDigest }) => {
      if (!readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
      const receipt = read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND exchange_id=? AND source_ref=?`,
        packageBReceiptEventId(FINAL_KIND, operationKey, finalScope(conversationId, exchangeId)), `package_b_${FINAL_KIND}`,
        conversationId, exchangeId, operationDigest);
      if (!receipt) return undefined;
      const enqueued = all(`SELECT event.*, payload.payload_ref, payload.content_hash_token,
        outbox.presentation_binding_id, outbox.target AS destination_ref,
        substr(binding_receipt.source_kind,length('package_b_presentation_binding_destination:')+1) AS destination_kind,
        binding.source_instance_id AS route_source_instance_id,
        binding.revision AS route_revision
        FROM journal_event event JOIN journal_payload payload ON payload.journal_event_id=event.journal_event_id
        JOIN presentation_outbox outbox ON outbox.presentation_outbox_id=event.correlation_id
        JOIN presentation_binding binding ON binding.presentation_binding_id=outbox.presentation_binding_id
        JOIN journal_event binding_receipt ON binding_receipt.event_type='package_b_presentation_binding_created'
          AND binding_receipt.correlation_id=binding.presentation_binding_id
        WHERE event.event_type=? AND event.causation_id=? ORDER BY event.revision,event.sequence_no`,
      `package_b_${ENQUEUED_KIND}`, receipt.journal_event_id);
      return frozen({ receipt, enqueued: frozen(enqueued) });
    },
  });
}
