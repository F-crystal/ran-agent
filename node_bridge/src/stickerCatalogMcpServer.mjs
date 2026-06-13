#!/usr/bin/env node
import readline from 'node:readline';

import {
  deleteStickers,
  listStickerTags,
  listStickers,
  pickStickers,
  resolveStickerAsset,
  saveStickersFromInbox,
  updateStickers,
} from './stickerCatalog.mjs';
import { buildRanMediaStickerMarker } from './replyMediaMarkers.mjs';

const SERVER_INFO = {
  name: 'ran-agent-sticker-catalog',
  version: '0.1.0',
};

const PUBLIC_TOOLS = new Set(['sticker_tags', 'sticker_pick', 'sticker_attach']);
const SAVE_TOOL = 'sticker_save_from_inbox';
const LITE_TOOLS = new Set([...PUBLIC_TOOLS, SAVE_TOOL]);
const OWNER_TOOLS = new Set([SAVE_TOOL, 'sticker_update', 'sticker_delete', 'sticker_list']);

export function buildStickerCatalogTools(options = {}) {
  const mode = stickerCatalogProfileMode(options);
  const tools = [
    {
      name: 'sticker_tags',
      title: 'Sticker Tags',
      description: 'List available sticker tags. Use before choosing a sticker for a stronger emotional reaction.',
      inputSchema: schema({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'sticker_pick',
      title: 'Sticker Pick',
      description: 'Pick sticker candidates by tag or text query. Returns public sticker metadata only.',
      inputSchema: schema({
        tag: str(),
        query: str(),
        limit: int(1, 20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'sticker_attach',
      title: 'Sticker Attach',
      description: 'Build a RAN_MEDIA marker for one catalog sticker. The bridge resolves stickerId server-side.',
      inputSchema: schema({
        stickerId: str(),
        caption: str(),
      }, ['stickerId']),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'sticker_save_from_inbox',
      title: 'Sticker Save From Inbox',
      description: 'Save explicitly requested trusted inbound media files into the sticker catalog.',
      inputSchema: schema({
        items: arr({
          type: 'object',
          properties: {
            filePath: str(),
            tags: arr(str()),
            desc: str(),
            source: str(['manual', 'wechat', 'feishu', 'import']),
          },
          required: ['filePath'],
          additionalProperties: false,
        }),
      }, ['items']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'sticker_update',
      title: 'Sticker Update',
      description: 'Owner-only update of sticker tags or description.',
      inputSchema: ownerSchema({
        items: arr({
          type: 'object',
          properties: {
            stickerId: str(),
            tags: arr(str()),
            desc: str(),
          },
          required: ['stickerId'],
          additionalProperties: false,
        }),
      }, ['items']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'sticker_delete',
      title: 'Sticker Delete',
      description: 'Owner-only soft delete of stickers from the catalog.',
      inputSchema: ownerSchema({
        items: arr({
          type: 'object',
          properties: { stickerId: str() },
          required: ['stickerId'],
          additionalProperties: false,
        }),
        hardDelete: bool(),
      }, ['items']),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: 'sticker_list',
      title: 'Sticker List',
      description: 'Owner-only catalog listing for maintenance. Public callers should use sticker_pick.',
      inputSchema: ownerSchema({
        tag: str(),
        query: str(),
        status: str(['active', 'deleted', 'all']),
        limit: int(1, 100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ];
  return mode === 'lite' ? tools.filter((tool) => LITE_TOOLS.has(tool.name)) : tools;
}

export async function handleStickerCatalogMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildStickerCatalogTools(options) };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    const args = params.arguments || {};
    if (!availableToolNames(options).has(name)) {
      return errorResult('unknown sticker catalog tool', 'STICKER_UNKNOWN_TOOL');
    }
    if (!PUBLIC_TOOLS.has(name) && !OWNER_TOOLS.has(name)) {
      return errorResult('unknown sticker catalog tool', 'STICKER_UNKNOWN_TOOL');
    }
    if (OWNER_TOOLS.has(name) && !isOwnerAuthorized(name, args, options)) {
      return errorResult('owner-only sticker catalog tool denied', 'STICKER_PERMISSION_DENIED');
    }
    try {
      return await dispatchTool(name, args, options);
    } catch (error) {
      return safeToolError(error);
    }
  }
  throw new Error(`unsupported MCP method: ${method}`);
}

function stickerCatalogProfileMode(options = {}) {
  const raw = String(options.profileMode || options.env?.STICKER_CATALOG_PROFILE_MODE || process.env.STICKER_CATALOG_PROFILE_MODE || '').trim().toLowerCase();
  return raw === 'lite' ? 'lite' : 'full';
}

function availableToolNames(options = {}) {
  return new Set(buildStickerCatalogTools(options).map((tool) => tool.name));
}

async function dispatchTool(name, args, options) {
  const env = options.env || process.env;
  if (name === 'sticker_tags') {
    return result({
      ok: true,
      tags: listStickerTags({ env }).map((item) => item.tag),
      usage: 'Pick a sticker only when a stronger emotional reaction is appropriate.',
    });
  }
  if (name === 'sticker_pick') {
    const tag = normalizeText(args.tag);
    const query = normalizeText(args.query);
    if (!tag && !query) {
      return errorResult('sticker_pick requires tag or query', 'STICKER_PICK_REQUIRES_FILTER');
    }
    const candidates = pickStickers({ tag, query, limit: args.limit }, { env }).map(publicCandidate);
    return result({ ok: true, candidates });
  }
  if (name === 'sticker_attach') {
    const stickerId = normalizeText(args.stickerId);
    let asset;
    try {
      asset = resolveStickerAsset(stickerId, { env });
    } catch {
      return errorResult('sticker not found', 'STICKER_NOT_FOUND');
    }
    const marker = buildRanMediaStickerMarker({ stickerId: asset.stickerId, caption: args.caption });
    return result({ ok: true, marker }, marker);
  }
  if (name === 'sticker_save_from_inbox') {
    return result({ ok: true, ...(await saveStickersFromInbox({ items: args.items }, { env })) });
  }
  if (name === 'sticker_update') {
    return result({ ok: true, ...updateStickers({ items: args.items }, { env }) });
  }
  if (name === 'sticker_delete') {
    return result({ ok: true, ...deleteStickers({ items: args.items, hardDelete: args.hardDelete === true }, { env }) });
  }
  if (name === 'sticker_list') {
    return result({ ok: true, stickers: listStickers(args, { env }) });
  }
  return errorResult('unknown sticker catalog tool', 'STICKER_UNKNOWN_TOOL');
}

function publicCandidate(sticker) {
  return {
    stickerId: sticker.stickerId,
    tags: Array.isArray(sticker.tags) ? [...sticker.tags] : [],
    desc: String(sticker.desc || ''),
    mime: String(sticker.mime || ''),
  };
}

function isOwnerAuthorized(toolName, args = {}, options = {}) {
  if (toolName === SAVE_TOOL && isRuntimeSaveAllowed(options)) return true;
  if (options.trustedOwner === true) return true;
  const expected = String(options.ownerToken || options.env?.STICKER_CATALOG_OWNER_TOKEN || process.env.STICKER_CATALOG_OWNER_TOKEN || '').trim();
  if (!expected) return false;
  return String(args.owner_token || '').trim() === expected;
}

function isRuntimeSaveAllowed(options = {}) {
  return String(options.env?.STICKER_CATALOG_ALLOW_RUNTIME_SAVE || process.env.STICKER_CATALOG_ALLOW_RUNTIME_SAVE || '').trim().toLowerCase() === 'true';
}

function safeToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) {
    return errorResult('sticker not found', 'STICKER_NOT_FOUND');
  }
  return errorResult('sticker catalog tool failed', 'STICKER_TOOL_ERROR');
}

function result(payload, text = '') {
  return {
    content: [{ type: 'text', text: text || JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message, errorCode) {
  const payload = { ok: false, error: String(message), error_code: errorCode };
  return {
    isError: true,
    content: [{ type: 'text', text: payload.error }],
    structuredContent: payload,
  };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function str(enumValues = null) {
  const schemaValue = { type: 'string' };
  if (enumValues) schemaValue.enum = enumValues;
  return schemaValue;
}

function bool() {
  return { type: 'boolean' };
}

function int(minimum = undefined, maximum = undefined) {
  const schemaValue = { type: 'integer' };
  if (minimum !== undefined) schemaValue.minimum = minimum;
  if (maximum !== undefined) schemaValue.maximum = maximum;
  return schemaValue;
}

function arr(items = {}) {
  return { type: 'array', items };
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function ownerSchema(properties, required = []) {
  return schema({ owner_token: str(), ...properties }, ['owner_token', ...required]);
}

function writeJsonRpcResponse(id, response) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: response })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
  })}\n`);
}

export function runStickerCatalogMcpServer(options = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) return;
    try {
      const response = await handleStickerCatalogMcpRequest(request, options);
      writeJsonRpcResponse(request.id, response);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStickerCatalogMcpServer();
}
