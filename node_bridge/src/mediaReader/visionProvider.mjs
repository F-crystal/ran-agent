import { MediaReaderError } from './assetResolver.mjs';

export async function analyzeImageVision(asset, options = {}) {
  if (options.visionProvider?.analyzeImage) {
    return await options.visionProvider.analyzeImage(asset, options);
  }
  const provider = String(options.env?.PERSONAL_AGENT_VISION_PROVIDER || '').trim();
  if (!provider) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: vision provider is not configured');
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', `DEPENDENCY_MISSING: vision provider adapter is not available: ${provider}`);
}
