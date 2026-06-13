/**
 * Hermes API/CLI adapter for the WeChat reply backend.
 *
 * This module only calls Hermes. It does not implement an agent runtime,
 * DeepSeek gateway, or tool loop.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ensureConversationMediaContext } from './mediaContextStore.mjs';
import {
  getContextPolicyConfig,
  buildCompactMediaContext,
  selectMediaArtifactsForPrompt,
  buildContextSizeLog,
} from './contextPolicy.mjs';
import { resolveProjectRoot } from './trustedMediaPaths.mjs';
import {
  getHermesLiteSoftResetConfig,
  getLiteSessionNonce,
  getPendingLiteResumeDigest,
  markLiteResumeDigestConsumed,
} from './hermesSessionMaintenance.mjs';

const execFile = promisify(execFileCallback);
const recentConversationStore = new Map();
const MAX_RECENT_CONVERSATION_SESSIONS = 200;
const VALID_CONTEXT_INJECTION_MODES = new Set(['auto', 'rich', 'slim', 'resume']);

const HERMES_CONTEXT_BUDGET_DEFAULTS = {
  rich: {
    recentLocalTurns: 10,
    recentLocalChars: 6000,
    globalRecentTurns: 6,
    globalRecentChars: 2500,
    activeTopicChars: 1200,
    continuityChars: 1200,
  },
  slim: {
    recentLocalTurns: 4,
    recentLocalChars: 2400,
    globalRecentTurns: 2,
    globalRecentChars: 800,
    activeTopicChars: 400,
    continuityChars: 600,
  },
  resume: {
    recentLocalTurns: 2,
    recentLocalChars: 1200,
    globalRecentTurns: 2,
    globalRecentChars: 600,
    activeTopicChars: 300,
    continuityChars: 500,
  },
};

export function getHermesGatewayConfig(env = process.env) {
  const baseUrl = String(env.HERMES_API_BASE_URL || 'http://127.0.0.1:8642/v1').trim().replace(/\/$/, '');
  const liteBaseUrl = String(env.HERMES_LITE_API_BASE_URL || baseUrl).trim().replace(/\/$/, '');
  const fullBaseUrl = String(env.HERMES_FULL_API_BASE_URL || 'http://127.0.0.1:8643/v1').trim().replace(/\/$/, '');
  const token = String(env.HERMES_API_KEY || env.API_SERVER_KEY || '').trim();
  const model = String(env.HERMES_DEFAULT_MODEL || env.HERMES_INFERENCE_MODEL || 'deepseek-v4-flash').trim();
  const provider = String(env.HERMES_PROVIDER || env.HERMES_INFERENCE_PROVIDER || 'deepseek').trim();
  const profile = String(env.HERMES_PROFILE || 'ran-assistant').trim();
  const mode = normalizeMode(env.HERMES_REPLY_MODE || env.HERMES_GATEWAY_CLIENT_MODE || 'api');
  const command = String(env.HERMES_COMMAND || 'hermes').trim() || 'hermes';
  const timeoutSeconds = Math.max(30, Number.parseInt(String(env.HERMES_REPLY_TIMEOUT_SECONDS || '180'), 10) || 180);
  const projectRoot = resolveProjectRoot(env);
  const {
    contextPolicyMode,
    maxMediaArtifacts,
    enableContextSizeLog,
  } = getContextPolicyConfig(env);
  const capabilityMode = String(env.RAN_AGENT_CAPABILITY_MODE || 'auto').trim().toLowerCase();
  const liteProfile = String(env.HERMES_LITE_PROFILE || 'ran-assistant-lite').trim();
  const fullProfile = String(env.HERMES_FULL_PROFILE || env.HERMES_PROFILE || 'ran-assistant').trim();
  const sessionContinuityEnabled = String(env.HERMES_SESSION_CONTINUITY_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const sessionIdPrefix = String(env.HERMES_SESSION_ID_PREFIX || 'ran-agent-wechat').trim() || 'ran-agent-wechat';
  const sessionKeyPrefix = String(env.HERMES_SESSION_KEY_PREFIX || 'ran-agent-memory').trim() || 'ran-agent-memory';
  const recentTextTurns = Math.max(0, Number.parseInt(String(env.HERMES_RECENT_TEXT_TURNS || '10'), 10) || 10);
  const recentTextCharBudget = Math.max(0, Number.parseInt(String(env.HERMES_RECENT_TEXT_CHAR_BUDGET || '6000'), 10) || 6000);
  const recentTextMaxUserChars = Math.max(100, Number.parseInt(String(env.HERMES_RECENT_TEXT_MAX_USER_CHARS || '1200'), 10) || 1200);
  const recentTextMaxAssistantChars = Math.max(100, Number.parseInt(String(env.HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS || '1200'), 10) || 1200);
  const globalRecentTurns = Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_TURNS || '6'), 10) || 6);
  const globalRecentCharBudget = Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_CHAR_BUDGET || '2500'), 10) || 2500);
  const activeTopicCharBudget = Math.max(0, Number.parseInt(String(env.HERMES_ACTIVE_TOPIC_CHAR_BUDGET || '1200'), 10) || 1200);
  const contextInjectionMode = String(env.HERMES_CONTEXT_INJECTION_MODE || 'auto').trim().toLowerCase() || 'auto';
  const softResetConfig = getHermesLiteSoftResetConfig(env);
  const contextBudgetOverrides = {
    recentLocalTurns: parseExplicitNonNegativeInteger(env.HERMES_RECENT_TEXT_TURNS),
    recentLocalChars: parseExplicitNonNegativeInteger(env.HERMES_RECENT_TEXT_CHAR_BUDGET),
    globalRecentTurns: parseExplicitNonNegativeInteger(env.HERMES_GLOBAL_RECENT_TURNS),
    globalRecentChars: parseExplicitNonNegativeInteger(env.HERMES_GLOBAL_RECENT_CHAR_BUDGET),
    activeTopicChars: parseExplicitNonNegativeInteger(env.HERMES_ACTIVE_TOPIC_CHAR_BUDGET),
    continuityChars: firstProvided(
      parseExplicitNonNegativeInteger(env.HERMES_CONTINUITY_NOTE_CHAR_BUDGET),
      parseExplicitNonNegativeInteger(env.HERMES_CONTINUITY_CHAR_BUDGET)
    ),
  };

  return {
    baseUrl,
    liteBaseUrl,
    fullBaseUrl,
    token,
    model,
    provider,
    profile,
    liteProfile,
    fullProfile,
    sessionContinuityEnabled,
    sessionIdPrefix,
    sessionKeyPrefix,
    recentTextTurns,
    recentTextCharBudget,
    recentTextMaxUserChars,
    recentTextMaxAssistantChars,
    globalRecentTurns,
    globalRecentCharBudget,
    activeTopicCharBudget,
    mode,
    command,
    timeoutSeconds,
    projectRoot,
    contextPolicyMode,
    contextInjectionMode,
    contextBudgetOverrides,
    softResetEnabled: softResetConfig.enabled,
    softResetDryRun: softResetConfig.dryRun,
    softResetMaxDigestChars: softResetConfig.maxDigestChars,
    softResetKeepLastN: softResetConfig.keepLastN,
    softResetStateFile: softResetConfig.stateFile,
    softResetDigestDir: softResetConfig.digestDir,
    maxMediaArtifacts,
    enableContextSizeLog,
    capabilityMode,
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 Hermes，请稍后再试。',
  };
}

export function resolveHermesContextBudget({
  mode = 'auto',
  config = {},
  continuityState = {},
  hasMedia = false,
} = {}) {
  const requestedMode = String(mode || 'auto').trim().toLowerCase() || 'auto';
  const invalidMode = !VALID_CONTEXT_INJECTION_MODES.has(requestedMode);
  const finalMode = invalidMode ? 'auto' : requestedMode;
  let defaults;
  let decisionReason;

  if (finalMode === 'rich') {
    defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.rich;
    decisionReason = 'explicit_rich';
  } else if (finalMode === 'slim') {
    defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.slim;
    decisionReason = 'explicit_slim';
  } else if (finalMode === 'resume') {
    defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.resume;
    decisionReason = 'explicit_resume';
  } else {
    const hasLocalRecent = continuityState.hasLocalRecent === true;
    const hasGlobalRecent = continuityState.hasGlobalRecent === true;
    const hasContinuityNote = continuityState.hasContinuityNote === true;
    if (hasMedia) {
      defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.slim;
      decisionReason = 'auto_media_slim';
    } else if (hasGlobalRecent && hasContinuityNote) {
      defaults = {
        ...HERMES_CONTEXT_BUDGET_DEFAULTS.slim,
        recentLocalTurns: 2,
        recentLocalChars: 1200,
      };
      decisionReason = 'auto_cross_channel_brief';
    } else if (hasLocalRecent) {
      defaults = {
        ...HERMES_CONTEXT_BUDGET_DEFAULTS.slim,
        globalRecentTurns: 0,
        globalRecentChars: 0,
        activeTopicChars: 0,
      };
      decisionReason = 'auto_same_conversation_slim';
    } else if (hasGlobalRecent) {
      defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.slim;
      decisionReason = 'auto_cross_channel_brief';
    } else {
      defaults = HERMES_CONTEXT_BUDGET_DEFAULTS.resume;
      decisionReason = 'auto_resume_new_session';
    }
  }

  return {
    mode: finalMode,
    budgets: normalizeContextBudget(applyBudgetOverrides(defaults, config.contextBudgetOverrides)),
    decisionReason,
    invalidMode,
  };
}

function applyBudgetOverrides(defaults = {}, overrides = {}) {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeContextBudget(budget = {}) {
  return {
    recentLocalTurns: normalizeBudgetNumber(budget.recentLocalTurns),
    recentLocalChars: normalizeBudgetNumber(budget.recentLocalChars),
    globalRecentTurns: normalizeBudgetNumber(budget.globalRecentTurns),
    globalRecentChars: normalizeBudgetNumber(budget.globalRecentChars),
    activeTopicChars: normalizeBudgetNumber(budget.activeTopicChars),
    continuityChars: normalizeBudgetNumber(budget.continuityChars),
  };
}

function normalizeBudgetNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function applyContextBudgetToConfig(config = {}, budgets = {}, mode = 'auto') {
  const normalized = normalizeContextBudget(budgets);
  return {
    ...config,
    contextInjectionMode: mode || config.contextInjectionMode || 'auto',
    recentTextTurns: normalized.recentLocalTurns,
    recentTextCharBudget: normalized.recentLocalChars,
    globalRecentTurns: normalized.globalRecentTurns,
    globalRecentCharBudget: normalized.globalRecentChars,
    activeTopicCharBudget: normalized.activeTopicChars,
    continuityCharBudget: normalized.continuityChars,
  };
}

function parseExplicitNonNegativeInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

const GENERATION_INTENT_PATTERN = /画|生成|头像|壁纸|海报|语音|朗读|读出来|tts|画图|生图|配图/;
const DEBUG_INTENT_PATTERN = /调试|debug|执行命令|运行命令|看文件|查看文件|查看日志|看日志|服务端|systemd|systemctl|journalctl|lark-cli|playwright|重启服务|部署|git\s+(push|pull|commit|log|diff|status)|npm\s+(install|run|test|exec)|pip\s+install|curl\s+/;
const FULL_OVERRIDE_PATTERN = /开\s*full|全能力|调试模式|full\s*mode/;
const LITE_OVERRIDE_PATTERN = /轻量|省\s*token|日常模式|lite\s*mode/;

function resolveCapabilityMode(payload, config) {
  const mode = config.capabilityMode || 'auto';
  const text = String(payload.text || '');
  const hasSocialLink = SOCIAL_PLATFORM_NAMES.some(({ pattern }) => pattern.test(text));
  const hasMedia = normalizeMediaItems(payload.media).length > 0
    || (Array.isArray(payload.image_urls) && payload.image_urls.some((u) => typeof u === 'string' && u.trim()));
  const hasGenerationIntent = GENERATION_INTENT_PATTERN.test(text);
  const hasDebugIntent = DEBUG_INTENT_PATTERN.test(text);

  // Explicit override
  if (mode === 'lite') return { mode: 'lite', reason: 'explicit_lite', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
  if (mode === 'full') return { mode: 'full', reason: 'explicit_full', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };

  // Auto mode
  if (FULL_OVERRIDE_PATTERN.test(text)) return { mode: 'full', reason: 'user_requested_full', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
  if (LITE_OVERRIDE_PATTERN.test(text)) return { mode: 'lite', reason: 'user_requested_lite', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
  if (hasDebugIntent) return { mode: 'full', reason: 'debug_intent', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
  if (hasGenerationIntent) return { mode: 'full', reason: 'generation_intent', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
  // Default: lite (covers normal chat, social links, image analysis, memory queries)
  return { mode: 'lite', reason: 'default', hasSocialLink, hasMedia, hasGenerationIntent, hasDebugIntent };
}

export async function sendChatToHermesGateway(payload, options = {}) {
  const env = options.env || process.env;
  const config = options.config || getHermesGatewayConfig(env);
  const logger = options.logger || console;
  const requestId = options.requestId || createRequestId();

  // Determine capability mode and select base URL + profile
  const capResult = resolveCapabilityMode(payload, config);
  let selectedBaseUrl = capResult.mode === 'lite' ? config.liteBaseUrl : config.fullBaseUrl;
  let selectedProfile = capResult.mode === 'lite' ? config.liteProfile : config.fullProfile;
  let fallbackReason = '';

  // If full mode and API mode, try full gateway first; fallback to lite if unavailable
  if (capResult.mode === 'full' && selectedBaseUrl !== config.liteBaseUrl && config.mode === 'api') {
    try {
      const testResp = await (options.fetchImpl || fetch)(`${selectedBaseUrl}/models`, {
        method: 'GET',
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!testResp.ok) {
        fallbackReason = 'full_gateway_unavailable';
        selectedBaseUrl = config.liteBaseUrl;
        selectedProfile = config.liteProfile;
      }
    } catch {
      fallbackReason = 'full_gateway_unavailable';
      selectedBaseUrl = config.liteBaseUrl;
      selectedProfile = config.liteProfile;
    }
  }

  // Always log capability mode (not just when contextSizeLog is enabled)
  logger.log?.('[hermes-capability-mode]', JSON.stringify({
    mode: capResult.mode,
    reason: capResult.reason,
    has_social_link: capResult.hasSocialLink,
    has_media: capResult.hasMedia,
    has_generation_intent: capResult.hasGenerationIntent,
    has_debug_intent: capResult.hasDebugIntent,
    selected_base_url: selectedBaseUrl,
    selected_profile: selectedProfile,
    request_id: requestId,
    fallback_reason: fallbackReason || undefined,
  }));
  logSocialLinkRouting(payload, logger, requestId);

  const selectedConfig = { ...config, baseUrl: selectedBaseUrl, profile: selectedProfile };
  const sessionContext = buildHermesSessionContext(payload, selectedConfig);
  const isLiteProfile = selectedConfig.profile === selectedConfig.liteProfile;
  const pendingResumeDigest = isLiteProfile ? getPendingLiteResumeDigest(selectedConfig) : null;
  const effectivePayload = pendingResumeDigest
    ? { ...payload, daily_digest_context: pendingResumeDigest.text }
    : payload;
  const hasExternalLocalRecent = Array.isArray(payload.recent_local_history) && payload.recent_local_history.length > 0;
  const hasStoredLocalRecent = sessionContext.enabled === true
    && Boolean(sessionContext.stableKey)
    && (recentConversationStore.get(sessionContext.stableKey) || []).length > 0;
  const hasGlobalRecent = Array.isArray(payload.recent_global_history) && payload.recent_global_history.length > 0;
  const contextBudget = resolveHermesContextBudget({
    mode: pendingResumeDigest ? 'resume' : selectedConfig.contextInjectionMode,
    config: selectedConfig,
    continuityState: {
      hasLocalRecent: hasExternalLocalRecent || (!Array.isArray(payload.recent_local_history) && hasStoredLocalRecent),
      hasGlobalRecent,
      hasContinuityNote: Boolean(String(payload.continuity_note || '').trim()),
    },
    channel: payload.platform || payload.channel,
    conversationId: firstNonEmptyString(payload.conversation_id, payload.conversationId, payload.sender_id, payload.senderId),
    sessionId: sessionContext.sessionId,
    hasMedia: capResult.hasMedia,
  });
  if (pendingResumeDigest) {
    contextBudget.decisionReason = 'soft_reset_pending_digest';
  }
  if (contextBudget.invalidMode) {
    logger.warn?.('invalid HERMES_CONTEXT_INJECTION_MODE; falling back to auto');
  }
  const budgetedConfig = applyContextBudgetToConfig(selectedConfig, contextBudget.budgets, contextBudget.mode);
  const externalRecentMessages = limitHistoryMessages(
    normalizeHistoryMessages(payload.recent_local_history, budgetedConfig),
    contextBudget.budgets.recentLocalTurns,
    contextBudget.budgets.recentLocalChars
  );
  const recentMessages = externalRecentMessages.length > 0
    ? externalRecentMessages
    : buildRecentHistoryMessages(sessionContext, budgetedConfig);
  const globalRecentMessages = limitHistoryMessages(normalizeHistoryMessages(payload.recent_global_history, {
    ...budgetedConfig,
    recentTextMaxUserChars: 900,
    recentTextMaxAssistantChars: 900,
  }), contextBudget.budgets.globalRecentTurns, contextBudget.budgets.globalRecentChars);

  const preparedMessage = await buildHermesUserMessage(effectivePayload, {
    env,
    config: budgetedConfig,
    logger,
    mediaContextOptions: options.mediaContextOptions,
    sessionContext,
    recentHistoryMessages: recentMessages,
    globalHistoryMessages: globalRecentMessages,
    contextBudget,
    requestId,
  });
  logHermesSessionContinuity({
    logger,
    config: budgetedConfig,
    sessionContext,
    recentMessages,
    globalRecentMessages,
    preparedMessage,
    continuityNoteChars: buildBudgetedContinuityNote(effectivePayload, recentMessages, contextBudget.budgets).length,
    payload: effectivePayload,
  });

  if (config.mode === 'oneshot') {
    const response = await sendChatToHermesOneShot(preparedMessage, {
      config: budgetedConfig,
      execFileImpl: options.execFileImpl,
    });
    if (pendingResumeDigest) markLiteResumeDigestConsumed(budgetedConfig, pendingResumeDigest.digestId);
    recordRecentConversationTurn(sessionContext, payload, response, budgetedConfig);
    return applyEvidenceGateToResponse(payload, response, env, logger, requestId);
  }

  try {
    const response = await sendChatToHermesApi(preparedMessage, {
      config: budgetedConfig,
      fetchImpl: options.fetchImpl,
      sessionContext,
      recentMessages,
      logger,
      requestId,
    });
    if (pendingResumeDigest) markLiteResumeDigestConsumed(budgetedConfig, pendingResumeDigest.digestId);
    recordRecentConversationTurn(sessionContext, payload, response, budgetedConfig);
    return applyEvidenceGateToResponse(payload, response, env, logger, requestId);
  } catch (error) {
    if (config.mode !== 'auto') {
      throw error;
    }
    logger.warn?.(`hermes api request failed, retrying with one-shot: ${formatErrorMessage(error)}`);
    const response = await sendChatToHermesOneShot(preparedMessage, {
      config: budgetedConfig,
      execFileImpl: options.execFileImpl,
    });
    if (pendingResumeDigest) markLiteResumeDigestConsumed(budgetedConfig, pendingResumeDigest.digestId);
    recordRecentConversationTurn(sessionContext, payload, response, budgetedConfig);
    return applyEvidenceGateToResponse(payload, response, env, logger, requestId);
  }
}

async function sendChatToHermesApi(message, options = {}) {
  const config = options.config || getHermesGatewayConfig();
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint = `${config.baseUrl}/chat/completions`;
  const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: buildHermesHeaders(config, options.sessionContext),
    body: JSON.stringify({
      model: config.profile || 'ran-assistant',
      messages: [
        {
          role: 'system',
          content: buildHermesSystemInstruction(),
        },
        ...recentMessages,
        {
          role: 'user',
          content: message,
        },
      ],
      stream: false,
    }),
  });

  if (!response?.ok) {
    const status = response?.status || 'unknown';
    const text = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(`hermes api request failed: HTTP ${status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }

  const body = await parseHermesJson(response);
  if (config.enableContextSizeLog) {
    logProviderUsageTelemetry(body, {
      config,
      sessionContext: options.sessionContext,
      logger: options.logger,
      requestId: options.requestId,
    });
  }
  return buildHermesReply(body, config);
}

async function sendChatToHermesOneShot(message, options = {}) {
  const config = options.config || getHermesGatewayConfig();
  const execFileImpl = options.execFileImpl || execFile;
  const args = [
    '-p',
    config.profile,
    '--provider',
    config.provider,
    '--model',
    config.model,
    '-z',
    message,
  ];
  const { stdout } = await execFileImpl(config.command, args, {
    cwd: config.projectRoot,
    timeout: config.timeoutSeconds * 1000,
  });
  return buildHermesReply({
    reply_text: String(stdout || '').trim(),
    model: config.model,
  }, config);
}

async function buildHermesUserMessage(payload = {}, options = {}) {
  const config = options.config || getHermesGatewayConfig(options.env);
  const mediaContext = await ensureConversationMediaContext(payload, {
    env: options.env,
    logger: options.logger,
    ...(options.mediaContextOptions || {}),
  });
  const mediaContextText = buildHermesMediaContextText(mediaContext, config);
  const hasMedia = normalizeMediaItems(payload.media).length > 0
    || (Array.isArray(payload.image_urls) && payload.image_urls.some((u) => typeof u === 'string' && u.trim()))
    || (Array.isArray(mediaContext.artifacts) && mediaContext.artifacts.length > 0);
  const courtlyAnchor = buildCourtlyStyleAnchor(payload);
  const socialRoutingHint = buildSocialLinkRoutingHint(payload);
  const recentHistoryMessages = Array.isArray(options.recentHistoryMessages) ? options.recentHistoryMessages : [];
  const globalHistoryMessages = Array.isArray(options.globalHistoryMessages) ? options.globalHistoryMessages : [];
  const contextBudget = options.contextBudget || {
    mode: config.contextInjectionMode || 'auto',
    budgets: {
      recentLocalTurns: config.recentTextTurns || 0,
      recentLocalChars: config.recentTextCharBudget || 0,
      globalRecentTurns: config.globalRecentTurns || 0,
      globalRecentChars: config.globalRecentCharBudget || 0,
      activeTopicChars: config.activeTopicCharBudget || 0,
      continuityChars: config.continuityCharBudget || 0,
    },
    decisionReason: '',
  };
  const continuityNote = buildBudgetedContinuityNote(payload, recentHistoryMessages, contextBudget.budgets);
  const activeTopic = contextBudget.budgets.activeTopicChars > 0
    ? clipText(String(payload.active_topic || '').trim(), contextBudget.budgets.activeTopicChars)
    : '';
  const dailyDigestText = buildDailyDigestContextText(payload);
  const currentUserMessage = buildHermesUserText(payload);
  const message = [
    buildBridgeTemporalUserContext(payload),
    dailyDigestText,
    continuityNote,
    buildGlobalActiveTopicNote({ ...payload, active_topic: activeTopic }, globalHistoryMessages, config),
    courtlyAnchor,
    socialRoutingHint,
    buildSocialMediaRetryHint(payload, recentHistoryMessages),
    hasMedia ? buildHermesMediaGenerationInstruction() : '',
    buildHermesInboundMediaInstruction(payload),
    mediaContextText,
    currentUserMessage,
  ].filter(Boolean).join('\n\n');

  if (config.enableContextSizeLog) {
    const sizeLog = buildContextSizeLog([
      { label: 'system_prompt_chars', text: buildHermesSystemInstruction() },
      { label: 'media_context_chars', text: mediaContextText },
      { label: 'final_prompt_chars', text: message },
    ]);
    options.logger?.log?.('[hermes-context-size]', JSON.stringify({
      ...sizeLog,
      media_artifact_count: Array.isArray(mediaContext.artifacts) ? mediaContext.artifacts.length : 0,
      request_id: options.requestId || createRequestId(),
      context_policy_mode: config.contextPolicyMode,
    }));
    logContextComponentTelemetry({
      payload,
      config,
      recentHistoryMessages,
      globalHistoryMessages,
      activeTopic,
      continuityNote,
      dailyDigestText,
      mediaContextText,
      currentUserMessage,
      contextBudget,
      sessionContext: options.sessionContext,
      requestId: options.requestId || createRequestId(),
      logger: options.logger,
    });
  }

  return message;
}

function logContextComponentTelemetry({
  payload = {},
  config = {},
  recentHistoryMessages = [],
  globalHistoryMessages = [],
  activeTopic = '',
  continuityNote = '',
  dailyDigestText = '',
  mediaContextText = '',
  currentUserMessage = '',
  contextBudget = {},
  sessionContext = {},
  requestId = createRequestId(),
  logger = console,
} = {}) {
  const budgets = normalizeContextBudget(contextBudget.budgets || {
    recentLocalTurns: config.recentTextTurns,
    recentLocalChars: config.recentTextCharBudget,
    globalRecentTurns: config.globalRecentTurns,
    globalRecentChars: config.globalRecentCharBudget,
    activeTopicChars: config.activeTopicCharBudget,
    continuityChars: config.continuityCharBudget,
  });
  logger?.log?.(`[hermes-context-components] ${JSON.stringify({
    request_id: requestId,
    profile: config.profile || '',
    channel: String(payload.platform || payload.channel || '').trim().toLowerCase() || '',
    conversation_id_hash: sha256Hex(firstNonEmptyString(payload.conversation_id, payload.conversationId, payload.sender_id, payload.senderId)).slice(0, 16),
    session_id_hash: sessionContext.sessionId
      ? sha256Hex(sessionContext.sessionId).slice(0, 16)
      : '',
    context_mode: contextBudget.mode || config.contextInjectionMode || 'auto',
    context_decision_reason: contextBudget.decisionReason || '',
    budgets,
    components: {
      recent_local_history: measureContextComponent(
        historyMessagesText(recentHistoryMessages),
        budgets.recentLocalTurns <= 0 || budgets.recentLocalChars <= 0 || recentHistoryMessages.length === 0
      ),
      global_recent_history: measureContextComponent(
        historyMessagesText(globalHistoryMessages),
        budgets.globalRecentTurns <= 0 || budgets.globalRecentChars <= 0 || globalHistoryMessages.length === 0
      ),
      active_topic: measureContextComponent(activeTopic, budgets.activeTopicChars <= 0 || !activeTopic),
      continuity_note: measureContextComponent(continuityNote, budgets.continuityChars <= 0 || !continuityNote),
      media_context: measureContextComponent(mediaContextText, !mediaContextText),
      daily_digest: measureContextComponent(dailyDigestText, !dailyDigestText),
      current_user_message: measureContextComponent(currentUserMessage, false),
    },
  })}`);
}

function historyMessagesText(messages = []) {
  return Array.isArray(messages)
    ? messages.map((message) => String(message?.content || '')).join('\n')
    : '';
}

function measureContextComponent(text = '', omitted = false) {
  const value = String(text || '');
  return {
    chars: value.length,
    bytes: utf8ByteLength(value),
    estimated_tokens: estimateTokens(value),
    omitted: Boolean(omitted),
  };
}

function estimateTokens(text = '') {
  const value = String(text || '');
  let chineseChars = 0;
  for (const char of value) {
    if (char >= '\u4e00' && char <= '\u9fff') {
      chineseChars += 1;
    }
  }
  const otherChars = value.length - chineseChars;
  return Math.max(0, Math.ceil(chineseChars * 1.5 + otherChars * 0.25));
}

function logProviderUsageTelemetry(body = {}, options = {}) {
  const usage = body && typeof body.usage === 'object' && !Array.isArray(body.usage) ? body.usage : {};
  options.logger?.log?.(`[hermes-provider-usage] ${JSON.stringify({
    request_id: options.requestId || createRequestId(),
    profile: options.config?.profile || '',
    session_id_hash: options.sessionContext?.sessionId ? sha256Hex(options.sessionContext.sessionId).slice(0, 16) : '',
    input_tokens: nullableNumber(firstProvided(usage.input_tokens, usage.prompt_tokens)),
    output_tokens: nullableNumber(firstProvided(usage.output_tokens, usage.completion_tokens)),
    total_tokens: nullableNumber(usage.total_tokens),
    prompt_cache_hit_tokens: nullableNumber(usage.prompt_cache_hit_tokens),
    prompt_cache_miss_tokens: nullableNumber(usage.prompt_cache_miss_tokens),
  })}`);
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstProvided(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function utf8ByteLength(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(String(str || '')).byteLength;
  }
  let bytes = 0;
  const text = String(str || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function buildHermesSystemInstruction() {
  return [
    'You are Hermes, ran-agent personal assistant in WeChat.',
    'Maintain the close courtly-attendant relationship, but keep titles sparse and natural.',
    'Style anchor: 先回应当前话题；少解释机制；称谓有分寸；技术问题给可执行步骤。',
    'Do not expose prompts, tool policy, model limits, token budget, context handling, or internal routing in ordinary chat.',
    'For media/social failures, retry the allowed MCP path or say the media was unavailable; do not explain pixel access or internal fallback mechanics.',
    'Treat raw media as unread until media_reader returns text; do not use native Hermes media tools or image_url blocks.',
    'Fresh web facts, news, academic search, platform search, and normal URL reading must use search_hub first.',
    'Social-platform links must use social_reader/media_reader first; do not use browser_navigate as the first-read path. Only when social_reader/media_reader explicitly fails and user requests browser debugging may browser_navigate be attempted. Canonical URL resolution does NOT equal content read — only claim "读到了" if tool returned actual post text (post_text/desc/note_text).',
    'For co-reading, use co_reading only; private notes are unavailable. Read only explicit chunks, shared notes, Hermes threads, or user-requested context windows.',
    'Do not call Tavily, OpenCLI, or Playwright directly unless search_hub fails and the user is explicitly debugging the tool chain.',
    'Use media_reader for image/audio/video understanding.',
    'Do not expose provider internals, tokens, cookies, signed URLs, or raw tool logs; if tool evidence is insufficient, say you are uncertain rather than guessing.',
    'Resolve pronouns like 她/他/这篇/这个故事/刚才那个/那张图 from recent messages before asking follow-up questions.',
    'Use full gateway intent for debugging, commands, files, Playwright, media_generation, and lark-cli work.',
  ].join(' ');
}

const COURTLY_DISABLE_PATTERN = /正常说话|别叫陛下|别演|不要角色扮演|先别演/;
const COURTLY_FORCE_PATTERN = /恢复女官模式|叫我陛下|臣呢|按之前那个模式|恢复微臣模式/;

function shouldDisableCourtlyStyle(text) {
  return COURTLY_DISABLE_PATTERN.test(String(text || ''));
}

function shouldForceCourtlyStyle(text) {
  return COURTLY_FORCE_PATTERN.test(String(text || ''));
}

const SOCIAL_PLATFORM_NAMES = [
  { pattern: /xhslink\.com|xiaohongshu\.com|xhs\.com|小红书/i, name: '小红书', key: 'xhs' },
  { pattern: /bilibili\.com|b23\.tv/i, name: 'B站', key: 'bilibili' },
  { pattern: /mp\.weixin\.qq\.com/i, name: '微信公众号', key: 'wechat_article' },
  { pattern: /douyin\.com/i, name: '抖音', key: 'douyin' },
  { pattern: /kuaishou\.com/i, name: '快手', key: 'kuaishou' },
  { pattern: /weibo\.com/i, name: '微博', key: 'weibo' },
  { pattern: /zhihu\.com/i, name: '知乎', key: 'zhihu' },
  { pattern: /music\.163\.com|y\.music\.163\.com/i, name: '网易云音乐', key: 'netease_music' },
];

function detectSocialPlatformInfo(text) {
  for (const item of SOCIAL_PLATFORM_NAMES) {
    if (item.pattern.test(text)) return item;
  }
  return null;
}

function detectSocialPlatform(text) {
  return detectSocialPlatformInfo(text)?.name || '';
}

function buildSocialLinkRoutingHint(payload = {}) {
  const text = String(payload.text || '');
  const platformInfo = detectSocialPlatformInfo(text);
  const platform = platformInfo?.name || '';
  if (!platformInfo) return '';
  const xhsRules = platformInfo.key === 'xhs'
    ? [
        '首个工具必须是 mcp_social_reader_read_social_post 或 mcp_social_reader_resolve_social_url；不要先走浏览器或终端。',
        'terminal 不得处理 xhslink/xiaohongshu/小红书链接，也不要把 URL 交给命令执行。',
        'browser_navigate 不得作为第一读取路径；只有 social_reader/media_reader 明确失败且用户请求浏览器调试时才允许尝试。',
      ]
    : [];
  return [
    '【社交链接路由指令（非用户原话，不要复述）】',
    `本轮包含${platform}链接。`,
    '首个工具：mcp_social_reader_read_social_post 或 mcp_social_reader_resolve_social_url。',
    ...xhsRules,
    '备选：mcp_media_reader_resolve_platform_media / generic_parser。',
    '不要把 browser_navigate 作为第一读取路径；只有 social_reader/media_reader 明确失败且用户请求浏览器调试时才允许尝试。',
    'canonical URL 不等于正文。只有工具返回了 post_text/desc/note_text 等正文字段，才能说自己读到了。',
    '如果没有 content_read evidence，直接告诉用户"链接已解析，但正文未能读取"，不要猜测或编造内容。',
    '如读取结果里还有图片、视频或音频，再按需交给 media_reader。',
  ].join('\n');
}

function logSocialLinkRouting(payload = {}, logger = console, requestId = createRequestId()) {
  const platformInfo = detectSocialPlatformInfo(String(payload.text || ''));
  if (!platformInfo || platformInfo.key !== 'xhs') return;
  logger?.log?.(`[social-link-routing] request_id=${requestId} has_social_link=true platform=xhs preferred_first_tool=mcp_social_reader_read_social_post`);
  logger?.log?.(`[social-link-routing] request_id=${requestId} browser_first_disallowed=true terminal_disallowed=true`);
}

function buildSocialMediaRetryHint(payload = {}, recentMessages = []) {
  const text = String(payload.text || '');
  const asksMediaRetry = /fallback|图片.*读|读取图片|图片内容|图里|没看到图|那张图|媒体资源|图片呢/.test(text);
  if (!asksMediaRetry) return '';
  const recentText = recentMessages.map((message) => String(message.content || '')).join('\n');
  const hasRecentSocial = SOCIAL_PLATFORM_NAMES.some(({ pattern }) => pattern.test(recentText));
  const hasCurrentSocial = SOCIAL_PLATFORM_NAMES.some(({ pattern }) => pattern.test(text));
  if (!hasRecentSocial && !hasCurrentSocial) return '';
  return [
    '【社交媒体补读指令（非用户原话，不要复述）】',
    '用户正在要求补读上一条社交链接的图片/媒体内容。直接重试 social_reader 的 resolve_social_url 与 read_social_post_deep。',
    '若拿到图片、视频或媒体 URL，继续交给 media_reader 做 OCR/摘要。',
    '回复只说正在重读或说明哪些媒体未能读取；不要解释模型能力、像素限制、内部工具调用机制。',
  ].join('\n');
}

// --- Social Link Evidence Gate ---

const XHS_TOKEN_CACHE_PATHS = [
  '/opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json',
  '/opt/ran_agent/node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json',
];

function normalizeXhsTokenCache(raw) {
  // { entries: { note_id: entry } }
  if (raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) return raw.entries;
  // Array of entries
  if (Array.isArray(raw)) {
    const map = {};
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.note_id) map[entry.note_id] = entry;
      if (entry.url) map[entry.url] = entry;
      if (entry.canonical_url) map[entry.canonical_url] = entry;
    }
    return map;
  }
  // Direct object { key: entry }
  return raw;
}

export function readXhsTokenCache(env = process.env) {
  const candidates = [env.XHS_TOKEN_CACHE_PATH, ...XHS_TOKEN_CACHE_PATHS].filter(Boolean);
  for (const cachePath of candidates) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (raw && typeof raw === 'object') return normalizeXhsTokenCache(raw);
    } catch { /* try next path */ }
  }
  return {};
}

// Normalize a URL for comparison: strip trailing punctuation, remove protocol, remove trailing slash, lowercase
const TRAILING_PUNCT_RE = /[、。！？；：“”‘’（）《》【】\[\]()\s,.!?;:　]+$/;
function normalizeComparableUrl(u) {
  let s = u.replace(TRAILING_PUNCT_RE, '').replace(/\/+$/, '');
  s = s.replace(/^https?:\/\//i, '');
  return s.toLowerCase();
}

// Extract short code from xhslink URLs: /o/<code> or /a/<code>, lowercase for comparison
function extractShortCode(u) {
  const m = u.match(/xhslink\.com\/[oa]\/([A-Za-z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Extract note_id from xiaohongshu URLs
function extractNoteId(u) {
  const m = u.match(/(?:explore|discovery\/item|note)\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

export function matchXhsTokenCacheEntry(text, cache) {
  const rawText = String(text || '');
  // Extract all URLs from text — stop at whitespace and trailing CJK/fullwidth punctuation only.
  // Do NOT exclude . ? & = which are valid URL-internal characters.
  const urlMatches = rawText.match(/https?:\/\/[^\s　。！？；：“”‘’（）《》]+/gi) || [];
  if (urlMatches.length === 0) return null;

  const entries = Object.values(cache || {}).filter((e) => e && typeof e === 'object');

  for (const rawUrl of urlMatches) {
    const url = normalizeComparableUrl(rawUrl);
    const shortCode = extractShortCode(rawUrl);
    const noteId = extractNoteId(rawUrl);

    for (const entry of entries) {
      const entryUrl = entry.url ? normalizeComparableUrl(entry.url) : '';
      const entryCanonical = entry.canonical_url ? normalizeComparableUrl(entry.canonical_url) : '';

      // Exact URL match (normalized: protocol-agnostic, trailing-punctuation-stripped)
      if (entryUrl && entryUrl === url) return entry;
      if (entryCanonical && entryCanonical === url) return entry;

      // Short code match: extract from both URLs and compare (case-insensitive)
      if (shortCode) {
        const entryShortCode = extractShortCode(entry.url || '') || extractShortCode(entry.canonical_url || '');
        if (entryShortCode && entryShortCode === shortCode) return entry;
      }

      // Note ID match
      if (noteId && entry.note_id === noteId) return entry;

      // Canonical URL contains note_id
      if (noteId && entryCanonical && entryCanonical.includes(noteId)) return entry;
    }
  }
  return null;
}

export function buildSocialEvidenceReport(payload, toolTraceOrResults = null, env = process.env, logger = console, requestId = createRequestId()) {
  const text = String(payload?.text || '');
  const platform = detectSocialPlatform(text);
  const emptyReport = {
    platform: '', hasSocialLink: false,
    link_resolution: { ok: false, source: null, canonical_url: null },
    metadata_read: { ok: false, source: null, fields: [] },
    content_read: { ok: false, source: null, fields: [] },
    allow_claim_read: false, evidence_source: 'none',
  };
  if (!platform) return emptyReport;

  const report = {
    platform,
    hasSocialLink: true,
    link_resolution: { ok: false, source: null, canonical_url: null },
    metadata_read: { ok: false, source: null, fields: [] },
    content_read: { ok: false, source: null, fields: [] },
    allow_claim_read: false,
    evidence_source: 'none',
  };

  // 1. Check token cache for link_resolution evidence
  const cache = readXhsTokenCache(env);
  const cacheEntry = matchXhsTokenCacheEntry(text, cache);
  if (cacheEntry?.canonical_url || cacheEntry?.note_id) {
    report.link_resolution = { ok: true, source: 'token_cache', canonical_url: cacheEntry.canonical_url || null };
    report.evidence_source = 'token_cache';
    const metaFields = ['title', 'user', 'author', 'cover', 'type'].filter((f) => cacheEntry[f]);
    if (metaFields.length > 0) {
      report.metadata_read = { ok: true, source: 'token_cache', fields: metaFields };
    }
  }

  // 2. If tool trace available, parse for higher-level evidence
  if (toolTraceOrResults) {
    report.evidence_source = 'tool_result';
    // Parse tool results for content_read fields:
    // post_text, desc, note_text, content, ocr_text, image_text, full_text
  }

  // 3. Determine allow_claim_read
  report.allow_claim_read = report.content_read?.ok === true;

  // 4. Log evidence stages
  logger?.log?.(`[xhs-evidence] request_id=${requestId} platform=${platform} has_social_link=true`);
  logger?.log?.(`[xhs-evidence] request_id=${requestId} platform=${platform} stage=link_resolution ok=${report.link_resolution.ok} source=${report.link_resolution.source || 'null'} canonical_url=${report.link_resolution.canonical_url || 'null'}`);
  logger?.log?.(`[xhs-evidence] request_id=${requestId} platform=${platform} stage=metadata_read ok=${report.metadata_read.ok} fields=${JSON.stringify(report.metadata_read.fields)}`);
  logger?.log?.(`[xhs-evidence] request_id=${requestId} platform=${platform} stage=content_read ok=${report.content_read.ok} source=${report.content_read.source || 'null'} fields=${JSON.stringify(report.content_read.fields)}`);
  logger?.log?.(`[xhs-evidence] request_id=${requestId} allow_claim_read=${report.allow_claim_read} evidence_source=${report.evidence_source}`);
  if (!toolTraceOrResults) {
    logger?.log?.(`[xhs-evidence] request_id=${requestId} WARNING: tool_result trace not available; using token_cache + reply_text_only fallback`);
  }

  return report;
}

const SOCIAL_CLAIM_PATTERN = /读到了|读到.*(?:全文|正文|原文|内容)|我看到了.*(?:全文|正文|帖子|笔记)|(?:全文|原文|正文|内容)\s*(?:是|如下)|帖子说|笔记说|文章说/;
const SOCIAL_FAILURE_ACK_PATTERN = /没能读|无法读|没有读到|读不到|未能读取|链接已解析|正文未能|只确认链接|只拿到了/;

export function applySocialLinkEvidenceGate(payload, replyText, evidenceReport, logger = console, requestId = createRequestId()) {
  if (!evidenceReport?.hasSocialLink) {
    return { replyText, evidenceGateTriggered: false, evidenceStage: 'none' };
  }

  // If evidence confirms content_read → allow
  if (evidenceReport.content_read?.ok && evidenceReport.allow_claim_read) {
    logger?.log?.(`[xhs-evidence] request_id=${requestId} allow_claim_read=true evidence_source=${evidenceReport.evidence_source} evidence_gate_triggered=false`);
    return { replyText, evidenceGateTriggered: false, evidenceStage: 'content_read' };
  }

  // Check reply text for content claims (last-resort detection)
  const hasClaim = SOCIAL_CLAIM_PATTERN.test(replyText);
  const hasFailureAck = SOCIAL_FAILURE_ACK_PATTERN.test(replyText);

  if (!hasClaim || hasFailureAck) {
    logger?.log?.(`[xhs-evidence] request_id=${requestId} allow_claim_read=false evidence_source=${evidenceReport.evidence_source} evidence_gate_triggered=false`);
    return { replyText, evidenceGateTriggered: false, evidenceStage: 'none' };
  }

  // Gate triggered — rewrite in courtly style, honest about what stage succeeded
  // Order: metadata_read → link_resolution → none
  let rewrite;
  let rewriteReason;
  if (evidenceReport.metadata_read?.ok) {
    rewrite = '臣这边只拿到了一些标题/作者等元数据，但没有拿到正文内容。';
    rewriteReason = 'metadata_only';
  } else if (evidenceReport.link_resolution?.ok) {
    rewrite = '臣这边只确认链接已解析，但没有拿到正文内容，不能说已经读到了全文。';
    rewriteReason = 'link_resolution_only';
  } else {
    rewrite = '臣这边没有成功解析这个链接，也没有读到正文。';
    rewriteReason = 'no_evidence';
  }

  logger?.log?.(`[xhs-evidence] request_id=${requestId} allow_claim_read=false evidence_source=${evidenceReport.evidence_source} evidence_gate_triggered=true rewrite_reason=${rewriteReason}`);

  const stage = evidenceReport.metadata_read?.ok ? 'metadata_read' : evidenceReport.link_resolution?.ok ? 'link_resolution' : 'none';
  return { replyText: rewrite, evidenceGateTriggered: true, evidenceStage: stage };
}

// --- End Social Link Evidence Gate ---

function applyEvidenceGateToResponse(payload, response, env, logger, requestId) {
  const evidenceReport = buildSocialEvidenceReport(payload, null, env, logger, requestId);
  const gateResult = applySocialLinkEvidenceGate(payload, response.reply_text, evidenceReport, logger, requestId);
  if (gateResult.evidenceGateTriggered) {
    return { ...response, reply_text: gateResult.replyText };
  }
  return response;
}

function buildConversationContinuityNote(payload = {}, recentMessages = []) {
  const text = String(payload.text || '').trim();
  if (!text) return '';
  const naturalnessFeedback = /不连贯|模板|套话|机制外显|不自然|像流程|太机械/.test(text);
  const referentialText = /她|他|这个故事|这篇|刚才那个|上面那张图|那张图|那个链接|这件事|图片呢|没看到图|fallback/.test(text);
  if (!naturalnessFeedback && !referentialText) return '';
  const recentTopic = inferRecentTopicFromMessages(recentMessages);
  if (referentialText && recentTopic) {
    return [
      '【conversation continuity note（非用户原话，不要复述）】',
      `current_topic: ${recentTopic}`,
      'user_mood: continuing the current thread',
      'relationship_tone: close, lower title density',
      'last_user_preference: keep continuity; avoid backstage explanations',
      'open_loop: resolve pronouns from recent messages before asking',
      'do_not_repeat: 不要问“是谁的故事”；不要解释内部连续性实现',
    ].join('\n');
  }
  return [
    '【conversation continuity note（非用户原话，不要复述）】',
    'current_topic: reply naturalness feedback',
    'user_mood: mildly dissatisfied',
    'relationship_tone: close, lower title density',
    'last_user_preference: reduce formulaic phrasing and backstage talk',
    'open_loop: acknowledge and adjust in the next reply',
    'do_not_repeat: self-audit report, dense courtly wording, process labels',
  ].join('\n');
}

function buildEffectiveContinuityNote(payload = {}, recentMessages = []) {
  const supplied = String(payload.continuity_note || '').trim();
  if (supplied) {
    return [
      '【conversation continuity note（非用户原话，不要复述）】',
      supplied,
      'do_not_repeat: 不要解释 session header、recent history、context window、token、stateless 或 memory scope',
    ].join('\n');
  }
  return buildConversationContinuityNote(payload, recentMessages);
}

function buildBudgetedContinuityNote(payload = {}, recentMessages = [], budgets = {}) {
  const limit = normalizeBudgetNumber(budgets.continuityChars);
  if (limit <= 0) return '';
  return clipText(buildEffectiveContinuityNote(payload, recentMessages), limit);
}

function buildDailyDigestContextText(payload = {}) {
  const digest = firstNonEmptyString(payload.daily_digest, payload.daily_digest_context);
  if (!digest) return '';
  return [
    '【daily_digest（soft reset resume；非用户原话，不要复述）】',
    digest,
    '只用于恢复未完成线索和偏好；不要把它当作长期记忆库，也不要解释 session reset。',
  ].join('\n');
}

function buildGlobalActiveTopicNote(payload = {}, globalHistoryMessages = [], config = {}) {
  const activeTopic = clipText(String(payload.active_topic || '').trim(), config.activeTopicCharBudget || 1200);
  const history = globalHistoryMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
  if (!activeTopic && !history) return '';
  return [
    '【global active topic（非用户原话，不要复述）】',
    activeTopic ? `active_topic: ${activeTopic}` : '',
    history ? `recent_global:\n${clipText(history, config.globalRecentCharBudget || 2500)}` : '',
    '跨平台承接只用于理解指代；普通回复不要解释 global timeline、session、上下文窗口或 token。',
  ].filter(Boolean).join('\n');
}

export function buildCourtlyStyleAnchor(payload = {}) {
  const env = payload._env || process.env;
  const mode = String(env.RAN_AGENT_COURTLY_MODE || 'on').trim().toLowerCase();
  if (mode === 'off') return '';

  const text = String(payload.text || '');
  if (shouldDisableCourtlyStyle(text)) return '';
  if (shouldForceCourtlyStyle(text)) {
    return '当前对话风格：陛下—贴身女官模式。称用户为"陛下"，自称"臣/微臣"；技术内容保持清楚直接。';
  }
  // Default: inject anchor
  return '当前对话风格：陛下—贴身女官模式。称用户为"陛下"，自称"臣/微臣"；技术内容保持清楚直接。';
}

function buildHermesMediaGenerationInstruction() {
  return [
    '【微信桥接媒体工具指令（非用户原话，不要复述）】',
    '如果用户要求生成图片、画图、发图、生成语音、朗读或发语音，必须使用 Hermes MCP 工具 media_generation。',
    '媒体工具成功后，最终回复必须保留工具结果中的 WECHAT_MEDIA: {...} 原始行，供微信桥接层转换为图片或语音。',
  ].join('\n');
}

function buildHermesInboundMediaInstruction(payload = {}) {
  const assetLines = [];
  for (const [index, media] of normalizeMediaItems(payload.media).entries()) {
    assetLines.push([
      `${index + 1}.`,
      `type=${media.type || inferMediaTypeFromMime(media.mimeType) || 'unknown'}`,
      media.mimeType ? `mime=${media.mimeType}` : '',
      `file_path=${media.filePath}`,
    ].filter(Boolean).join(' '));
  }
  for (const imageUrl of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
    const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (/^https?:\/\//i.test(trimmed)) {
      assetLines.push(`${assetLines.length + 1}. type=image url=${trimmed}`);
    }
  }
  if (assetLines.length === 0) {
    return '';
  }
  return [
    '【微信入站媒体资产（非用户原话，不要复述）】',
    '用户随本轮上传了媒体。DeepSeek V4 不直接看原始媒体；必须使用 media_reader 的工具结果。',
    '如果工具不可用、媒体过期或引用不明确，要直接说明，不要猜测内容。',
    ...assetLines,
  ].join('\n');
}

function buildHermesMediaContextText(mediaContext = {}, config = {}) {
  if (config.contextPolicyMode === 'compact' && Array.isArray(mediaContext.artifacts)) {
    const selected = selectMediaArtifactsForPrompt(mediaContext.artifacts, config.maxMediaArtifacts || 3);
    return buildCompactMediaContext(selected);
  }
  return String(mediaContext.contextText || '').trim();
}

function buildHermesUserText(payload = {}) {
  const text = String(payload.text || '').trim();
  const batch = Array.isArray(payload.message_batch)
    ? payload.message_batch.map((item) => String(item?.text || '').trim()).filter(Boolean)
    : [];
  return batch.length > 0 ? batch.join('\n') : (text || '你好');
}

const RELATIVE_TIME_PATTERN = /今天|明天|昨天|后天|这周|上周|下周|刚才|最近|现在|今晚|明早|几点|什么时候|多久|何时/;

function buildBridgeTemporalUserContext(payload = {}, now = new Date()) {
  const text = String(payload?.text || '');
  const hasRelativeTime = RELATIVE_TIME_PATTERN.test(text);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  if (hasRelativeTime) {
    return `【微信桥接实时上下文（非用户原话，不要复述）】当前本地时间：${formatter.format(now)}（Asia/Shanghai；ISO=${now.toISOString()}）。这是本轮最新时间上下文，涉及相对时间判断时优先参考。`;
  }
  return `【时间：${formatter.format(now)}】`;
}

function buildHermesSessionContext(payload = {}, config = {}) {
  if (config.sessionContinuityEnabled === false) {
    return { enabled: false, stableKey: '', sessionId: '', sessionKey: '' };
  }
  if (payload.hermes_session_id && payload.hermes_session_key) {
    return applyLiteSessionNonce({
      enabled: true,
      stableKey: String(payload.stable_conversation_key || `${payload.platform || payload.channel || 'wechat'}:${payload.conversation_id || payload.sender_id || 'unknown'}`),
      sessionId: String(payload.hermes_session_id),
      sessionKey: String(payload.hermes_session_key),
      globalUserId: String(payload.global_user_id || ''),
      platform: String(payload.platform || payload.channel || ''),
    }, config);
  }
  const channel = String(payload.channel || 'wechat').trim().toLowerCase() || 'wechat';
  const conversationId = firstNonEmptyString(
    payload.conversation_id,
    payload.conversationId,
    payload.room_id,
    payload.roomId,
    payload.sender_id,
    payload.senderId,
    payload.user
  ) || 'unknown';
  const stableKey = `${channel}:${conversationId}`;
  const digest = sha256Hex(stableKey).slice(0, 16);
  return applyLiteSessionNonce({
    enabled: true,
    stableKey,
    sessionId: `${config.sessionIdPrefix || 'ran-agent-wechat'}-${digest}`,
    sessionKey: `${config.sessionKeyPrefix || 'ran-agent-memory'}-${digest}`,
    globalUserId: String(payload.global_user_id || ''),
    platform: channel,
  }, config);
}

function applyLiteSessionNonce(sessionContext = {}, config = {}) {
  if (config.profile !== config.liteProfile || config.softResetEnabled !== true) {
    return sessionContext;
  }
  const nonce = getLiteSessionNonce(config);
  if (!nonce) return sessionContext;
  const nonceHash = sha256Hex(nonce).slice(0, 8);
  return {
    ...sessionContext,
    sessionId: `${sessionContext.sessionId}-${nonceHash}`,
    sessionKey: `${sessionContext.sessionKey}-${nonceHash}`,
  };
}

function buildRecentHistoryMessages(sessionContext = {}, config = {}) {
  if (!sessionContext.enabled || !sessionContext.stableKey || config.recentTextTurns <= 0 || config.recentTextCharBudget <= 0) {
    return [];
  }
  const stored = recentConversationStore.get(sessionContext.stableKey) || [];
  const maxMessages = Math.max(0, Number(config.recentTextTurns || 10) * 2);
  const candidates = stored.slice(-maxMessages).map((message) => normalizeRecentMessage(message, config)).filter(Boolean);
  const selected = [];
  let usedChars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const messageChars = message.content.length;
    if (usedChars + messageChars > config.recentTextCharBudget && selected.length > 0) {
      continue;
    }
    if (usedChars + messageChars > config.recentTextCharBudget) {
      selected.unshift({
        ...message,
        content: clipText(message.content, Math.max(1, config.recentTextCharBudget - usedChars)),
      });
      break;
    }
    selected.unshift(message);
    usedChars += messageChars;
  }
  return selected;
}

function normalizeRecentMessage(message = {}, config = {}) {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : '';
  if (!role) return null;
  const maxChars = role === 'user' ? config.recentTextMaxUserChars : config.recentTextMaxAssistantChars;
  const content = sanitizeRecentHistoryText(message.content, maxChars);
  if (!content) return null;
  return { role, content };
}

function normalizeHistoryMessages(messages = [], config = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => normalizeRecentMessage(message, config)).filter(Boolean);
}

function limitHistoryMessages(messages = [], turns = 0, charBudget = 0) {
  if (!Array.isArray(messages) || turns <= 0 || charBudget <= 0) return [];
  const maxMessages = Math.max(0, Number(turns || 0) * 2);
  const candidates = messages.slice(-maxMessages);
  const selected = [];
  let usedChars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const content = String(message?.content || '');
    if (!content) continue;
    if (usedChars + content.length > charBudget && selected.length > 0) {
      continue;
    }
    if (usedChars + content.length > charBudget) {
      selected.unshift({
        ...message,
        content: clipText(content, Math.max(1, charBudget - usedChars)),
      });
      break;
    }
    selected.unshift(message);
    usedChars += content.length;
  }
  return selected;
}

function sanitizeRecentHistoryText(value, maxChars) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/data:[a-z0-9/+.-]+;base64,/i.test(raw)) {
    return '[媒体内容已省略]';
  }
  let text = raw
    .replace(/```[\s\S]*?```/g, '[代码块已省略]')
    .replace(/\{[\s\S]{1200,}\}/g, '[长 JSON 已省略]')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/(token|cookie|authorization|xsec_token|api_key)=([^\s&]+)/ig, '$1=[redacted]');
  return clipText(text, maxChars);
}

function clipText(text, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  const normalized = String(text || '');
  if (normalized.length <= limit) return normalized;
  return limit === 1 ? '…' : `${normalized.slice(0, limit - 1)}…`;
}

function recordRecentConversationTurn(sessionContext = {}, payload = {}, response = {}, config = {}) {
  if (!sessionContext.enabled || !sessionContext.stableKey || config.recentTextTurns <= 0) {
    return;
  }
  const currentUser = sanitizeRecentHistoryText(buildHermesUserText(payload), config.recentTextMaxUserChars);
  const assistant = sanitizeRecentHistoryText(response.reply_text || response.replyText || '', config.recentTextMaxAssistantChars);
  const existing = recentConversationStore.get(sessionContext.stableKey) || [];
  const next = [...existing];
  if (currentUser) next.push({ role: 'user', content: currentUser, at: new Date().toISOString() });
  if (assistant) next.push({ role: 'assistant', content: assistant, at: new Date().toISOString() });
  const maxMessages = Math.max(2, Number(config.recentTextTurns || 10) * 2);
  if (!recentConversationStore.has(sessionContext.stableKey) && recentConversationStore.size >= MAX_RECENT_CONVERSATION_SESSIONS) {
    const oldestKey = recentConversationStore.keys().next().value;
    if (oldestKey) recentConversationStore.delete(oldestKey);
  }
  recentConversationStore.set(sessionContext.stableKey, next.slice(-maxMessages));
}

function inferRecentTopicFromMessages(messages = []) {
  const text = messages.map((message) => String(message.content || '')).join('\n');
  if (!text) return '';
  const patterns = [
    /内莉[·・]?布莱|Nellie Bly/ig,
    /强女故事03[^。！？\n]*/i,
    /她把自己送进了疯人院[^。！？\n]*/i,
    /https?:\/\/(?:xhslink\.com|[^/\s]*xiaohongshu\.com)\/[^\s]+/i,
  ];
  const hits = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) hits.push(match[0]);
  }
  if (hits.length > 0) {
    return clipText([...new Set(hits)].join(' / '), 140);
  }
  const last = [...messages].reverse().find((message) => String(message.content || '').trim());
  return clipText(String(last?.content || '').trim(), 140);
}

function logHermesSessionContinuity({
  logger,
  config,
  sessionContext,
  recentMessages,
  globalRecentMessages = [],
  preparedMessage,
  continuityNoteChars,
  payload,
}) {
  const recentChars = recentMessages.reduce((sum, message) => sum + String(message.content || '').length, 0);
  logger?.log?.('[hermes-session-continuity]', JSON.stringify({
    enabled: sessionContext.enabled === true,
    selected_base_url: config.baseUrl,
    selected_profile: config.profile,
    session_id_hash: sessionContext.sessionId ? sha256Hex(sessionContext.sessionId).slice(0, 16) : '',
    session_key_hash: sessionContext.sessionKey ? sha256Hex(sessionContext.sessionKey).slice(0, 16) : '',
    global_user_id_hash: sessionContext.globalUserId ? sha256Hex(sessionContext.globalUserId).slice(0, 16) : '',
    platform: sessionContext.platform || payload?.platform || payload?.channel || '',
    recent_turns_included: Math.floor(recentMessages.length / 2),
    local_recent_turns: Math.floor(recentMessages.length / 2),
    global_recent_turns: Math.floor(globalRecentMessages.length / 2),
    recent_chars: recentChars,
    continuity_note_chars: Number(continuityNoteChars || 0),
    active_topic_chars: String(payload?.active_topic || '').length,
    has_referential_user_text: /她|他|这个故事|这篇|刚才那个|上面那张图|那张图|那个链接|这件事|图片呢|没看到图|fallback/.test(String(payload?.text || '')),
    current_prompt_chars: String(preparedMessage || '').length,
  }));
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function buildHermesHeaders(config = {}, sessionContext = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  if (config.sessionContinuityEnabled !== false && sessionContext.sessionId && sessionContext.sessionKey) {
    headers['X-Hermes-Session-Id'] = sessionContext.sessionId;
    headers['X-Hermes-Session-Key'] = sessionContext.sessionKey;
  }
  return headers;
}

async function parseHermesJson(response) {
  try {
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`hermes api returned invalid JSON: ${message}`);
  }
}

function buildHermesReply(body = {}, config = {}) {
  const replyText = extractHermesReplyText(body).trim();
  const media = normalizeOutgoingMedia(body.media);
  return {
    reply_text: replyText || config.fallbackText || '',
    follow_up_messages: Array.isArray(body.follow_up_messages) ? body.follow_up_messages : [],
    media,
    model: body.model || config.model,
  };
}

function extractHermesReplyText(body = {}) {
  if (typeof body.reply_text === 'string') {
    return body.reply_text;
  }
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }
  if (Array.isArray(choice?.message?.content)) {
    return extractTextParts(choice.message.content);
  }
  if (typeof choice?.text === 'string') {
    return choice.text;
  }
  if (Array.isArray(body.output)) {
    return extractTextParts(body.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [item]));
  }
  return '';
}

function extractTextParts(parts = []) {
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.content === 'string') {
        return part.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return ['api', 'oneshot', 'auto'].includes(normalized) ? normalized : 'api';
}

function normalizeMediaItems(media) {
  if (!media) {
    return [];
  }
  const items = Array.isArray(media) ? media : [media];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : '';
      if (!filePath) {
        return null;
      }
      return {
        filePath,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '',
        type: typeof item.type === 'string' ? item.type.trim().toLowerCase() : '',
      };
    })
    .filter(Boolean);
}

function normalizeOutgoingMedia(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const type = typeof media.type === 'string' ? media.type.trim().toLowerCase() : '';
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim() : '';
  if (!type || !url || !['image', 'video', 'file', 'audio'].includes(type)) {
    return null;
  }
  return fileName ? { type, url, fileName } : { type, url };
}

function inferMediaTypeFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return '';
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createRequestId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
