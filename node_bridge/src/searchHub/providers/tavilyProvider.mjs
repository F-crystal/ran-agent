import { getSearchHubConfig } from '../schema.mjs';
import { normalizeSearchResult } from '../sourceCurator.mjs';

export function createTavilyProvider(options = {}) {
  return {
    async search(args = {}) {
      const config = args.config || options.config || getSearchHubConfig(options.env);
      if (!config.enableTavily) return warn('TAVILY_DISABLED');
      if (!config.tavilyApiKey) return warn('TAVILY_API_KEY_MISSING');
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') return warn('FETCH_NOT_AVAILABLE');
      const limit = args.limit || config.defaultLimit || 5;
      try {
        const response = await fetchImpl('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: config.tavilyApiKey,
            query: args.query,
            max_results: limit,
            include_answer: false,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return warn(`TAVILY_HTTP_${response.status}`);
        const items = (body.results || []).map((item) => normalizeSearchResult({
          title: item.title,
          url: item.url,
          snippet: item.content,
          content: item.raw_content || '',
          provider: 'tavily',
          source: 'tavily',
          confidence: item.score,
        }));
        return { items, used_providers: items.length ? ['tavily'] : [], warnings: [] };
      } catch (error) {
        return warn(error?.name === 'TimeoutError' ? 'TAVILY_TIMEOUT' : 'TAVILY_FAILED');
      }
    },
    async read(args = {}) {
      const config = args.config || options.config || getSearchHubConfig(options.env);
      if (!config.enableTavily) return { item: normalizeSearchResult({ url: args.url, provider: 'tavily' }), warnings: ['TAVILY_DISABLED'] };
      if (!config.tavilyApiKey) return { item: normalizeSearchResult({ url: args.url, provider: 'tavily' }), warnings: ['TAVILY_API_KEY_MISSING'] };
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') return { item: normalizeSearchResult({ url: args.url, provider: 'tavily' }), warnings: ['FETCH_NOT_AVAILABLE'] };
      try {
        const response = await fetchImpl('https://api.tavily.com/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: config.tavilyApiKey,
            urls: [args.url],
            extract_depth: args.depth === 'full' ? 'advanced' : 'basic',
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        const body = await response.json().catch(() => ({}));
        const first = body.results?.[0] || {};
        const item = normalizeSearchResult({
          title: first.title || args.url,
          url: first.url || args.url,
          content: first.raw_content || first.content || '',
          provider: 'tavily',
          source: 'tavily',
        });
        return { item, content: item.content, warnings: response.ok ? [] : [`TAVILY_HTTP_${response.status}`] };
      } catch {
        return { item: normalizeSearchResult({ url: args.url, provider: 'tavily' }), warnings: ['TAVILY_READ_FAILED'] };
      }
    },
  };
}

function warn(warning) {
  return { items: [], used_providers: [], warnings: [warning] };
}
