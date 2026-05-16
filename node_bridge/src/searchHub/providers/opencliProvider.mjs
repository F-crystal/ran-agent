import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { getSearchHubConfig, isOpencliBrowserAllowed } from '../schema.mjs';
import { normalizeSearchResult, sanitizeWarnings } from '../sourceCurator.mjs';

const execFile = promisify(execFileCallback);

const WRITE_WORDS = new Set([
  'publish', 'post', 'send', 'like', 'unlike', 'follow', 'unfollow', 'delete',
  'comment', 'reply', 'answer', 'subscribe', 'unsubscribe', 'add-to-cart', 'rm',
  'mv', 'rename', 'mkdir', 'save', 'share', 'create', 'write', 'upload',
]);

const PUBLIC_ALLOWLIST = new Set([
  'openalex search', 'openalex work', 'arxiv search', 'arxiv paper',
  'pubmed search', 'pubmed article', 'hackernews top', 'hackernews new',
  'hackernews best', 'hackernews search', 'google news', 'google suggest',
  'google trends', 'web read',
]);

const BROWSER_ALLOWLIST = new Set([
  'google search', 'google-scholar search', 'google-scholar cite',
  'google-scholar profile', 'baidu-scholar search', 'wanfang search',
  'xiaohongshu search', 'xiaohongshu note', 'xiaohongshu comments',
  'bilibili hot', 'bilibili search', 'bilibili video', 'bilibili subtitle',
  'bilibili comments', 'zhihu hot', 'zhihu search', 'zhihu question',
  'zhihu download', 'reddit hot', 'reddit search', 'reddit read',
  'reddit subreddit', 'web read',
]);

export function isWriteOperation(commandText = '') {
  return tokenize(commandText).some((token) => WRITE_WORDS.has(token.toLowerCase()));
}

export function isBrowserBackedAdapter(commandText = '') {
  const [site, command] = tokenize(commandText);
  const pair = `${site || ''} ${command || ''}`.toLowerCase();
  return BROWSER_ALLOWLIST.has(pair) && !PUBLIC_ALLOWLIST.has(pair);
}

export function buildOpencliCommand(commandText = {}, options = {}) {
  const tokens = tokenize(commandText);
  if (tokens.length < 2) {
    throw new Error('OPENCLI_COMMAND_NOT_ALLOWED');
  }
  const pair = `${tokens[0]} ${tokens[1]}`.toLowerCase();
  if (isWriteOperation(tokens.join(' ')) && isKnownAdapter(tokens[0])) {
    throw new Error('OPENCLI_WRITE_OPERATION_BLOCKED');
  }
  const allowed = PUBLIC_ALLOWLIST.has(pair) || BROWSER_ALLOWLIST.has(pair);
  if (!allowed) {
    throw new Error('OPENCLI_COMMAND_NOT_ALLOWED');
  }
  const args = [...tokens];
  if (!args.includes('-f') && !args.includes('--format')) {
    args.push('-f', 'json');
  }
  return {
    bin: options.bin || 'opencli',
    args,
    browserBacked: isBrowserBackedAdapter(tokens.join(' ')),
  };
}

function isKnownAdapter(site = '') {
  const prefix = `${String(site).toLowerCase()} `;
  return [...PUBLIC_ALLOWLIST, ...BROWSER_ALLOWLIST].some((entry) => entry.startsWith(prefix));
}

export async function callOpencliAdapter(options = {}) {
  const config = options.config || getSearchHubConfig(options.env);
  if (!config.enableOpencli) {
    return emptyResult('OPENCLI_DISABLED');
  }

  let command;
  try {
    command = buildOpencliCommand(options.commandText || '', { bin: config.opencliBin });
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }

  if (command.browserBacked && !isOpencliBrowserAllowed(config)) {
    return emptyResult('OPENCLI_BROWSER_DISABLED');
  }

  const execFileImpl = options.execFileImpl || execFile;
  try {
    const { stdout, stderr } = await execFileImpl(command.bin, command.args, {
      timeout: config.opencliTimeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const items = parseOpencliOutput(stdout).map((item) => normalizeSearchResult({
      ...item,
      provider: 'opencli',
      source: item.source || item.site || 'opencli',
    }));
    return {
      items,
      used_providers: items.length > 0 ? ['opencli'] : [],
      warnings: sanitizeWarnings(stderr ? [`OPENCLI_STDERR:${stderr}`] : []),
    };
  } catch (error) {
    return emptyResult(mapOpencliError(error));
  }
}

export function createOpencliProvider(options = {}) {
  return {
    async search(args = {}) {
      return callOpencliAdapter({
        ...options,
        commandText: args.commandText || buildCommandForSearch(args),
        config: args.config || options.config,
      });
    },
    async read(args = {}) {
      return callOpencliAdapter({
        ...options,
        commandText: args.commandText || `web read ${args.url || ''}`,
        config: args.config || options.config,
      });
    },
  };
}

function buildCommandForSearch(args = {}) {
  const query = String(args.query || '').trim();
  const intent = String(args.intent || 'web');
  if (intent === 'academic') return `openalex search ${query}`;
  if (intent === 'social') return `google search ${query}`;
  if (intent === 'news') return `google news ${query}`;
  return `google news ${query}`;
}

function parseOpencliOutput(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.results)) return parsed.results;
    return [parsed];
  } catch {
    return [{ title: text.slice(0, 120), snippet: text, provider: 'opencli' }];
  }
}

function mapOpencliError(error) {
  const code = Number(error?.code);
  if (code === 66) return 'OPENCLI_EMPTY_RESULT';
  if (code === 69) return 'OPENCLI_BROWSER_UNAVAILABLE';
  if (code === 75) return 'OPENCLI_TIMEOUT';
  if (code === 77) return 'OPENCLI_AUTH_REQUIRED';
  if (code === 78) return 'OPENCLI_CONFIG_ERROR';
  if (error?.code === 'ENOENT') return 'OPENCLI_NOT_FOUND';
  if (/timed out/i.test(String(error?.message || ''))) return 'OPENCLI_TIMEOUT';
  return 'OPENCLI_FAILED';
}

function emptyResult(warning) {
  return {
    items: [],
    used_providers: [],
    warnings: [warning],
  };
}

function tokenize(commandText = '') {
  return String(commandText || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
