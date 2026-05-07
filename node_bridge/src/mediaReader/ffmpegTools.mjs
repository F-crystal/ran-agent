import { MediaReaderError } from './assetResolver.mjs';

export async function analyzeVideoWithFfmpeg(asset, options = {}) {
  if (options.ffmpegProvider?.analyzeVideo) {
    return await options.ffmpegProvider.analyzeVideo(asset, options);
  }
  throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: ffmpeg/ffprobe adapter is not configured');
}
