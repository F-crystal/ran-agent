import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MediaReaderError } from './assetResolver.mjs';
import { sha256Bytes } from './cacheStore.mjs';
import { analyzeImageOcr } from './ocrProvider.mjs';
import { analyzeImageVision } from './visionProvider.mjs';
import { transcribeAudioProvider } from './asrProvider.mjs';

const execFile = promisify(childProcess.execFile);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value, fallback) {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function commandErrorCode(error, fallback) {
  if (error?.code === 'ENOENT') {
    return 'DEPENDENCY_MISSING';
  }
  return fallback;
}

async function runCommand(command, args, options = {}, errorCode = 'DOWNLOAD_FAILED') {
  const execFileImpl = options.execFileImpl || execFile;
  try {
    return await execFileImpl(command, args, {
      timeout: positiveInt(options.env?.PERSONAL_AGENT_FFMPEG_TIMEOUT_MS, 120000),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const code = commandErrorCode(error, errorCode);
    throw new MediaReaderError(code, `${code}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFfprobe(stdout) {
  try {
    const payload = JSON.parse(String(stdout || '{}'));
    const duration = positiveNumber(payload?.format?.duration, 0);
    const videoStream = Array.isArray(payload?.streams)
      ? payload.streams.find((stream) => stream?.codec_type === 'video')
      : null;
    return {
      duration_seconds: duration,
      format_name: String(payload?.format?.format_name || ''),
      width: Number(videoStream?.width || 0),
      height: Number(videoStream?.height || 0),
    };
  } catch {
    throw new MediaReaderError('FFPROBE_FAILED', 'FFPROBE_FAILED: ffprobe returned invalid JSON');
  }
}

function frameAssetFromPath(filePath, sourceAsset) {
  const bytes = fs.readFileSync(filePath);
  return {
    type: 'image',
    file_path: filePath,
    mime: 'image/png',
    content_sha256: sha256Bytes(bytes),
    content_length: bytes.length,
    url_host: sourceAsset.url_host || '',
    url_redacted: sourceAsset.url_redacted || '',
  };
}

export async function analyzeVideoWithFfmpeg(asset, options = {}) {
  if (options.ffmpegProvider?.analyzeVideo) {
    return await options.ffmpegProvider.analyzeVideo(asset, options);
  }
  const env = options.env || process.env;
  const args = options.args || {};
  const ffprobePath = String(env.PERSONAL_AGENT_FFPROBE_PATH || 'ffprobe').trim();
  const ffmpegPath = String(env.PERSONAL_AGENT_FFMPEG_PATH || 'ffmpeg').trim();
  const maxFrames = positiveInt(args.max_frames || env.PERSONAL_AGENT_VIDEO_MAX_FRAMES, 12);
  const maxSeconds = positiveNumber(args.max_seconds || env.PERSONAL_AGENT_VIDEO_MAX_SECONDS, 180);
  const includeAudio = args.include_audio !== false;
  const includeOcr = args.include_ocr !== false;
  const includeVlm = args.include_vlm !== false;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-media-video-'));

  const probe = await runCommand(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', asset.file_path],
    options,
    'FFPROBE_FAILED'
  );
  const metadata = parseFfprobe(probe.stdout);
  if (metadata.duration_seconds > maxSeconds) {
    throw new MediaReaderError('VIDEO_TOO_LONG', 'VIDEO_TOO_LONG: video duration exceeds configured limit', {
      duration_seconds: metadata.duration_seconds,
      max_seconds: maxSeconds,
    });
  }

  const framePattern = path.join(workDir, 'frame_%03d.png');
  const fps = metadata.duration_seconds > 0
    ? Math.max(0.1, Math.min(4, maxFrames / metadata.duration_seconds))
    : 1;
  await runCommand(
    ffmpegPath,
    ['-y', '-i', asset.file_path, '-vf', `fps=${fps.toFixed(4)}`, '-frames:v', String(maxFrames), framePattern],
    options,
    'FRAME_EXTRACTION_FAILED'
  );
  const framePaths = fs.readdirSync(workDir)
    .filter((name) => /^frame_\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(workDir, name));

  const frames = [];
  for (let index = 0; index < framePaths.length; index += 1) {
    const frameAsset = frameAssetFromPath(framePaths[index], asset);
    const ocr = includeOcr ? await analyzeImageOcr(frameAsset, options) : { text: '', blocks: [], model: '' };
    const vision = includeVlm ? await analyzeImageVision(frameAsset, options) : { summary: '', objects: [], model: '' };
    frames.push({
      frame_index: index,
      content_sha256: frameAsset.content_sha256,
      ocr_text: String(ocr.text || ''),
      visible_text_blocks: Array.isArray(ocr.blocks) ? ocr.blocks : [],
      scene_summary: String(vision.summary || ''),
      objects: Array.isArray(vision.objects) ? vision.objects : [],
      model: { ocr: ocr.model || '', vlm: vision.model || '' },
    });
  }

  let asr = {};
  const warnings = [];
  if (includeAudio) {
    const audioPath = path.join(workDir, 'audio.wav');
    try {
      await runCommand(
        ffmpegPath,
        ['-y', '-i', asset.file_path, '-vn', '-ac', '1', '-ar', '16000', audioPath],
        options,
        'AUDIO_EXTRACTION_FAILED'
      );
      const bytes = fs.readFileSync(audioPath);
      asr = await transcribeAudioProvider({
        type: 'audio',
        file_path: audioPath,
        mime: 'audio/wav',
        content_sha256: sha256Bytes(bytes),
        content_length: bytes.length,
        url_host: asset.url_host || '',
        url_redacted: asset.url_redacted || '',
      }, options);
    } catch (error) {
      if (error instanceof MediaReaderError) {
        warnings.push(error.error_code);
      } else {
        warnings.push('AUDIO_EXTRACTION_FAILED');
      }
    }
  }

  const visualSummary = frames.map((frame) => frame.scene_summary).filter(Boolean).join('\n');
  const audioSummary = String(asr.transcript || '');
  return {
    metadata,
    frames,
    asr,
    timeline: frames.map((frame) => ({
      frame_index: frame.frame_index,
      summary: frame.scene_summary || frame.ocr_text || '',
    })),
    visual_summary: visualSummary,
    audio_summary: audioSummary,
    overall_summary: [visualSummary, audioSummary].filter(Boolean).join('\n'),
    warnings,
  };
}
