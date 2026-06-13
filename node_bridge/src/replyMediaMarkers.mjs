const RAN_MEDIA_SOURCE = 'sticker_catalog';
const RAN_MEDIA_KIND = 'sticker';
const FORBIDDEN_MARKER_KEYS = new Set(['path', 'url', 'filepath']);

export function buildRanMediaStickerMarker({ stickerId, caption = '' } = {}) {
  const normalizedStickerId = normalizeText(stickerId);
  if (!normalizedStickerId) {
    throw new Error('stickerId is required');
  }
  return `RAN_MEDIA: ${JSON.stringify({
    source: RAN_MEDIA_SOURCE,
    kind: RAN_MEDIA_KIND,
    stickerId: normalizedStickerId,
    caption: normalizeText(caption),
  })}`;
}

export function extractRanMediaMarker(text) {
  const raw = String(text || '');
  const markerPattern = /^RAN_MEDIA:\s*(\{.*\})\s*$/im;
  const match = raw.match(markerPattern);
  if (!match?.[1]) {
    return null;
  }

  const cleanedText = cleanMarkerText(raw, markerPattern);
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_INVALID_JSON',
      markerMeta: null,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_INVALID_PAYLOAD',
      markerMeta: null,
    };
  }
  const markerMeta = summarizeRanMediaMarkerPayload(parsed);
  if (hasForbiddenMarkerKey(parsed)) {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_FORBIDDEN_LOCATION_FIELD',
      markerMeta,
    };
  }
  if (parsed.source !== RAN_MEDIA_SOURCE) {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_UNKNOWN_SOURCE',
      markerMeta,
    };
  }
  if (parsed.kind !== RAN_MEDIA_KIND) {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_UNSUPPORTED_KIND',
      markerMeta,
    };
  }

  const stickerId = normalizeText(parsed.stickerId);
  const caption = normalizeText(parsed.caption);
  if (!stickerId) {
    return {
      text: cleanedText,
      mediaIntent: null,
      errorCode: 'RAN_MEDIA_MISSING_STICKER_ID',
      markerMeta,
    };
  }

  return {
    text: cleanedText || caption,
    mediaIntent: {
      source: RAN_MEDIA_SOURCE,
      kind: RAN_MEDIA_KIND,
      stickerId,
      caption,
    },
    errorCode: '',
    markerMeta,
  };
}

export function extractLegacyWechatMediaMarker(text) {
  const raw = String(text || '');
  const markerPattern = /^WECHAT_MEDIA:\s*(\{.*\})\s*$/im;
  const match = raw.match(markerPattern);
  if (!match?.[1]) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (parsed?.source !== 'media_generation_mcp') {
    return null;
  }
  const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
  const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
  const fileName = typeof parsed.fileName === 'string' ? parsed.fileName.trim() : '';
  if (!type || !url || !['image', 'video', 'file', 'audio'].includes(type)) {
    return null;
  }
  return {
    text: cleanMarkerText(raw, markerPattern),
    media: fileName ? { type, url, fileName } : { type, url },
  };
}

function hasForbiddenMarkerKey(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((item) => hasForbiddenMarkerKey(item));
  }
  return Object.entries(payload).some(([key, value]) => (
    FORBIDDEN_MARKER_KEYS.has(key.toLowerCase()) || hasForbiddenMarkerKey(value)
  ));
}

function cleanMarkerText(raw, markerPattern) {
  return raw
    .replace(markerPattern, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeRanMediaMarkerPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const keys = Object.keys(payload)
    .filter((key) => typeof key === 'string')
    .map((key) => key.slice(0, 40))
    .sort();
  return {
    source: normalizeText(payload.source).slice(0, 80),
    kind: normalizeText(payload.kind).slice(0, 80),
    hasStickerId: Boolean(normalizeText(payload.stickerId)),
    hasCaption: Boolean(normalizeText(payload.caption)),
    keys,
  };
}

function normalizeText(value) {
  return String(value || '').trim();
}
