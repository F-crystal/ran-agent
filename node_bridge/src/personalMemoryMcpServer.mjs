#!/usr/bin/env node
import readline from 'node:readline';

const SERVER_INFO = {
  name: 'ran-agent-personal-memory',
  version: '0.1.0',
};

function backendBaseUrl(env = process.env) {
  return String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').trim().replace(/\/$/, '');
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
  const result = {
    ok: true,
    should_inject: payload.should_inject === true,
    rendered_context: renderedContext,
    used_sources: usedSources,
    injection_level: String(payload.injection_level || ''),
    short_term_memories: Array.isArray(payload.short_term_memories) ? payload.short_term_memories : [],
    long_term_memories: Array.isArray(payload.long_term_memories) ? payload.long_term_memories : [],
    core_memories: Array.isArray(payload.core_memories) ? payload.core_memories : [],
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
      name: 'recall_personal_memory',
      title: 'Recall Personal Memory',
      description: [
        'Read-only recall from the local personal memory backend, including Ombre emotional memory and SQLite working/profile memory.',
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
  ];
}

async function recallPersonalMemory(args = {}, options = {}) {
  const query = String(args.query || args.user_text || '').trim();
  if (!query) {
    return buildErrorResult('recall_personal_memory requires query');
  }
  const responseMode = String(args.response_mode || 'chat').trim() || 'chat';
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(`${backendBaseUrl(options.env)}/tools/memory/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_text: query,
        route: 'text_chat',
        response_mode: responseMode,
      }),
    });
  } catch (error) {
    return buildErrorResult(error instanceof Error ? error.message : String(error));
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = String(body?.error || '').trim() || `HTTP ${response.status}`;
    return buildErrorResult(`memory recall failed: ${errorText}`);
  }
  return buildRecallResult(body);
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

  if (method === 'tools/list') {
    return {
      tools: buildPersonalMemoryTools(),
    };
  }

  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    if (name === 'recall_personal_memory') {
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
