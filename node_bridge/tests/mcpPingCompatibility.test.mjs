import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { handleCoReadingMcpRequest } from '../src/coReading/mcpServer.mjs';
import { handleExternalMcpGatewayMcpRequest } from '../src/externalMcp/gatewayMcpServer.mjs';
import { handleMediaGenerationMcpRequest } from '../src/mediaGenerationMcpServer.mjs';
import { handleMediaReaderMcpRequest } from '../src/mediaReaderMcpServer.mjs';
import { handlePersonalMemoryMcpRequest } from '../src/personalMemoryMcpServer.mjs';
import { handleSearchHubMcpRequest } from '../src/searchHubMcpServer.mjs';
import { handleSocialReaderMcpRequest } from '../src/socialReaderMcpServer.mjs';
import { handleStickerCatalogMcpRequest } from '../src/stickerCatalogMcpServer.mjs';

const servers = {
  co_reading: [handleCoReadingMcpRequest, '../src/coReading/mcpServer.mjs'],
  external_mcp_gateway: [handleExternalMcpGatewayMcpRequest, '../src/externalMcp/gatewayMcpServer.mjs'],
  media_generation: [handleMediaGenerationMcpRequest, '../src/mediaGenerationMcpServer.mjs'],
  media_reader: [handleMediaReaderMcpRequest, '../src/mediaReaderMcpServer.mjs'],
  personal_memory: [handlePersonalMemoryMcpRequest, '../src/personalMemoryMcpServer.mjs'],
  search_hub: [handleSearchHubMcpRequest, '../src/searchHubMcpServer.mjs'],
  social_reader: [handleSocialReaderMcpRequest, '../src/socialReaderMcpServer.mjs'],
  sticker_catalog: [handleStickerCatalogMcpRequest, '../src/stickerCatalogMcpServer.mjs'],
};

for (const [name, [handler]] of Object.entries(servers)) {
  test(`${name} acknowledges MCP ping without entering tool dispatch`, async () => {
    const request = new Proxy({ method: 'ping' }, {
      get(target, property) {
        if (property === 'method') return target.method;
        assert.fail(`${name} ping must not inspect request.${String(property)}`);
      },
    });
    const options = new Proxy({}, {
      get(_target, property) {
        assert.fail(`${name} ping must not inspect options.${String(property)}`);
      },
      has(_target, property) {
        assert.fail(`${name} ping must not inspect options.${String(property)}`);
      },
      ownKeys() {
        assert.fail(`${name} ping must not enumerate options`);
      },
      getOwnPropertyDescriptor(_target, property) {
        assert.fail(`${name} ping must not inspect options.${String(property)}`);
      },
    });
    const result = await handler(request, options);
    assert.deepEqual(result, {});
  });
}

for (const [name, [, relativePath]] of Object.entries(servers)) {
  test(`${name} stdio transport preserves the ping id and empty result`, () => {
    const server = fileURLToPath(new URL(relativePath, import.meta.url));
    const request = JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'ping' });
    const completed = spawnSync(process.execPath, [server], {
      encoding: 'utf8',
      env: { NODE_NO_WARNINGS: '1' },
      input: `${request}\n`,
      timeout: 5000,
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.stderr, '');
    assert.deepEqual(JSON.parse(completed.stdout.trim()), {
      jsonrpc: '2.0',
      id: 41,
      result: {},
    });
  });
}
