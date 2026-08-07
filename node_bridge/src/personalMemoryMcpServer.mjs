#!/usr/bin/env node
import readline from 'node:readline';

const SERVER_INFO = {
  name: 'ran-agent-personal-memory',
  version: '0.1.0',
};

function backendBaseUrl(env = process.env) {
  return String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').trim().replace(/\/$/, '');
}

function backendTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(String(env.PERSONAL_MEMORY_BACKEND_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function buildErrorResult(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: String(message || 'tool failed'),
      },
    ],
    structuredContent: {
      ok: false,
      error: String(message || 'tool failed'),
    },
  };
}

function buildRecallResult(payload = {}) {
  const renderedContext = String(payload.rendered_context || '').trim();
  const usedSources = Array.isArray(payload.used_sources) ? payload.used_sources.map(String) : [];
  const sourceStatus = payload.source_status && typeof payload.source_status === 'object' && !Array.isArray(payload.source_status)
    ? Object.fromEntries(Object.entries(payload.source_status).map(([key, value]) => [String(key), String(value)]))
    : {};
  const result = {
    ok: true,
    should_inject: payload.should_inject === true,
    rendered_context: renderedContext,
    used_sources: usedSources,
    source_status: sourceStatus,
    injection_level: String(payload.injection_level || ''),
    short_term_memories: Array.isArray(payload.short_term_memories) ? payload.short_term_memories : [],
    long_term_memories: Array.isArray(payload.long_term_memories) ? payload.long_term_memories : [],
    core_memories: Array.isArray(payload.core_memories) ? payload.core_memories : [],
    knowledge_hits: Array.isArray(payload.knowledge_hits) ? payload.knowledge_hits : [],
  };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

export function buildPersonalMemoryTools() {
  return [
    {
      name: 'check_personal_memory_backend',
      title: 'Check Personal Memory Backend',
      description: 'Check whether the local Python backend is reachable for personal memory operations. Does not read or write memory.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'recall_personal_memory',
      title: 'Recall Personal Memory',
      description: [
        'Read-only recall from the local personal memory backend, including Ombre, SQLite working/profile memory, and bounded Vault knowledge.',
        'Use when prior preferences, commitments, relationship context, unresolved emotional state, or long-term memory may affect the reply.',
        'Do not use when the current conversation context is already enough. If recall is weak or empty, say you are not sure rather than inventing memory.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The memory question or natural-language clue to recall.',
          },
          response_mode: {
            type: 'string',
            description: 'Optional response mode hint such as chat or casual_chat.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'surface_relevant_context',
      title: 'Surface Relevant Context',
      description: [
        'Read-only lightweight context surfacing for Hermes.',
        'Use when the current topic, hobby, project, person, artifact, or recurring theme seems familiar from prior conversations, even if the user did not explicitly ask to search memory.',
        'Return only bounded personal-memory and vault-knowledge clues; weave them naturally into the reply without saying you searched or exposing internal sources.',
        'If recall is weak or empty, continue from the current conversation and do not invent continuity.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The natural-language topic or clue that may connect to prior memory or vault knowledge.',
          },
          response_mode: {
            type: 'string',
            description: 'Optional response mode hint such as chat or casual_chat.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

async function recallPersonalMemory(args = {}, options = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    return buildErrorResult('recall_personal_memory requires query');
  }
  const responseMode = String(args.response_mode || 'chat').trim() || 'chat';
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), backendTimeoutMs(options.env));
  let response;
  try {
    response = await fetchImpl(`${backendBaseUrl(options.env)}/tools/memory/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        user_text: query,
        route: 'text_chat',
        response_mode: responseMode,
      }),
    });
  } catch (error) {
    return buildErrorResult(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = String(body?.error || '').trim() || `HTTP ${response.status}`;
    return buildErrorResult(`memory recall failed: ${errorText}`);
  }
  return buildRecallResult(body);
}

async function checkPersonalMemoryBackend(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = backendBaseUrl(options.env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), backendTimeoutMs(options.env));
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
  } catch (error) {
    return buildErrorResult(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = String(body?.error || '').trim() || `HTTP ${response.status}`;
    return buildErrorResult(`memory backend health check failed: ${errorText}`);
  }
  const result = {
    ok: true,
    backend_base_url: baseUrl,
    status: String(body?.status || 'ok'),
  };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

export async function handlePersonalMemoryMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    };
  }

  if (method === 'ping') {
    return {};
  }

  if (method === 'tools/list') {
    return {
      tools: buildPersonalMemoryTools(),
    };
  }

  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    if (name === 'check_personal_memory_backend') {
      return await checkPersonalMemoryBackend(options);
    }
    if (name === 'recall_personal_memory') {
      return await recallPersonalMemory(params.arguments || {}, options);
    }
    if (name === 'surface_relevant_context') {
      return await recallPersonalMemory(params.arguments || {}, options);
    }
    return buildErrorResult(`unknown tool: ${name}`);
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

export function runPersonalMemoryMcpServer(options = {}) {
  const logger = options.logger || {
    error: (message) => process.stderr.write(`${message}\n`),
  };
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) {
      return;
    }
    try {
      const result = await handlePersonalMemoryMcpRequest(request, options);
      writeJsonRpcResponse(request.id, result);
    } catch (error) {
      logger.error?.(error instanceof Error ? error.stack || error.message : String(error));
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPersonalMemoryMcpServer();
}
