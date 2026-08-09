import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSearchHubMcpRequest } from '../src/searchHubMcpServer.mjs';
import { routeSearchHubRead, routeSearchHubResearch, routeSearchHubSearch } from '../src/searchHub/router.mjs';
import { getSearchHubConfig } from '../src/searchHub/schema.mjs';

function provider(name, items = []) {
  return {
    async search(args) {
      return {
        items: items.map((item) => ({ ...item, provider: name })),
        used_providers: [name],
        warnings: [],
      };
    },
    async read(args) {
      return {
        item: { title: args.url, url: args.url, provider: name, source: name },
        content: `${name} content`,
        warnings: [],
      };
    },
  };
}

test('AI hot queries route to aihot before general web providers', async () => {
  const calls = [];
  const result = await routeSearchHubSearch({
    query: '今天 AI 圈有什么新东西',
    intent: 'auto',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {
      aihotProvider: {
        async search() {
          calls.push('aihot');
          return { items: [{ title: 'AI Hot', url: 'https://ai.example', provider: 'aihot', confidence: 0.9 }], used_providers: ['aihot'], warnings: [] };
        },
      },
      tavilyProvider: provider('tavily', [{ title: 'Web', url: 'https://web.example', confidence: 0.4 }]),
    },
  });

  assert.equal(calls[0], 'aihot');
  assert.equal(result.items[0].provider, 'aihot');
  assert.deepEqual(result.used_providers, ['aihot', 'tavily']);
});

test('lite academic queries use public OpenCLI adapters', async () => {
  let commandText = '';
  const result = await routeSearchHubSearch({
    query: 'RAG 最近论文',
    intent: 'academic',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {
      opencliProvider: {
        async search(args) {
          commandText = args.commandText;
          return { items: [{ title: 'RAG paper', url: 'https://arxiv.org/abs/1', provider: 'opencli' }], used_providers: ['opencli'], warnings: [] };
        },
      },
    },
  });

  assert.match(commandText, /openalex search|arxiv search|pubmed search/);
  assert.equal(result.items[0].provider, 'opencli');
});

test('full academic queries may use browser-backed scholar adapters', async () => {
  let commandText = '';
  await routeSearchHubSearch({
    query: 'RAG 最近论文',
    intent: 'academic',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'full' }),
    providers: {
      opencliProvider: {
        async search(args) {
          commandText = args.commandText;
          return { items: [], used_providers: ['opencli'], warnings: [] };
        },
      },
    },
  });

  assert.match(commandText, /google-scholar search|baidu-scholar search|wanfang search/);
});

test('social links are not consumed by Search Hub link reading', async () => {
  const result = await routeSearchHubSearch({
    query: 'https://xhslink.com/abc',
    intent: 'auto',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {},
  });

  assert.deepEqual(result.items, []);
  assert.match(result.warnings.join('\n'), /SOCIAL_LINK_SHOULD_USE_SOCIAL_READER/);
});

test('platform social search warns in lite and can route in full', async () => {
  const lite = await routeSearchHubSearch({
    query: '小红书搜索 phase 11',
    intent: 'social',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {},
  });
  assert.match(lite.warnings.join('\n'), /SEARCH_HUB_BROWSER_BACKED_SOCIAL_SEARCH_UNAVAILABLE/);

  let fullCommand = '';
  await routeSearchHubSearch({
    query: '小红书搜索 phase 11',
    intent: 'social',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'full' }),
    providers: {
      opencliProvider: {
        async search(args) {
          fullCommand = args.commandText;
          return { items: [], used_providers: ['opencli'], warnings: [] };
        },
      },
    },
  });
  assert.match(fullCommand, /xiaohongshu search/);
});

test('normal URL reading uses search hub read provider and returns schema', async () => {
  const result = await routeSearchHubRead({
    url: 'https://example.com/page?token=secret&id=1',
    depth: 'summary',
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {
      tavilyProvider: provider('tavily'),
    },
  });

  assert.equal(result.item.url, 'https://example.com/page?id=1');
  assert.equal(result.content, 'tavily content');
});

test('research returns a brief with curated sources', async () => {
  const result = await routeSearchHubResearch({
    query: 'OpenAI news',
    max_sources: 2,
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'lite' }),
    providers: {
      aihotProvider: {
        async search() {
          return { items: [], used_providers: ['aihot'], warnings: [] };
        },
      },
      tavilyProvider: provider('tavily', [{ title: 'OpenAI', url: 'https://example.com', snippet: 'snippet' }]),
    },
  });

  assert.match(result.brief, /OpenAI/);
  assert.equal(result.sources.length, 1);
});

test('DLM research-shaped MCP call reaches the typed search_hub research handler', async () => {
  const providerCalls = [];
  const result = await handleSearchHubMcpRequest({
    method: 'tools/call',
    params: {
      name: 'research',
      arguments: {
        query: '扩散语言模型 DLM 与自回归语言模型的原理对比和入门资料',
        intent: 'academic',
        max_sources: 2,
      },
    },
  }, {
    config: getSearchHubConfig({ SEARCH_HUB_PROFILE_MODE: 'full' }),
    providers: {
      opencliProvider: {
        async search(args) {
          providerCalls.push({ provider: 'opencli', query: args.query, commandText: args.commandText });
          return {
            items: [{
              title: 'Diffusion language models',
              url: 'https://arxiv.org/abs/2502.09992',
              snippet: 'A diffusion language model overview.',
              provider: 'opencli',
            }],
            used_providers: ['opencli'],
            warnings: [],
          };
        },
      },
      tavilyProvider: {
        async search(args) {
          providerCalls.push({ provider: 'tavily', query: args.query });
          return { items: [], used_providers: ['tavily'], warnings: [] };
        },
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(providerCalls[0].provider, 'opencli');
  assert.match(providerCalls[0].commandText, /google-scholar search/);
  assert.equal(result.structuredContent.sources.length, 1);
  assert.match(result.structuredContent.brief, /Diffusion language models/);
  assert.doesNotMatch(JSON.stringify(result), /web_extract|web_search|tool_describe/);
});
