import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { MediaReaderError } from './assetResolver.mjs';

const execFile = promisify(childProcess.execFile);

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
  ];
}

export async function analyzeImageOcrWithPaddle(asset, options = {}) {
  const env = options.env || process.env;
  const command = String(env.PERSONAL_AGENT_PADDLEOCR_COMMAND || 'paddleocr').trim();
  const execFileImpl = options.execFileImpl || execFile;
  const childEnv = {
    ...process.env,
    ...env,
    FLAGS_use_mkldnn: String(env.FLAGS_use_mkldnn || 'false'),
  };
  let result;
  try {
    result = await execFileImpl(command, paddleArgs(asset, env), {
      env: childEnv,
      timeout: Number(env.PERSONAL_AGENT_PADDLEOCR_TIMEOUT_MS || 120000),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: PaddleOCR command is not installed or not in PATH');
    }
    throw new MediaReaderError('OCR_FAILED', `OCR_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = parsePaddleOutput(result.stdout);
  return {
    text: payload.text,
    blocks: payload.blocks,
    model: 'paddleocr',
  };
}
