import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import { ingressOperationDigest } from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
  assertNonEmptyString,
  assertPackageBOperationKey,
  assertPackageBReceipt,
  findPackageBReceipt,
  findPackageBReceiptByOperationKey,
  frozen,
  packageBReceiptEventId,
  readVerifiedConversationIdentity,
} from './packageBRepositorySupport.mjs';

const RECEIPT_KIND = 'ingress_committed';

function result(receipt, disposition) {
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    ingressEventId: receipt.correlation_id,
    operationDigest: receipt.source_ref,
  });
}

export function createPackageBIngressRepository({ get, run }) {
  return frozen({
    commit(input) {
      assertPackageBOperationKey(input.operationKey);
      for (const [field, value] of [
        ['ingressEventId', input.ingressEventId], ['platform', input.platform],
        ['sourceInstanceId', input.sourceInstanceId], ['ownerId', input.ownerId],
        ['actorRef', input.actorRef], ['platformConversationBinding', input.platformConversationBinding],
        ['canonicalConversationKey', input.canonicalConversationKey], ['receivedAt', input.receivedAt],
        ['createdAt', input.createdAt], ['mutationKind', input.mutationKind],
      ]) assertNonEmptyString(value, field);
      assertKeyedContentHashToken(input.payloadHashToken);
      const digest = ingressOperationDigest(input);
      const operationScope = `ingress:${input.canonicalConversationKey}`;
      const priorElsewhere = findPackageBReceiptByOperationKey(get, RECEIPT_KIND, input.operationKey);
      if (priorElsewhere && priorElsewhere.causation_id !== input.canonicalConversationKey) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'ingress operation key targets another Conversation scope');
      }
      const priorOperation = findPackageBReceipt(get, RECEIPT_KIND, input.operationKey, operationScope);
      if (priorOperation) {
        assertPackageBReceipt(priorOperation, digest, 'ingress');
        return result(priorOperation, 'already_applied');
      }

      const nativeEventId = input.nativeEventId ?? null;
      const trusted = input.nativeEventIdTrust === 'trusted';
      const untrusted = input.nativeEventIdTrust === 'untrusted';
      const absent = input.nativeEventIdTrust === 'absent';
      if ((trusted || untrusted) && (typeof nativeEventId !== 'string' || !nativeEventId.trim())) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'trusted and untrusted native event IDs require a value');
      }
      if (absent && nativeEventId !== null) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'absent native event ID must be null');
      }
      if (!trusted && !untrusted && !absent) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'native event ID trust is invalid');
      }

      if (trusted) {
        const existing = get(`SELECT * FROM ingress_event
          WHERE source_instance_id=? AND platform=? AND native_event_id=?
            AND native_event_id_trust='trusted'`,
        input.sourceInstanceId, input.platform, nativeEventId);
        if (existing) {
        const receipt = get(`SELECT * FROM journal_event
            WHERE event_type=? AND correlation_id=?`, `package_b_${RECEIPT_KIND}`, existing.ingress_event_id);
          if (!receipt) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'trusted ingress receipt is missing');
          const comparable = ingressOperationDigest({ ...input, operationKey: receipt.origin_ref });
          assertPackageBReceipt(receipt, comparable, 'trusted ingress');
          return result(receipt, 'duplicate_native');
        }
      }

      run(`INSERT INTO ingress_event(
        ingress_event_id,source_instance_id,platform,native_event_id,native_event_id_trust,
        idempotency_disposition,conversation_hint,payload_ref,payload_hash_token,state,
        revision,received_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'received',0,?,?)`,
      input.ingressEventId, input.sourceInstanceId, input.platform, nativeEventId,
      input.nativeEventIdTrust, trusted ? 'native_exact' : 'internal_only',
      input.canonicalConversationKey, input.payloadRef, input.payloadHashToken,
      input.receivedAt, input.createdAt);
      const receipt = appendPackageBReceipt(run, get, {
        kind: RECEIPT_KIND, operationKey: input.operationKey, operationDigest: digest,
        resultId: input.ingressEventId, ownerId: input.ownerId, actorRef: input.actorRef,
        causationId: input.canonicalConversationKey, operationScope, createdAt: input.createdAt,
      });
      return result(receipt, 'applied');
    },
  });
}

export function createPackageBIngressReader({ read }) {
  return frozen({
    byId: ({ identity, ingressEventId }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT ingress.* FROM ingress_event ingress
      JOIN journal_event receipt ON receipt.correlation_id=ingress.ingress_event_id
      WHERE ingress.ingress_event_id=? AND receipt.event_type=? AND receipt.owner_id=?
        AND receipt.causation_id=?`, ingressEventId, `package_b_${RECEIPT_KIND}`, identity.ownerId, identity.canonicalConversationKey),
    byTrustedNativeScope: ({ identity, sourceInstanceId, platform, nativeEventId }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT ingress.* FROM ingress_event ingress
      JOIN journal_event receipt ON receipt.correlation_id=ingress.ingress_event_id
      WHERE ingress.source_instance_id=? AND ingress.platform=? AND ingress.native_event_id=?
        AND ingress.native_event_id_trust='trusted' AND receipt.event_type=? AND receipt.owner_id=?
        AND receipt.causation_id=?`, sourceInstanceId, platform, nativeEventId,
    `package_b_${RECEIPT_KIND}`, identity.ownerId, identity.canonicalConversationKey),
    byOperation: ({ identity, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND source_ref=?`,
    packageBReceiptEventId(RECEIPT_KIND, operationKey, `ingress:${identity.canonicalConversationKey}`),
    `package_b_${RECEIPT_KIND}`, operationDigest),
  });
}
