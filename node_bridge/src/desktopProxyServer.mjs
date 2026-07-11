import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleIncomingMessage } from './channelHub.mjs';

export function getDesktopProxyConfig(env = process.env) {
  return {
    enabled: String(env.DESKTOP_PROXY_ENABLED || 'false').trim().toLowerCase() === 'true',
    host: String(env.DESKTOP_PROXY_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Math.max(1, Number.parseInt(String(env.DESKTOP_PROXY_PORT || '8650'), 10) || 8650),
    apiKey: String(env.DESKTOP_PROXY_API_KEY || '').trim(),
    defaultClientId: String(env.DESKTOP_PROXY_DEFAULT_CLIENT_ID || 'desktop-local').trim() || 'desktop-local',
  };
}

export function createDesktopProxyServer(options = {}) {
  const env = options.env || process.env;
  const config = { ...getDesktopProxyConfig(env), ...(options.config || {}) };
  const channelHub = options.channelHub || handleIncomingMessage;
  async function handleRequest(req) {
    if (!hasValidBinding(config)) {
      return jsonResponse(config.apiKey ? 403 : 401, { error: { message: config.apiKey ? 'Desktop proxy binding is not allowed' : 'Authentication is required', type: 'authentication_error' } });
    }
    if (!isAuthorized(req, config)) {
      return jsonResponse(401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return jsonResponse(200, {
        object: 'list',
        data: [
          { id: 'ran-agent', object: 'model', owned_by: 'ran-agent' },
          { id: 'ran-assistant-lite', object: 'model', owned_by: 'ran-agent' },
          { id: 'ran-assistant', object: 'model', owned_by: 'ran-agent' },
        ],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = typeof req.json === 'function' ? await req.json() : await readJsonBody(req);
      if (body.stream === true) {
        return jsonResponse(400, { error: { message: 'stream=true is not supported by ran-agent desktop proxy yet', type: 'invalid_request_error' } });
      }
      const identity = authenticatedDesktopIdentity(config);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
      const current = lastUserIndex >= 0 ? messages[lastUserIndex] : messages.at(-1);
      const priorMessages = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : messages.slice(0, -1);
      const normalized = {
        id: firstHeader(req.headers, 'x-request-id') || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform: 'desktop',
        channel_type: 'desktop',
        conversation_id: identity,
        sender_id: identity,
        text: extractOpenAiText(current?.content),
        prior_messages: priorMessages.map((message) => ({ role: message.role, content: extractOpenAiText(message.content) })).filter((message) => message.content),
        raw_event_meta: {
          model: body.model || 'ran-agent',
          request_id: firstHeader(req.headers, 'x-request-id') || '',
        },
        created_at: Date.now(),
      };
      const reply = await channelHub(normalized, {
        env,
        logger: options.logger || console,
        outbox: options.outbox,
        ...(options.outbox ? { adapter: createDesktopResponseAdapter() } : {}),
      });
      return jsonResponse(200, openAiResponseFromReply(reply, { model: body.model || 'ran-agent' }));
    }
    return jsonResponse(404, { error: { message: 'Not found', type: 'invalid_request_error' } });
  }
  return { handleRequest, config };
}

export function startDesktopProxyServer(options = {}) {
  const env = options.env || process.env;
  const config = { ...getDesktopProxyConfig(env), ...(options.config || {}) };
  const logger = options.logger || console;
  if (!config.enabled) {
    logger.info?.('[desktop-proxy] disabled');
    return null;
  }
  if (!hasValidBinding(config)) {
    logger.error?.('[desktop-proxy] refused invalid authentication binding');
    return null;
  }
  const app = createDesktopProxyServer({ ...options, config });
  const server = http.createServer(async (req, res) => {
    try {
      const response = await app.handleRequest(req);
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
    }
  });
  server.listen(config.port, config.host, () => {
    logger.log?.(`[desktop-proxy] listening host=${config.host} port=${config.port}`);
  });
  return server;
}

export function openAiResponseFromReply(reply = {}, { model = 'ran-agent' } = {}) {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: String(reply.replyText || reply.reply_text || ''),
        },
        finish_reason: 'stop',
      },
    ],
  };
}

function jsonResponse(status, body) {
  return { status, body };
}

function isAuthorized(req, config) {
  if (!config.apiKey) return false;
  const header = firstHeader(req.headers, 'authorization');
  const expected = Buffer.from(`Bearer ${config.apiKey}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasValidBinding(config) {
  if (!config.apiKey) return false;
  return isLoopbackHost(config.host) || Buffer.byteLength(config.apiKey, 'utf8') >= 32;
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === 'localhost' || value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function authenticatedDesktopIdentity(config) {
  return `desktop:${createHash('sha256').update(config.apiKey, 'utf8').digest('hex').slice(0, 32)}`;
}

function createDesktopResponseAdapter() {
  return {
    async sendReply() {
      // HTTP bytes are written only after ChannelHub returns.  Without a finish
      // callback we retain an honest ambiguous delivery instead of a false sent.
      return {
        textStatus: 'ambiguous',
        attachments: [],
        adapterReceiptRef: 'desktop:http-response-boundary',
      };
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function firstHeader(headers = {}, name) {
  const direct = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || '').trim();
  return String(direct || '').trim();
}

function extractOpenAiText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}
