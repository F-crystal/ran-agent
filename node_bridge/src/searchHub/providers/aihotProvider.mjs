import { getSearchHubConfig } from '../schema.mjs';
import { normalizeSearchResult } from '../sourceCurator.mjs';

const AIHOT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function createAihotProvider(options = {}) {
  return {
    async search(args = {}) {
      const config = args.config || options.config || getSearchHubConfig(options.env);
      if (!config.enableAihot) return { items: [], used_providers: [], warnings: ['AIHOT_DISABLED'] };
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') return { items: [], used_providers: [], warnings: ['FETCH_NOT_AVAILABLE'] };
      const url = buildAihotUrl(args);
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': AIHOT_UA },
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return { items: [], used_providers: [], warnings: [`AIHOT_HTTP_${response.status}`] };
        const sourceItems = Array.isArray(body.items) ? body.items : [];
        const items = sourceItems.map((item) => normalizeSearchResult({
          title: item.titleZh || item.title || item.leadTitle || '',
          url: item.url || item.originalUrl || 'https://aihot.virxact.com',
          source: item.source || 'aihot.virxact.com',
          published_at: item.publishedAt || item.date || '',
          snippet: item.summaryZh || item.summary || item.description || '',
          content: item.summaryZh || item.summary || '',
          provider: 'aihot',
          confidence: 0.92,
        }));
        return { items, used_providers: items.length ? ['aihot'] : [], warnings: [] };
      } catch {
        return { items: [], used_providers: [], warnings: ['AIHOT_FAILED'] };
      }
    },
  };
}

function buildAihotUrl(args = {}) {
  const url = new URL('https://aihot.virxact.com/api/public/items');
  url.searchParams.set('mode', 'selected');
  url.searchParams.set('take', String(Math.min(100, Math.max(1, args.limit || 50))));
  const query = String(args.query || '').trim();
  const q = query.match(/OpenAI|Anthropic|Google|Sora|RAG|GPT-\d|Claude|Gemini|DeepSeek/i)?.[0];
  if (q) url.searchParams.set('q', q);
  return url.toString();
}
