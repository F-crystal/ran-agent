import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCoReadingTools } from '../src/coReading/mcpServer.mjs';
import { PROTECTED_MCP_NAMES } from '../src/externalMcp/protectedCapabilities.mjs';
import { handleMediaGenerationMcpRequest } from '../src/mediaGenerationMcpServer.mjs';
import { buildMediaReaderTools } from '../src/mediaReaderMcpServer.mjs';
import { buildPersonalMemoryTools } from '../src/personalMemoryMcpServer.mjs';
import { buildSearchHubTools } from '../src/searchHub/schema.mjs';
import { buildSocialReaderTools } from '../src/socialReaderMcpServer.mjs';
import { buildStickerCatalogTools } from '../src/stickerCatalogMcpServer.mjs';
import { OMBRE_RECALL_TOOLS, OMBRE_UPSTREAM_COMMIT } from '../src/ombreRecallPolicy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORBIDDEN_PRIVATE_KEYS = /^(actorKey|capability|evidenceDigest|issuer|nonce|operationId|receipt|requestRef)$/i;
const TOOL_NAMES = Object.freeze({
  search_hub: ['search', 'read', 'research'],
  social_reader: ['resolve_social_url', 'read_social_post', 'read_social_post_deep', 'read_music_share'],
  media_reader: ['extract_media_assets', 'analyze_image', 'resolve_platform_media', 'transcribe_audio', 'analyze_video', 'analyze_media_batch', 'search_media_artifacts'],
  personal_memory: ['check_personal_memory_backend', 'recall_personal_memory', 'surface_relevant_context'],
  ombre_memory: ['ombre_recall_search', 'ombre_recall_read'],
  co_reading: [
    'reading_list_books', 'reading_list_chunks', 'reading_get_progress', 'reading_continue',
    'reading_read_chunk', 'reading_get_context_window', 'reading_search', 'reading_list_annotations',
    'reading_read_thread', 'reading_get_storage_stats', 'reading_list_events', 'reading_import_book',
    'reading_import_pasted_text', 'reading_add_annotation', 'reading_share_annotation',
    'reading_reply_to_annotation', 'reading_mark_progress', 'reading_archive_book',
    'reading_restore_book', 'reading_delete_book', 'reading_cleanup_trash',
  ],
  sticker_catalog_lite: ['sticker_tags', 'sticker_pick', 'sticker_attach', 'sticker_save_from_inbox'],
  sticker_catalog_full: ['sticker_tags', 'sticker_pick', 'sticker_attach', 'sticker_save_from_inbox', 'sticker_update', 'sticker_delete', 'sticker_list'],
  media_generation: ['generate_image', 'generate_speech'],
});

function yamlList(text, section, key) {
  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line === `${section}:`);
  assert.notEqual(sectionIndex, -1, `missing YAML section ${section}`);
  const keyIndex = lines.findIndex((line, index) => index > sectionIndex && line === `  ${key}:`);
  assert.notEqual(keyIndex, -1, `missing YAML list ${section}.${key}`);
  const values = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || /^  \S/.test(line)) break;
    const match = line.match(/^    - (.+)$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function yamlTopMapKeys(text, section) {
  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line === `${section}:`);
  assert.notEqual(sectionIndex, -1, `missing YAML section ${section}`);
  const values = [];
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    const match = line.match(/^  ([a-zA-Z0-9_]+):$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function collectKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    output.push(key);
    collectKeys(item, output);
  }
  return output;
}

test('current companion profile retains personal memory and retires standalone Obsidian', async () => {
  const text = await readFile(path.join(ROOT, 'hermes/profile/config.companion.yaml'), 'utf8');
  const values = yamlList(text.replace('cli: &companion_toolsets', 'cli:'), 'platform_toolsets', 'cli');
  assert.equal(values.includes('web'), false);
  assert.equal(values.includes('mcp-search_hub'), true);
  assert.equal(values.includes('mcp-personal_memory'), true);
  assert.equal(values.includes('mcp-obsidian_memory'), false);
  assert.match(text, /^  api_server: \*companion_toolsets$/m);
  const servers = yamlTopMapKeys(text, 'mcp_servers');
  assert.equal(servers.includes('personal_memory'), true);
  assert.equal(servers.includes('obsidian_memory'), false);
});

test('protected locally-owned MCP tool names and public schemas stay exact', async () => {
  const mediaGeneration = await handleMediaGenerationMcpRequest({ method: 'tools/list' });
  const actual = {
    search_hub: buildSearchHubTools(),
    social_reader: buildSocialReaderTools({}),
    media_reader: buildMediaReaderTools(),
    personal_memory: buildPersonalMemoryTools(),
    ombre_memory: OMBRE_RECALL_TOOLS,
    co_reading: buildCoReadingTools(),
    sticker_catalog_lite: buildStickerCatalogTools({ profileMode: 'lite' }),
    sticker_catalog_full: buildStickerCatalogTools({ profileMode: 'full' }),
    media_generation: mediaGeneration.tools,
  };
  for (const [name, tools] of Object.entries(actual)) {
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES[name], name);
    const privateKeys = collectKeys(tools).filter((key) => FORBIDDEN_PRIVATE_KEYS.test(key));
    assert.deepEqual(privateKeys, [], `${name} leaked private receipt schema keys`);
  }
  assert.equal(OMBRE_UPSTREAM_COMMIT, '0e83d4671ce1629e03ad36bb9160235bf60dbd34');
});

test('runtime protected namespace matches supported source MCPs', () => {
  assert.deepEqual([...PROTECTED_MCP_NAMES], [
    'search_hub', 'social_reader', 'media_reader', 'personal_memory', 'ombre_memory',
    'co_reading', 'sticker_catalog', 'media_generation', 'time', 'playwright',
  ]);
  assert.equal(new Set(PROTECTED_MCP_NAMES).size, PROTECTED_MCP_NAMES.length);
});
