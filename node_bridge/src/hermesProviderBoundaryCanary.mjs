import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeHermesIdentityVersion,
  loadPublishedProjection,
} from './hermesIdentityProjection.mjs';
import {
  getHermesGatewayConfig,
  sendChatToHermesGateway,
} from './hermesGatewayClient.mjs';

export async function runHermesProviderBoundaryCanary(options = {}) {
  const env = options.env || process.env;
  const mode = env.RAN_AGENT_PROVIDER_CANARY_MODE;
  if (!['lite', 'full'].includes(mode)) throw new Error('provider_canary_mode_invalid');
  const nonce = env.RAN_AGENT_PROVIDER_CANARY_NONCE;
  if (!/^[a-f0-9]{32,128}$/.test(nonce || '')) throw new Error('provider_canary_nonce_invalid');
  const projectRoot = path.resolve(env.RAN_AGENT_REPO_ROOT || process.cwd());
  const pointer = env.HERMES_PUBLISHED_MEMORY_CONTEXT_PATH;
  if (!pointer) throw new Error('provider_canary_projection_pointer_missing');
  const identity = computeHermesIdentityVersion(projectRoot);
  const projection = loadPublishedProjection(pointer, identity.version);
  const expected = `OMBRE_PROVIDER_CANARY_OK:${nonce}:${identity.version}:${projection.projection_revision}`;
  const result = await sendChatToHermesGateway({
    text: [
      `O1 provider-boundary canary nonce=${nonce}.`,
      'Read identity_version and projection_revision from the system-priority context.',
      'Return exactly OMBRE_PROVIDER_CANARY_OK:<nonce>:<identity_version>:<projection_revision>',
      'using their actual values and no other text.',
    ].join(' '),
    sender_id: `ombre-o1-provider-canary-${mode}`,
    platform: 'desktop',
    channel_type: 'desktop',
  }, {
    config: getHermesGatewayConfig(env),
    logger: options.logger || { log() {}, warn() {} },
  });
  let reply = String(result?.reply_text || '').trim();
  try {
    const envelope = JSON.parse(reply);
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && Object.keys(envelope).length === 1 && typeof envelope.reply_text === 'string') {
      reply = envelope.reply_text.trim();
    }
  } catch {
    // A plain exact receipt is also accepted.
  }
  if (reply !== expected) {
    throw new Error('provider_canary_response_invalid');
  }
  return {
    mode,
    identity_version: identity.version,
    projection_revision: projection.projection_revision,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await runHermesProviderBoundaryCanary())}\n`);
  } catch (error) {
    process.stderr.write(`HERMES_PROVIDER_CANARY_FAILED: ${error?.message || error}\n`);
    process.exit(1);
  }
}
