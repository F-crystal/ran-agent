import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonalMemoryTools,
  handlePersonalMemoryMcpRequest,
} from '../src/personalMemoryMcpServer.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('personal memory exposes backend check and read-only recall tools', () => {
  const tools = buildPersonalMemoryTools();

  assert.deepEqual(tools.map((tool) => tool.name), [
    'check_personal_memory_backend',
    'recall_personal_memory',
    'surface_relevant_context',
  ]);
  assert.equal(tools[0].inputSchema.type, 'object');
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.match(tools[1].description, /Ombre/);
  assert.match(tools[1].description, /SQLite/);
  assert.equal(tools[1].inputSchema.type, 'object');
  assert.equal(tools[1].inputSchema.additionalProperties, false);
  assert.deepEqual(tools[1].inputSchema.required, ['query']);
  assert.match(tools[2].description, /familiar/);
  assert.match(tools[2].description, /prior conversations/);
  assert.deepEqual(tools[2].inputSchema.required, ['query']);
});

test('personal memory initialize and tools list follow MCP shape', async () => {
  const initialized = await handlePersonalMemoryMcpRequest({ method: 'initialize' });
  const listed = await handlePersonalMemoryMcpRequest({ method: 'tools/list' });

  assert.equal(initialized.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.capabilities, { tools: {} });
  assert.equal(initialized.serverInfo.name, 'ran-agent-personal-memory');
  assert.equal(listed.tools.length, 3);
});

test('check_personal_memory_backend reports backend health', async () => {
  const calls = [];
  const result = await handlePersonalMemoryMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'check_personal_memory_backend',
        arguments: {},
      },
    },
    {
      env: { PYTHON_BACKEND_BASE_URL: 'http://backend.test' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ status: 'ok' });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://backend.test/health');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.status, 'ok');
});

test('recall_personal_memory forwards to backend memory recall endpoint', async () => {
  const calls = [];
  const result = await handlePersonalMemoryMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'recall_personal_memory',
        arguments: {
          query: '我之前说过让我卡住的事',
          response_mode: 'casual_chat',
        },
      },
    },
    {
      env: { PYTHON_BACKEND_BASE_URL: 'http://backend.test' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          should_inject: true,
          rendered_context: '【你对用户的了解】\n- 用户最近被一个问题卡住过',
          used_sources: ['ombre_long_memory', 'local_profile_memory'],
          source_status: { local_memory: 'hit', ombre: 'empty' },
        });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://backend.test/tools/memory/recall');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_text: '我之前说过让我卡住的事',
    route: 'text_chat',
    response_mode: 'casual_chat',
  });
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.source_status, { local_memory: 'hit', ombre: 'empty' });
  assert.equal(result.structuredContent.rendered_context, '【你对用户的了解】\n- 用户最近被一个问题卡住过');
  assert.match(result.content[0].text, /ombre_long_memory/);
});

test('surface_relevant_context reuses bounded backend memory recall endpoint', async () => {
  const calls = [];
  const result = await handlePersonalMemoryMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'surface_relevant_context',
        arguments: {
          query: '拼豆',
          response_mode: 'casual_chat',
        },
      },
    },
    {
      env: { PYTHON_BACKEND_BASE_URL: 'http://backend.test' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          should_inject: true,
          rendered_context: '【你对用户的了解】\n- 用户之前聊过拼豆作品',
          used_sources: ['local_profile_memory', 'vault_knowledge'],
        });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://backend.test/tools/memory/recall');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_text: '拼豆',
    route: 'text_chat',
    response_mode: 'casual_chat',
  });
  assert.equal(result.structuredContent.should_inject, true);
  assert.match(result.structuredContent.rendered_context, /拼豆作品/);
});

test('recall_personal_memory returns structured error on backend failure', async () => {
  const result = await handlePersonalMemoryMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'recall_personal_memory',
        arguments: { query: '过去的事' },
      },
    },
    {
      fetchImpl: async () => jsonResponse({ error: 'backend down' }, 503),
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.error, /backend down/);
});
