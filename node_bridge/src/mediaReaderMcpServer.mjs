#!/usr/bin/env node
import readline from 'node:readline';
import { downloadMediaAsset, buildErrorPayload, buildMediaAssets, MediaReaderError } from './mediaReader/assetResolver.mjs';
import { createCacheStore, sha256Hex } from './mediaReader/cacheStore.mjs';
import { analyzeImageOcr } from './mediaReader/ocrProvider.mjs';
import { analyzeImageVision } from './mediaReader/visionProvider.mjs';
import { transcribeAudioProvider } from './mediaReader/asrProvider.mjs';
import { analyzeVideoWithFfmpeg } from './mediaReader/ffmpegTools.mjs';
import { analyzeMediaBatch } from './mediaReader/batchAnalyzer.mjs';
import {
  isPlatformMediaInput,
  resolvePlatformMedia,
  sanitizePlatformResult,
} from './mediaReader/platformResolvers/index.mjs';
import {
  downloadBilibiliVideoForAnalysis,
  shouldDownloadBilibiliForAnalysis,
} from './mediaReader/platformResolvers/bilibiliResolver.mjs';

const SERVER_INFO = {
  name: 'ran-agent-media-reader',
  version: '0.1.0',
};

function buildTextResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function buildErrorResult(error, extra = {}) {
  const payload = buildErrorPayload(error, extra);
  return {
    isError: true,
    content: [{ type: 'text', text: payload.error }],
    structuredContent: payload,
  };
}

export function buildMediaReaderTools() {
  return [
    {
      name: 'extract_media_assets',
      title: 'Extract Media Assets',
      description: 'Extract and normalize media asset URLs from social text or explicit media URLs.',
      inputSchema: {
        type: 'object',
        properties: {
          url_or_text: { type: 'string', description: 'Text or URL that may contain media links.' },
          platform: { type: 'string', description: 'Optional source platform.' },
          media_urls: { type: 'array', items: { type: 'string' }, default: [] },
          max_assets: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'analyze_image',
      title: 'Analyze Image',
      description: 'Analyze an image with OCR and optional vision-language model summary.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          asset_id: { type: 'string' },
          ocr: { type: 'boolean', default: true },
          vlm: { type: 'boolean', default: true },
          prompt: { type: 'string' },
          language_hint: { type: 'string', default: 'zh' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'resolve_platform_media',
      title: 'Resolve Platform Media',
      description: 'Resolve Bilibili/XHS/WeChat share text, shortlinks, and platform pages into normalized media assets.',
      inputSchema: {
        type: 'object',
        properties: {
          url_or_text: { type: 'string' },
          platform: { type: 'string', enum: ['auto', 'bilibili', 'xhs', 'wechat_article'], default: 'auto' },
          media_detail: { type: 'string', enum: ['basic', 'standard', 'full'], default: 'standard' },
          include_comments: { type: 'boolean', default: false },
          max_comments: { type: 'integer', minimum: 0, maximum: 200, default: 30 },
          max_assets: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'transcribe_audio',
      title: 'Transcribe Audio',
      description: 'Transcribe audio into structured text with optional timestamps.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          asset_id: { type: 'string' },
          language_hint: { type: 'string', default: 'zh' },
          timestamps: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'analyze_video',
      title: 'Analyze Video',
      description: 'Analyze video through metadata, frame extraction, OCR/VLM, and audio transcription.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          asset_id: { type: 'string' },
          include_audio: { type: 'boolean', default: true },
          include_ocr: { type: 'boolean', default: true },
          include_vlm: { type: 'boolean', default: true },
          max_seconds: { type: 'integer', minimum: 1, default: 180 },
          max_frames: { type: 'integer', minimum: 1, default: 12 },
          frame_strategy: { type: 'string', enum: ['uniform', 'scene_change', 'hybrid'], default: 'hybrid' },
          prompt: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'analyze_media_batch',
      title: 'Analyze Media Batch',
      description: 'Analyze multiple media assets and return partial results when some assets fail.',
      inputSchema: {
        type: 'object',
        properties: {
          assets: { type: 'array', items: { type: 'object' }, default: [] },
          media_detail: { type: 'string', enum: ['basic', 'standard', 'full'], default: 'standard' },
          max_assets: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          max_frames_per_video: { type: 'integer', minimum: 1, default: 12 },
          task: { type: 'string', default: 'summarize_social_post_media' },
        },
        additionalProperties: false,
      },
    },
  ];
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeEnvBoolean(env, key, fallback) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function hasOwnEnv(env, key) {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

function ocrTimeoutMsFor({ env, mediaDetail }) {
  if (hasOwnEnv(env, 'PERSONAL_AGENT_OCR_TIMEOUT_MS')) {
    return normalizePositiveInt(env.PERSONAL_AGENT_OCR_TIMEOUT_MS, 15000);
  }
  if (String(mediaDetail || '').toLowerCase() === 'full') {
    return 90000;
  }
  return 15000;
}

function errorCodeFor(error, fallback) {
  if (error instanceof MediaReaderError) {
    return error.error_code || fallback;
  }
  return String(error?.error_code || '').trim() || fallback;
}

function ocrErrorCodeFor(error) {
  const code = errorCodeFor(error, 'OCR_FAILED');
  return code === 'OCR_TIMEOUT' ? 'OCR_TIMEOUT' : 'OCR_FAILED';
}

function errorForSettledResult(result) {
  if (result.error instanceof MediaReaderError && result.error.error_code === result.code) {
    return result.error;
  }
  return new MediaReaderError(
    result.code,
    `${result.code}: ${result.error?.message || result.error || 'analysis failed'}`
  );
}

function warningFor(code) {
  return { code };
}

async function withTimeout(promise, timeoutMs, errorCode) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new MediaReaderError(errorCode, `${errorCode}: operation timed out`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function settleAnalyzer(fn, fallbackCode, codeForError = null) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const code = codeForError ? codeForError(error) : errorCodeFor(error, fallbackCode);
    return { ok: false, error, code };
  }
}

async function analyzeImage(args = {}, options = {}) {
  const env = options.env || process.env;
  const cache = createCacheStore(options.env);
  const asset = await downloadMediaAsset({ url: args.url, expectedKind: 'image' }, { ...options, cacheStore: cache });
  if (asset.type !== 'image') {
    throw new MediaReaderError('UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE: expected image media', {
      media_type: asset.type,
      url_host: asset.url_host,
    });
  }
  const ocrEnabled = normalizeBoolean(args.ocr, true) && normalizeEnvBoolean(env, 'PERSONAL_AGENT_OCR_ENABLED', true);
  const vlmEnabled = normalizeBoolean(args.vlm, true);
  const ocrRequired = normalizeEnvBoolean(env, 'PERSONAL_AGENT_OCR_REQUIRED', false);
  const imageVlmFirst = normalizeEnvBoolean(env, 'PERSONAL_AGENT_IMAGE_VLM_FIRST', true);
  const mediaDetail = args.media_detail || options.mediaDetail || 'standard';
  if (!ocrEnabled && !vlmEnabled) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: at least one image analyzer must be enabled');
  }
  const provider = [
    ocrEnabled ? String(options.env?.PERSONAL_AGENT_OCR_PROVIDER || 'custom-ocr') : '',
    vlmEnabled ? String(options.env?.PERSONAL_AGENT_VISION_PROVIDER || 'custom-vlm') : '',
  ].filter(Boolean).join('+');
  const model = provider;
  const promptHash = sha256Hex(String(args.prompt || ''));
  const analysisKey = cache.analysisKey({
    contentSha256: asset.content_sha256,
    provider,
    model,
    params: { ocr: ocrEnabled, vlm: vlmEnabled, language_hint: args.language_hint || 'zh' },
    promptHash,
  });
  const cached = cache.readAnalysis('vlm', provider, model, analysisKey);
  if (cached) {
    return { ...cached, cache_hit: true };
  }
  const ocrTimeoutMs = ocrTimeoutMsFor({ env, mediaDetail });
  const providerOptions = {
    ...options,
    args,
    env: {
      ...env,
      PERSONAL_AGENT_OCR_TIMEOUT_MS: String(ocrTimeoutMs),
    },
  };
  const runOcr = () => settleAnalyzer(
    () => withTimeout(analyzeImageOcr(asset, providerOptions), ocrTimeoutMs, 'OCR_TIMEOUT'),
    'OCR_FAILED',
    ocrErrorCodeFor
  );
  const runVision = () => settleAnalyzer(
    () => analyzeImageVision(asset, providerOptions),
    'VLM_FAILED'
  );
  let ocrPromise;
  let visionPromise;
  if (imageVlmFirst) {
    visionPromise = vlmEnabled ? runVision() : Promise.resolve({ ok: true, value: { summary: '', objects: [], model: '' } });
    ocrPromise = ocrEnabled ? runOcr() : Promise.resolve({ ok: true, value: { text: '', blocks: [], model: '' } });
  } else {
    ocrPromise = ocrEnabled ? runOcr() : Promise.resolve({ ok: true, value: { text: '', blocks: [], model: '' } });
    visionPromise = vlmEnabled ? runVision() : Promise.resolve({ ok: true, value: { summary: '', objects: [], model: '' } });
  }
  let ocrResult;
  let visionResult;
  if (imageVlmFirst) {
    [visionResult, ocrResult] = await Promise.all([visionPromise, ocrPromise]);
  } else {
    [ocrResult, visionResult] = await Promise.all([ocrPromise, visionPromise]);
  }
  if (!ocrResult.ok && ocrRequired) {
    throw errorForSettledResult(ocrResult);
  }
  if (!ocrResult.ok && (!visionResult.ok || !vlmEnabled)) {
    throw errorForSettledResult(ocrResult);
  }
  if (!visionResult.ok && (!ocrResult.ok || !ocrEnabled)) {
    throw errorForSettledResult(visionResult);
  }
  const ocr = ocrResult.ok ? ocrResult.value : { text: '', blocks: [], model: ocrResult.code === 'OCR_TIMEOUT' ? 'paddleocr_timeout' : 'paddleocr_failed' };
  const vision = visionResult.ok ? visionResult.value : { summary: '', objects: [], model: 'vlm_failed' };
  const warnings = [];
  if (!ocrResult.ok) warnings.push(warningFor(ocrResult.code));
  if (!visionResult.ok) warnings.push(warningFor(visionResult.code));
  const partial = warnings.length > 0;
  const payload = {
    ok: true,
    type: 'image',
    content_sha256: asset.content_sha256,
    ocr_text: String(ocr.text || ''),
    visible_text_blocks: Array.isArray(ocr.blocks) ? ocr.blocks : [],
    scene_summary: String(vision.summary || ''),
    objects: Array.isArray(vision.objects) ? vision.objects : [],
    model: { ocr: ocr.model || '', vlm: vision.model || '' },
    cache_hit: false,
    warnings,
  };
  if (partial) {
    payload.partial = true;
    payload.error_code = warnings[0]?.code || 'PARTIAL_IMAGE_ANALYSIS';
  } else {
    cache.writeAnalysis('vlm', provider, model, analysisKey, payload);
  }
  return payload;
}

async function transcribeAudio(args = {}, options = {}) {
  const asset = await downloadMediaAsset({ url: args.url, expectedKind: 'audio' }, options);
  if (asset.type !== 'audio') {
    throw new MediaReaderError('UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE: expected audio media', { media_type: asset.type });
  }
  const transcript = await transcribeAudioProvider(asset, { ...options, args });
  return {
    ok: true,
    type: 'audio',
    content_sha256: asset.content_sha256,
    transcript: String(transcript.transcript || ''),
    segments: Array.isArray(transcript.segments) ? transcript.segments : [],
    language: transcript.language || args.language_hint || '',
    model: transcript.model || '',
    cache_hit: false,
    warnings: [],
  };
}

async function analyzeVideo(args = {}, options = {}) {
  const videoInput = args.url || args.url_or_text || '';
  if (isPlatformMediaInput(videoInput)) {
    const resolved = await resolvePlatformMedia({
      url_or_text: videoInput,
      platform: args.platform || 'auto',
      media_detail: args.media_detail || 'standard',
      include_comments: args.include_comments === true,
      max_comments: args.max_comments || 30,
      max_assets: args.max_assets || 20,
    }, options);
    const sanitized = sanitizePlatformResult(resolved);
    const subtitle = sanitized.subtitle;
    const subtitleText = subtitle?.text || '';
    const isBilibili = sanitized.platform === 'bilibili';

    // Subtitle-first path: when real transcript/subtitle text exists, skip video download.
    // For B站: requires yt-dlp subtitle extraction. For XHS/others: post_text IS the note content.
    const hasTranscript = Boolean(subtitleText);
    const hasXhsTextContent = sanitized.platform === 'xhs' && sanitized.post_text && sanitized.post_text.length > 60;
    const hasTextContent = hasTranscript || hasXhsTextContent;
    const effectiveTranscript = subtitleText || (hasXhsTextContent ? sanitized.post_text : '');

    if (hasTextContent) {
      const warnings = [...sanitized.warnings];
      let coverSummary = '';
      const coverMedia = sanitized.media?.find((m) => m.type === 'cover' || m.type === 'image');
      if (coverMedia?.url) {
        try {
          const coverAsset = await downloadMediaAsset({ url: coverMedia.url, expectedKind: 'image' }, options);
          if (coverAsset.type === 'image') {
            const vision = await analyzeImageVision(coverAsset, options);
            coverSummary = String(vision.summary || '');
          }
        } catch {
          warnings.push('COVER_ANALYSIS_FAILED');
        }
      }
      const visualSummary = [sanitized.post_text !== effectiveTranscript ? sanitized.post_text : '', coverSummary].filter(Boolean).join('\n');
      const overallSummary = [
        `Title: ${sanitized.metadata?.title || sanitized.metadata?.note_id || ''}`,
        sanitized.metadata?.uploader ? `Uploader: ${sanitized.metadata.uploader}` : '',
        sanitized.metadata?.duration_seconds ? `Duration: ${Math.round(sanitized.metadata.duration_seconds)}s` : '',
        visualSummary ? `\nDescription: ${visualSummary}` : '',
        coverSummary ? `\nVisual: ${coverSummary}` : '',
        effectiveTranscript ? `\nTranscript:\n${effectiveTranscript}` : '',
      ].filter(Boolean).join('\n');
      const transcriptSource = subtitleText ? sanitized.transcript_source : (sanitized.post_text ? 'post_text' : 'none');
      return {
        ok: true,
        type: 'platform_video',
        platform: sanitized.platform,
        resolver: sanitized.resolver,
        analysis_mode: 'transcript_first',
        metadata: sanitized.metadata,
        platform_media: sanitized,
        asr: { transcript: subtitleText, source: transcriptSource },
        frames: [],
        timeline: [],
        visual_summary: visualSummary,
        audio_summary: subtitleText || sanitized.post_text,
        overall_summary: overallSummary,
        transcript_source: transcriptSource,
        visual_source: coverSummary ? 'thumbnail_vlm' : sanitized.visual_source,
        cache_hit: false,
        warnings,
      };
    }

    // No transcript: fall back to video download for B站 (if explicitly enabled),
    // or return metadata-only for other platforms.
    if (isBilibili && shouldDownloadBilibiliForAnalysis(options.env || process.env)) {
      const analysisArgs = { ...args, include_ocr: false };
      const asset = await downloadBilibiliVideoForAnalysis({
        url: resolved.resolved_url || videoInput,
        bvid: sanitized.metadata?.bvid || '',
        maxSeconds: args.max_seconds,
      }, options);
      const videoAnalysis = await analyzeVideoWithFfmpeg(asset, { ...options, args: analysisArgs });
      const asr = subtitleText
        ? { transcript: subtitleText, source: sanitized.transcript_source }
        : (videoAnalysis.asr || {});
      const visualSummary = String(videoAnalysis.visual_summary || sanitized.post_text || sanitized.metadata?.title || '');
      const audioSummary = subtitleText || String(videoAnalysis.audio_summary || asr.transcript || '');
      return {
        ok: true,
        type: 'platform_video',
        platform: sanitized.platform,
        resolver: sanitized.resolver,
        analysis_mode: 'frame_extraction',
        metadata: {
          ...sanitized.metadata,
          ...(videoAnalysis.metadata || {}),
        },
        platform_media: sanitized,
        content_sha256: asset.content_sha256,
        asr,
        frames: Array.isArray(videoAnalysis.frames) ? videoAnalysis.frames : [],
        timeline: Array.isArray(videoAnalysis.timeline) ? videoAnalysis.timeline : [],
        visual_summary: visualSummary,
        audio_summary: audioSummary,
        overall_summary: [sanitized.post_text, visualSummary, audioSummary].filter(Boolean).join('\n'),
        transcript_source: subtitleText ? sanitized.transcript_source : (asr.transcript ? 'asr' : sanitized.transcript_source),
        visual_source: videoAnalysis.frames?.length ? 'video_frames' : sanitized.visual_source,
        cache_hit: false,
        warnings: [...sanitized.warnings, ...(Array.isArray(videoAnalysis.warnings) ? videoAnalysis.warnings : [])],
      };
    }
    return {
      ok: true,
      type: 'platform_video',
      platform: sanitized.platform,
      resolver: sanitized.resolver,
      analysis_mode: 'metadata_only',
      metadata: sanitized.metadata,
      platform_media: sanitized,
      asr: subtitleText ? { transcript: subtitleText, source: sanitized.transcript_source } : {},
      frames: [],
      timeline: [],
      visual_summary: sanitized.post_text || sanitized.metadata?.title || '',
      audio_summary: subtitleText,
      overall_summary: [sanitized.post_text, subtitleText].filter(Boolean).join('\n'),
      transcript_source: sanitized.transcript_source,
      visual_source: sanitized.visual_source,
      cache_hit: false,
      warnings: isBilibili ? [...sanitized.warnings, 'SUBTITLE_NOT_FOUND'] : sanitized.warnings,
    };
  }
  const asset = await downloadMediaAsset({ url: args.url, expectedKind: 'video' }, options);
  if (asset.type !== 'video') {
    throw new MediaReaderError('UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE: expected video media', { media_type: asset.type });
  }
  const result = await analyzeVideoWithFfmpeg(asset, { ...options, args });
  return {
    ok: true,
    type: 'video',
    content_sha256: asset.content_sha256,
    metadata: result.metadata || {},
    frames: Array.isArray(result.frames) ? result.frames : [],
    asr: result.asr || {},
    timeline: Array.isArray(result.timeline) ? result.timeline : [],
    visual_summary: String(result.visual_summary || ''),
    audio_summary: String(result.audio_summary || ''),
    overall_summary: String(result.overall_summary || ''),
    cache_hit: false,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

async function callTool(name, args = {}, options = {}) {
  if (name === 'extract_media_assets') {
    const assets = buildMediaAssets({
      urlOrText: args.url_or_text || '',
      mediaUrls: Array.isArray(args.media_urls) ? args.media_urls : [],
      platform: args.platform || '',
      maxAssets: Number(args.max_assets || 20),
    });
    return buildTextResult({ ok: true, assets, warnings: assets.length ? [] : ['NO_MEDIA_FOUND'] });
  }
  if (name === 'resolve_platform_media') {
    const result = await resolvePlatformMedia({
      url_or_text: args.url_or_text || '',
      platform: args.platform || 'auto',
      media_detail: args.media_detail || 'standard',
      include_comments: args.include_comments === true,
      max_comments: Number(args.max_comments || 30),
      max_assets: Number(args.max_assets || 20),
    }, options);
    return buildTextResult(sanitizePlatformResult(result));
  }
  if (name === 'analyze_image') {
    return buildTextResult(await analyzeImage(args, options));
  }
  if (name === 'transcribe_audio') {
    return buildTextResult(await transcribeAudio(args, options));
  }
  if (name === 'analyze_video') {
    return buildTextResult(await analyzeVideo(args, options));
  }
  if (name === 'analyze_media_batch') {
    const assets = Array.isArray(args.assets) ? args.assets.slice(0, Number(args.max_assets || 20)) : [];
    const result = await analyzeMediaBatch({
      assets,
      mediaDetail: args.media_detail || 'standard',
      env: options.env,
      analyzeOne: async (asset) => {
        if (asset.type === 'platform' || isPlatformMediaInput(asset.url || asset.url_or_text || '')) {
          const resolved = await resolvePlatformMedia({
            url_or_text: asset.url_or_text || asset.url || '',
            platform: asset.platform || 'auto',
            media_detail: args.media_detail || 'standard',
            include_comments: args.include_comments === true,
            max_comments: args.max_comments || 30,
            max_assets: args.max_assets || 20,
          }, options);
          const sanitized = sanitizePlatformResult(resolved);
          const childItems = [];
          const childWarnings = [...sanitized.warnings];
          if (sanitized.platform === 'bilibili' && shouldDownloadBilibiliForAnalysis(options.env || process.env)) {
            try {
              childItems.push(await analyzeVideo({
                url: asset.url_or_text || asset.url || '',
                platform: asset.platform || 'bilibili',
                media_detail: args.media_detail || 'standard',
                include_audio: true,
                include_ocr: true,
                include_vlm: args.media_detail !== 'basic',
                max_frames: args.max_frames_per_video,
              }, options));
            } catch (error) {
              childWarnings.push({ code: errorCodeFor(error, 'MEDIA_ANALYSIS_FAILED'), asset_id: asset.asset_id || '' });
            }
          } else {
            for (const media of (resolved.media || []).slice(0, Number(args.max_assets || 20))) {
              try {
                if ((media.type === 'image' || media.type === 'cover') && media.url) {
                  childItems.push(await analyzeImage({ url: media.url, ocr: true, vlm: args.media_detail !== 'basic', media_detail: args.media_detail || 'standard' }, {
                    ...options,
                    mediaDetail: args.media_detail || 'standard',
                  }));
                } else if (media.type === 'audio' && media.url) {
                  childItems.push(await transcribeAudio({ url: media.url, timestamps: true }, options));
                } else if (media.type === 'video' && media.url) {
                  childItems.push(await analyzeVideo({ url: media.url, max_frames: args.max_frames_per_video }, options));
                } else if (media.type === 'subtitle') {
                  childItems.push({
                    ok: true,
                    type: 'subtitle',
                    transcript: media.text || sanitized.subtitle?.text || '',
                    warnings: [],
                  });
                } else {
                  childWarnings.push({ code: 'UNSUPPORTED_MEDIA_TYPE', asset_id: media.asset_id || '' });
                }
              } catch (error) {
                childWarnings.push({ code: errorCodeFor(error, 'MEDIA_ANALYSIS_FAILED'), asset_id: media.asset_id || '' });
              }
            }
          }
          const summaries = childItems
            .map((item) => item.overall_summary || item.scene_summary || item.transcript || item.ocr_text || '')
            .filter(Boolean);
          return {
            ok: true,
            type: 'platform_media',
            platform: sanitized.platform,
            resolver: sanitized.resolver,
            metadata: sanitized.metadata,
            platform_media: sanitized,
            items: childItems,
            overall_summary: [sanitized.post_text, ...summaries].filter(Boolean).join('\n'),
            partial: childWarnings.length > 0,
            error_code: childWarnings[0]?.code || '',
            warnings: childWarnings,
          };
        }
        if (asset.type === 'image' || asset.type === 'cover') {
          return await analyzeImage({ url: asset.url, ocr: true, vlm: args.media_detail !== 'basic', media_detail: args.media_detail || 'standard' }, {
            ...options,
            mediaDetail: args.media_detail || 'standard',
          });
        }
        if (asset.type === 'audio') {
          return await transcribeAudio({ url: asset.url, timestamps: true }, options);
        }
        if (asset.type === 'video') {
          return await analyzeVideo({ url: asset.url, max_frames: args.max_frames_per_video }, options);
        }
        if (asset.type === 'subtitle') {
          return { ok: true, type: 'subtitle', transcript: String(asset.text || ''), warnings: [] };
        }
        throw new MediaReaderError('UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE: unsupported media asset type');
      },
    });
    return buildTextResult(result);
  }
  throw new MediaReaderError('UNKNOWN_TOOL', `UNKNOWN_TOOL: ${name}`);
}

export async function handleMediaReaderMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildMediaReaderTools() };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    try {
      return await callTool(String(params.name || ''), params.arguments || {}, options);
    } catch (error) {
      return buildErrorResult(error);
    }
  }
  throw new Error(`unsupported MCP method: ${method}`);
}

function writeJsonRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
  })}\n`);
}

export function runMediaReaderMcpServer(options = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) return;
    try {
      writeJsonRpcResponse(request.id, await handleMediaReaderMcpRequest(request, options));
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMediaReaderMcpServer();
}
