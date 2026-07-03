import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

import { normalizeManifest } from './registry.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function probeExternalMcpServer(input = {}, options = {}) {
  if (options.signal?.aborted) return abortedResult();
  try {
    const client = await createMcpHttpClient(input, options);
    const init = await client.initialize();
    await client.initialized();
    const listed = await client.listTools();
    return {
      ok: true,
      protocolVersion: init.protocolVersion,
      upstreamSessionId: client.sessionId,
      notifications: client.notifications,
      manifest: normalizeManifest({
        id: input.serverId || input.id,
        title: input.title || init.serverInfo?.name || input.serverId || input.id,
        source: input.source || '',
        version: input.version || init.serverInfo?.version || '',
        transport: normalizeTransport(input.transport),
        url: input.url,
        activityKind: input.activityKind || input.activity_kind || input.kind || '',
        tools: listed.tools || [],
      }),
    };
  } catch (error) {
    return errorResult(error);
  }
}

export async function callExternalMcpTool(input = {}, options = {}) {
  if (options.signal?.aborted) return abortedResult();
  try {
    const client = await createMcpHttpClient(input, options);
    await client.initialize();
    await client.initialized();
    const result = await client.callTool(input.toolName || input.tool_name, input.arguments || {});
    return {
      ok: true,
      result,
      upstreamSessionId: client.sessionId,
      notifications: client.notifications,
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function createMcpHttpClient(input, options) {
  const transport = normalizeTransport(input.transport);
  if (transport === 'sse') {
    const url = await resolveLegacySseEndpoint(input.url, options);
    await assertMcpUrlAllowed(url, options);
    return new McpHttpClient({ ...input, url, transport: 'streamable-http' }, options);
  }
  await assertMcpUrlAllowed(input.url, options);
  return new McpHttpClient(input, options);
}

class McpHttpClient {
  constructor(input = {}, options = {}) {
    this.url = normalizeUrl(input.url, options);
    this.fetchImpl = options.fetchImpl || createSafeFetch({ lookupImpl: options.lookupImpl });
    this.lookupImpl = options.lookupImpl;
    this.timeoutMs = normalizePositiveInt(options.timeoutMs || input.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.parentSignal = options.signal || null;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
    this.sessionId = '';
    this.nextId = 1;
    this.notifications = [];
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is unavailable for external MCP executor');
    }
  }

  async initialize() {
    const response = await this.post('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ran-agent-external-mcp-gateway', version: '0.1.0' },
    });
    this.protocolVersion = response.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    return response;
  }

  async initialized() {
    await this.post('notifications/initialized', {}, { notification: true });
  }

  async listTools() {
    return await this.post('tools/list', {});
  }

  async callTool(name, args) {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('toolName is required');
    return await this.post('tools/call', { name: toolName, arguments: args && typeof args === 'object' ? args : {} });
  }

  async post(method, params = {}, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++;
    const payload = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params };
    const response = await fetchWithRedirects(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: makeTimeoutSignal(this.parentSignal, this.timeoutMs),
      redirect: 'manual',
    }, {
      fetchImpl: this.fetchImpl,
      urlSafetyOptions: {
        skipUrlSafety: false,
        lookupImpl: this.lookupImpl,
      },
    });
    const sessionId = response.headers?.get?.('mcp-session-id') || response.headers?.get?.('MCP-Session-Id') || '';
    if (sessionId) this.sessionId = sessionId;
    if (notification && [200, 202, 204].includes(response.status)) return null;
    const decoded = await decodeMcpResponse(response, id);
    this.notifications.push(...decoded.notifications);
    return decoded.result;
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
    };
    if (this.sessionId) headers['MCP-Session-Id'] = this.sessionId;
    return headers;
  }
}

async function fetchWithRedirects(url, init, { fetchImpl, redirectsLeft = 3, urlSafetyOptions = {} } = {}) {
  const response = await fetchImpl(url, init);
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  if (redirectsLeft <= 0) throw new Error('external MCP redirect limit exceeded');
  const location = response.headers?.get?.('location') || '';
  const nextUrl = new URL(location, url).toString();
  await assertMcpUrlAllowed(nextUrl, urlSafetyOptions);
  return await fetchWithRedirects(nextUrl, init, { fetchImpl, redirectsLeft: redirectsLeft - 1, urlSafetyOptions });
}

async function decodeMcpResponse(response, expectedId) {
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`external MCP HTTP ${response.status}`);
    error.code = response.status === 404 ? 'EXTERNAL_MCP_SESSION_LOST' : 'EXTERNAL_MCP_HTTP_ERROR';
    throw error;
  }
  const contentType = response.headers?.get?.('content-type') || '';
  const messages = contentType.includes('text/event-stream')
    ? parseSseMessages(text)
    : [parseJsonMessage(text)];
  const notifications = messages.filter((item) => item?.method && item.id === undefined);
  const responseMessage = messages.find((item) => item && item.id === expectedId) || messages.find((item) => item?.result || item?.error);
  if (!responseMessage) return { result: {}, notifications };
  if (responseMessage.error) {
    const error = new Error(String(responseMessage.error.message || 'external MCP JSON-RPC error'));
    error.code = String(responseMessage.error.code || 'EXTERNAL_MCP_JSONRPC_ERROR');
    throw error;
  }
  return { result: responseMessage.result || {}, notifications };
}

function parseSseMessages(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map((event) => event.split(/\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map(parseJsonMessage)
    .filter(Boolean);
}

function parseJsonMessage(text) {
  try {
    const parsed = JSON.parse(String(text || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveLegacySseEndpoint(url, options = {}) {
  await assertMcpUrlAllowed(url, options);
  const safeUrl = normalizeUrl(url, options);
  const fetchImpl = options.fetchImpl || createSafeFetch({ lookupImpl: options.lookupImpl });
  const signal = makeTimeoutSignal(options.signal || null, normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  const response = await fetchWithRedirects(safeUrl, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal,
    redirect: 'manual',
  }, {
    fetchImpl,
    urlSafetyOptions: {
      skipUrlSafety: false,
      lookupImpl: options.lookupImpl,
    },
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`legacy SSE HTTP ${response.status}`);
  const endpoint = await readSseEndpoint(response, signal);
  if (!endpoint) throw new Error('legacy SSE endpoint event missing');
  return new URL(endpoint, safeUrl).toString();
}

async function readSseEndpoint(response, signal) {
  if (!response.body?.getReader) {
    const body = await response.text();
    return parseSseEndpoint(body);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (body.length < 65_536) {
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      const endpoint = parseSseEndpoint(body);
      if (endpoint) {
        await reader.cancel().catch(() => {});
        return endpoint;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return parseSseEndpoint(body);
}

async function readChunkWithAbort(reader, signal) {
  if (signal?.aborted) throw abortError();
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener?.('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal?.removeEventListener?.('abort', onAbort);
    });
  });
}

function parseSseEndpoint(text) {
  const events = String(text || '').split(/\n\n+/);
  for (const event of events) {
    if (!/^event:\s*endpoint/im.test(event)) continue;
    const data = event.split(/\n/).find((line) => line.startsWith('data:'));
    if (data) return data.slice(5).trim();
  }
  return '';
}

function normalizeUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('external MCP URL is required');
  }
  if (options.skipUrlSafety === true) return parsed.toString();
  if (parsed.protocol !== 'https:') throw new Error('external MCP URL must use HTTPS');
  if (isBlockedHostname(parsed.hostname)) throw new Error('external MCP URL host is denied');
  if (net.isIP(parsed.hostname) && isBlockedIp(parsed.hostname)) throw new Error('external MCP URL IP is denied');
  return parsed.toString();
}

async function assertMcpUrlAllowed(value, options = {}) {
  const parsed = new URL(normalizeUrl(value, options));
  if (options.skipUrlSafety === true) return { url: parsed.toString(), hostname: parsed.hostname, address: '', family: 0 };
  const literalIp = net.isIP(parsed.hostname) ? parsed.hostname : '';
  if (literalIp) {
    if (isBlockedIp(literalIp)) throw new Error('external MCP URL IP is denied');
    return { url: parsed.toString(), hostname: parsed.hostname, address: literalIp, family: net.isIP(literalIp) };
  }
  const records = await lookupHost(parsed.hostname, options.lookupImpl);
  if (records.length === 0 || records.some((item) => isBlockedIp(item.address))) {
    throw new Error('external MCP URL DNS/SSRF check denied');
  }
  const selected = records[0];
  return {
    url: parsed.toString(),
    hostname: parsed.hostname,
    address: selected.address,
    family: selected.family || net.isIP(selected.address),
  };
}

function createSafeFetch(urlSafetyOptions = {}) {
  return async (url, init = {}) => {
    const allowed = await assertMcpUrlAllowed(url, urlSafetyOptions);
    return await httpsFetchPinned(allowed, init);
  };
}

async function httpsFetchPinned(allowed, init = {}) {
  const parsed = new URL(allowed.url);
  if (parsed.protocol !== 'https:') throw new Error('external MCP URL must use HTTPS');
  if (!allowed.address) throw new Error('external MCP URL DNS/SSRF check denied');
  return await new Promise((resolve, reject) => {
    let settled = false;
    let responseStream = null;
    const request = https.request({
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method || 'GET',
      headers: headersToObject(init.headers),
      servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
      lookup: pinnedLookup(allowed),
    }, (res) => {
      responseStream = res;
      res.once('end', cleanup);
      res.once('close', cleanup);
      settled = true;
      resolve(new Response(Readable.toWeb(res), {
        status: res.statusCode || 500,
        statusText: res.statusMessage || '',
        headers: responseHeaders(res.headers),
      }));
    });
    const onAbort = () => {
      const error = abortError();
      request.destroy(error);
      responseStream?.destroy?.(error);
      if (!settled) reject(error);
    };
    function cleanup() {
      init.signal?.removeEventListener?.('abort', onAbort);
    }
    request.once('error', (error) => {
      cleanup();
      if (!settled) reject(error);
    });
    if (init.signal?.aborted) {
      onAbort();
      return;
    }
    init.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

function pinnedLookup(allowed) {
  const family = Number(allowed.family) || net.isIP(allowed.address) || 4;
  return (_hostname, opts, callback) => {
    process.nextTick(() => {
      if (opts?.all) {
        callback(null, [{ address: allowed.address, family }]);
        return;
      }
      callback(null, allowed.address, family);
    });
  };
}

function headersToObject(headers) {
  const output = {};
  for (const [key, value] of new Headers(headers || {}).entries()) output[key] = value;
  return output;
}

function responseHeaders(headers) {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, String(item));
    } else if (value !== undefined) {
      output.set(key, String(value));
    }
  }
  return output;
}

async function lookupHost(hostname, lookupImpl) {
  if (typeof lookupImpl === 'function') {
    const records = await lookupImpl(hostname);
    return normalizeLookupRecords(records);
  }
  return normalizeLookupRecords(await dns.lookup(hostname, { all: true, verbatim: true }));
}

function normalizeLookupRecords(records) {
  const list = Array.isArray(records) ? records : records ? [records] : [];
  return list
    .map((item) => (typeof item === 'string' ? { address: item } : item))
    .filter((item) => item && typeof item.address === 'string' && item.address.trim());
}

function makeTimeoutSignal(parentSignal, timeoutMs) {
  if (parentSignal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(abortError('external MCP request timed out')), timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort(abortError());
  parentSignal?.addEventListener?.('abort', abort, { once: true });
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timeout);
    parentSignal?.removeEventListener?.('abort', abort);
  }, { once: true });
  return controller.signal;
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error || 'external MCP executor error');
  if (error?.name === 'AbortError' || /abort|timed out/i.test(message)) return abortedResult(message);
  return { ok: false, error: message, error_code: error?.code || 'EXTERNAL_MCP_EXECUTOR_ERROR' };
}

function abortedResult(message = 'external MCP request aborted') {
  return { ok: false, error: message, error_code: 'EXTERNAL_MCP_ABORTED' };
}

function abortError(message = 'external MCP request aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function normalizeTransport(value) {
  const text = String(value || 'streamable-http').trim().toLowerCase();
  return text === 'http' ? 'streamable-http' : text;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isBlockedHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return !normalized
    || normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.lan');
}

function isBlockedIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return isBlockedIpv4(address);
  }
  if (version === 6) {
    const lower = String(address || '').toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return lower === '::1'
      || lower === '::'
      || lower.startsWith('fe80:')
      || lower.startsWith('fc')
      || lower.startsWith('fd')
      || (mapped ? isBlockedIpv4(mapped[1]) : false);
  }
  return true;
}

function isBlockedIpv4(address) {
  const [a, b] = String(address).split('.').map((item) => Number.parseInt(item, 10));
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}
