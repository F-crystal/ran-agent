#!/usr/bin/env node
import readline from 'node:readline';
import { downloadMediaAsset, buildErrorPayload, buildMediaAssets, MediaReaderError } from './mediaReader/assetResolver.mjs';
import { createCacheStore, sha256Hex } from './mediaReader/cacheStore.mjs';
import { analyzeImageOcr } from './mediaReader/ocrProvider.mjs';
import { analyzeImageVision } from './mediaReader/visionProvider.mjs';
import { transcribeAudioProvider } from './mediaReader/asrProvider.mjs';
import { analyzeVideoWithFfmpeg } from './mediaReader/ffmpegTools.mjs';
import { analyzeMediaBatch } from './mediaReader/batchAnalyzer.mjs';

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

async function analyzeImage(args = {}, options = {}) {
  const cache = createCacheStore(options.env);
  const asset = await downloadMediaAsset({ url: args.url, expectedKind: 'image' }, { ...options, cacheStore: cache });
  if (asset.type !== 'image') {
    throw new MediaReaderError('UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE: expected image media', {
      media_type: asset.type,
      url_host: asset.url_host,
    });
  }
  const ocrEnabled = normalizeBoolean(args.ocr, true);
  const vlmEnabled = normalizeBoolean(args.vlm, true);
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
  const providerOptions = { ...options, args };
  const ocr = ocrEnabled ? await analyzeImageOcr(asset, providerOptions) : { text: '', blocks: [], model: '' };
  const vision = vlmEnabled ? await analyzeImageVision(asset, providerOptions) : { summary: '', objects: [], model: '' };
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
    warnings: [],
  };
  cache.writeAnalysis('vlm', provider, model, analysisKey, payload);
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
        if (asset.type === 'image') {
          return await analyzeImage({ url: asset.url, ocr: true, vlm: args.media_detail !== 'basic' }, options);
        }
        if (asset.type === 'audio') {
          return await transcribeAudio({ url: asset.url, timestamps: true }, options);
        }
        if (asset.type === 'video') {
          return await analyzeVideo({ url: asset.url, max_frames: args.max_frames_per_video }, options);
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
