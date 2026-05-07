import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { MediaReaderError } from './assetResolver.mjs';

const execFile = promisify(childProcess.execFile);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function paddleTimeoutMs(env = process.env) {
  return positiveInt(
    env.PERSONAL_AGENT_PADDLEOCR_TIMEOUT_MS,
    positiveInt(env.PERSONAL_AGENT_OCR_TIMEOUT_MS, 15000)
  );
}

function logOcrPhase(options, phase, startedAt, extra = {}) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const payload = {
    component: 'media_reader',
    event: phase,
    elapsed_ms: elapsedMs,
  };
  if (extra.exit_code !== undefined) payload.exit_code = extra.exit_code;
  if (extra.error_code) payload.error_code = extra.error_code;
  const logger = options.ocrLogImpl || console.error;
  logger(JSON.stringify(payload));
}

function parseMaybeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const objectStart = raw.indexOf('{');
    const objectEnd = raw.lastIndexOf('}');
    const arrayStart = raw.indexOf('[');
    const arrayEnd = raw.lastIndexOf(']');
    const candidates = [];
    if (objectStart !== -1 && objectEnd > objectStart) {
      candidates.push(raw.slice(objectStart, objectEnd + 1));
    }
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      candidates.push(raw.slice(arrayStart, arrayEnd + 1));
    }
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next JSON-looking span; PaddleOCR may print logs around JSON.
      }
    }
    return null;
  }
}

function collectTextBlocks(value, output = []) {
  if (!value) {
    return output;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push({ text });
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextBlocks(item, output);
    }
    return output;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'rec_text', 'transcription', 'label']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        output.push({ text: value[key].trim() });
      }
    }
    for (const key of ['blocks', 'results', 'data', 'ocr_result', 'res', 'rec_texts']) {
      if (value[key]) {
        collectTextBlocks(value[key], output);
      }
    }
  }
  return output;
}

function parsePaddleOutput(stdout) {
  const parsed = parseMaybeJson(stdout);
  if (parsed && typeof parsed === 'object') {
    const directText = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const blocks = collectTextBlocks(parsed);
    const text = directText || blocks.map((block) => block.text).filter(Boolean).join('\n');
    return { text, blocks };
  }
  const text = String(stdout || '').trim();
  return {
    text,
    blocks: text ? text.split(/\r?\n/).map((line) => ({ text: line })).filter((block) => block.text) : [],
  };
}

function paddleArgs(asset, env = process.env) {
  const configured = String(env.PERSONAL_AGENT_PADDLEOCR_ARGS || '').trim();
  if (configured) {
    try {
      return JSON.parse(configured).map((item) => String(item).replace('{image}', asset.file_path));
    } catch {
      throw new MediaReaderError('OCR_FAILED', 'OCR_FAILED: PERSONAL_AGENT_PADDLEOCR_ARGS must be a JSON string array');
    }
  }
  return [
    'ocr',
    '-i',
    asset.file_path,
    '--use_doc_orientation_classify',
    'False',
    '--use_doc_unwarping',
    'False',
    '--use_textline_orientation',
    'False',
    '--device',
    'cpu',
    '--enable_mkldnn',
    'False',
  ];
}

export async function analyzeImageOcrWithPaddle(asset, options = {}) {
  const env = options.env || process.env;
  const command = String(env.PERSONAL_AGENT_PADDLEOCR_COMMAND || 'paddleocr').trim();
  const execFileImpl = options.execFileImpl || execFile;
  const timeout = paddleTimeoutMs(env);
  const startedAt = Date.now();
  const childEnv = {
    ...process.env,
    ...env,
    FLAGS_use_mkldnn: String(env.FLAGS_use_mkldnn || 'false'),
    FLAGS_use_onednn: String(env.FLAGS_use_onednn || 'false'),
  };
  let result;
  try {
    logOcrPhase(options, 'ocr_start', startedAt);
    logOcrPhase(options, 'ocr_spawn', startedAt);
    logOcrPhase(options, 'ocr_model_init_or_first_run', startedAt);
    result = await execFileImpl(command, paddleArgs(asset, env), {
      env: childEnv,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      logOcrPhase(options, 'ocr_exit', startedAt, { exit_code: null, error_code: 'DEPENDENCY_MISSING' });
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: PaddleOCR command is not installed or not in PATH');
    }
    if (error?.killed || error?.signal === 'SIGKILL' || /timed out|timeout/i.test(String(error?.message || ''))) {
      logOcrPhase(options, 'ocr_timeout', startedAt, { error_code: 'OCR_TIMEOUT' });
      logOcrPhase(options, 'ocr_exit', startedAt, { exit_code: error?.code ?? null, error_code: 'OCR_TIMEOUT' });
      throw new MediaReaderError('OCR_TIMEOUT', `OCR_TIMEOUT: PaddleOCR exceeded ${timeout}ms`);
    }
    logOcrPhase(options, 'ocr_exit', startedAt, { exit_code: error?.code ?? null, error_code: 'OCR_FAILED' });
    throw new MediaReaderError('OCR_FAILED', `OCR_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  logOcrPhase(options, 'ocr_exit', startedAt, { exit_code: 0 });
  const payload = parsePaddleOutput(result.stdout);
  return {
    text: payload.text,
    blocks: payload.blocks,
    model: 'paddleocr',
  };
}
