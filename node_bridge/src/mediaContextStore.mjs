import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { handleMediaReaderMcpRequest } from './mediaReaderMcpServer.mjs';
import {
  isPathInsideRoot,
  isTrustedLocalMediaPath,
  resolveProjectRoot,
} from './trustedMediaPaths.mjs';

const MAX_RENDERED_ARTIFACTS = 5;
const MAX_RENDERED_FIELD_CHARS = 1400;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256FileOrValue(filePath, env = process.env) {
  if (!isTrustedLocalMediaPath(filePath, env)) {
    return '';
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    }
  } catch {
    // The bridge can still preserve a stable reference if the media file is gone.
  }
  return sha256Hex(String(filePath || ''));
}

function safeToken(value, fallback = 'default') {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120)
    || fallback;
}

function stateDir(env = process.env, options = {}) {
  const configured = String(env.PERSONAL_AGENT_MEDIA_CONTEXT_DIR || '').trim();
  const root = resolveProjectRoot(env);
  const resolved = configured
    ? (path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(root, configured))
    : path.join(root, 'debug', 'media_context');
  if (!isPathInsideRoot(resolved, root)) {
    throw new Error(`MEDIA_CONTEXT_DIR_BLOCKED: media context dir must stay inside project workspace: ${root}`);
  }
  if (options.ensure === true) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function conversationStatePath(conversationId, env = process.env) {
  return path.join(stateDir(env), 'conversations', `${safeToken(conversationId)}.json`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function inferMediaType({ explicit = '', mime = '', source = '' } = {}) {
  const normalized = String(explicit || '').trim().toLowerCase();
  if (['image', 'audio', 'video', 'document', 'file'].includes(normalized)) {
    return normalized;
  }
  const lowerMime = String(mime || '').trim().toLowerCase();
  if (lowerMime.startsWith('image/')) return 'image';
  if (lowerMime.startsWith('audio/')) return 'audio';
  if (lowerMime.startsWith('video/')) return 'video';
  const lowerSource = String(source || '').trim().toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic)(\?|$)/.test(lowerSource)) return 'image';
  if (/\.(wav|mp3|m4a|aac|flac|ogg|oga)(\?|$)/.test(lowerSource)) return 'audio';
  if (/\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/.test(lowerSource)) return 'video';
  return 'file';
}

function normalizeMediaItems(media, env = process.env) {
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
      if (!filePath || !isTrustedLocalMediaPath(filePath, env)) {
        return null;
      }
      const resolvedPath = path.resolve(filePath);
      const mime = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
      const type = inferMediaType({ explicit: item.type, mime, source: resolvedPath });
      const contentHash = sha256FileOrValue(resolvedPath, env);
      return {
        id: `media-${contentHash.slice(0, 16)}`,
        type,
        mime,
        path: resolvedPath,
        content_hash: contentHash,
        source: 'wechat_media',
      };
    })
    .filter(Boolean);
}

function normalizeImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls)) {
    return [];
  }
  return imageUrls
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(isRemoteMediaUrl)
    .map((url) => {
      const hash = sha256Hex(url);
      return {
        id: `media-${hash.slice(0, 16)}`,
        type: 'image',
        mime: '',
        url,
        content_hash: hash,
        source: 'wechat_image_url',
      };
    });
}

function isRemoteMediaUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

export function collectInboundMediaAssets(payload = {}, options = {}) {
  const seen = new Set();
  const env = options.env || process.env;
  const assets = [...normalizeMediaItems(payload.media, env), ...normalizeImageUrls(payload.image_urls)]
    .filter((asset) => {
      const key = asset.path || asset.url || asset.id;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return assets.map((asset, index) => ({
    ...asset,
    ordinal: index + 1,
    created_at: new Date().toISOString(),
  }));
}

function defaultState(conversationId) {
  return {
    version: 1,
    conversation_id: conversationId,
    media_assets: [],
    artifacts: [],
    refs: [],
    updated_at: new Date().toISOString(),
  };
}

function loadConversationState(conversationId, env) {
  const loaded = readJson(conversationStatePath(conversationId, env));
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return defaultState(conversationId);
  }
  return {
    ...defaultState(conversationId),
    ...loaded,
    media_assets: Array.isArray(loaded.media_assets) ? loaded.media_assets : [],
    artifacts: Array.isArray(loaded.artifacts) ? loaded.artifacts : [],
    refs: Array.isArray(loaded.refs) ? loaded.refs : [],
  };
}

function saveConversationState(state, env) {
  // Prune expired artifacts before saving
  const now = Date.now();
  if (Array.isArray(state.artifacts)) {
    state.artifacts = state.artifacts.filter((artifact) => {
      if (artifact.ok === false) return false;
      if (artifact.created_at) {
        const createdMs = Date.parse(artifact.created_at);
        if (Number.isFinite(createdMs) && (now - createdMs) > ARTIFACT_TTL_MS) return false;
      }
      return true;
    });
  }
  writeJson(conversationStatePath(state.conversation_id, env), {
    ...state,
    updated_at: new Date().toISOString(),
  });
}

function summaryFromMediaReaderPayload(payload = {}) {
  return String(
    payload.overall_summary
    || payload.scene_summary
    || payload.visual_summary
    || payload.audio_summary
    || payload.transcript
    || payload.ocr_text
    || ''
  ).trim();
}

async function callMediaReaderAnalyze(toolName, args, options = {}) {
  if (options.mediaReaderAnalyzeImpl) {
    return await options.mediaReaderAnalyzeImpl({ toolName, args });
  }
  return await handleMediaReaderMcpRequest(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    options
  );
}

async function analyzeWithMediaReader(asset, options = {}) {
  const toolName = asset.type === 'audio'
    ? 'transcribe_audio'
    : asset.type === 'video'
      ? 'analyze_video'
      : 'analyze_image';
  const source = asset.url
    ? { url: asset.url }
    : asset.path
      ? { file_path: asset.path, mime: asset.mime }
      : {};
  if (!source.url && !source.file_path) {
    return null;
  }
  const args = toolName === 'analyze_image'
    ? { ...source, ocr: true, vlm: true }
    : toolName === 'analyze_video'
      ? { ...source, include_audio: true, include_ocr: false, include_vlm: false }
      : source;
  const result = await callMediaReaderAnalyze(toolName, args, options);
  const payload = result.structuredContent || {};
  return {
    ok: payload.ok !== false && result.isError !== true,
    analyzer: 'media_reader',
    summary: summaryFromMediaReaderPayload(payload),
    ocr_text: payload.ocr_text || '',
    transcript: payload.transcript || payload.asr?.transcript || '',
    keyframes: Array.isArray(payload.frames) ? payload.frames : [],
    provider_ref: JSON.stringify(payload.model || {}),
    error_code: payload.error_code || '',
    raw: payload,
  };
}

async function defaultAnalyzeMediaAsset({ asset, payload }, options = {}) {
  const fallback = await analyzeWithMediaReader(asset, options);
  if (fallback) {
    return fallback;
  }
  return {
    ok: false,
    analyzer: 'media_reader',
    summary: '',
    error_code: 'MEDIA_ANALYSIS_UNAVAILABLE',
    error: 'no available media analyzer',
  };
}

function normalizeArtifact({ asset, analysis }) {
  const createdAt = new Date().toISOString();
  const artifactId = `artifact-${sha256Hex(JSON.stringify({
    media_id: asset.id,
    analyzer: analysis.analyzer,
    summary: analysis.summary,
    artifact_path: analysis.artifact_path,
    created_at: createdAt,
  })).slice(0, 16)}`;
  return {
    id: artifactId,
    media_id: asset.id,
    type: asset.type,
    analyzer: analysis.analyzer || 'media_reader',
    ok: analysis.ok !== false,
    summary: String(analysis.summary || ''),
    ocr_text: String(analysis.ocr_text || ''),
    transcript: String(analysis.transcript || ''),
    keyframes: Array.isArray(analysis.keyframes) ? analysis.keyframes.slice(0, 6) : [],
    artifact_path: '',
    source_artifact_path: String(analysis.artifact_path || ''),
    expires_at: String(analysis.expires_at || ''),
    provider_ref: String(analysis.provider_ref || ''),
    error_code: String(analysis.error_code || ''),
    fallback_from: String(analysis.fallback_from || ''),
    created_at: createdAt,
  };
}

function writeMediaArtifactFile(artifact, analysis = {}, env = process.env) {
  const artifactDir = path.join(stateDir(env, { ensure: true }), 'artifacts');
  const artifactPath = path.join(artifactDir, `${artifact.id}.json`);
  try {
    writeJson(artifactPath, {
      ...artifact,
      raw: analysis.raw || undefined,
    });
    return {
      ...artifact,
      artifact_path: artifactPath,
    };
  } catch {
    return artifact;
  }
}

function mergeAsset(state, asset) {
  if (!state.media_assets.some((item) => item.id === asset.id)) {
    state.media_assets.push(asset);
  }
}

function updateRef(state, asset, artifact) {
  const now = new Date().toISOString();
  state.refs = state.refs.filter((item) => item.media_id !== asset.id);
  state.refs.push({
    conversation_id: state.conversation_id,
    media_id: asset.id,
    artifact_id: artifact?.id || '',
    aliases: aliasesForAsset(asset),
    last_injected_at: now,
  });
}

function aliasesForAsset(asset) {
  if (asset.type === 'image') {
    return asset.ordinal === 1 ? ['刚才那张图', '第一张截图'] : [`第${asset.ordinal}张图`];
  }
  if (asset.type === 'audio') {
    return asset.ordinal === 1 ? ['刚才那段语音', '第一段语音'] : [`第${asset.ordinal}段语音`];
  }
  if (asset.type === 'video') {
    return asset.ordinal === 1 ? ['刚才那个视频', '第一个视频'] : [`第${asset.ordinal}个视频`];
  }
  return asset.ordinal === 1 ? ['刚才那个文件', '第一个文件'] : [`第${asset.ordinal}个文件`];
}

function findReusableArtifact(state, asset) {
  return [...state.artifacts]
    .reverse()
    .find((artifact) => artifact.media_id === asset.id && artifact.ok !== false);
}

const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function latestArtifacts(state, limit = MAX_RENDERED_ARTIFACTS) {
  const now = Date.now();
  return [...state.artifacts]
    .filter((artifact) => {
      if (artifact.ok === false) return false;
      // Time-based expiration: discard artifacts older than TTL
      if (artifact.created_at) {
        const createdMs = Date.parse(artifact.created_at);
        if (Number.isFinite(createdMs) && (now - createdMs) > ARTIFACT_TTL_MS) {
          return false;
        }
      }
      return true;
    })
    .slice(-limit)
    .reverse();
}

function compactText(value, maxChars = MAX_RENDERED_FIELD_CHARS) {
  const text = String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 20).trim()}...(truncated)`;
}

function refForArtifact(refs = [], artifact) {
  return refs.find((item) => item.artifact_id === artifact.id || item.media_id === artifact.media_id) || null;
}

export function renderConversationMediaContext(state = {}) {
  const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  if (artifacts.length === 0) {
    return '';
  }
  const refs = Array.isArray(state.refs) ? state.refs : [];
  const lines = [
    '【最近媒体上下文（非用户原话，不要复述机制）】',
    '下面是本会话近期媒体的稳定分析产物。回答“刚才那张图/那段语音/那个视频”等指代时优先参考这些 artifact，而不是要求用户重发原始媒体。',
  ];
  for (const artifact of artifacts.slice(0, MAX_RENDERED_ARTIFACTS)) {
    const ref = refForArtifact(refs, artifact);
    const aliases = Array.isArray(ref?.aliases) ? ref.aliases.join('/') : '';
    lines.push([
      `- artifact_id=${artifact.id}`,
      `media_id=${artifact.media_id}`,
      `type=${artifact.type}`,
      `analyzer=${artifact.analyzer}`,
      aliases ? `aliases=${aliases}` : '',
    ].filter(Boolean).join(' '));
    if (artifact.summary) {
      lines.push(`  summary: ${compactText(artifact.summary)}`);
    }
    if (artifact.fallback_from) {
      lines.push(`  fallback_from=${artifact.fallback_from}`);
    }
    if (artifact.error_code) {
      lines.push(`  error_code=${artifact.error_code}`);
    }
    if (artifact.ocr_text) {
      lines.push(`  ocr_text: ${compactText(artifact.ocr_text, 800)}`);
    }
    if (artifact.transcript) {
      lines.push(`  transcript: ${compactText(artifact.transcript)}`);
    }
    if (Array.isArray(artifact.keyframes) && artifact.keyframes.length > 0) {
      const frameText = artifact.keyframes
        .map((frame, index) => frame?.summary || frame?.ocr_text || frame?.text || `frame ${index + 1}`)
        .filter(Boolean)
        .slice(0, 4)
        .join(' | ');
      if (frameText) {
        lines.push(`  keyframes: ${compactText(frameText)}`);
      }
    }
  }
  return lines.join('\n');
}

export async function ensureConversationMediaContext(payload = {}, options = {}) {
  const env = options.env || process.env;
  const conversationId = String(payload.sender_id || payload.conversation_id || payload.user || 'wechat').trim() || 'wechat';
  const state = loadConversationState(conversationId, env);
  const assets = collectInboundMediaAssets(payload, { env });
  const analyze = options.analyzeMediaAssetImpl || defaultAnalyzeMediaAsset;
  const currentArtifacts = [];

  if (assets.length === 0) {
    const artifactsForContext = latestArtifacts(state);
    return {
      assets,
      artifacts: artifactsForContext,
      state,
      contextText: renderConversationMediaContext({
        artifacts: artifactsForContext,
        refs: state.refs,
      }),
    };
  }

  for (const asset of assets) {
    mergeAsset(state, asset);
    let artifact = findReusableArtifact(state, asset);
    if (!artifact) {
      let analysis;
      try {
        analysis = await analyze({ asset, payload }, options);
      } catch (error) {
        analysis = {
          ok: false,
          analyzer: 'media_reader',
          summary: '',
          error_code: 'MEDIA_ANALYSIS_FAILED',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      artifact = writeMediaArtifactFile(
        normalizeArtifact({ asset, analysis }),
        analysis,
        env
      );
      state.artifacts.push(artifact);
    }
    updateRef(state, asset, artifact);
    currentArtifacts.push(artifact);
  }

  try {
    saveConversationState(state, env);
  } catch (error) {
    options.logger?.warn?.(`failed to save media context: ${error instanceof Error ? error.message : String(error)}`);
  }

  const artifactsForContext = currentArtifacts.length > 0 ? currentArtifacts : latestArtifacts(state);
  return {
    assets,
    artifacts: artifactsForContext,
    state,
    contextText: renderConversationMediaContext({
      artifacts: artifactsForContext,
      refs: state.refs,
    }),
  };
}
