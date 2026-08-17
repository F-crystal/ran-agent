import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  getSearchHubConfig,
  isPlaywrightFallbackAllowed,
  isOpencliBrowserAllowed,
} from '../src/searchHub/schema.mjs';

function platformToolsets(text) {
  return text.split('\nmcp_servers:')[0].split('\nplatform_toolsets:')[1] || '';
}

test('profile mode auto resolves lite from ran-assistant-lite profile names', () => {
  const config = getSearchHubConfig({
    SEARCH_HUB_PROFILE_MODE: 'auto',
    HERMES_PROFILE: 'ran-assistant-lite',
    API_SERVER_MODEL_NAME: 'ran-assistant-lite',
  });

  assert.equal(config.profileMode, 'lite');
  assert.equal(isOpencliBrowserAllowed(config), false);
  assert.equal(isPlaywrightFallbackAllowed(config), false);
  assert.equal(config.publicOnlyDefault, true);
});

test('profile mode auto resolves full from ran-assistant profile names', () => {
  const config = getSearchHubConfig({
    SEARCH_HUB_PROFILE_MODE: 'auto',
    HERMES_PROFILE: 'ran-assistant',
    API_SERVER_MODEL_NAME: 'ran-assistant',
  });

  assert.equal(config.profileMode, 'full');
  assert.equal(isOpencliBrowserAllowed(config), true);
  assert.equal(isPlaywrightFallbackAllowed(config), true);
  assert.equal(config.publicOnlyDefault, false);
});

test('source Hermes configs register search_hub in lite and full profiles', () => {
  const full = readFileSync(new URL('../../hermes/profile/config.yaml', import.meta.url), 'utf8');
  const lite = readFileSync(new URL('../../hermes/profile/config.lite.yaml', import.meta.url), 'utf8');

  for (const text of [full, lite]) {
    assert.match(text, /mcp-search_hub/);
    assert.match(text, /^\s{2}search_hub:/m);
    assert.match(text, /start_search_hub_mcp\.sh/);
  }
  assert.doesNotMatch(platformToolsets(lite), /mcp-playwright\s*$/m);
  assert.doesNotMatch(platformToolsets(lite), /mcp-media_generation\s*$/m);
  assert.match(platformToolsets(full), /mcp-playwright/);
  assert.match(full, /SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK:\s+"true"/);
  assert.match(platformToolsets(full), /mcp-media_generation/);
});

test('companion profile exposes search_hub without the competing generic web toolset', () => {
  const companion = readFileSync(new URL('../../hermes/profile/config.companion.yaml', import.meta.url), 'utf8');
  const toolsets = platformToolsets(companion);

  assert.match(toolsets, /mcp-search_hub/);
  assert.doesNotMatch(toolsets, /^\s*- web\s*$/m);
  assert.doesNotMatch(companion, /^web:\s*$/m);
  assert.match(companion, /^  search_hub:\s*$/m);
  assert.match(companion, /SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK:\s+"true"/);
});

test('lite profile keeps co_reading out of conversational toolset while full keeps it', () => {
  const full = readFileSync(new URL('../../hermes/profile/config.yaml', import.meta.url), 'utf8');
  const lite = readFileSync(new URL('../../hermes/profile/config.lite.yaml', import.meta.url), 'utf8');
  const apply = readFileSync(new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url), 'utf8');

  assert.doesNotMatch(platformToolsets(lite), /mcp-co_reading/);
  assert.doesNotMatch(lite, /^\s{2}co_reading:/m);
  assert.match(platformToolsets(full), /mcp-co_reading/);
  assert.match(full, /^\s{2}co_reading:/m);
  assert.match(apply, /mcp-co_reading/);
});

test('repo MCP config and apply script know search_hub', () => {
  const mcp = JSON.parse(readFileSync(new URL('../../.mcp.json', import.meta.url), 'utf8'));
  const apply = readFileSync(new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url), 'utf8');

  assert.deepEqual(mcp.mcpServers.search_hub.args, ['scripts/start_search_hub_mcp.sh']);
  assert.match(apply, /SEARCH_HUB_PROFILE_MODE=lite/);
  assert.match(apply, /SEARCH_HUB_PROFILE_MODE=full/);
  assert.match(apply, /mcp-search_hub/);
  assert.match(apply, /start_search_hub_mcp\.sh/);
});

test('lite and full profiles register sticker_catalog MCP with public usage boundary', () => {
  const full = readFileSync(new URL('../../hermes/profile/config.yaml', import.meta.url), 'utf8');
  const lite = readFileSync(new URL('../../hermes/profile/config.lite.yaml', import.meta.url), 'utf8');
  const agents = readFileSync(new URL('../../hermes/profile/AGENTS.md', import.meta.url), 'utf8');

  for (const text of [full, lite]) {
    assert.match(platformToolsets(text), /mcp-sticker_catalog/);
    assert.match(text, /^\s{2}sticker_catalog:/m);
    assert.match(text, /start_sticker_catalog_mcp\.sh/);
  }
  assert.match(lite, /STICKER_CATALOG_PROFILE_MODE:\s+lite/);
  assert.match(lite, /STICKER_CATALOG_ALLOW_RUNTIME_SAVE:\s+"true"/);
  assert.match(full, /STICKER_CATALOG_PROFILE_MODE:\s+full/);
  assert.match(full, /STICKER_CATALOG_ALLOW_RUNTIME_SAVE:\s+"true"/);
  assert.match(agents, /sticker_tags/);
  assert.match(agents, /sticker_pick/);
  assert.match(agents, /sticker_attach/);
  assert.match(agents, /lite.*sticker_tags\/sticker_pick\/sticker_attach\/sticker_save_from_inbox/s);
});

test('repo MCP config and apply script know sticker_catalog', () => {
  const mcp = JSON.parse(readFileSync(new URL('../../.mcp.json', import.meta.url), 'utf8'));
  const apply = readFileSync(new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url), 'utf8');

  assert.deepEqual(mcp.mcpServers.sticker_catalog.args, ['scripts/start_sticker_catalog_mcp.sh']);
  assert.match(apply, /mcp-sticker_catalog/);
  assert.match(apply, /start_sticker_catalog_mcp\.sh/);
});

test('Hermes profiles no longer expose retired mimo_power MCP', () => {
  const full = readFileSync(new URL('../../hermes/profile/config.yaml', import.meta.url), 'utf8');
  const lite = readFileSync(new URL('../../hermes/profile/config.lite.yaml', import.meta.url), 'utf8');
  const mcp = JSON.parse(readFileSync(new URL('../../.mcp.json', import.meta.url), 'utf8'));
  const apply = readFileSync(new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url), 'utf8');

  for (const text of [full, lite, apply]) {
    assert.doesNotMatch(text, /mcp-mimo_power/);
    assert.doesNotMatch(text, /^\s{2}mimo_power:/m);
  }
  assert.equal(Object.hasOwn(mcp.mcpServers, 'mimo_power'), false);
});
