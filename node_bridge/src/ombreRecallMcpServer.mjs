import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OMBRE_RECALL_TOOLS,
  OMBRE_UPSTREAM_COMMIT,
  isAllowedOmbreRecallTool,
  ombreRecallPolicyDigest,
} from './ombreRecallPolicy.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18002;

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textResult(value) {
  const structuredContent = value;
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent,
    isError: false,
  };
}

function validatedBucketRoot(root) {
  const candidate = path.resolve(root);
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('bucket_root_invalid');
  fs.accessSync(candidate, fs.constants.R_OK);
  return fs.realpathSync(candidate);
}

function isRecallMarkdownFile(entry, name = entry.name) {
  return entry.isFile() && !entry.isSymbolicLink() && name.endsWith('.md');
}

function regularMarkdownFiles(root) {
  const resolvedRoot = validatedBucketRoot(root);
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (isRecallMarkdownFile(entry)) files.push(candidate);
    }
  };
  visit(resolvedRoot);
  return { resolvedRoot, files };
}

function validateRecallArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments_invalid');
  const allowed = name === 'ombre_recall_read' ? ['path', 'max_chars'] : ['query', 'limit'];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('arguments_invalid');
  if (name === 'ombre_recall_read') {
    if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('path_required');
    if (args.max_chars !== undefined && (!Number.isInteger(args.max_chars) || args.max_chars < 1 || args.max_chars > 20000)) {
      throw new Error('max_chars_invalid');
    }
    return;
  }
  if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query_required');
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) {
    throw new Error('limit_invalid');
  }
}

function resolveBucketFile(root, relativePath) {
  const resolvedRoot = validatedBucketRoot(root);
  const requested = String(relativePath || '');
  if (!requested || requested !== requested.normalize('NFC') || path.isAbsolute(requested) || requested.includes('\0')) {
    throw new Error('path_invalid');
  }
  const components = requested.split(/[\\/]/u);
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new Error('path_outside_bucket');
  }
  const candidate = path.join(resolvedRoot, ...components);
  let current = resolvedRoot;
  for (const [index, component] of components.entries()) {
    if (!fs.readdirSync(current).includes(component)) throw new Error('path_not_canonical');
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('path_symlink_denied');
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error('path_component_invalid');
    if (index === components.length - 1 && !isRecallMarkdownFile(stat, component)) {
      throw new Error('not_regular_markdown');
    }
  }
  const resolvedCandidate = fs.realpathSync(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('path_outside_bucket');
  }
  if (relative !== components.join(path.sep) || resolvedCandidate !== candidate) throw new Error('path_not_canonical');
  return { candidate: resolvedCandidate, resolvedRoot };
}

export function callOmbreRecallTool(name, args = {}, options = {}) {
  if (!isAllowedOmbreRecallTool(name)) throw new Error('tool_not_allowed');
  validateRecallArguments(name, args);
  const bucketRoot = path.resolve(options.bucketRoot || process.env.OMBRE_BUCKETS_DIR || 'vault/ombre');
  if (name === 'ombre_recall_read') {
    const { candidate, resolvedRoot } = resolveBucketFile(bucketRoot, args.path);
    const maxChars = Math.min(20000, Math.max(1, Number(args.max_chars) || 8000));
    return {
      path: path.relative(resolvedRoot, candidate),
      content: fs.readFileSync(candidate, 'utf8').slice(0, maxChars),
      truncated: fs.statSync(candidate).size > maxChars,
    };
  }

  const query = String(args.query || '').trim().toLocaleLowerCase();
  if (!query) throw new Error('query_required');
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
  const { resolvedRoot, files } = regularMarkdownFiles(bucketRoot);
  const items = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const index = content.toLocaleLowerCase().indexOf(query);
    if (index < 0) continue;
    items.push({
      path: path.relative(resolvedRoot, file),
      excerpt: content.slice(Math.max(0, index - 240), index + query.length + 560),
    });
    if (items.length >= limit) break;
  }
  return { items };
}

export function handleOmbreRecallRpc(payload, options = {}) {
  const id = payload?.id ?? null;
  if (!payload || payload.jsonrpc !== '2.0') return errorResponse(id, -32600, 'Invalid Request');
  if (payload.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'ran-agent-ombre-recall',
          version: '1.0.0',
        },
      },
    };
  }
  if (payload.method === 'notifications/initialized') return null;
  if (payload.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: OMBRE_RECALL_TOOLS } };
  }
  if (payload.method !== 'tools/call') return errorResponse(id, -32601, 'Method not found');
  const name = String(payload.params?.name || '');
  if (!isAllowedOmbreRecallTool(name)) {
    return errorResponse(id, -32001, 'Ombre capability denied by local recall-only policy');
  }
  try {
    return {
      jsonrpc: '2.0',
      id,
      result: textResult(callOmbreRecallTool(name, payload.params?.arguments || {}, options)),
    };
  } catch {
    return errorResponse(id, -32002, 'Ombre recall failed closed');
  }
}

export function createOmbreRecallServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (host !== '127.0.0.1') throw new Error('Ombre recall adapter must bind to 127.0.0.1');
  return http.createServer((request, response) => {
    if (request.url === '/health' && request.method === 'GET') {
      let healthy = true;
      try {
        validatedBucketRoot(options.bucketRoot || process.env.OMBRE_BUCKETS_DIR || 'vault/ombre');
      } catch {
        healthy = false;
      }
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: healthy,
        mode: 'recall-only',
        upstream_commit: OMBRE_UPSTREAM_COMMIT,
        policy_digest: ombreRecallPolicyDigest(),
      }));
      return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      let result;
      try {
        result = handleOmbreRecallRpc(JSON.parse(body), options);
      } catch {
        result = errorResponse(null, -32700, 'Parse error');
      }
      response.writeHead(result === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(result === null ? '' : JSON.stringify(result));
    });
  });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const host = process.env.OMBRE_RECALL_BIND_HOST || DEFAULT_HOST;
  const port = Number(process.env.OMBRE_RECALL_PORT || DEFAULT_PORT);
  createOmbreRecallServer({ host }).listen(port, host, () => {
    process.stdout.write(`ombre-recall listening http://${host}:${port}/mcp\n`);
  });
}
