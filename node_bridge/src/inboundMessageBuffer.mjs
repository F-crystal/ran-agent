/**
 * Inbound message buffer for WeChat turn aggregation.
 *
 * Collects media-only messages and merges them with subsequent text that
 * refers to the media, producing a single logical user turn before handing
 * off to the reply backend.
 *
 * Supports two merge paths:
 *   1. Immediate: text-ref arrives while pending media exists → merge now
 *   2. Deferred:  text-ref arrives first, media arrives later
 *      - Wait WECHAT_TEXT_REF_WAIT_MS for media
 *      - If media arrives → merge immediately
 *      - If wait expires → send text alone, but keep text-ref intent alive
 *        until WECHAT_PENDING_TEXT_REF_TTL_MS
 *      - If media arrives within intent TTL → return deferred merge
 */

const MEDIA_REF_PATTERNS = [
  /用\s*(?:mimo|MiMo|米模)/i,
  /看[一看]?(?:一下|看|了)?/,
  /读[一读]?(?:一下|看|了)?/,
  /分析[一下]?(?:这个|这些|这张|这段|那个|那些|那张|那段)?/,
  /(?:刚才|之前|上面|刚才那|那[个张段份])(?:的|那)?(?:图|截图|图片|照片|视频|语音|文件|音频|文档)/,
  /图[片里]?(?:是|有|中|面|内|写|说|显示|画|内容|什么|啥)/,
  /(?:什么|啥)(?:内容|东西|意思|情况)/,
  /(?:帮|给|让)(?:我|我看看?)\s*(?:看|分析|读|识别|理解|解读|ocr)/i,
  /这个(?:文件|图片|图|截图|视频|语音|音频|文档)/,
  /(?:ocr|识别|转写|提取文字|文字提取)/i,
];

export function isMediaRefText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return false;
  }
  return MEDIA_REF_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isMediaOnlyPayload(payload) {
  const hasText = String(payload.text || '').trim().length > 0;
  const hasMedia = Array.isArray(payload.media) && payload.media.length > 0;
  const hasImageUrls = Array.isArray(payload.image_urls) && payload.image_urls.some((u) => typeof u === 'string' && u.trim());
  return !hasText && (hasMedia || hasImageUrls);
}

export function createInboundMessageBuffer(options = {}) {
  const logger = options.logger || console;
  const now = options.nowImpl || (() => Date.now());

  const graceMs = Math.max(1000, Number(options.mediaReplyGraceMs || 12000));
  const textRefWaitMs = Math.max(1000, Number(options.textRefWaitMs || 30000));
  const pendingTtlMs = Math.max(10000, Number(options.pendingMediaTtlMs || 600000));
  const pendingTextRefTtlMs = Math.max(10000, Number(options.pendingTextRefTtlMs || 120000));
  const idleReplyEnabled = options.mediaOnlyIdleReply === true;

  // sender_id -> { items: [...], createdAt }
  const pendingMedia = new Map();

  // sender_id -> { payload, resolve, timer }
  const waitingTextRef = new Map();

  // sender_id -> { payload, createdAt, consumed }
  // Kept after initial wait expires so media arriving within intent TTL
  // can still trigger a deferred merge.
  const pendingTextRefIntents = new Map();

  // Callback set by the bridge to trigger deferred replies when media
  // arrives after the text-ref wait has expired.
  let onDeferredMerge = null;

  function cleanupExpired() {
    const ts = now();
    for (const [senderId, entry] of pendingMedia) {
      if (ts - entry.createdAt > pendingTtlMs) {
        logger.log?.(`[buffer] pending media expired sender=${senderId} age=${ts - entry.createdAt}ms`);
        pendingMedia.delete(senderId);
      }
    }
    for (const [senderId, intent] of pendingTextRefIntents) {
      if (ts - intent.createdAt > pendingTextRefTtlMs || intent.consumed) {
        pendingTextRefIntents.delete(senderId);
      }
    }
  }

  function getPending(senderId) {
    cleanupExpired();
    return pendingMedia.get(senderId) || null;
  }

  function drainPendingMedia(senderId) {
    const entry = pendingMedia.get(senderId);
    if (!entry) {
      return [];
    }
    const items = entry.items.filter((item) => !item.consumed);
    for (const item of items) {
      item.consumed = true;
    }
    if (entry.items.every((item) => item.consumed)) {
      pendingMedia.delete(senderId);
    }
    return items;
  }

  function addPendingMedia(payload) {
    const senderId = String(payload.sender_id || '').trim();
    if (!senderId) {
      return;
    }
    cleanupExpired();
    const ts = now();
    let entry = pendingMedia.get(senderId);
    if (!entry) {
      entry = { items: [], createdAt: ts };
      pendingMedia.set(senderId, entry);
    }
    entry.items.push({
      media: Array.isArray(payload.media) ? payload.media : [],
      image_urls: Array.isArray(payload.image_urls) ? payload.image_urls : [],
      createdAt: ts,
      consumed: false,
    });
    logger.log?.(`[buffer] pending media added sender=${senderId} total=${entry.items.length}`);
  }

  function mergeMediaIntoPayload(payload, senderId) {
    const entry = pendingMedia.get(senderId);
    if (!entry) {
      return payload;
    }
    const items = entry.items.filter((item) => !item.consumed);
    if (items.length === 0) {
      return payload;
    }
    for (const item of items) {
      item.consumed = true;
    }
    if (entry.items.every((item) => item.consumed)) {
      pendingMedia.delete(senderId);
    }

    const mergedMedia = [];
    const mergedImageUrls = [];
    for (const item of items) {
      for (const m of item.media) {
        if (!mergedMedia.some((existing) => existing.filePath === m.filePath)) {
          mergedMedia.push(m);
        }
      }
      for (const url of item.image_urls) {
        if (typeof url === 'string' && url.trim() && !mergedImageUrls.includes(url.trim())) {
          mergedImageUrls.push(url.trim());
        }
      }
    }
    // Also include media from the text payload itself
    for (const m of Array.isArray(payload.media) ? payload.media : []) {
      if (!mergedMedia.some((existing) => existing.filePath === m.filePath)) {
        mergedMedia.push(m);
      }
    }
    for (const url of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
      if (typeof url === 'string' && url.trim() && !mergedImageUrls.includes(url.trim())) {
        mergedImageUrls.push(url.trim());
      }
    }

    const result = {
      ...payload,
      media: mergedMedia.length > 0 ? mergedMedia : undefined,
      image_urls: mergedImageUrls,
    };
    if (mergedMedia.length > 0) {
      result.route_hint = 'vision_understand';
    }
    logger.log?.(`[buffer] merged ${items.length} pending media batch(es) into turn sender=${senderId}`);
    return result;
  }

  function waitForTextRef(senderId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitingTextRef.delete(senderId);
        logger.log?.(`[buffer] text-ref wait expired sender=${senderId} (intent kept until TTL)`);
        resolve({ timedOut: true });
      }, textRefWaitMs);
      waitingTextRef.set(senderId, { resolve, timer, createdAt: now() });
    });
  }

  function resolveTextRefWait(senderId, payload) {
    const wait = waitingTextRef.get(senderId);
    if (!wait) {
      return false;
    }
    clearTimeout(wait.timer);
    waitingTextRef.delete(senderId);
    addPendingMedia(payload);
    wait.resolve({ timedOut: false, payload });
    return true;
  }

  function saveTextRefIntent(senderId, payload) {
    pendingTextRefIntents.set(senderId, {
      payload,
      createdAt: now(),
      consumed: false,
    });
    logger.log?.(`[buffer] text-ref intent saved sender=${senderId} ttl=${pendingTextRefTtlMs}ms`);
  }

  function checkDeferredTextRefIntent(senderId) {
    cleanupExpired();
    const intent = pendingTextRefIntents.get(senderId);
    if (!intent || intent.consumed) {
      return null;
    }
    // Check if there's unconsumed pending media
    const entry = pendingMedia.get(senderId);
    if (!entry || !entry.items.some((item) => !item.consumed)) {
      return null;
    }
    intent.consumed = true;
    const merged = mergeMediaIntoPayload(intent.payload, senderId);
    logger.log?.(`[buffer] deferred merge: text-ref intent + media sender=${senderId}`);
    return merged;
  }

  /**
   * Set callback for deferred merges. When media arrives and a text-ref
   * intent is pending, the buffer calls this with the merged payload so
   * the bridge can trigger a reply.
   */
  function setDeferredMergeCallback(fn) {
    onDeferredMerge = fn;
  }

  /**
   * Main entry point. Classifies an inbound payload and decides what to do:
   *
   * Returns { action, payload, pendingMediaCount?, deferredMerge? }:
   *   - { action: 'reply', payload } — send to reply backend immediately
   *   - { action: 'hold', pendingMediaCount } — media held, no reply
   *   - { action: 'wait', promise } — waiting for media, caller should await
   *   - { action: 'deferred-merge', payload } — media arrived after text-ref
   *     wait expired; merged with saved text-ref intent
   */
  async function processInbound(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    // Case 1: Media-only message
    if (isMediaOnly) {
      // Check if a text message is actively waiting
      const resolved = resolveTextRefWait(senderId, payload);
      if (resolved) {
        return { action: 'hold', pendingMediaCount: 0, resolvedViaWait: true };
      }
      addPendingMedia(payload);
      // Check if there's a saved text-ref intent within its TTL
      const deferred = checkDeferredTextRefIntent(senderId);
      if (deferred) {
        return { action: 'deferred-merge', payload: deferred };
      }
      if (idleReplyEnabled) {
        return {
          action: 'reply',
          payload: {
            ...payload,
            text: '收到媒体，等你发说明文字后一起处理。',
          },
        };
      }
      return { action: 'hold', pendingMediaCount: pendingMedia.get(senderId)?.items.length || 0 };
    }

    // Case 2: Text that looks like a media reference
    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        // Merge immediately
        return { action: 'reply', payload: mergeMediaIntoPayload(payload, senderId) };
      }
      // No pending media — wait for one to arrive
      logger.log?.(`[buffer] text-ref without pending media, waiting ${textRefWaitMs}ms sender=${senderId}`);
      const result = await waitForTextRef(senderId);
      if (result.timedOut) {
        // Save intent so media arriving within pendingTextRefTtlMs can still merge
        saveTextRefIntent(senderId, payload);
        return { action: 'reply', payload };
      }
      // Media arrived during wait — merge
      return { action: 'reply', payload: mergeMediaIntoPayload(payload, senderId) };
    }

    // Case 3: Plain text — no waiting, no binding
    return { action: 'reply', payload };
  }

  /**
   * Synchronous version for callers that can't await.
   * For case 2 without pending media, sends text alone and saves intent.
   */
  function processInboundSync(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    if (isMediaOnly) {
      resolveTextRefWait(senderId, payload);
      addPendingMedia(payload);
      const deferred = checkDeferredTextRefIntent(senderId);
      if (deferred) {
        return { action: 'deferred-merge', payload: deferred };
      }
      if (idleReplyEnabled) {
        return {
          action: 'reply',
          payload: {
            ...payload,
            text: '收到媒体，等你发说明文字后一起处理。',
          },
        };
      }
      return { action: 'hold', pendingMediaCount: pendingMedia.get(senderId)?.items.length || 0 };
    }

    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        return { action: 'reply', payload: mergeMediaIntoPayload(payload, senderId) };
      }
      // No pending media in sync mode — save intent, send text alone
      saveTextRefIntent(senderId, payload);
      return { action: 'reply', payload };
    }

    return { action: 'reply', payload };
  }

  function getStats() {
    cleanupExpired();
    const entries = [];
    for (const [senderId, entry] of pendingMedia) {
      entries.push({
        senderId,
        pendingCount: entry.items.filter((i) => !i.consumed).length,
        ageMs: now() - entry.createdAt,
      });
    }
    const intentEntries = [];
    for (const [senderId, intent] of pendingTextRefIntents) {
      if (!intent.consumed) {
        intentEntries.push({ senderId, ageMs: now() - intent.createdAt });
      }
    }
    return {
      entries,
      waitingTextRefCount: waitingTextRef.size,
      pendingTextRefIntents: intentEntries,
    };
  }

  function clear() {
    for (const [, wait] of waitingTextRef) {
      clearTimeout(wait.timer);
    }
    waitingTextRef.clear();
    pendingMedia.clear();
    pendingTextRefIntents.clear();
  }

  return {
    processInbound,
    processInboundSync,
    isMediaRefText,
    isMediaOnlyPayload,
    addPendingMedia,
    mergeMediaIntoPayload,
    waitForTextRef,
    resolveTextRefWait,
    saveTextRefIntent,
    checkDeferredTextRefIntent,
    setDeferredMergeCallback,
    getStats,
    clear,
    _config: { graceMs, textRefWaitMs, pendingTtlMs, pendingTextRefTtlMs, idleReplyEnabled },
  };
}
