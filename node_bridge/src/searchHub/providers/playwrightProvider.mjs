import { isPlaywrightFallbackAllowed } from '../schema.mjs';
import { normalizeSearchResult } from '../sourceCurator.mjs';

export function createPlaywrightProvider(options = {}) {
  return {
    async search(args = {}) {
      const config = args.config || options.config || {};
      if (!isPlaywrightFallbackAllowed(config)) {
        return { items: [], used_providers: [], warnings: ['PLAYWRIGHT_FALLBACK_DISABLED'] };
      }
      return { items: [], used_providers: [], warnings: ['PLAYWRIGHT_FALLBACK_NOT_IMPLEMENTED_IN_SEARCH_HUB'] };
    },
    async read(args = {}) {
      const config = args.config || options.config || {};
      if (!isPlaywrightFallbackAllowed(config)) {
        return { item: normalizeSearchResult({ url: args.url, provider: 'playwright' }), warnings: ['PLAYWRIGHT_FALLBACK_DISABLED'] };
      }
      return { item: normalizeSearchResult({ url: args.url, provider: 'playwright' }), warnings: ['PLAYWRIGHT_FALLBACK_NOT_IMPLEMENTED_IN_SEARCH_HUB'] };
    },
  };
}
