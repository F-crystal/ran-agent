import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpencliCommand,
  callOpencliAdapter,
  isBrowserBackedAdapter,
  isWriteOperation,
} from '../src/searchHub/providers/opencliProvider.mjs';
import { getSearchHubConfig } from '../src/searchHub/schema.mjs';

test('OpenCLI provider blocks write operations before spawning', () => {
  assert.equal(isWriteOperation('xiaohongshu publish'), true);
  assert.equal(isWriteOperation('reddit comment'), true);
  assert.equal(isWriteOperation('arxiv search rag'), false);
});

test('OpenCLI provider classifies browser-backed adapters', () => {
  assert.equal(isBrowserBackedAdapter('google search rag'), true);
  assert.equal(isBrowserBackedAdapter('xiaohongshu search rag'), true);
  assert.equal(isBrowserBackedAdapter('arxiv search rag'), false);
  assert.equal(isBrowserBackedAdapter('hackernews top'), false);
});

test('lite mode rejects browser-backed adapters with typed warning', async () => {
  const result = await callOpencliAdapter({
    commandText: 'google search openai',
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    execFileImpl: async () => {
      throw new Error('must not execute');
    },
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.used_providers, []);
  assert.match(result.warnings.join('\n'), /OPENCLI_BROWSER_DISABLED/);
});

test('full mode allows browser-backed adapters and forces JSON output', async () => {
  let captured = null;
  const result = await callOpencliAdapter({
    commandText: 'google search openai',
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'full' }),
    execFileImpl: async (bin, args, options) => {
      captured = { bin, args, options };
      return {
        stdout: JSON.stringify([{ title: 'OpenAI news', url: 'https://example.com', snippet: 'news' }]),
        stderr: '',
      };
    },
  });

  assert.equal(captured.bin, 'opencli');
  assert.deepEqual(captured.args.slice(0, 3), ['google', 'search', 'openai']);
  assert.deepEqual(captured.args.slice(-2), ['-f', 'json']);
  assert.equal(result.items[0].provider, 'opencli');
  assert.equal(result.used_providers[0], 'opencli');
});

test('buildOpencliCommand rejects unsafe and unknown command surfaces', () => {
  assert.throws(() => buildOpencliCommand('rm -rf /'), /OPENCLI_COMMAND_NOT_ALLOWED/);
  assert.throws(() => buildOpencliCommand('xiaohongshu publish hello'), /OPENCLI_WRITE_OPERATION_BLOCKED/);
});
