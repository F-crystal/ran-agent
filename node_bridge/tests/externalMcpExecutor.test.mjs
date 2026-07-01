import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callExternalMcpTool,
  probeExternalMcpServer,
} from '../src/externalMcp/executor.mjs';

test('streamable HTTP executor initializes, lists tools, and calls tools', async () => {
  const requests = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(String(request.body || '{}'));
    const headers = Object.fromEntries(new Headers(request.headers).entries());
    requests.push({ url, method: body.method, headers, body });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'cedartoy', version: '1.0.0' },
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'upstream-session-1',
        },
      });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/list') {
      return new Response([
        'event: message',
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
        '',
        'event: message',
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'ecosystem.cmd',
                description: 'Run a command inside a text-only sandbox game.',
                inputSchema: {
                  type: 'object',
                  properties: { cmd: { type: 'string' } },
                  required: ['cmd'],
                },
              },
            ],
          },
        })}`,
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: `observed:${body.params.arguments.cmd}` }],
          structuredContent: { ok: true },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'unexpected method' }), { status: 500 });
  };
  const url = 'http://127.0.0.1:38888/mcp';

  const probe = await probeExternalMcpServer({
    serverId: 'cedartoy-games',
    title: 'CedarToy Games',
    url,
    transport: 'streamable-http',
    activityKind: 'game',
  }, { skipUrlSafety: true, fetchImpl });

  assert.equal(probe.ok, true);
  assert.equal(probe.manifest.id, 'cedartoy-games');
  assert.equal(probe.manifest.transport, 'streamable-http');
  assert.equal(probe.manifest.tools[0].tier, 'T3');
  assert.equal(probe.notifications.some((item) => item.method === 'notifications/tools/list_changed'), true);

  const call = await callExternalMcpTool({
    url,
    transport: 'streamable-http',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'observe' },
  }, { skipUrlSafety: true, fetchImpl });

  assert.equal(call.ok, true);
  assert.equal(call.result.content[0].text, 'observed:observe');
  assert.deepEqual(requests.map((item) => item.method), [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'initialize',
    'notifications/initialized',
    'tools/call',
  ]);
  assert.equal(requests[2].headers['mcp-session-id'], 'upstream-session-1');
  assert.match(requests[2].headers.accept, /text\/event-stream/);
});

test('executor reports cancellation without calling remote MCP', async () => {
  let fetchCalled = false;
  const controller = new AbortController();
  controller.abort();

  const result = await callExternalMcpTool({
    url: 'https://example.com/mcp',
    transport: 'streamable-http',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'wait' },
  }, {
    signal: controller.signal,
    lookupImpl: async () => [{ address: '203.0.113.20', family: 4 }],
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_ABORTED');
  assert.equal(fetchCalled, false);
});

test('executor blocks redirects that resolve to private network addresses', async () => {
  let calls = 0;
  const result = await callExternalMcpTool({
    url: 'https://safe.example/mcp',
    transport: 'streamable-http',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'observe' },
  }, {
    lookupImpl: async (hostname) => (
      hostname === 'private.example'
        ? [{ address: '10.0.0.5', family: 4 }]
        : [{ address: '203.0.113.21', family: 4 }]
    ),
    fetchImpl: async () => {
      calls += 1;
      return new Response('', {
        status: 302,
        headers: { location: 'https://private.example/mcp' },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_EXECUTOR_ERROR');
  assert.match(result.error, /denied|SSRF|private/i);
  assert.equal(calls, 1);
});

test('legacy SSE executor resolves endpoint without waiting for an endless stream', async () => {
  const encoder = new TextEncoder();
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push({ url: String(url), method: request.method });
    if (request.method === 'GET') {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const body = JSON.parse(String(request.body || '{}'));
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'legacy-sse' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/list') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'ecosystem.cmd', description: 'Run a sandbox game command.' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 500 });
  };

  const result = await probeExternalMcpServer({
    serverId: 'legacy-game',
    url: 'https://legacy.example/sse',
    transport: 'sse',
    activityKind: 'game',
  }, {
    fetchImpl,
    lookupImpl: async () => [{ address: '203.0.113.22', family: 4 }],
    timeoutMs: 500,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requests.map((item) => [item.method, item.url]), [
    ['GET', 'https://legacy.example/sse'],
    ['POST', 'https://legacy.example/messages'],
    ['POST', 'https://legacy.example/messages'],
    ['POST', 'https://legacy.example/messages'],
  ]);
});
