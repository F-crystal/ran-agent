import { buildErrorPayload } from './assetResolver.mjs';

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_BATCH_TIMEOUT_MS = 120000;
const DEFAULT_PER_ITEM_TIMEOUT_MS = 60000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function withTimeout(promise, timeoutMs, errorCode) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${errorCode}: operation timed out`);
      error.error_code = errorCode;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function summarizeItems(items) {
  return items
    .map((item) => item.overall_summary || item.scene_summary || item.transcript || item.ocr_text || '')
    .filter(Boolean)
    .join('\n');
}

export async function analyzeMediaBatch({ assets = [], mediaDetail = 'standard', analyzeOne, env = process.env }) {
  const maxConcurrency = positiveInt(env.PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY);
  const batchTimeoutMs = positiveInt(env.PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS, DEFAULT_BATCH_TIMEOUT_MS);
  const perItemTimeoutMs = positiveInt(env.PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS, DEFAULT_PER_ITEM_TIMEOUT_MS);
  const queue = [...assets];
  const items = [];
  const partialFailures = [];
  const warnings = [];

  async function worker() {
    while (queue.length > 0) {
      const asset = queue.shift();
      try {
        const result = await withTimeout(
          analyzeOne(asset, { mediaDetail }),
          perItemTimeoutMs,
          'DOWNLOAD_TIMEOUT'
        );
        items.push(result);
      } catch (error) {
        const payload = buildErrorPayload(error, { asset_id: asset?.asset_id || '' });
        partialFailures.push({
          asset_id: asset?.asset_id || '',
          error_code: payload.error_code,
          error: payload.error,
        });
      }
    }
  }

  await withTimeout(
    Promise.all(Array.from({ length: Math.min(maxConcurrency, queue.length || 1) }, () => worker())),
    batchTimeoutMs,
    'DOWNLOAD_TIMEOUT'
  ).catch((error) => {
    const payload = buildErrorPayload(error);
    warnings.push(payload.error_code);
  });

  return {
    ok: true,
    partial: partialFailures.length > 0,
    items,
    merged_summary: summarizeItems(items),
    timeline: items.flatMap((item) => Array.isArray(item.timeline) ? item.timeline : []),
    partial_failures: partialFailures,
    warnings,
  };
}
