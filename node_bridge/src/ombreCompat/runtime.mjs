import fs from 'node:fs';

import { getGlobalTimelineConfig, resolveTimelineEventByKey } from '../globalTimeline.mjs';
import { adapterPolicyDigest } from './adapterPolicy.mjs';
import { canonicalDigest } from './canonical.mjs';
import { getOmbreCompatConfig, isCompatActive } from './config.mjs';
import { buildCompatFinalTurnEvent } from './emitter.mjs';
import { createLifecycleLane } from './lifecycleLane.mjs';
import { createCompatPayloadStore } from './payloadStore.mjs';
import { createProjectionRefresher } from './projectionRefresh.mjs';
import { createCompatQueueStore, deriveSourceEventId } from './queueStore.mjs';
import { createReconciler } from './reconciler.mjs';
import { validateFinalTurnSourceEvent } from './sourceEvent.mjs';
import { createStewardAdapter } from './stewardAdapter.mjs';
import { createCompatWorker } from './worker.mjs';
import { compatError } from './constants.mjs';

export function sourceTimelineEventKey({ platform, conversation_id, exchange_id }) {
  const sourceId = deriveSourceEventId({ platform, conversation_id, exchange_id });
  return `ombre-source:${sourceId}:user`;
}

export async function createOmbreCompatRuntime(options = {}) {
  const env = options.env || process.env;
  const outbox = options.outbox;
  const config = getOmbreCompatConfig(env);
  if (!isCompatActive(config, env)) return disabledRuntime();
  if (!outbox || typeof outbox.get !== 'function' || typeof outbox.getTerminalReceipt !== 'function') {
    throw compatError('COMPAT_CONFIG_INCOMPLETE', 'durable outbox binding is required');
  }

  const identity = readIdentity(config.stewardIdentityFile);
  const store = createCompatQueueStore({
    dir: config.queueDir,
    adapterPolicyDigest: adapterPolicyDigest(),
  });
  store.open();
  let payloadStore;
  try {
    payloadStore = createCompatPayloadStore({ dir: config.payloadDir });
    const adapter = createStewardAdapter({
      endpoint: config.stewardEndpoint,
      tokenFile: config.stewardTokenFile,
      timeoutMs: config.dispatchTimeoutMs,
      fetchImpl: options.fetchImpl,
      baseUpstreamCommit: identity.base_upstream_commit,
      patchManifestSha256: identity.patch_manifest_sha256,
      apiSchemaSha256: identity.api_schema_sha256,
      effectiveSourceTreeSha256: identity.effective_source_tree_sha256,
    });
    await adapter.verifyUpstreamVersion();

    const checkpointGuard = createCheckpointGuard({ store, outbox, env });
    const reconciler = createReconciler({ store, adapter });
    const lifecycleLane = createLifecycleLane({ store, payloadStore, adapter });
    const refresher = createProjectionRefresher({
      projectionDir: config.projectionDir,
      store,
      resolver: () => projectionItems(store),
    });
    const worker = createCompatWorker({
      store,
      payloadStore,
      adapter,
      lifecycleLane,
      reconciler,
      refresher,
      curatorConfig: config.curator,
      reviewerConfig: config.reviewer,
      curatorImpl: options.curatorImpl,
      reviewerImpl: options.reviewerImpl,
      sourceTextResolver: ({ binding }) => resolveSourceTexts({ binding, outbox, env }),
      checkpointGuard,
      itemEligible: (item) => {
        const source = store.getSource(item.source_event_id);
        const latest = source.revisions.find((entry) => entry.source_revision === source.current_revision);
        return latest?.presentation_state === 'presented' && latest?.lifecycle_state === 'current';
      },
      beforeCheckpoint: options.beforeCheckpoint,
      afterCheckpoint: options.afterCheckpoint,
    });

    let stopping = false;
    let drainPromise = Promise.resolve([]);
    let latestDrainReports = [];
    const scheduleDrain = () => {
      if (stopping) return drainPromise;
      drainPromise = drainPromise.then(async () => {
        const reports = [];
        for (let pass = 0; pass < 16; pass += 1) {
          let current;
          try {
            current = await worker.runPending();
          } catch (error) {
            reports.push({
              progress: false,
              outcome: error?.code || 'COMPAT_STORE_CORRUPT',
            });
            break;
          }
          reports.push(...current);
          if (!current.some((report) => report.progress)) break;
        }
        latestDrainReports = reports;
        return reports;
      });
      return drainPromise;
    };

    const runtime = {
      active: true,
      store,
      payloadStore,
      adapter,
      observeReserved(input) {
        if (stopping) throw compatError('COMPAT_CONFIG_INCOMPLETE', 'compat runtime is stopping');
        return ingressReserved({ store, outbox, env, ...input });
      },
      async observeTerminal(receipt) {
        if (stopping) return { disposition: 'stopping' };
        const result = ingressTerminal({ store, outbox, receipt });
        if (receipt.delivery === 'sent') await scheduleDrain();
        return result;
      },
      async catchUp() {
        const reports = [];
        for (const item of outbox.list()) {
          if (!['sent', 'failed', 'ambiguous'].includes(item.delivery)) continue;
          const receipt = outbox.getTerminalReceipt(item.delivery_terminal_receipt_id);
          if (!receipt) throw compatError('COMPAT_INGRESS_INVALID', 'terminal outbox receipt is missing');
          const sourceId = deriveSourceEventId({
            platform: item.platform,
            conversation_id: item.conversation_id,
            exchange_id: item.exchange_id,
          });
          const source = store.exportView().sources.find((entry) => entry.event_id === sourceId);
          if (!source) continue;
          const current = source.revisions.find((entry) => entry.source_revision === source.current_revision);
          if (current?.delivery_observation_ref !== terminalObservationRef(receipt)) {
            reports.push(await runtime.observeTerminal(receipt));
          }
        }
        await scheduleDrain();
        return reports;
      },
      drain: scheduleDrain,
      handleSourceLifecycle: (input) => lifecycleLane.handleSourceLifecycle(input),
      async compatibilityDelete(input) {
        const result = await lifecycleLane.compatibilityDelete(input);
        await scheduleDrain();
        return result;
      },
      diagnostics: () => Object.freeze({
        latest_drain_reports: structuredClone(latestDrainReports),
      }),
      async stop() {
        if (stopping) return;
        stopping = true;
        await drainPromise;
        payloadStore.close();
        store.close();
      },
    };
    await runtime.catchUp();
    return Object.freeze(runtime);
  } catch (error) {
    try { payloadStore?.close(); } catch {}
    try { store.close(); } catch {}
    throw error;
  }
}

function ingressReserved({ store, outbox, env, message, response, outboxItem }) {
  const item = outboxItem || outbox.get(response?.outboxId);
  if (!item || item.delivery !== 'reserved') {
    throw compatError('COMPAT_INGRESS_INVALID', 'source must bind a reserved durable outbox item');
  }
  const userKey = sourceTimelineEventKey({
    platform: item.platform,
    conversation_id: item.conversation_id,
    exchange_id: item.exchange_id,
  });
  const timelinePath = getGlobalTimelineConfig(env).timelinePath;
  const userRecord = resolveTimelineEventByKey({ timelinePath, eventKey: userKey }).record;
  const event = buildCompatFinalTurnEvent({
    platform: item.platform,
    conversationId: item.conversation_id,
    exchangeId: item.exchange_id,
    userText: userRecord.text,
    assistantText: item.text,
    userFinalPayloadRef: `global-timeline-event:${userKey}`,
    assistantFinalPayloadRef: `durable-outbox-item:${item.outboxId}`,
    scopeEnvelope: {
      actor: message?.global_user_id || message?.sender_id || null,
      platform: item.platform,
      conversation_id: item.conversation_id,
      channel_type: message?.channel_type || 'dm',
      visibility: message?.channel_type === 'group' ? 'group' : 'private',
    },
    sensitivity: message?.channel_type === 'group' ? 'standard' : 'personal',
    trustedActionReceiptRefs: Array.isArray(response?.trustedActionReceiptRefs)
      ? response.trustedActionReceiptRefs : [],
    sourceGateReceiptRef: `durable-outbox-reservation:${item.outboxId}`,
    emittedAt: item.createdAt,
    presentationState: 'not_presented',
  });
  return store.ingressSourceEvent(event);
}

function ingressTerminal({ store, outbox, receipt }) {
  const item = outbox.get(receipt?.outbox_id);
  if (!item || item.delivery_terminal_receipt_id !== receipt.delivery_terminal_receipt_id
    || receipt.content_digest !== item.contentDigest) {
    throw compatError('COMPAT_INGRESS_INVALID', 'terminal receipt is not the current outbox binding');
  }
  const eventId = deriveSourceEventId({
    platform: item.platform,
    conversation_id: item.conversation_id,
    exchange_id: item.exchange_id,
  });
  const source = store.getSource(eventId);
  const current = source.revisions.find((entry) => entry.source_revision === source.current_revision);
  const presentation = receipt.delivery === 'sent' ? 'presented' : receipt.delivery;
  const event = validateFinalTurnSourceEvent({
    ...current,
    source_revision: current.source_revision + 1,
    presentation_state: presentation,
    delivery_observation_ref: terminalObservationRef(receipt),
    delivery_observation_digest: receipt.receipt_digest,
    emitted_at: receipt.delivery_committed_at,
    source_event_digest: undefined,
  });
  return store.ingressSourceEvent(event);
}

function createCheckpointGuard({ store, outbox, env }) {
  return ({ expected_source_revision, item }) => {
    const source = store.getSource(item.source_event_id);
    const latest = source.revisions.find((entry) => entry.source_revision === source.current_revision);
    if (latest.source_revision !== expected_source_revision) {
      throw compatError('COMPAT_STALE_SOURCE_REVISION', 'source revision changed during processing');
    }
    if (latest.presentation_state !== 'presented') {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', 'source is not presented');
    }
    if (latest.lifecycle_state !== 'current') {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', 'source lifecycle is not current');
    }
    resolveSourceTexts({ binding: latest, outbox, env });
    const receiptId = String(latest.delivery_observation_ref || '').replace(/^durable-outbox-terminal:/, '');
    const receipt = outbox.getTerminalReceipt(receiptId);
    const outboxItem = receipt ? outbox.get(receipt.outbox_id) : null;
    if (!receipt || receipt.delivery !== 'sent' || receipt.receipt_digest !== latest.delivery_observation_digest
      || outboxItem?.delivery_terminal_receipt_id !== receiptId
      || outboxItem?.contentDigest !== receipt.content_digest) {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', 'terminal receipt binding is stale');
    }
    return true;
  };
}

function resolveSourceTexts({ binding, outbox, env }) {
  const userKey = String(binding.user_final_payload_ref || '').replace(/^global-timeline-event:/, '');
  const user = resolveTimelineEventByKey({
    timelinePath: getGlobalTimelineConfig(env).timelinePath,
    eventKey: userKey,
  }).record.text;
  const outboxId = String(binding.assistant_final_payload_ref || '').replace(/^durable-outbox-item:/, '');
  const assistantItem = outbox.get(outboxId);
  if (!assistantItem
    || canonicalDigest(user) !== binding.user_final_payload_digest
    || canonicalDigest(assistantItem.text) !== binding.assistant_final_payload_digest) {
    throw compatError('COMPAT_PAYLOAD_UNRESOLVABLE', 'source payload binding is not resolvable and digest-equal');
  }
  return {
    user,
    assistant: assistantItem.text,
  };
}

function projectionItems(store) {
  const tombstones = new Map(store.exportView().tombstones.map((entry) => [entry.target_ref, entry]));
  return {
    items: store.listOperations()
      .filter((operation) => operation.state === 'published')
      .map((operation) => {
        const receipt = operation.projection_receipt_ref
          ? store.getReceipt(operation.projection_receipt_ref) : null;
        const tombstone = tombstones.get(receipt?.target_projection_ref);
        return {
          item_ref: receipt?.target_projection_ref,
          item_digest: receipt?.response_digest,
          source_operation_key: operation.operation_key,
          layer: operation.candidate_kind,
          payload_ref: tombstone ? null : operation.candidate_payload_ref,
          payload_digest: operation.candidate_payload_digest,
          target_ref: receipt?.target_projection_ref,
          revision: receipt?.target_revision_after,
          lifecycle_state: tombstone ? 'tombstoned' : 'current',
          tombstone_metadata: tombstone ? {
            tombstone_ref: tombstone.tombstone_ref,
            tombstone_state: tombstone.tombstone_state,
            deletion_ref: tombstone.deletion_ref,
            deletion_domain: tombstone.deletion_domain,
          } : null,
        };
      }),
  };
}

function readIdentity(target) {
  if (!target) throw compatError('COMPAT_CONFIG_INCOMPLETE', 'steward identity file is required');
  try {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('identity is not a regular file');
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    const keys = [
      'base_upstream_commit', 'patch_manifest_sha256',
      'api_schema_sha256', 'effective_source_tree_sha256',
    ];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())) throw new Error('identity fields');
    return value;
  } catch (cause) {
    throw compatError('COMPAT_CONFIG_INCOMPLETE', 'steward identity unavailable', cause);
  }
}

function terminalObservationRef(receipt) {
  return `durable-outbox-terminal:${receipt.delivery_terminal_receipt_id}`;
}

function disabledRuntime() {
  return Object.freeze({
    active: false,
    observeReserved: () => null,
    observeTerminal: async () => null,
    catchUp: async () => [],
    drain: async () => [],
    diagnostics: () => Object.freeze({ latest_drain_reports: [] }),
    stop: async () => {},
  });
}
