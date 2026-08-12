import { createHash } from 'node:crypto';

import { createTrustedBridgeInformationalReportTask } from '../hermesTaskScope.mjs';
import { sendFeishuReply } from '../feishuBridge.mjs';
import {
  buildExternalMcpSyntheticTurn,
  evaluateExternalMcpSystemQueueEgress,
} from '../externalMcp/systemQueue.mjs';
import { parseExternalMcpTaskRef } from './coreExternalNotificationService.mjs';
import { coreError } from './coreErrors.mjs';
import { createPythonCoreMaintenanceHandler } from './coreMaintenanceHandler.mjs';
import { createCoreReminderSyncHandler } from './coreReminderSyncHandler.mjs';
import { createCoreWorkRunRuntime } from './coreWorkRunRuntime.mjs';
import { createCoreWorkRunWorker } from './coreWorkRunWorker.mjs';
import { createPackageBScheduledDeliveryHandler } from './packageB/packageBScheduledDeliveryService.mjs';

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function promptFor(payloadRef) {
  if (payloadRef.startsWith('s12-acceptance:')) {
    return 'S12 Core cutover acceptance. Reply exactly: S12 Core cutover accepted.';
  }
  if (payloadRef === 'system-task:ai-daily-digest') {
    return '生成今天的主动简报。只汇总当前可核验的日程、待办和重要事实；没有有用内容时保持静默。';
  }
  if (payloadRef.startsWith('legacy-todo:')) {
    return `处理 owner 明确设置的提醒 ${payloadRef}。核对当前待办后，仅在提醒仍有效且到期时发送。`;
  }
  return `处理受管计划任务 ${payloadRef}；没有应展示给 owner 的结果时保持静默。`;
}

function todoId(payloadRef) {
  const match = String(payloadRef || '').match(/^legacy-todo:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function feishuTarget(view) {
  const recipient = String(view?.target || '').trim();
  if (view?.platform !== 'feishu' || !recipient) {
    throw coreError('CORE_FEISHU_ROUTE_INVALID', 'Feishu delivery requires one typed recipient');
  }
  if (view.destinationKind === 'user') return { channel_type: 'dm', sender_id: recipient };
  if (view.destinationKind === 'conversation') return { channel_type: 'group', conversation_id: recipient };
  throw coreError('CORE_FEISHU_ROUTE_INVALID', 'Feishu delivery route kind is unsupported');
}

async function pythonJson(fetchImpl, baseUrl, route, body) {
  const response = await fetchImpl(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response?.ok) throw new Error(`Python todo request failed: ${route}`);
  return response.json();
}

export function createCoreRuntimeComposition({
  runtime,
  channelHub,
  externalPollHandler,
  attentionFlushHandler,
  externalMcpRuntime,
  env = process.env,
  logger = console,
  fetchImpl = globalThis.fetch,
  sendFeishu = sendFeishuReply,
  now = () => new Date(),
} = {}) {
  if (!runtime) return null;
  const pythonBaseUrl = String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const scheduled = createPackageBScheduledDeliveryHandler({
    core: runtime.core,
    hashContent: runtime.hashContent,
    now,
    decide: async (task) => {
      const externalTask = parseExternalMcpTaskRef(task.payloadRef);
      if (externalTask) {
        const activity = externalMcpRuntime?.store?.get?.(externalTask.activityId);
        const fact = runtime.core.reader.journalEvent(externalTask.factEventId);
        const factPayload = runtime.core.reader.journalPayloadForEvent(externalTask.factEventId);
        const projection = runtime.core.reader.externalPollProjectionForFact(externalTask.factEventId);
        if (!activity || activity.status !== 'active'
          || Number(activity.revision) !== externalTask.revision
          || String(activity.checkpoint?.stateDigest || '') !== externalTask.checkpointDigest
          || fact?.event_type !== 'external_poll_fact_observed' || fact.invalidated_at !== null
          || factPayload?.payload_ref !== `external-mcp:/activity/${externalTask.activityId}/revision/${externalTask.revision}`
          || projection?.state !== 'completed' || projection.payload_ref !== task.payloadRef) {
          return { suppressSend: true, provider: 'core', model: 'external-fact-state-check' };
        }
        const evidenceRef = `core-external-mcp:${externalTask.factEventId}`;
        const message = buildExternalMcpSyntheticTurn({
          id: `core-external-${digest(task.workRunId)}`,
          kind: activity.domain === 'game' ? 'game' : activity.domain === 'forum' ? 'forum' : 'external_mcp',
          globalUserId: task.ownerId,
          platform: task.platform,
          conversationId: task.conversationId,
          senderId: task.ownerId,
          watchScope: activity.scope?.resourceId || activity.scope?.serverId,
          reason: activity.checkpoint?.summary || 'external MCP checkpoint updated',
          evidenceRefs: [evidenceRef],
          deliverability: 'notify_allowed',
          allowedCapabilityTiers: ['T1', 'T2', 'T3'],
        });
        const response = await channelHub(message, { env, logger, replyBackend: env.replyBackend });
        const egress = evaluateExternalMcpSystemQueueEgress({
          event: message.proactive_event, replyText: response?.replyText, env,
        });
        return {
          replyText: egress.send ? egress.message : '',
          suppressSend: !egress.send,
          provider: response?.provider || response?.source || 'hermes',
          model: response?.model || response?.profile || 'unspecified',
        };
      }
      const reminderId = todoId(task.payloadRef);
      const reminder = reminderId === null ? null
        : (await pythonJson(fetchImpl, pythonBaseUrl, '/tools/todo/get', { todo_id: reminderId })).todo;
      if (reminder && reminder.status !== 'pending') {
        return { suppressSend: true, provider: 'core', model: 'reminder-state-check' };
      }
      const base = {
        id: `core-scheduled-${digest(task.workRunId)}`,
        message_id: `core-scheduled-${digest(task.workRunId)}`,
        platform: task.platform,
        channel_type: task.destinationKind === 'conversation' ? 'group' : 'dm',
        conversation_id: task.conversationId,
        sender_id: task.ownerId,
        text: reminder
          ? `处理 owner 明确设置的到点提醒：${reminder.content}。提醒时间：${reminder.reminder_at}。仅在待办仍为 pending 时发送；否则保持静默。`
          : promptFor(task.payloadRef),
        media: [],
        created_at: now().getTime(),
        route_hint: task.payloadRef === 'system-task:ai-daily-digest'
          ? 'scheduled_ai_daily_digest' : 'hermes_proactive_event',
      };
      const message = task.payloadRef === 'system-task:ai-daily-digest'
        ? createTrustedBridgeInformationalReportTask(base, 'scheduled_ai_daily_digest')
        : base;
      const response = await channelHub(message, { env, logger, replyBackend: env.replyBackend });
      return {
        replyText: response?.replyText,
        suppressSend: response?.suppressSend === true,
        provider: response?.provider || response?.source || 'hermes',
        model: response?.model || response?.profile || 'unspecified',
      };
    },
    send: async (view) => {
      await sendFeishu({ target: feishuTarget(view), text: view.text, env });
      const evidenceRef = `feishu:core-scheduled:${digest(view.outboxId)}`;
      return {
        resultState: 'sent', evidenceRef,
        evidenceHashToken: runtime.hashContent('adapter-receipt', evidenceRef),
      };
    },
    afterTerminal: async (context) => {
      const reminderId = todoId(context.payload_ref);
      if (reminderId === null) return;
      try {
        await pythonJson(fetchImpl, pythonBaseUrl, '/tools/todo/ack', { todo_id: reminderId });
      } catch (error) {
        logger.warn?.(`[core-reminder] local acknowledgement pending: ${error?.message || error}`);
        return false;
      }
    },
  });
  const pythonMaintenance = createPythonCoreMaintenanceHandler({
    env, fetchImpl, hashContent: runtime.hashContent,
  });
  const reminderSync = createCoreReminderSyncHandler({
    core: runtime.core, env, fetchImpl, hashContent: runtime.hashContent, now,
  });
  const maintenance = async (input) => (attentionFlushHandler?.canHandle?.(input.work)
    ? attentionFlushHandler(input)
    : reminderSync.canHandle(input.work) ? reminderSync(input) : pythonMaintenance(input));
  maintenance.canHandle = (work) => Boolean(attentionFlushHandler?.canHandle?.(work))
    || reminderSync.canHandle(work) || pythonMaintenance.canHandle(work);
  const workRunWorker = createCoreWorkRunWorker({
    core: runtime.core,
    hashContent: runtime.hashContent,
    handlers: {
      scheduled_instruction: scheduled,
      system_maintenance: maintenance,
      ...(externalPollHandler ? { external_poll: externalPollHandler } : {}),
    },
    now,
  });
  const worker = typeof externalPollHandler?.recoverPendingProjections === 'function'
    ? Object.freeze({
      async runOnce() {
        await externalPollHandler.recoverPendingProjections();
        return workRunWorker.runOnce();
      },
    }) : workRunWorker;
  return createCoreWorkRunRuntime({
    worker, logger, intervalMs: Math.max(250, Number(env.RAN_AGENT_CORE_WORK_POLL_MS || 5_000)),
  });
}
