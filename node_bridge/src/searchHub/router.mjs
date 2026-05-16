import { getSearchHubConfig, isOpencliBrowserAllowed, isPlaywrightFallbackAllowed } from './schema.mjs';
import { curateSearchResults, mergeProviderResults, normalizeSearchResult, sanitizeWarnings } from './sourceCurator.mjs';
import { createAihotProvider } from './providers/aihotProvider.mjs';
import { createOpencliProvider } from './providers/opencliProvider.mjs';
import { createPlaywrightProvider } from './providers/playwrightProvider.mjs';
import { createSocialReaderProvider } from './providers/socialReaderProvider.mjs';
import { createTavilyProvider } from './providers/tavilyProvider.mjs';

const SOCIAL_LINK_PATTERN = /https?:\/\/\S*(xhslink\.com|xiaohongshu\.com|xhs\.com|bilibili\.com|b23\.tv|mp\.weixin\.qq\.com|douyin\.com|kuaishou\.com|weibo\.com|zhihu\.com|music\.163\.com)/i;
const AIHOT_PATTERN = /AI\s*圈|AI\s*新闻|AI\s*日报|AI\s*热点|AI\s*HOT|OpenAI|Anthropic|Google|模型发布|大模型|LLM|Sora|Claude|Gemini|DeepSeek/i;
const ACADEMIC_PATTERN = /论文|paper|arxiv|pubmed|openalex|doi|scholar|学术|RAG|citation|文献/i;
const SOCIAL_SEARCH_PATTERN = /小红书搜索|B站搜索|知乎搜索|微博搜索|reddit search|xiaohongshu search|bilibili search|zhihu search/i;
const NEWS_PATTERN = /新闻|最新|今天|昨天|趋势|发布|news|today|latest/i;

export async function routeSearchHubSearch(args = {}, options = {}) {
  const config = options.config || getSearchHubConfig(options.env);
  const query = String(args.query || '').trim();
  if (!query) return { items: [], used_providers: [], warnings: ['SEARCH_HUB_QUERY_REQUIRED'] };
  if (SOCIAL_LINK_PATTERN.test(query) && String(args.intent || 'auto') !== 'social_search') {
    return { items: [], used_providers: [], warnings: ['SOCIAL_LINK_SHOULD_USE_SOCIAL_READER'] };
  }

  const providers = buildProviders(options, config);
  const intent = classifyIntent(args.intent, query);
  const limit = Math.max(1, Number.parseInt(String(args.limit || config.defaultLimit || '5'), 10) || 5);
  const results = [];

  if (intent === 'aihot') {
    results.push(await maybeSearch(providers.aihotProvider, { ...args, query, limit, config }));
    results.push(await maybeSearch(providers.tavilyProvider, { ...args, query, limit, config, intent: 'news' }));
    results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: `google news ${query}` }));
  } else if (intent === 'academic') {
    const commandText = config.profileMode === 'full'
      ? `google-scholar search ${query}`
      : `openalex search ${query}`;
    results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText, intent }));
    if (config.profileMode === 'lite') {
      results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: `arxiv search ${query}`, intent }));
      results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: `pubmed search ${query}`, intent }));
    }
    results.push(await maybeSearch(providers.tavilyProvider, { ...args, query, limit, config, intent: 'web' }));
  } else if (intent === 'social') {
    if (!isOpencliBrowserAllowed(config)) {
      return {
        items: [],
        used_providers: [],
        warnings: ['SEARCH_HUB_BROWSER_BACKED_SOCIAL_SEARCH_UNAVAILABLE'],
      };
    }
    results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: buildSocialSearchCommand(query), intent }));
    results.push(await maybeSearch(providers.socialReaderProvider, { ...args, query, limit, config, intent }));
  } else if (intent === 'news') {
    results.push(await maybeSearch(providers.tavilyProvider, { ...args, query, limit, config, intent }));
    results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: `google news ${query}`, intent }));
  } else {
    results.push(await maybeSearch(providers.tavilyProvider, { ...args, query, limit, config, intent: 'web' }));
    results.push(await maybeSearch(providers.opencliProvider, { ...args, query, limit, config, commandText: config.profileMode === 'full' ? `google search ${query}` : `google news ${query}`, intent: 'web' }));
  }

  const merged = mergeProviderResults(results, { limit });
  if (merged.items.length === 0 && isPlaywrightFallbackAllowed(config)) {
    const fallback = await maybeSearch(providers.playwrightProvider, { ...args, query, limit, config });
    return mergeProviderResults([merged, fallback], { limit });
  }
  return merged;
}

export async function routeSearchHubRead(args = {}, options = {}) {
  const config = options.config || getSearchHubConfig(options.env);
  const url = String(args.url || '').trim();
  if (!url) {
    return {
      item: normalizeSearchResult({ provider: 'search_hub' }),
      warnings: ['SEARCH_HUB_URL_REQUIRED'],
    };
  }
  if (SOCIAL_LINK_PATTERN.test(url)) {
    return {
      item: normalizeSearchResult({ url, provider: 'social_reader', source: 'social_reader' }),
      warnings: ['SOCIAL_LINK_SHOULD_USE_SOCIAL_READER'],
    };
  }
  const providers = buildProviders(options, config);
  const order = config.profileMode === 'full'
    ? [providers.opencliProvider, providers.tavilyProvider, providers.playwrightProvider]
    : [providers.tavilyProvider, providers.opencliProvider];
  const warnings = [];
  for (const provider of order) {
    if (!provider?.read) continue;
    const result = await provider.read({ ...args, url, config });
    warnings.push(...(result?.warnings || []));
    if (result?.item && (result.content || result.item.content || !result.warnings?.length)) {
      const item = normalizeSearchResult(result.item);
      return {
        item,
        content: result.content || item.content,
        warnings: sanitizeWarnings(warnings),
      };
    }
  }
  return {
    item: normalizeSearchResult({ url, provider: 'search_hub' }),
    warnings: sanitizeWarnings(warnings.length ? warnings : ['SEARCH_HUB_READ_FAILED']),
  };
}

export async function routeSearchHubResearch(args = {}, options = {}) {
  const maxSources = Math.max(1, Number.parseInt(String(args.max_sources || '5'), 10) || 5);
  const search = await routeSearchHubSearch({
    query: args.query,
    intent: args.intent || 'auto',
    limit: maxSources,
  }, options);
  const curated = curateSearchResults(search.items, { limit: maxSources, warnings: search.warnings });
  const brief = curated.items.length
    ? curated.items.map((item, index) => `${index + 1}. ${item.title}${item.snippet ? ` — ${item.snippet}` : ''}`).join('\n')
    : '未找到足够可靠的来源。';
  return {
    brief,
    sources: curated.items,
    used_providers: search.used_providers,
    warnings: curated.warnings,
  };
}

export function classifyIntent(intent = 'auto', query = '') {
  const normalized = String(intent || 'auto').toLowerCase();
  if (['news', 'academic', 'social', 'aihot', 'web'].includes(normalized)) return normalized;
  if (SOCIAL_SEARCH_PATTERN.test(query)) return 'social';
  if (AIHOT_PATTERN.test(query)) return 'aihot';
  if (ACADEMIC_PATTERN.test(query)) return 'academic';
  if (NEWS_PATTERN.test(query)) return 'news';
  return 'web';
}

function buildProviders(options = {}, config = {}) {
  return {
    tavilyProvider: options.providers?.tavilyProvider || createTavilyProvider({ ...options, config }),
    opencliProvider: options.providers?.opencliProvider || createOpencliProvider({ ...options, config }),
    aihotProvider: options.providers?.aihotProvider || createAihotProvider({ ...options, config }),
    socialReaderProvider: options.providers?.socialReaderProvider || createSocialReaderProvider({ ...options, config }),
    playwrightProvider: options.providers?.playwrightProvider || createPlaywrightProvider({ ...options, config }),
  };
}

async function maybeSearch(provider, args) {
  if (!provider?.search) return null;
  try {
    return await provider.search(args);
  } catch (error) {
    return {
      items: [],
      used_providers: [],
      warnings: [`PROVIDER_FAILED:${String(error?.message || error).slice(0, 120)}`],
    };
  }
}

function buildSocialSearchCommand(query) {
  if (/小红书|xiaohongshu|xhs/i.test(query)) return `xiaohongshu search ${query}`;
  if (/B站|bilibili/i.test(query)) return `bilibili search ${query}`;
  if (/知乎|zhihu/i.test(query)) return `zhihu search ${query}`;
  if (/reddit/i.test(query)) return `reddit search ${query}`;
  return `google search ${query}`;
}
