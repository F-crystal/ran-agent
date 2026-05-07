import { MediaReaderError } from './assetResolver.mjs';
import { analyzeImageOcrWithDashScope, isDashScopeProvider } from './dashscopeProvider.mjs';

export async function analyzeImageOcr(asset, options = {}) {
  if (options.ocrProvider?.analyzeImage) {
    return await options.ocrProvider.analyzeImage(asset, options);
  }
  const provider = String(options.env?.PERSONAL_AGENT_OCR_PROVIDER || '').trim();
  if (isDashScopeProvider(provider, options.env)) {
    return await analyzeImageOcrWithDashScope(asset, options);
  }
  if (!provider) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: OCR provider is not configured');
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', `DEPENDENCY_MISSING: OCR provider adapter is not available: ${provider}`);
}
