export const SEARCH_HUB_SERVER_INFO = {
  name: 'ran-agent-search-hub',
  version: '0.1.0',
};

export function getSearchHubConfig(env = process.env) {
  const profileMode = resolveProfileMode(env);
  const defaults = profileMode === 'full' ? fullDefaults() : liteDefaults();
  return {
    enabled: parseBool(env.SEARCH_HUB_ENABLED, true),
    profileMode,
    defaultLimit: parseIntEnv(env.SEARCH_HUB_DEFAULT_LIMIT, 5),
    timeoutMs: parseIntEnv(env.SEARCH_HUB_TIMEOUT_MS, 30000),
    cacheTtlMs: parseIntEnv(env.SEARCH_HUB_CACHE_TTL_MS, 300000),
    cachePath: String(env.SEARCH_HUB_CACHE_PATH || '/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl'),
    enableTavily: parseBool(env.SEARCH_HUB_ENABLE_TAVILY, true),
    enableAihot: parseBool(env.SEARCH_HUB_ENABLE_AIHOT, true),
    enableOpencli: parseBool(env.SEARCH_HUB_ENABLE_OPENCLI, true),
    enableOpencliBrowser: parseBool(env.SEARCH_HUB_ENABLE_OPENCLI_BROWSER, defaults.enableOpencliBrowser),
    enablePlaywrightFallback: parseBool(env.SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK, defaults.enablePlaywrightFallback),
    opencliBin: String(env.SEARCH_HUB_OPENCLI_BIN || 'opencli').trim() || 'opencli',
    opencliTimeoutMs: parseIntEnv(env.SEARCH_HUB_OPENCLI_TIMEOUT_MS, 60000),
    publicOnlyDefault: parseBool(env.SEARCH_HUB_PUBLIC_ONLY_DEFAULT, defaults.publicOnlyDefault),
    openalexMailto: String(env.OPENALEX_MAILTO || '').trim(),
    tavilyApiKey: String(env.TAVILY_API_KEY || '').trim(),
  };
}

export function resolveProfileMode(env = process.env) {
  const explicit = String(env.SEARCH_HUB_PROFILE_MODE || 'auto').trim().toLowerCase();
  if (explicit === 'lite' || explicit === 'full') return explicit;
  const joined = `${env.HERMES_PROFILE || ''} ${env.API_SERVER_MODEL_NAME || ''}`.toLowerCase();
  if (joined.includes('ran-assistant-lite')) return 'lite';
  if (joined.includes('ran-assistant')) return 'full';
  return 'lite';
}

export function isOpencliBrowserAllowed(config = {}) {
  return config.profileMode === 'full' && config.enableOpencliBrowser === true;
}

export function isPlaywrightFallbackAllowed(config = {}) {
  return config.profileMode === 'full' && config.enablePlaywrightFallback === true;
}

export function buildSearchHubTools() {
  return [
    {
      name: 'search',
      title: 'Search Hub Search',
      description: 'Unified read-only search entry for fresh web facts, news, academic discovery, AI hot topics, and platform search routing.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          intent: { type: 'string', enum: ['auto', 'news', 'academic', 'social', 'aihot', 'web'] },
          freshness: { type: 'string', enum: ['auto', 'today', 'week', 'month', 'any'] },
          limit: { type: 'number' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'read',
      title: 'Search Hub Read',
      description: 'Read a normal non-social URL through Search Hub. Social platform links should use social_reader first.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          depth: { type: 'string', enum: ['summary', 'full'] },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'research',
      title: 'Search Hub Research',
      description: 'Collect and curate several read-only sources into a compact research brief.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          intent: { type: 'string' },
          max_sources: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

function liteDefaults() {
  return {
    enableOpencliBrowser: false,
    enablePlaywrightFallback: false,
    publicOnlyDefault: true,
  };
}

function fullDefaults() {
  return {
    enableOpencliBrowser: true,
    enablePlaywrightFallback: true,
    publicOnlyDefault: false,
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
