/**
 * Reply backend selector for Hermes chat mainline.
 */

import { getBackendIngestConfig, ingestExchangeToBackend } from './backendIngestClient.mjs';
import { getHermesGatewayConfig, sendChatToHermesGateway } from './hermesGatewayClient.mjs';

export function getReplyBackendConfig(env = process.env) {
  return {
    replyBackend: 'hermes',
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 personal agent，请稍后再试。',
  };
}

export function createReplyBackend(options = {}) {
  const env = options.env || process.env;
  const config = getReplyBackendConfig(env);

  return {
    async getReply(message, backendOptions = {}) {
      const gatewayConfig = backendOptions.hermesConfig || getHermesGatewayConfig(env);
      const chatImpl = options.hermesImpl || options.chatImpl || sendChatToHermesGateway;
      const response = await chatImpl(
        {
          text: message.text,
          sender_id: message.sender_id,
          channel: 'wechat',
          route_hint: message.route_hint || '',
          message_batch: Array.isArray(message.message_batch) ? message.message_batch : [],
          image_urls: Array.isArray(message.image_urls) ? message.image_urls : [],
          media: normalizeMediaItems(message.media),
        },
        {
          config: gatewayConfig,
          fetchImpl: backendOptions.fetchImpl,
          execFileImpl: backendOptions.execFileImpl,
          env,
          logger: options.logger || console,
          mediaContextOptions: backendOptions.mediaContextOptions,
        }
      );

      const ingestConfig = backendOptions.ingestConfig || getBackendIngestConfig(env);
      const ingest = options.ingestImpl || ingestExchangeToBackend;
      const ingestPayload = {
        channel: 'wechat',
        sender_id: message.sender_id,
        user_text: message.text,
        reply_text: response.reply_text,
        source: 'hermes',
        image_urls: Array.isArray(message.image_urls)
          ? message.image_urls.filter((item) => typeof item === 'string' && item.trim())
          : [],
        media: normalizeMediaItems(message.media),
      };
      // Debug log for multimedia sync
      const logger = options.logger || console;
      logger.log?.(`[ingest] sender_id=${ingestPayload.sender_id} text_length=${ingestPayload.user_text?.length || 0} image_urls_count=${ingestPayload.image_urls?.length || 0} media_count=${ingestPayload.media?.length || 0}`);
      if (ingestPayload.media?.length > 0) {
        logger.log?.(`[ingest] media items: ${JSON.stringify(ingestPayload.media.map(m => ({ type: m.type, mimeType: m.mimeType, filePath: m.filePath?.substring(0, 50) })))}`);
      }
      try {
        await ingest(ingestPayload, {
          config: ingestConfig,
          fetchImpl: backendOptions.fetchImpl,
        });
        logger.log?.(`[ingest] success`);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        logger.warn?.(`backend ingest skipped: ${messageText}`);
      }

      const mediaFromMarker = extractTrustedMediaMarker(response.reply_text);
      const responseMedia = response.media && typeof response.media === 'object'
        ? response.media
        : mediaFromMarker?.media || null;
      const responseText = responseMedia && mediaFromMarker?.media
        ? mediaFromMarker.text
        : response.reply_text;

      return {
        replyText: responseText,
        followUpMessages: Array.isArray(response.follow_up_messages) ? response.follow_up_messages : [],
        media: responseMedia,
        source: 'hermes',
      };
    },
    config,
  };
}

function extractTrustedMediaMarker(text) {
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
  const cleanedText = raw
    .replace(markerPattern, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text: cleanedText,
    media: fileName ? { type, url, fileName } : { type, url },
  };
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
