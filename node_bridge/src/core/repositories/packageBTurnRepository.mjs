import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import {
  conversationIdentityOperationDigest,
  foregroundExchangeOperationDigest,
  userTurnOperationDigest,
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

const IDENTITY_KIND = 'conversation_identity_bound';
const USER_COMMIT_KIND = 'semantic_user_turn_committed';
const USER_REVISION_KIND = 'semantic_user_revision_committed';
const FOREGROUND_KIND = 'foreground_exchange_bound';
const VALIDATED_PLATFORMS = new Set(['wechat', 'feishu', 'desktop', 'telegram']);

function identityScope() { return 'conversation_identity'; }
function userScope(conversationId, exchangeId) { return `user_turn:${conversationId}:${exchangeId}`; }
function foregroundScope(conversationId) { return `foreground_exchange:${conversationId}`; }

function identityFromReceipt(receipt) {
  const platform = receipt.source_kind.startsWith('package_b_conversation_identity:')
    ? receipt.source_kind.slice('package_b_conversation_identity:'.length)
    : null;
  if (!platform || !receipt.conversation_id || !receipt.owner_id || !receipt.actor_ref
    || !receipt.origin_ref || !receipt.causation_id || !receipt.correlation_id) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'Conversation identity receipt is incomplete');
  }
  return frozen({
    identityRevision: Number(receipt.revision), canonicalConversationKey: receipt.origin_ref,
    identityReceiptId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no),
    conversationId: receipt.conversation_id, ownerId: receipt.owner_id, actorRef: receipt.actor_ref,
    platform, sourceInstanceId: receipt.causation_id, platformConversationBinding: receipt.correlation_id,
    operationDigest: receipt.source_ref, createdAt: receipt.created_at,
  });
}

function userResult(receipt, disposition) {
  return frozen({
    disposition, resultId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no),
    conversationId: receipt.conversation_id, exchangeId: receipt.exchange_id,
    semanticTurnId: receipt.actor_ref, sourceRevision: Number(receipt.revision),
    operationDigest: receipt.source_ref,
  });
}

function assertScopedKey(get, kind, operationKey, operationScope, conversationId, exchangeId) {
  const elsewhere = findPackageBReceiptByOperationKey(get, kind, operationKey);
  if (elsewhere && (elsewhere.conversation_id !== conversationId || elsewhere.exchange_id !== exchangeId)) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', `${kind} operation key targets another parent scope`);
  }
  return findPackageBReceipt(get, kind, operationKey, operationScope);
}

export function createPackageBTurnRepository({ get, run }) {
  return frozen({
    createOrResolveConversation(input) {
      for (const [field, value] of [
        ['conversationId', input.conversationId], ['canonicalConversationKey', input.canonicalConversationKey],
        ['ownerId', input.ownerId], ['actorRef', input.actorRef], ['platform', input.platform],
        ['sourceInstanceId', input.sourceInstanceId], ['platformConversationBinding', input.platformConversationBinding],
        ['primaryFrontend', input.primaryFrontend], ['createdAt', input.createdAt],
      ]) assertNonEmptyString(value, field);
      if (!VALIDATED_PLATFORMS.has(input.platform) || input.primaryFrontend !== input.platform) {
        throw coreError('CORE_CONVERSATION_IDENTITY_INVALID', 'Conversation identity must contain a validated platform binding');
      }
      const digest = conversationIdentityOperationDigest(input);
      const eventId = packageBReceiptEventId(IDENTITY_KIND, input.canonicalConversationKey, identityScope());
      const receipt = get('SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=?', eventId, `package_b_${IDENTITY_KIND}`);
      if (receipt) {
        assertPackageBReceipt(receipt, digest, 'Conversation identity');
        const identity = identityFromReceipt(receipt);
        const conversation = get('SELECT * FROM conversation WHERE conversation_id=? AND owner_id=?', identity.conversationId, identity.ownerId);
        if (!conversation) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'Conversation identity points to a missing Conversation');
        return frozen({ disposition: 'already_applied', conversation, identity });
      }
      const existing = get('SELECT * FROM conversation WHERE conversation_id=?', input.conversationId);
      if (existing) throw coreError('CORE_CONVERSATION_IDENTITY_CONFLICT', 'Conversation ID is already bound to another identity');
      run(`INSERT INTO conversation(
        conversation_id,owner_id,state,primary_frontend,visibility_scope,revision,created_at,updated_at
      ) VALUES (?,?,'active',?,'owner',0,?,?)`, input.conversationId, input.ownerId,
      input.primaryFrontend, input.createdAt, input.createdAt);
      const identityReceipt = appendPackageBReceipt(run, get, {
        kind: IDENTITY_KIND, operationKey: input.canonicalConversationKey, operationScope: identityScope(),
        operationDigest: digest, resultId: input.conversationId, ownerId: input.ownerId,
        conversationId: input.conversationId, actorRef: input.actorRef, revision: 1,
        causationId: input.sourceInstanceId, correlationId: input.platformConversationBinding,
        sourceKind: `package_b_conversation_identity:${input.platform}`, createdAt: input.createdAt,
      });
      return frozen({
        disposition: 'applied', conversation: get('SELECT * FROM conversation WHERE conversation_id=?', input.conversationId),
        identity: identityFromReceipt(identityReceipt),
      });
    },

    commitUserTurn(input) {
      assertPackageBOperationKey(input.operationKey);
      assertKeyedContentHashToken(input.payloadHashToken);
      const conversation = get('SELECT * FROM conversation WHERE conversation_id=?', input.conversationId);
      const identityReceipt = get(`SELECT * FROM journal_event WHERE event_type=? AND conversation_id=?`,
        `package_b_${IDENTITY_KIND}`, input.conversationId);
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=? AND state=\'sealed\'', input.assemblyId, input.conversationId);
      const activeIngress = get(`SELECT * FROM turn_assembly_part WHERE turn_assembly_id=? AND ingress_event_id=? AND state='active'`, input.assemblyId, input.ingressEventId);
      if (!conversation || !identityReceipt || !assembly || !activeIngress || input.actorRef !== identityReceipt.actor_ref) {
        throw coreError('CORE_USER_TURN_PARENT_INVALID', 'user turn requires a sealed, identity-scoped assembly part');
      }
      const digest = userTurnOperationDigest({ ...input, sourceRevision: 1, changeKind: 'initial', supersedesRevisionId: null });
      const operationScope = userScope(input.conversationId, input.exchangeId);
      const prior = assertScopedKey(get, USER_COMMIT_KIND, input.operationKey, operationScope, input.conversationId, input.exchangeId);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'semantic user turn');
        return userResult(prior, 'already_applied');
      }
      if (get('SELECT 1 AS found FROM exchange WHERE exchange_id=?', input.exchangeId)
        || get('SELECT 1 AS found FROM semantic_turn WHERE semantic_turn_id=?', input.semanticTurnId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'Exchange or user turn identity is already used');
      }
      run(`INSERT INTO exchange(
        exchange_id,conversation_id,ingress_event_id,root_instruction_turn_id,state,priority,revision,created_at,updated_at
      ) VALUES (?,?,?,NULL,'open','normal',0,?,?)`, input.exchangeId, input.conversationId,
      input.ingressEventId, input.committedAt, input.committedAt);
      run(`INSERT INTO semantic_turn(
        semantic_turn_id,conversation_id,exchange_id,actor_ref,role,active_revision_id,commit_state,visibility,created_at
      ) VALUES (?,?,?,?, 'user',NULL,'committed','visible',?)`, input.semanticTurnId, input.conversationId,
      input.exchangeId, input.actorRef, input.committedAt);
      run(`INSERT INTO turn_revision(
        turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,content_hash_token,source_event_id,supersedes_revision_id,created_at
      ) VALUES (?,?,1,'initial',?,?,?,NULL,?)`, input.turnRevisionId, input.semanticTurnId,
      input.payloadRef, input.payloadHashToken, input.sourceEventId, input.committedAt);
      run(`UPDATE semantic_turn SET active_revision_id=? WHERE semantic_turn_id=? AND active_revision_id IS NULL`, input.turnRevisionId, input.semanticTurnId);
      run(`UPDATE exchange SET root_instruction_turn_id=?,revision=revision+1,updated_at=?
        WHERE exchange_id=? AND conversation_id=? AND revision=0`, input.semanticTurnId, input.committedAt,
      input.exchangeId, input.conversationId);
      const receipt = appendPackageBReceipt(run, get, {
        kind: USER_COMMIT_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.semanticTurnId, ownerId: conversation.owner_id, conversationId: input.conversationId,
        exchangeId: input.exchangeId, actorRef: input.semanticTurnId, revision: 1,
        causationId: input.sourceEventId, createdAt: input.committedAt,
      });
      return userResult(receipt, 'applied');
    },

    appendUserRevision(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedCurrentRevision, 'expected current user revision');
      assertKeyedContentHashToken(input.payloadHashToken);
      const turn = get(`SELECT * FROM semantic_turn WHERE semantic_turn_id=? AND conversation_id=? AND exchange_id=? AND role='user'`,
        input.semanticTurnId, input.conversationId, input.exchangeId);
      if (!turn) throw coreError('CORE_TURN_ROLE_FORBIDDEN', 'only user turns can receive public revisions');
      const nextRevision = input.expectedCurrentRevision + 1;
      const digest = userTurnOperationDigest({
        ...input, sourceRevision: nextRevision, changeKind: input.changeKind,
        supersedesRevisionId: input.expectedCurrentRevisionId,
      });
      const operationScope = userScope(input.conversationId, input.exchangeId);
      const prior = assertScopedKey(get, USER_REVISION_KIND, input.operationKey, operationScope, input.conversationId, input.exchangeId);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'semantic user revision');
        return userResult(prior, 'already_applied');
      }
      const current = get('SELECT * FROM turn_revision WHERE turn_revision_id=? AND semantic_turn_id=?', turn.active_revision_id, input.semanticTurnId);
      if (!current || Number(current.revision) !== input.expectedCurrentRevision
        || current.turn_revision_id !== input.expectedCurrentRevisionId) return null;
      const epoch = get(`SELECT 1 AS found FROM journal_event
        WHERE event_type='package_b_provider_epoch_created' AND conversation_id=? AND exchange_id=?
          AND actor_ref=? AND revision=?`, input.conversationId, input.exchangeId,
      input.semanticTurnId, input.expectedCurrentRevision);
      if (epoch) throw coreError('CORE_PROVIDER_SNAPSHOT_BOUND', 'provider epoch already binds the active user source revision');
      if (!['corrected', 'withdrawn', 'superseded'].includes(input.changeKind)) {
        throw coreError('CORE_TURN_REVISION_INVALID', 'user revision must declare a non-initial change kind');
      }
      run(`INSERT INTO turn_revision(
        turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,content_hash_token,source_event_id,supersedes_revision_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`, input.turnRevisionId, input.semanticTurnId, nextRevision, input.changeKind,
      input.payloadRef, input.payloadHashToken, input.sourceEventId, current.turn_revision_id, input.committedAt);
      const activated = run(`UPDATE semantic_turn SET active_revision_id=? WHERE semantic_turn_id=? AND active_revision_id=?`,
        input.turnRevisionId, input.semanticTurnId, current.turn_revision_id);
      if (activated.changes !== 1) throw coreError('CORE_TURN_REVISION_STALE', 'user turn active revision changed');
      const owner = get('SELECT owner_id FROM conversation WHERE conversation_id=?', input.conversationId);
      const receipt = appendPackageBReceipt(run, get, {
        kind: USER_REVISION_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.semanticTurnId, ownerId: owner.owner_id, conversationId: input.conversationId,
        exchangeId: input.exchangeId, actorRef: input.semanticTurnId, revision: nextRevision,
        causationId: input.sourceEventId, createdAt: input.committedAt,
      });
      return userResult(receipt, 'applied');
    },

    compareAndSetForegroundExchange(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedConversationRevision, 'expected Conversation revision');
      const digest = foregroundExchangeOperationDigest(input);
      const operationScope = foregroundScope(input.conversationId);
      const prior = findPackageBReceipt(get, FOREGROUND_KIND, input.operationKey, operationScope);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'foreground Exchange binding');
        return frozen({ disposition: 'already_applied', resultId: prior.journal_event_id,
          journalSequence: Number(prior.sequence_no), operationDigest: prior.source_ref,
          conversation: get('SELECT * FROM conversation WHERE conversation_id=?', input.conversationId) });
      }
      const elsewhere = findPackageBReceiptByOperationKey(get, FOREGROUND_KIND, input.operationKey);
      if (elsewhere && elsewhere.conversation_id !== input.conversationId) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'foreground Exchange key targets another Conversation');
      }
      if (input.exchangeId !== null && input.exchangeId !== undefined
        && !get('SELECT 1 AS found FROM exchange WHERE exchange_id=? AND conversation_id=?', input.exchangeId, input.conversationId)) {
        throw coreError('CORE_EXCHANGE_PARENT_INVALID', 'foreground Exchange is outside the Conversation');
      }
      const result = run(`UPDATE conversation SET foreground_exchange_id=?,revision=revision+1,updated_at=?
        WHERE conversation_id=? AND revision=?`, input.exchangeId ?? null, input.updatedAt,
      input.conversationId, input.expectedConversationRevision);
      if (result.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: FOREGROUND_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.conversationId, conversationId: input.conversationId, exchangeId: input.exchangeId ?? null,
        revision: input.expectedConversationRevision + 1, createdAt: input.updatedAt,
      });
      return frozen({ disposition: 'applied', resultId: receipt.journal_event_id,
        journalSequence: Number(receipt.sequence_no), operationDigest: receipt.source_ref,
        conversation: get('SELECT * FROM conversation WHERE conversation_id=?', input.conversationId) });
    },
  });
}

export function createPackageBTurnReader({ read, all }) {
  return frozen({
    conversationByCanonicalKey: ({ identity }) => {
      const receipt = readVerifiedConversationIdentity(read, identity);
      return receipt ? identityFromReceipt(receipt) : undefined;
    },
    conversationIdentity: ({ identity, conversationId = identity?.conversationId }) => {
      const receipt = readVerifiedConversationIdentity(read, identity, conversationId);
      return receipt ? identityFromReceipt(receipt) : undefined;
    },
    identityReceipt: ({ identity, conversationId = identity?.conversationId }) => readVerifiedConversationIdentity(read, identity, conversationId),
    presentationBinding: ({ identity, conversationId, bindingId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM presentation_binding WHERE presentation_binding_id=? AND conversation_id=?`, bindingId, conversationId),
    exchange: ({ identity, conversationId, exchangeId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM exchange WHERE exchange_id=? AND conversation_id=?`, exchangeId, conversationId),
    turn: ({ identity, conversationId, exchangeId, turnId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM semantic_turn WHERE semantic_turn_id=? AND conversation_id=? AND exchange_id=?`, turnId, conversationId, exchangeId),
    turnRevisions: ({ identity, conversationId, exchangeId, turnId }) => readVerifiedConversationIdentity(read, identity, conversationId) ? all(`SELECT revision.* FROM turn_revision revision
      JOIN semantic_turn turn ON turn.semantic_turn_id=revision.semantic_turn_id
      WHERE revision.semantic_turn_id=? AND turn.conversation_id=? AND turn.exchange_id=? ORDER BY revision.revision`,
    turnId, conversationId, exchangeId) : [],
    userReceipt: ({ identity, conversationId, exchangeId, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND exchange_id=? AND source_ref=?`,
    packageBReceiptEventId(USER_COMMIT_KIND, operationKey, userScope(conversationId, exchangeId)),
    `package_b_${USER_COMMIT_KIND}`, conversationId, exchangeId, operationDigest),
    userRevisionReceipt: ({ identity, conversationId, exchangeId, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND exchange_id=? AND source_ref=?`, packageBReceiptEventId(USER_REVISION_KIND, operationKey,
      userScope(conversationId, exchangeId)), `package_b_${USER_REVISION_KIND}`, conversationId, exchangeId, operationDigest),
    foregroundExchangeReceipt: ({ identity, conversationId, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND source_ref=?`, packageBReceiptEventId(FOREGROUND_KIND, operationKey, foregroundScope(conversationId)),
      `package_b_${FOREGROUND_KIND}`, conversationId, operationDigest),
  });
}
