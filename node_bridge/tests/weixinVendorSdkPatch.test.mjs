import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const VENDOR_SDK_PATH = new URL('../vendor/weixin-agent-sdk/dist/index.mjs', import.meta.url);

test('vendored weixin sdk respects explicit file media type for wav attachments', () => {
  const source = fs.readFileSync(VENDOR_SDK_PATH, 'utf8');

  assert.match(
    source,
    /mediaType:\s*response\.media\.type/,
    'runtime send path must pass ChatResponse.media.type into sendWeixinMediaFile'
  );
  assert.match(
    source,
    /if\s*\(\s*mediaType\s*!==\s*"file"\s*&&\s*mime\.startsWith\("audio\/"\)\s*\)/,
    'audio MIME routing must not override an explicit file attachment response'
  );
});
