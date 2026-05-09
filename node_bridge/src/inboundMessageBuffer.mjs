/**
 * Inbound message buffer for WeChat turn aggregation.
 *
 * Collects media-only messages and merges them with subsequent text that
 * refers to the media, producing a single logical user turn before handing
 * off to the reply backend.
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

const MEDIA_ONLY_TYPES = new Set(['image', 'video', 'audio', 'file']);

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
  const textRefWaitMs = Math.max(1000, Number(options.textRefWaitMs || 8000));
  const pendingTtlMs = Math.max(10000, Number(options.pendingMediaTtlMs || 600000));
  const idleReplyEnabled = options.mediaOnlyIdleReply === true;

  // sender_id -> { items: [...], createdAt }
  const pending = new Map();

  // sender_id -> { payload, resolve, timer }
  const waitingTextRef = new Map();

  function cleanupExpired() {
    const ts = now();
    for (const [senderId, entry] of pending) {
      if (ts - entry.createdAt > pendingTtlMs) {
        logger.log?.(`[buffer] pending media expired sender=${senderId} age=${ts - entry.createdAt}ms`);
        pending.delete(senderId);
      }
    }
  }

  function getPending(senderId) {
    cleanupExpired();
    return pending.get(senderId) || null;
  }

  function drainPendingMedia(senderId) {
    const entry = pending.get(senderId);
    if (!entry) {
      return [];
    }
    const items = entry.items.filter((item) => !item.consumed);
    for (const item of items) {
      item.consumed = true;
    }
    // Remove the entry if all items consumed
    if (entry.items.every((item) => item.consumed)) {
      pending.delete(senderId);
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
    let entry = pending.get(senderId);
    if (!entry) {
      entry = { items: [], createdAt: ts };
      pending.set(senderId, entry);
    }
    entry.items.push({
      media: Array.isArray(payload.media) ? payload.media : [],
      image_urls: Array.isArray(payload.image_urls) ? payload.image_urls : [],
      createdAt: ts,
      consumed: false,
    });
    logger.log?.(`[buffer] pending media added sender=${senderId} total=${entry.items.length}`);
  }

  function mergeMediaFromPending(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const items = drainPendingMedia(senderId);
    if (items.length === 0) {
      return payload;
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
    // Also include media from the text payload itself (shouldn't normally have, but be safe)
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
    logger.log?.(`[buffer] merged ${items.length} pending media batch(es) into text turn sender=${senderId}`);
    return result;
  }

  function waitForTextRef(senderId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitingTextRef.delete(senderId);
        logger.log?.(`[buffer] text-ref wait expired sender=${senderId}`);
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
    // Add the arriving media to the pending queue so mergeMediaFromPending
    // can pick it up when the waiting text-ref processes the result.
    addPendingMedia(payload);
    wait.resolve({ timedOut: false, payload });
    return true;
  }

  /**
   * Main entry point. Classifies an inbound payload and decides what to do:
   *
   * Returns { action, payload, pendingMediaCount? }:
   *   - { action: 'reply', payload } — send to reply backend immediately
   *   - { action: 'hold', pendingMediaCount } — media held, no reply
   *   - { action: 'wait', promise } — waiting for media, caller should await
   */
  async function processInbound(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    // Case 1: Media-only message
    if (isMediaOnly) {
      // Check if a text message is already waiting for media
      const resolved = resolveTextRefWait(senderId, payload);
      if (resolved) {
        // The waiting text already resolved — but we need to add media to it.
        // Actually the resolve sends the media payload back to the waiting caller.
        // The waiting caller will merge and return.
        return { action: 'hold', pendingMediaCount: 0, resolvedViaWait: true };
      }
      addPendingMedia(payload);
      if (idleReplyEnabled) {
        return {
          action: 'reply',
          payload: {
            ...payload,
            text: '收到媒体，等你发说明文字后一起处理。',
          },
        };
      }
      return { action: 'hold', pendingMediaCount: pending.get(senderId)?.items.length || 0 };
    }

    // Case 2: Text that looks like a media reference
    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        // Merge immediately
        return { action: 'reply', payload: mergeMediaFromPending(payload) };
      }
      // No pending media — wait for one to arrive
      logger.log?.(`[buffer] text-ref without pending media, waiting sender=${senderId}`);
      const result = await waitForTextRef(senderId);
      if (result.timedOut) {
        // No media arrived within wait window — send text alone
        return { action: 'reply', payload };
      }
      // Media arrived — merge
      return { action: 'reply', payload: mergeMediaFromPending(payload) };
    }

    // Case 3: Plain text — no waiting, no binding
    return { action: 'reply', payload };
  }

  /**
   * Synchronous version for callers that can't await.
   * Handles cases 1 and 3 synchronously; for case 2 with pending media, merges
   * immediately; for case 2 without pending media, sends text alone (no wait).
   */
  function processInboundSync(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    if (isMediaOnly) {
      // Resolve any waiting text-ref
      resolveTextRefWait(senderId, payload);
      addPendingMedia(payload);
      if (idleReplyEnabled) {
        return {
          action: 'reply',
          payload: {
            ...payload,
            text: '收到媒体，等你发说明文字后一起处理。',
          },
        };
      }
      return { action: 'hold', pendingMediaCount: pending.get(senderId)?.items.length || 0 };
    }

    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        return { action: 'reply', payload: mergeMediaFromPending(payload) };
      }
      return { action: 'reply', payload };
    }

    return { action: 'reply', payload };
  }

  function getStats() {
    cleanupExpired();
    const entries = [];
    for (const [senderId, entry] of pending) {
      entries.push({
        senderId,
        pendingCount: entry.items.filter((i) => !i.consumed).length,
        ageMs: now() - entry.createdAt,
      });
    }
    return { entries, waitingTextRefCount: waitingTextRef.size };
  }

  function clear() {
    for (const [, wait] of waitingTextRef) {
      clearTimeout(wait.timer);
    }
    waitingTextRef.clear();
    pending.clear();
  }

  return {
    processInbound,
    processInboundSync,
    isMediaRefText,
    isMediaOnlyPayload,
    addPendingMedia,
    drainPendingMedia,
    mergeMediaFromPending,
    waitForTextRef,
    resolveTextRefWait,
    getStats,
    clear,
    _config: { graceMs, textRefWaitMs, pendingTtlMs, idleReplyEnabled },
  };
}
