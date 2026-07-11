import { createHash } from 'node:crypto';

const ALLOWED_FIELDS = new Set([
  'requestRef',
  'command',
  'goal',
  'reference',
  'environmentHint',
  'reporting',
  'preferences',
]);
const PRIVATE_PREFIXES = [
  'actor', 'globaluser', 'recipient', 'server', 'session', 'activity', 'grant',
  'token', 'profile', 'transport', 'scope', 'budget', 'receipt', 'operation',
  'consent', 'authorization',
];
const COMMANDS = new Set(['start_or_resume', 'adjust', 'stop']);
const UNFINISHED = new Set(['active', 'paused', 'blocked']);
const DOMAINS = new Set(['game', 'forum', 'embodied', 'other']);
const TERMINAL_STATES = Object.freeze(['completed', 'blocked', 'stopped', 'expired']);
const RECEIPT_STATUSES = new Set(['active', ...TERMINAL_STATES]);
const GOAL_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:@/-]{8,240}$/;
const ALWAYS_DEDICATED = /(?:co[-_ ]?reading|共读|生成(?:一[张个段])?(?:图片|音频|视频)|画图|记住|回忆|几点|时间|表情包|sticker|playwright|browser\s*debug|浏览器调试)/i;
const CONTENT_LINK = /(?:https?:\/\/|\b(?:url|link|page|post|article|video|platform)\b|链接|网页|页面|帖子|文章|视频|平台)/i;
const CONTENT_READ = /(?:读取|阅读|总结|概括|看(?:看|一下)?|\bread\b|\bsummari[sz]e\b)/i;
const CONTENT_MONITOR = /(?:监控|观察.{0,8}(?:更新|变化)|后续更新|\bwatch(?:ing)?\b.{0,24}\b(?:changes?|updates?)\b|\bmonitor(?:ing)?\b(?:.{0,24}\b(?:changes?|updates?)\b)?)/i;

export function createExternalMcpActivityFacade({ supervisor, resolveStandingStart } = {}) {
  if (
    !supervisor
    || typeof supervisor.listActivities !== 'function'
    || typeof supervisor.commit !== 'function'
  ) {
    throw facadeError('EXTERNAL_ACTIVITY_SUPERVISOR_INVALID', 'external activity supervisor is unavailable');
  }

  async function handle(input, trustedActorContext) {
    const request = normalizeRequest(input);
    const actorContext = normalizeTrustedActor(trustedActorContext);

    if (request.command === 'start_or_resume' && request.goal && isDedicatedOneShotGoal(request.goal)) {
      return noOp(request.requestRef, 'not_durable_environment_goal');
    }

    const activities = await listScopedActivities(supervisor, actorContext);
    if (request.command === 'start_or_resume') {
      return await startOrResume({ request, actorContext, activities, supervisor });
    }
    if (request.command === 'stop' && isStopAll(request)) {
      if (activities.length === 0) return noOp(request.requestRef, 'no_matching_activity');
      const representative = [...activities].sort((left, right) => left.activityId.localeCompare(right.activityId))[0];
      const selection = selectionFor(
        actorContext,
        'all',
        representative.goalDigest,
      );
      return await commitAndReceipt(supervisor, {
        action: 'stop_all',
        requestRef: request.requestRef,
        selection,
        actorContext,
        activityIds: activities.map((item) => item.activityId),
        reporting: request.reporting,
      }, 'stopped_all');
    }

    const matches = selectNaturalMatches(activities, request);
    if (matches.length === 0) return noOp(request.requestRef, 'no_matching_activity');
    if (matches.length > 1) return clarification(request.requestRef, matches);
    const match = matches[0];
    const goal = request.command === 'adjust' && request.goal ? request.goal : match.goal;
    const goalDigest = request.command === 'adjust' && request.goal ? digestGoal(goal) : match.goalDigest;
    const selection = selectionFor(actorContext, match.domain, goalDigest);
    return await commitAndReceipt(supervisor, {
      action: request.command,
      requestRef: request.requestRef,
      selection,
      actorContext,
      activityId: match.activityId,
      goal,
      reference: request.reference,
      environmentHint: request.environmentHint,
      reporting: request.reporting,
    }, request.command === 'adjust' ? 'adjusted' : 'stopped');
  }

  async function repairStart({ requestRef, actorContext, currentMessage } = {}) {
    if (typeof resolveStandingStart !== 'function') return noOp(String(requestRef || ''), 'no_standing_consent');
    const trustedActor = normalizeTrustedActor(actorContext);
    const standing = await resolveStandingStart(Object.freeze({
      actorContext: trustedActor,
      currentTurn: Object.freeze({ text: optionalText(currentMessage?.text, 8_000) }),
    }));
    const repair = normalizeStandingStart(standing);
    if (!repair) return noOp(String(requestRef || ''), 'no_standing_consent');
    return await handle({
      requestRef,
      command: 'start_or_resume',
      goal: repair.goal,
      environmentHint: repair.environmentHint,
      reporting: repair.reporting,
    }, trustedActor);
  }

  return Object.freeze({ handle, repairStart });
}

function isDedicatedOneShotGoal(goal) {
  const text = String(goal || '');
  if (ALWAYS_DEDICATED.test(text)) return true;
  return CONTENT_LINK.test(text) && CONTENT_READ.test(text) && !CONTENT_MONITOR.test(text);
}

function normalizeStandingStart(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !['goal', 'environmentHint', 'reporting'].includes(key))) return null;
  const goal = optionalText(value.goal, 2_000);
  if (!goal || isDedicatedOneShotGoal(goal)) return null;
  try {
    return deepFreeze({
      goal,
      environmentHint: optionalText(value.environmentHint, 500),
      reporting: value.reporting === undefined ? {} : normalizeReporting(value.reporting, 0),
    });
  } catch {
    return null;
  }
}

async function startOrResume({ request, actorContext, activities, supervisor }) {
  if (!request.goal) {
    const matches = selectNaturalMatches(activities, request);
    if (matches.length === 0) return noOp(request.requestRef, 'no_matching_activity');
    if (matches.length > 1) return clarification(request.requestRef, matches);
    const match = matches[0];
    return await resume(supervisor, request, actorContext, match);
  }

  const domain = inferDomain(`${request.environmentHint} ${request.goal}`);
  const goalDigest = digestGoal(request.goal);
  const exact = activities.filter((item) => item.domain === domain && item.goalDigest === goalDigest);
  if (exact.length > 1) return clarification(request.requestRef, exact);
  if (exact.length === 1) {
    const match = exact[0];
    if (match.status === 'active' && match.committed === true && match.firstWakeCommitted === true) {
      const receipt = normalizeReceipt(match.receipt, selectionFor(actorContext, domain, goalDigest));
      return success(request.requestRef, 'deduped', receipt);
    }
    return await resume(supervisor, request, actorContext, match);
  }

  const selection = selectionFor(actorContext, domain, goalDigest);
  return await commitAndReceipt(supervisor, {
    action: 'start',
    requestRef: request.requestRef,
    selection,
    actorContext,
    goal: request.goal,
    reference: request.reference,
    environmentHint: request.environmentHint,
    reporting: request.reporting,
  }, 'started');
}

async function resume(supervisor, request, actorContext, match) {
  const selection = selectionFor(actorContext, match.domain, match.goalDigest);
  return await commitAndReceipt(supervisor, {
    action: 'resume',
    requestRef: request.requestRef,
    selection,
    actorContext,
    activityId: match.activityId,
    goal: match.goal,
    reference: request.reference,
    environmentHint: request.environmentHint,
    reporting: request.reporting,
  }, 'resumed');
}

async function listScopedActivities(supervisor, actorContext) {
  let listed;
  try {
    listed = await supervisor.listActivities(Object.freeze({
      actorKey: actorContext.actorKey,
      conversationKey: actorContext.conversationKey,
    }));
  } catch {
    throw facadeError('EXTERNAL_ACTIVITY_SUPERVISOR_FAILED', 'external activity supervisor failed');
  }
  if (!Array.isArray(listed)) {
    throw facadeError('EXTERNAL_ACTIVITY_SUPERVISOR_FAILED', 'external activity supervisor failed');
  }
  return listed
    .map(normalizeActivity)
    .filter((item) => item
      && item.actorKey === actorContext.actorKey
      && item.conversationKey === actorContext.conversationKey
      && UNFINISHED.has(item.status));
}

async function commitAndReceipt(supervisor, command, action) {
  let result;
  try {
    result = await supervisor.commit(deepFreeze(structuredClone(command)));
  } catch {
    throw facadeError('EXTERNAL_ACTIVITY_SUPERVISOR_FAILED', 'external activity supervisor failed');
  }
  if (result?.committed !== true || result?.firstWakeCommitted !== true) {
    throw facadeError('EXTERNAL_ACTIVITY_NOT_COMMITTED', 'external activity was not durably committed');
  }
  const receipt = normalizeReceipt(result.receipt, command.selection);
  return success(command.requestRef, action, receipt);
}

function normalizeRequest(value) {
  if (!isPlainObject(value)) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity request is invalid');
  for (const key of Object.keys(value)) {
    const normalized = normalizeField(key);
    if (isPrivateField(normalized)) {
      throw facadeError('EXTERNAL_ACTIVITY_PRIVATE_FIELD', 'activity request contains a private field');
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw facadeError('EXTERNAL_ACTIVITY_UNKNOWN_FIELD', 'activity request contains an unknown field');
    }
  }
  const requestRef = identifier(value.requestRef, 80, 'EXTERNAL_ACTIVITY_REQUEST_INVALID');
  const command = String(value.command || '');
  if (!COMMANDS.has(command)) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity command is invalid');
  if (value.reporting !== undefined && value.preferences !== undefined) {
    throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is ambiguous');
  }
  const reportingSource = value.reporting === undefined ? value.preferences : value.reporting;
  const reporting = reportingSource === undefined ? {} : normalizeReporting(reportingSource, 0);
  return deepFreeze({
    requestRef,
    command,
    goal: optionalText(value.goal, 2_000),
    reference: optionalText(value.reference, 500),
    environmentHint: optionalText(value.environmentHint, 500),
    reporting,
  });
}

function normalizeReporting(value, depth) {
  if (depth > 5) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is invalid');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is invalid');
    return value;
  }
  if (typeof value === 'string') return optionalText(value, 500);
  if (Array.isArray(value)) {
    if (value.length > 32) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is invalid');
    return value.map((item) => normalizeReporting(item, depth + 1));
  }
  if (!isPlainObject(value)) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is invalid');
  const keys = Object.keys(value).sort();
  if (keys.length > 32) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity reporting preference is invalid');
  const output = {};
  for (const key of keys) {
    if (isPrivateField(normalizeField(key))) {
      throw facadeError('EXTERNAL_ACTIVITY_PRIVATE_FIELD', 'activity request contains a private field');
    }
    output[key] = normalizeReporting(value[key], depth + 1);
  }
  return output;
}

function normalizeTrustedActor(value) {
  if (!isPlainObject(value)) throw facadeError('EXTERNAL_ACTIVITY_ACTOR_INVALID', 'trusted actor context is required');
  return deepFreeze({
    actorKey: identifier(value.actorKey, 180, 'EXTERNAL_ACTIVITY_ACTOR_INVALID'),
    conversationKey: identifier(value.conversationKey, 180, 'EXTERNAL_ACTIVITY_ACTOR_INVALID'),
    ...(value.platform ? { platform: identifier(value.platform, 40, 'EXTERNAL_ACTIVITY_ACTOR_INVALID') } : {}),
  });
}

function normalizeActivity(value) {
  if (!isPlainObject(value)) return null;
  const goal = typeof value.goal === 'string' ? value.goal : value.goal?.text;
  const actorKey = String(value.actorKey || value.actor?.key || '');
  const conversationKey = String(value.conversationKey || '');
  const domain = String(value.domain || '').toLowerCase();
  const goalDigest = GOAL_DIGEST.test(String(value.goalDigest || '')) ? value.goalDigest : digestGoal(goal);
  if (!SAFE_ID.test(String(value.activityId || '')) || !actorKey || !conversationKey || !DOMAINS.has(domain) || !goal) return null;
  return {
    activityId: value.activityId,
    actorKey,
    conversationKey,
    domain,
    goal: String(goal),
    normalizedGoal: normalizeGoal(value.normalizedGoal || goal),
    goalDigest,
    status: String(value.status || ''),
    committed: value.committed === true,
    firstWakeCommitted: value.firstWakeCommitted === true,
    receipt: value.receipt,
  };
}

function selectNaturalMatches(activities, request) {
  let candidates = activities;
  if (request.environmentHint) {
    const domain = inferDomain(request.environmentHint);
    const narrowed = candidates.filter((item) => item.domain === domain);
    if (narrowed.length > 0) candidates = narrowed;
  }
  const reference = normalizeGoal(request.reference || request.goal || '');
  if (!reference) return candidates;
  const matched = candidates.filter((item) => (
    item.normalizedGoal.includes(reference)
    || reference.includes(item.normalizedGoal)
    || referencesDomain(reference, item.domain)
  ));
  return matched;
}

function selectionFor(actorContext, domain, goalDigest) {
  return Object.freeze({
    actorKey: actorContext.actorKey,
    conversationKey: actorContext.conversationKey,
    domain,
    goalDigest,
    key: `${actorContext.actorKey}|${actorContext.conversationKey}|${domain}|${goalDigest}`,
  });
}

function normalizeReceipt(value, selection) {
  try {
    const keys = Object.keys(value || {}).sort();
    if (keys.join('|') !== ['actorKey', 'goalDigest', 'jobId', 'nextRunAt', 'status', 'terminalStates'].join('|')) throw new Error('invalid');
    if (!SAFE_ID.test(value.jobId) || value.actorKey !== selection.actorKey || value.goalDigest !== selection.goalDigest) throw new Error('invalid');
    if (!RECEIPT_STATUSES.has(value.status) || !Number.isFinite(Date.parse(value.nextRunAt))) throw new Error('invalid');
    if (!Array.isArray(value.terminalStates) || value.terminalStates.length !== TERMINAL_STATES.length
      || value.terminalStates.some((item, index) => item !== TERMINAL_STATES[index])) throw new Error('invalid');
    return deepFreeze({
      jobId: value.jobId,
      actorKey: value.actorKey,
      goalDigest: value.goalDigest,
      status: value.status,
      nextRunAt: value.nextRunAt,
      terminalStates: [...TERMINAL_STATES],
    });
  } catch {
    throw facadeError('EXTERNAL_ACTIVITY_RECEIPT_UNTRUSTED', 'external activity receipt is not trusted');
  }
}

function inferDomain(value) {
  const text = normalizeGoal(value);
  if (/(?:game|minecraft|游戏|玩|关卡)/i.test(text)) return 'game';
  if (/(?:browser|浏览器|\bapi\b|接口)/i.test(text)) return 'other';
  if (/(?:device|robot|机器人|设备|控制|校准)/i.test(text)) return 'embodied';
  if (/(?:forum|discourse|论坛|帖子|草稿|观察|监控|watch)/i.test(text)) return 'forum';
  return 'other';
}

function referencesDomain(reference, domain) {
  if (domain === 'game') return /(?:game|游戏|玩)/i.test(reference);
  if (domain === 'forum') return /(?:forum|论坛|帖子|观察)/i.test(reference);
  if (domain === 'embodied') return /(?:device|robot|设备|机器人)/i.test(reference);
  return false;
}

function isStopAll(request) {
  const text = normalizeGoal(`${request.goal} ${request.reference}`);
  return /^(?:all|stop all|全部|停止全部|停止所有|都停了)$/.test(text);
}

function clarification(requestRef, matches) {
  const labels = Array.from(new Set(matches.map((item) => ({
    game: '游戏',
    forum: '论坛观察',
    embodied: '设备任务',
    other: '其他目标',
  }[item.domain]))));
  return deepFreeze({
    ok: true,
    requestRef,
    action: 'clarify',
    message: `我找到了几个还在进行的目标。你想处理${labels.join('还是')}？`,
    receipt: null,
  });
}

function noOp(requestRef, reason) {
  return Object.freeze({ ok: true, requestRef, action: 'noop', reason, receipt: null });
}

function success(requestRef, action, receipt) {
  return Object.freeze({ ok: true, requestRef, action, receipt });
}

function digestGoal(value) {
  return digestText(normalizeGoal(value));
}

function digestText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeGoal(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function identifier(value, maxLength, code) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) throw facadeError(code, 'activity identifier is invalid');
  return text;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity request text is invalid');
  const text = value.trim();
  if (text.length > maxLength || /\0/.test(text)) throw facadeError('EXTERNAL_ACTIVITY_REQUEST_INVALID', 'activity request text is invalid');
  return text;
}

function normalizeField(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPrivateField(value) {
  return PRIVATE_PREFIXES.some((prefix) => value === prefix || value.startsWith(prefix));
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

function facadeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
