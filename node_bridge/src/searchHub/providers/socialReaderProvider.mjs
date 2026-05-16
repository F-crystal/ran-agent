import { normalizeSearchResult } from '../sourceCurator.mjs';

export function createSocialReaderProvider() {
  return {
    async search(args = {}) {
      return {
        items: [],
        used_providers: [],
        warnings: [`SOCIAL_READER_HANDOFF:${String(args.query || '').slice(0, 80)}`],
      };
    },
    async read(args = {}) {
      return {
        item: normalizeSearchResult({ url: args.url, provider: 'social_reader', source: 'social_reader' }),
        content: '',
        warnings: ['SOCIAL_LINK_SHOULD_USE_SOCIAL_READER'],
      };
    },
  };
}
