#!/usr/bin/env node
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import {
  isPathInsideRoot,
  isTrustedLocalMediaPath,
  resolveProjectRoot,
  trustedMediaDirsDescription,
} from './trustedMediaPaths.mjs';

const SERVER_INFO = {
  name: 'ran-agent-mimo-power',
  version: '0.1.0',
};
const DEFAULT_EXPIRES_AT = '2026-06-09T23:59:00Z';
const DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2.5-pro';
const DEFAULT_MAX_COMPLETION_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

class MimoPowerError extends Error {
  constructor(errorCode, message, extra = {}) {
    super(message || errorCode);
    this.name = 'MimoPowerError';
    this.error_code = errorCode;
    this.extra = extra;
  }
}

export function buildMimoPowerTools() {
  return [
    {
      name: 'analyze',
      title: 'MiMo Power Analyze',
      description: [
        'Use MiMo Token Plan as a powerful multimodal, long-context, deep reasoning tool.',
        'Use when the user explicitly asks for MiMo, deep multimodal analysis, heavy archive/document review, image/audio/video understanding, or complex synthesis.',
        'Hermes remains the speaker; this tool returns evidence and artifacts for Hermes to summarize.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The concrete analysis task for MiMo.',
          },
          mode: {
            type: 'string',
            enum: ['deep', 'fast', 'vision', 'audio', 'video', 'code', 'archive', 'general'],
            description: 'Optional task mode. Use deep by default for heavy multimodal work.',
          },
          assets: {
            type: 'array',
            description: 'Optional multimodal assets. Each item may use url or file_path.',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['image', 'audio', 'video', 'document', 'text'],
                },
                url: {
                  type: 'string',
                  description: 'Public HTTP(S) URL for the asset.',
                },
                file_path: {
                  type: 'string',
                  description: 'Local file path under the project workspace.',
                },
                mime: {
                  type: 'string',
                  description: 'MIME type for local file or base64 data.',
                },
                text: {
                  type: 'string',
                  description: 'Inline text asset.',
                },
                data: {
                  type: 'string',
                  description: 'Base64 asset data.',
                },
                fps: {
                  type: 'number',
                  description: 'Video sampling FPS when asset type is video.',
                },
                media_resolution: {
                  type: 'string',
                  enum: ['low', 'default', 'high'],
                  description: 'Video/image resolution hint when supported by MiMo.',
                },
              },
              additionalProperties: false,
            },
          },
          max_completion_tokens: {
            type: 'number',
            description: 'Optional output token cap for this request.',
          },
          model: {
            type: 'string',
            description: 'Optional explicit model override.',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  ];
}

function assertInsideProject(filePath, env = process.env) {
  const root = resolveProjectRoot(env);
  const resolved = path.resolve(filePath);
  if (!isTrustedLocalMediaPath(resolved, env)) {
    throw new MimoPowerError(
      'LOCAL_FILE_BLOCKED',
      `LOCAL_FILE_BLOCKED: local asset must stay inside trusted media directories: ${trustedMediaDirsDescription(env) || root}`,
      { project_root: root }
    );
  }
  return resolved;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeAssetType(asset = {}) {
  const explicit = String(asset.type || '').trim().toLowerCase();
  if (['image', 'audio', 'video', 'document', 'text'].includes(explicit)) {
    return explicit;
  }
  const source = String(asset.url || asset.file_path || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp)(\?|$)/.test(source)) return 'image';
  if (/\.(wav|mp3|m4a|aac|flac|ogg)(\?|$)/.test(source)) return 'audio';
  if (/\.(mp4|mov|webm|mkv)(\?|$)/.test(source)) return 'video';
  return 'text';
}

function mimeForAsset(asset = {}, type = '') {
  const explicit = String(asset.mime || '').trim();
  if (explicit) {
    return explicit;
  }
  if (type === 'image') return 'image/png';
  if (type === 'audio') return 'audio/wav';
  if (type === 'video') return 'video/mp4';
  return 'text/plain';
}

function readLocalAssetData(asset, type, env = process.env) {
  const resolved = assertInsideProject(asset.file_path, env);
  const maxBytes = normalizePositiveInteger(env.MIMO_POWER_MAX_LOCAL_FILE_BYTES, DEFAULT_MAX_LOCAL_FILE_BYTES);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new MimoPowerError('LOCAL_FILE_BLOCKED', 'LOCAL_FILE_BLOCKED: local asset is not a regular file');
  }
  if (stat.size > maxBytes) {
    throw new MimoPowerError('MAX_BYTES_EXCEEDED', 'MAX_BYTES_EXCEEDED: local asset exceeds MIMO_POWER_MAX_LOCAL_FILE_BYTES', {
      max_bytes: maxBytes,
      size: stat.size,
    });
  }
  const base64 = fs.readFileSync(resolved).toString('base64');
  const mime = mimeForAsset(asset, type);
  if (type === 'image') {
    return `data:${mime};base64,${base64}`;
  }
  return base64;
}

function assetUrlOrData(asset, type, env = process.env) {
  if (asset.url) {
    return String(asset.url).trim();
  }
  if (asset.data) {
    const data = String(asset.data).trim();
    if (type === 'image' && !data.startsWith('data:')) {
      return `data:${mimeForAsset(asset, type)};base64,${data}`;
    }
    return data;
  }
  if (asset.file_path) {
    return readLocalAssetData(asset, type, env);
  }
  return '';
}

function buildAssetContentPart(asset = {}, env = process.env) {
  const type = normalizeAssetType(asset);
  if (type === 'text' || type === 'document') {
    const text = String(asset.text || '').trim();
    if (!text) {
      return null;
    }
    return { type: 'text', text };
  }
  const source = assetUrlOrData(asset, type, env);
  if (!source) {
    return null;
  }
  if (type === 'image') {
    return { type: 'image_url', image_url: { url: source } };
  }
  if (type === 'audio') {
    return { type: 'input_audio', input_audio: { data: source } };
  }
  if (type === 'video') {
    const part = { type: 'video_url', video_url: { url: source } };
    const fps = Number(asset.fps);
    if (Number.isFinite(fps) && fps > 0) {
      part.fps = fps;
    }
    const mediaResolution = String(asset.media_resolution || '').trim();
    if (['low', 'default', 'high'].includes(mediaResolution)) {
      part.media_resolution = mediaResolution;
    }
    return part;
  }
  return null;
}

/**
 * Normalize endpoint style: 'chat' (default) or 'responses'
 */
function normalizeMimoEndpointStyle(env = process.env) {
  const style = String(env.MIMO_POWER_ENDPOINT_STYLE || 'chat').trim().toLowerCase();
  if (style === 'responses') return 'responses';
  return 'chat';
}

/**
 * Select model based on mode and assets.
 * Returns { model, error } where error is set if no suitable model is found.
 */
function selectModel(args = {}, options = {}) {
  const env = options.env || process.env;
  const assets = Array.isArray(args.assets) ? args.assets : [];
  const mode = String(args.mode || '').trim().toLowerCase();
  
  // 1. If args.model is explicitly provided, use it
  if (args.model && String(args.model).trim()) {
    return { model: String(args.model).trim(), error: null };
  }
  
  // Detect asset types
  const hasImage = assets.some(a => normalizeAssetType(a) === 'image');
  const hasVideo = assets.some(a => normalizeAssetType(a) === 'video');
  const hasAudio = assets.some(a => normalizeAssetType(a) === 'audio');
  const hasVisionAsset = hasImage || hasVideo;
  
  // 2. Vision mode or vision assets
  if (mode === 'vision' || hasVisionAsset) {
    const visionModel = String(env.MIMO_POWER_VISION_MODEL || '').trim();
    if (visionModel) {
      return { model: visionModel, error: null };
    }
    const multiModel = String(env.MIMO_POWER_MULTIMODAL_MODEL || '').trim();
    if (multiModel) {
      return { model: multiModel, error: null };
    }
    return { model: null, error: new MimoPowerError('MIMO_VISION_MODEL_MISSING', 'MIMO_VISION_MODEL_MISSING: no vision/multimodal model configured for image/video assets') };
  }
  
  // 3. Audio mode or audio assets
  if (mode === 'audio' || hasAudio) {
    const audioModel = String(env.MIMO_POWER_AUDIO_MODEL || '').trim();
    if (audioModel) {
      return { model: audioModel, error: null };
    }
    const multiModel = String(env.MIMO_POWER_MULTIMODAL_MODEL || '').trim();
    if (multiModel) {
      return { model: multiModel, error: null };
    }
    return { model: null, error: new MimoPowerError('MIMO_AUDIO_MODEL_MISSING', 'MIMO_AUDIO_MODEL_MISSING: no audio/multimodal model configured for audio assets') };
  }
  
  // 4. Text-only task
  const textModel = String(env.MIMO_POWER_TEXT_MODEL || '').trim();
  if (textModel) {
    return { model: textModel, error: null };
  }
  const legacyModel = String(env.MIMO_POWER_MODEL || '').trim();
  if (legacyModel) {
    return { model: legacyModel, error: null };
  }
  // Fallback to default
  return { model: DEFAULT_MODEL, error: null };
}

export function buildMimoChatCompletionsRequestBody(args = {}, options = {}) {
  const env = options.env || process.env;
  const task = String(args.task || '').trim();
  if (!task) {
    throw new MimoPowerError('INVALID_ARGUMENTS', 'INVALID_ARGUMENTS: analyze requires task');
  }
  const mode = String(args.mode || 'deep').trim() || 'deep';
  const assets = Array.isArray(args.assets) ? args.assets : [];
  const content = assets
    .map((asset) => buildAssetContentPart(asset, env))
    .filter(Boolean);
  content.push({
    type: 'text',
    text: [
      `Task: ${task}`,
      `mode: ${mode}`,
      'Return a concise but evidence-rich result for Hermes to summarize. Include key findings, concrete evidence, risks, and next actions when relevant.',
    ].join('\n'),
  });
  
  const modelSelection = selectModel(args, options);
  if (modelSelection.error) {
    throw modelSelection.error;
  }
  
  return {
    model: modelSelection.model,
    messages: [
      {
        role: 'system',
        content: [
          'You are MiMo, a powerful multimodal analysis worker called by Hermes.',
          'Do not roleplay as the user-facing assistant.',
          'Focus on accurate multimodal understanding, long-context synthesis, and actionable findings.',
        ].join(' '),
      },
      {
        role: 'user',
        content,
      },
    ],
    max_completion_tokens: normalizePositiveInteger(
      args.max_completion_tokens || env.MIMO_POWER_MAX_COMPLETION_TOKENS,
      DEFAULT_MAX_COMPLETION_TOKENS
    ),
  };
}

export function buildMimoRequestBody(args = {}, options = {}) {
  return buildMimoChatCompletionsRequestBody(args, options);
}

export function buildMimoResponsesRequestBody(args = {}, options = {}) {
  const env = options.env || process.env;
  const task = String(args.task || '').trim();
  if (!task) {
    throw new MimoPowerError('INVALID_ARGUMENTS', 'INVALID_ARGUMENTS: analyze requires task');
  }
  const mode = String(args.mode || 'deep').trim() || 'deep';
  const assets = Array.isArray(args.assets) ? args.assets : [];
  const input = assets
    .map((asset) => buildAssetContentPart(asset, env))
    .filter(Boolean);
  input.push({
    type: 'text',
    text: [
      `Task: ${task}`,
      `mode: ${mode}`,
      'Return a concise but evidence-rich result for Hermes to summarize. Include key findings, concrete evidence, risks, and next actions when relevant.',
    ].join('\n'),
  });
  
  const modelSelection = selectModel(args, options);
  if (modelSelection.error) {
    throw modelSelection.error;
  }
  
  return {
    model: modelSelection.model,
    input,
    max_output_tokens: normalizePositiveInteger(
      args.max_completion_tokens || env.MIMO_POWER_MAX_COMPLETION_TOKENS,
      DEFAULT_MAX_COMPLETION_TOKENS
    ),
  };
}

/**
 * Unified request builder that selects endpoint style and builds body.
 */
export function buildMimoRequest(args = {}, options = {}) {
  const env = options.env || process.env;
  const endpointStyle = normalizeMimoEndpointStyle(env);
  
  if (endpointStyle === 'responses') {
    return {
      endpointPath: '/responses',
      body: buildMimoResponsesRequestBody(args, options),
      responseStyle: 'responses',
    };
  }
  
  return {
    endpointPath: '/chat/completions',
    body: buildMimoChatCompletionsRequestBody(args, options),
    responseStyle: 'chat',
  };
}

function normalizeBaseUrl(env = process.env) {
  return String(env.MIMO_TOKEN_PLAN_OPENAI_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
}

function tokenPlanExpiry(env = process.env) {
  const raw = String(env.MIMO_TOKEN_PLAN_EXPIRES_AT || DEFAULT_EXPIRES_AT).trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : new Date(DEFAULT_EXPIRES_AT);
}

function checkAvailability(env = process.env, now = new Date()) {
  const apiKey = String(env.MIMO_TOKEN_PLAN_API_KEY || '').trim();
  if (!apiKey) {
    throw new MimoPowerError('MIMO_TOKEN_PLAN_KEY_MISSING', 'MIMO_TOKEN_PLAN_KEY_MISSING: set MIMO_TOKEN_PLAN_API_KEY');
  }
  const expiresAt = tokenPlanExpiry(env);
  if (now.getTime() > expiresAt.getTime()) {
    throw new MimoPowerError('MIMO_TOKEN_PLAN_EXPIRED', `MIMO_TOKEN_PLAN_EXPIRED: Token Plan expired at ${expiresAt.toISOString()}`, {
      expires_at: expiresAt.toISOString(),
    });
  }
  return { apiKey, expiresAt };
}

function isPrivateIpv4(ip) {
  const parts = String(ip || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIp(ip) {
  const value = String(ip || '').toLowerCase();
  return isPrivateIpv4(value) || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:') || value === '169.254.169.254';
}

async function defaultResolveHostname(hostname) {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function configuredAllowedHosts(env = process.env) {
  return String(env.MIMO_POWER_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname, allowedHosts) {
  if (allowedHosts.length === 0) return true;
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function assertSafePublicAssetUrls(args = {}, options = {}) {
  const env = options.env || process.env;
  const resolveHostnameImpl = options.resolveHostnameImpl || defaultResolveHostname;
  const allowedHosts = configuredAllowedHosts(env);
  const assets = Array.isArray(args.assets) ? args.assets : [];
  for (const asset of assets) {
    const rawUrl = String(asset?.url || '').trim();
    if (!rawUrl) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new MimoPowerError('URL_BLOCKED', 'URL_BLOCKED: invalid MiMo asset URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new MimoPowerError('URL_BLOCKED', 'URL_BLOCKED: MiMo asset URL scheme is not allowed');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!hostAllowed(hostname, allowedHosts)) {
      throw new MimoPowerError('URL_BLOCKED', 'URL_BLOCKED: MiMo asset host is not in MIMO_POWER_ALLOWED_HOSTS', {
        url_host: hostname,
      });
    }
    if (net.isIP(hostname) && isPrivateIp(hostname)) {
      throw new MimoPowerError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: MiMo asset URL points to private network', {
        url_host: hostname,
      });
    }
    const addresses = await resolveHostnameImpl(hostname);
    if (addresses.some(isPrivateIp)) {
      throw new MimoPowerError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: MiMo asset host resolved to private network', {
        url_host: hostname,
      });
    }
  }
}

async function postMimoRequest(body, endpointPath, options = {}) {
  const env = options.env || process.env;
  const { apiKey } = checkAvailability(env, options.now || new Date());
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = normalizePositiveInteger(env.MIMO_POWER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${normalizeBaseUrl(env)}${endpointPath}`, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message || error))) {
      throw new MimoPowerError('MIMO_REQUEST_TIMEOUT', `MIMO_REQUEST_TIMEOUT: MiMo request timed out after ${timeoutMs}ms`);
    }
    throw new MimoPowerError('MIMO_REQUEST_FAILED', `MIMO_REQUEST_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    const text = await response?.text?.().catch(() => '') || '';
    throw new MimoPowerError('MIMO_REQUEST_FAILED', `MIMO_REQUEST_FAILED: MiMo returned HTTP ${response?.status || 0}`, {
      status: response?.status || 0,
      response_excerpt: text.slice(0, 1000),
    });
  }
  return await response.json();
}

function resultTextFromResponseChat(payload = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const content = String(message.content || '').trim();
  if (content) {
    return content;
  }
  return '';
}

function resultTextFromResponseResponses(payload = {}) {
  // Try output_text first
  if (payload?.output_text) {
    return String(payload.output_text).trim();
  }
  // Try output[].content[].text
  const output = payload?.output;
  if (Array.isArray(output) && output.length > 0) {
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'text' && part?.text) {
            return String(part.text).trim();
          }
          if (part?.text) {
            return String(part.text).trim();
          }
        }
      }
    }
  }
  return '';
}

function resultTextFromResponse(payload = {}, responseStyle = 'chat') {
  if (responseStyle === 'responses') {
    return resultTextFromResponseResponses(payload);
  }
  return resultTextFromResponseChat(payload);
}

function taskDir(env = process.env) {
  const root = resolveProjectRoot(env);
  const raw = String(env.MIMO_POWER_TASK_DIR || path.join(root, 'debug/mimo/tasks')).trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isPathInsideRoot(resolved, root)) {
    throw new MimoPowerError('TASK_DIR_BLOCKED', `TASK_DIR_BLOCKED: MIMO_POWER_TASK_DIR must stay inside project workspace: ${root}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function writeTaskArtifact({ args, body, response, summary, responseStyle }, env = process.env) {
  const id = `mimo-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 10)}`;
  const filePath = path.join(taskDir(env), `${id}.md`);
  const usage = response?.usage || response?.token_usage || {};
  const model = response?.model || body.model || '';
  const endpointPath = responseStyle === 'responses' ? '/responses' : '/chat/completions';
  const content = [
    `# MiMo Power Result ${id}`,
    '',
    `- endpoint: ${endpointPath}`,
    `- model: ${model}`,
    `- mode: ${args.mode || 'deep'}`,
    `- total_tokens: ${usage.total_tokens ?? usage.output_tokens ?? ''}`,
    '',
    '## Task',
    '',
    String(args.task || '').trim(),
    '',
    '## Summary',
    '',
    summary || '[empty visible content]',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function buildSuccessResult({ args, body, response, summary, artifactPath, responseStyle }) {
  const endpointPath = responseStyle === 'responses' ? '/responses' : '/chat/completions';
  const usage = response?.usage || response?.token_usage || {};
  const payload = {
    ok: true,
    task: String(args.task || '').trim(),
    mode: String(args.mode || 'deep'),
    endpoint: endpointPath,
    summary,
    model: response?.model || body.model || '',
    usage: {
      total_tokens: usage.total_tokens ?? usage.output_tokens ?? '',
      input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? '',
      output_tokens: usage.output_tokens ?? usage.completion_tokens ?? '',
    },
    artifact_path: artifactPath,
    expires_at: DEFAULT_EXPIRES_AT,
  };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function buildErrorResult(error) {
  const code = error instanceof MimoPowerError ? error.error_code : 'MIMO_POWER_FAILED';
  const payload = {
    ok: false,
    error_code: code,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof MimoPowerError ? error.extra : {}),
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function callAnalyze(args = {}, options = {}) {
  try {
    const env = options.env || process.env;
    checkAvailability(env, options.now || new Date());
    await assertSafePublicAssetUrls(args, options);
    
    const { endpointPath, body, responseStyle } = buildMimoRequest(args, options);
    const response = await postMimoRequest(body, endpointPath, options);
    const summary = resultTextFromResponse(response, responseStyle);
    const artifactPath = writeTaskArtifact({ args, body, response, summary, responseStyle }, env);
    return buildSuccessResult({ args, body, response, summary, artifactPath, responseStyle });
  } catch (error) {
    return buildErrorResult(error);
  }
}

export async function handleMimoPowerMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildMimoPowerTools() };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    if (name === 'analyze') {
      return await callAnalyze(params.arguments || {}, options);
    }
    return buildErrorResult(new MimoPowerError('UNKNOWN_TOOL', `UNKNOWN_TOOL: ${name}`));
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
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`);
}

export function runMimoPowerMcpServer(options = {}) {
  const logger = options.logger || {
    error: (message) => process.stderr.write(`${message}\n`),
  };
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
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
      const result = await handleMimoPowerMcpRequest(request, options);
      writeJsonRpcResponse(request.id, result);
    } catch (error) {
      logger.error?.(`mimo_power MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMimoPowerMcpServer();
}
