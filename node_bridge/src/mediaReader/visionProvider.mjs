import { MediaReaderError } from './assetResolver.mjs';
import { analyzeImageVisionWithDashScope, isDashScopeProvider } from './dashscopeProvider.mjs';
import { analyzeImageVisionWithQwenMm, isQwenMmProvider } from './qwenMmProvider.mjs';

export async function analyzeImageVision(asset, options = {}) {
  if (options.visionProvider?.analyzeImage) {
    return await options.visionProvider.analyzeImage(asset, options);
  }
  const provider = String(options.env?.PERSONAL_AGENT_VISION_PROVIDER || '').trim();
  if (isQwenMmProvider(provider)) {
    return await analyzeImageVisionWithQwenMm(asset, options);
  }
  if (isDashScopeProvider(provider, options.env)) {
    return await analyzeImageVisionWithDashScope(asset, options);
  }
  if (!provider) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: vision provider is not configured');
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', `DEPENDENCY_MISSING: vision provider adapter is not available: ${provider}`);
}
