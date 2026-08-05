#!/usr/bin/env node
import readline from 'node:readline';
import { SEARCH_HUB_SERVER_INFO, buildSearchHubTools, getSearchHubConfig } from './searchHub/schema.mjs';
import {
  routeSearchHubRead,
  routeSearchHubResearch,
  routeSearchHubSearch,
} from './searchHub/router.mjs';

function buildToolResult(payload = {}) {
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

function buildErrorResult(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: String(message || 'search_hub failed'),
      },
    ],
    structuredContent: {
      ok: false,
      error: String(message || 'search_hub failed'),
    },
  };
}

export async function handleSearchHubMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SEARCH_HUB_SERVER_INFO,
    };
  }
  if (method === 'ping') {
    return {};
  }
  if (method === 'tools/list') {
    return { tools: buildSearchHubTools() };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    const args = params.arguments || {};
    const config = options.config || getSearchHubConfig(options.env);
    if (!config.enabled) return buildErrorResult('SEARCH_HUB_DISABLED');
    if (name === 'search') {
      return buildToolResult(await routeSearchHubSearch(args, { ...options, config }));
    }
    if (name === 'read') {
      return buildToolResult(await routeSearchHubRead(args, { ...options, config }));
    }
    if (name === 'research') {
      return buildToolResult(await routeSearchHubResearch(args, { ...options, config }));
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

export function runSearchHubMcpServer(options = {}) {
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
      const result = await handleSearchHubMcpRequest(request, options);
      writeJsonRpcResponse(request.id, result);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSearchHubMcpServer();
}
