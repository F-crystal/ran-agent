import { MediaReaderError } from './assetResolver.mjs';
import { isDashScopeProvider, transcribeAudioWithDashScope } from './dashscopeProvider.mjs';

export async function transcribeAudioProvider(asset, options = {}) {
  if (options.asrProvider?.transcribeAudio) {
    return await options.asrProvider.transcribeAudio(asset, options);
  }
  const provider = String(options.env?.PERSONAL_AGENT_ASR_PROVIDER || '').trim();
  if (isDashScopeProvider(provider, options.env)) {
    return await transcribeAudioWithDashScope(asset, options);
  }
  if (!provider) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: ASR provider is not configured');
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', `DEPENDENCY_MISSING: ASR provider adapter is not available: ${provider}`);
}
