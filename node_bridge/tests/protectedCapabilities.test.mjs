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
const MANIFEST_PATH = path.join(ROOT, 'docs/governance/hermes_protected_capabilities.v1.json');
const FORBIDDEN_PRIVATE_KEYS = /^(actorKey|capability|evidenceDigest|issuer|nonce|operationId|receipt|requestRef)$/i;

async function loadManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

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

test('protected capability manifest pins exact source full/lite profiles', async () => {
  const manifest = await loadManifest();
  for (const [profile, filename] of [['full', 'config.yaml'], ['lite', 'config.lite.yaml']]) {
    const text = await readFile(path.join(ROOT, 'hermes/profile', filename), 'utf8');
    const expectedToolsets = manifest.profiles[profile].sourceToolsets;
    assert.deepEqual(yamlList(text, 'platform_toolsets', 'cli'), expectedToolsets);
    assert.deepEqual(yamlList(text, 'platform_toolsets', 'gateway'), expectedToolsets);
    assert.deepEqual(yamlTopMapKeys(text, 'mcp_servers'), manifest.profiles[profile].sourceMcpServers);
    assert.deepEqual(
      new Set(expectedToolsets),
      new Set([
        ...manifest.profiles[profile].requiredToolsets,
        ...Object.keys(manifest.profiles[profile].conditionalToolsets),
      ]),
    );
    for (const forbidden of manifest.profiles[profile].forbiddenToolsets) {
      assert.equal(expectedToolsets.includes(forbidden), false, `${profile} exposes ${forbidden}`);
    }
  }
});

test('protected locally-owned MCP tool names and public schemas stay exact', async () => {
  const manifest = await loadManifest();
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
    assert.deepEqual(tools.map((tool) => tool.name), manifest.locallyOwnedServers[name].toolNames, name);
    const privateKeys = collectKeys(tools).filter((key) => FORBIDDEN_PRIVATE_KEYS.test(key));
    assert.deepEqual(privateKeys, [], `${name} leaked private receipt schema keys`);
  }
  assert.equal(manifest.locallyOwnedServers.ombre_memory.mode, 'local-recall-only');
  assert.equal(manifest.locallyOwnedServers.ombre_memory.upstreamCommit, OMBRE_UPSTREAM_COMMIT);
  assert.equal(manifest.liveFingerprintOnly.includes('ombre_memory'), false);
});

test('runtime protected namespace exactly matches the governed manifest', async () => {
  const manifest = await loadManifest();
  assert.deepEqual([...PROTECTED_MCP_NAMES], manifest.reservedMcpNames);
  assert.equal(new Set(PROTECTED_MCP_NAMES).size, PROTECTED_MCP_NAMES.length);
});
