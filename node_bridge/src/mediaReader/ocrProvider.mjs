import { MediaReaderError } from './assetResolver.mjs';
import { analyzeImageOcrWithDashScope, isDashScopeProvider } from './dashscopeProvider.mjs';
import { analyzeImageOcrWithPaddle } from './paddleOcrProvider.mjs';
import { analyzeImageOcrWithQwenMm, isQwenMmProvider } from './qwenMmProvider.mjs';

export async function analyzeImageOcr(asset, options = {}) {
  if (options.ocrProvider?.analyzeImage) {
    return await options.ocrProvider.analyzeImage(asset, options);
  }
  const provider = String(options.env?.PERSONAL_AGENT_OCR_PROVIDER || '').trim();
  if (!provider || provider.toLowerCase() === 'paddleocr' || provider.toLowerCase() === 'paddle') {
    return await analyzeImageOcrWithPaddle(asset, options);
  }
  if (isQwenMmProvider(provider)) {
    return await analyzeImageOcrWithQwenMm(asset, options);
  }
  if (isDashScopeProvider(provider, options.env)) {
    return await analyzeImageOcrWithDashScope(asset, options);
  }
  if (!provider) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: OCR provider is not configured');
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', `DEPENDENCY_MISSING: OCR provider adapter is not available: ${provider}`);
}
