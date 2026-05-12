/**
 * Inbound message buffer for WeChat turn aggregation.
 * 
 * Supports three merge paths:
 * 1. Explicit ref: text matches MEDIA_REF_PATTERNS -> strong bind, consumed=true
 * 2. Implicit candidate: plain text within window -> soft attach, consumed=false
 * 3. Deferred: text-ref arrives first, media arrives later
 */

// Media reference patterns - spaces removed from alternation groups for correct matching
const MEDIA_REF_PATTERNS = [
  /用\s*(?:mimo|MiMo|米模)/i,
  /看看？/,
  /看看这个/,
  /读.*(?:图片 | 图 | 一下)?/,
  /分析.*/,
  /(?:刚才 | 之前 | 上面 | 刚才那 | 那 [个张段份]).*?(?:图 | 截图 | 图片 | 照片 | 视频 | 语音 | 文件 | 音频 | 文档)/,
  /图.*/,
  /(?:什么 | 啥)(?:内容 | 东西 | 情况)/,
  /帮 (?:我 | 给我)?(?:看 | 分析 | 读 | 识别 | 理解 | 解读|看一下)/i,
  /这个 (?:文件 | 图片 | 图 | 截图 | 视频 | 语音 | 音频 | 文档)/,
  /识别.*/i,
].map(p => new RegExp(p.source.replace(/ /g, ""), p.flags));

export function isMediaRefText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return MEDIA_REF_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isMediaOnlyPayload(payload) {
  const hasText = String(payload.text || '').trim().length > 0;
  const hasMedia = Array.isArray(payload.media) && payload.media.length > 0;
  const hasImageUrls = Array.isArray(payload.image_urls) && payload.image_urls.some((u) => typeof u === 'string' && u.trim());
  return !hasText && (hasMedia || hasImageUrls);
}

function buildMediaCandidate(item, relation, confidence, source = 'pending_media') {
  const candidate = { relation, confidence, source };
  for (const m of item.media || []) {
    if (m.artifact_id) { candidate.artifact_id = m.artifact_id; break; }
    if (m.filePath) { candidate.file_path = m.filePath; break; }
    if (m.type) { candidate.type = m.type; break; }
  }
  candidate.created_at = item.createdAt;
  return candidate;
}

export function createInboundMessageBuffer(options = {}) {
  const logger = options.logger || console;
  const now = options.nowImpl || (() => Date.now());
  const graceMs = Math.max(1000, Number(options.mediaReplyGraceMs || 12000));
  const textRefWaitMs = Math.max(1000, Number(options.textRefWaitMs || 30000));
  const pendingTtlMs = Math.max(10000, Number(options.pendingMediaTtlMs || 600000));
  const pendingTextRefTtlMs = Math.max(10000, Number(options.pendingTextRefTtlMs || 120000));
  const idleReplyEnabled = options.mediaOnlyIdleReply === true;

  const pendingMedia = new Map();
  const waitingTextRef = new Map();
  const pendingTextRefIntents = new Map();
  let onDeferredMerge = null;

  function cleanupExpired() {
    const ts = now();
    for (const [senderId, entry] of pendingMedia) {
      if (ts - entry.createdAt > pendingTtlMs) {
        logger.log?.(`[buffer] pending media expired sender=${senderId} age=${ts - entry.createdAt}ms`);
        pendingMedia.delete(senderId);
      } else if (entry.items.every((item) => item.consumed)) {
        // Remove fully consumed entries
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

  function addPendingMedia(payload) {
    const senderId = String(payload.sender_id || '').trim();
    if (!senderId) return;
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
      soft_used: false,
    });
    logger.log?.(`[buffer] pending media added sender=${senderId} total=${entry.items.length}`);
  }

  function mergeMediaIntoPayload(payload, senderId, forceConsume = true) {
    const entry = pendingMedia.get(senderId);
    if (!entry) return payload;
    const items = entry.items.filter((item) => !item.consumed);
    if (items.length === 0) return payload;
    
    if (forceConsume) {
      for (const item of items) item.consumed = true;
    }

    const mergedMedia = [];
    const mergedImageUrls = [];
    const mediaCandidates = [];
    
    for (const item of items) {
      for (const m of item.media) {
        if (!mergedMedia.some((existing) => existing.filePath === m.filePath)) mergedMedia.push(m);
      }
      for (const url of item.image_urls) {
        if (typeof url === 'string' && url.trim() && !mergedImageUrls.includes(url.trim())) mergedImageUrls.push(url.trim());
      }
      mediaCandidates.push(buildMediaCandidate(item, 'explicit_ref', 1.0, 'pending_media'));
    }
    
    for (const m of Array.isArray(payload.media) ? payload.media : []) {
      if (!mergedMedia.some((existing) => existing.filePath === m.filePath)) mergedMedia.push(m);
    }
    for (const url of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
      if (typeof url === 'string' && url.trim() && !mergedImageUrls.includes(url.trim())) mergedImageUrls.push(url.trim());
    }

    const result = {
      ...payload,
      media: mergedMedia.length > 0 ? mergedMedia : undefined,
      image_urls: mergedImageUrls,
    };
    if (mediaCandidates.length > 0) result.media_candidates = mediaCandidates;
    if (mergedMedia.length > 0) result.route_hint = 'vision_understand';
    logger.log?.(`[buffer] merged ${items.length} pending media batch(es) into turn sender=${senderId} forceConsume=${forceConsume}`);
    return result;
  }

  function attachRecentMediaCandidates(payload, senderId, maxCandidates = 1) {
    const entry = pendingMedia.get(senderId);
    if (!entry || entry.items.length === 0) return payload;
    
    const availableItems = entry.items.filter((item) => !item.consumed).slice(-maxCandidates);
    if (availableItems.length === 0) return payload;
    
    const mediaCandidates = [];
    const mergedMedia = [];
    const mergedImageUrls = [];
    
    for (const item of availableItems) {
      mediaCandidates.push(buildMediaCandidate(item, 'recent_candidate', 0.5, 'pending_media'));
      for (const m of item.media) {
        if (!mergedMedia.some((existing) => existing.filePath === m.filePath)) mergedMedia.push(m);
      }
      for (const url of item.image_urls) {
        if (typeof url === 'string' && url.trim() && !mergedImageUrls.includes(url.trim())) mergedImageUrls.push(url.trim());
      }
    }
    
    for (const item of availableItems) item.soft_used = true;
    
    const result = {
      ...payload,
      media: mergedMedia.length > 0 ? [...(payload.media || []), ...mergedMedia] : payload.media,
      image_urls: [...(payload.image_urls || []), ...mergedImageUrls].filter(Boolean),
    };
    if (mediaCandidates.length > 0) result.media_candidates = mediaCandidates;
    if (mergedMedia.length > 0) result.route_hint = 'vision_understand';
    logger.log?.(`[buffer] attached ${mediaCandidates.length} recent media candidates sender=${senderId}`);
    return result;
  }

  function resolveTextRefWait(senderId, payload) {
    const wait = waitingTextRef.get(senderId);
    if (!wait) return false;
    clearTimeout(wait.timer);
    waitingTextRef.delete(senderId);
    addPendingMedia(payload);
    // Merge media into the original text payload and resolve with merged result
    const merged = mergeMediaIntoPayload(wait.payload, senderId, true);
    wait.resolve({ timedOut: false, payload: merged });
    return true;
  }

  function waitForTextRef(senderId, originalPayload) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitingTextRef.delete(senderId);
        logger.log?.(`[buffer] text-ref wait expired sender=${senderId} (intent kept until TTL)`);
        resolve({ timedOut: true, payload: originalPayload });
      }, textRefWaitMs);
      waitingTextRef.set(senderId, { resolve, timer, createdAt: now(), payload: originalPayload });
    });
  }

  function saveTextRefIntent(senderId, payload) {
    pendingTextRefIntents.set(senderId, { payload, createdAt: now(), consumed: false });
    logger.log?.(`[buffer] text-ref intent saved sender=${senderId} ttl=${pendingTextRefTtlMs}ms`);
  }

  function checkDeferredTextRefIntent(senderId) {
    cleanupExpired();
    const intent = pendingTextRefIntents.get(senderId);
    if (!intent || intent.consumed) return null;
    const entry = pendingMedia.get(senderId);
    if (!entry || !entry.items.some((item) => !item.consumed)) return null;
    intent.consumed = true;
    const merged = mergeMediaIntoPayload(intent.payload, senderId, true);
    logger.log?.(`[buffer] deferred merge: text-ref intent + media sender=${senderId}`);
    return merged;
  }

  function setDeferredMergeCallback(fn) { onDeferredMerge = fn; }

  async function processInbound(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    if (isMediaOnly) {
      const resolved = resolveTextRefWait(senderId, payload);
      if (resolved) return { action: 'hold', pendingMediaCount: 0, resolvedViaWait: true };
      addPendingMedia(payload);
      const deferred = checkDeferredTextRefIntent(senderId);
      if (deferred) return { action: 'deferred-merge', payload: deferred };
      if (idleReplyEnabled) {
        return { action: 'reply', payload: { ...payload, text: '收到媒体，等你发说明文字后一起处理。' } };
      }
      return { action: 'hold', pendingMediaCount: pendingMedia.get(senderId)?.items.length || 0 };
    }

    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        return { action: 'reply', payload: mergeMediaIntoPayload(payload, senderId, true) };
      }
      logger.log?.(`[buffer] text-ref without pending media, waiting ${textRefWaitMs}ms sender=${senderId}`);
      const result = await waitForTextRef(senderId, payload);
      if (result.timedOut) {
        saveTextRefIntent(senderId, payload);
        return { action: 'reply', payload: result.payload };
      }
      // Media arrived during wait - result.payload already merged
      return { action: 'reply', payload: result.payload };
    }

    const pendingEntry = getPending(senderId);
    if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
      return { action: 'reply', payload: attachRecentMediaCandidates(payload, senderId, 1) };
    }
    return { action: 'reply', payload };
  }

  function processInboundSync(payload) {
    const senderId = String(payload.sender_id || '').trim();
    const text = String(payload.text || '').trim();
    const isMediaOnly = isMediaOnlyPayload(payload);
    const isTextRef = text && isMediaRefText(text);

    if (isMediaOnly) {
      resolveTextRefWait(senderId, payload);
      addPendingMedia(payload);
      const deferred = checkDeferredTextRefIntent(senderId);
      if (deferred) return { action: 'deferred-merge', payload: deferred };
      if (idleReplyEnabled) {
        return { action: 'reply', payload: { ...payload, text: '收到媒体，等你发说明文字后一起处理。' } };
      }
      return { action: 'hold', pendingMediaCount: pendingMedia.get(senderId)?.items.length || 0 };
    }

    if (isTextRef) {
      const pendingEntry = getPending(senderId);
      if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
        return { action: 'reply', payload: mergeMediaIntoPayload(payload, senderId, true) };
      }
      saveTextRefIntent(senderId, payload);
      return { action: 'reply', payload };
    }

    const pendingEntry = getPending(senderId);
    if (pendingEntry && pendingEntry.items.some((item) => !item.consumed)) {
      return { action: 'reply', payload: attachRecentMediaCandidates(payload, senderId, 1) };
    }
    return { action: 'reply', payload };
  }

  function getStats() {
    cleanupExpired();
    const entries = [];
    for (const [senderId, entry] of pendingMedia) {
      entries.push({
        senderId,
        itemCount: entry.items.length,
        unconsumedCount: entry.items.filter((i) => !i.consumed).length,
        softUsedCount: entry.items.filter((i) => i.soft_used && !i.consumed).length,
        age: now() - entry.createdAt,
        pendingCount: entry.items.filter((i) => !i.consumed).length,
      });
    }
    return {
      pendingMedia: entries,
      pendingMediaCount: entries.length,
      waitingTextRef: waitingTextRef.size,
      pendingTextRefIntents: Array.from(pendingTextRefIntents.values()),
    };
  }

  return {
    processInbound,
    processInboundSync,
    setDeferredMergeCallback,
    getStats,
    resolveTextRefWait,
  };
}
