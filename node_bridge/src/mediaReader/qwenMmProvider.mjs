import path from 'node:path';
import { MediaReaderError } from './assetResolver.mjs';
import { parseJsonContent } from './dashscopeProvider.mjs';
import { callMcpToolViaStdio, textFromMcpResult } from './platformResolvers/mcpClient.mjs';
import { resolveProjectRoot } from '../trustedMediaPaths.mjs';

const DEFAULT_MODEL = 'qwen3.6-flash';

export function isQwenMmProvider(provider) {
  return String(provider || '').trim().toLowerCase() === 'qwen-mm';
}

function qwenMmModel(env) {
  return String(env.QWEN_MM_API_VL_MODEL || DEFAULT_MODEL).trim();
}

async function callQwenMm(toolName, toolArguments, errorCode, options = {}) {
  const env = options.env || process.env;
  const callMcpTool = options.qwenMmCallMcpTool || callMcpToolViaStdio;
  const timeoutMs = Number(env.PERSONAL_AGENT_OCR_TIMEOUT_MS || 120000);
  try {
    const result = await callMcpTool({
      command: path.join(resolveProjectRoot(env), 'scripts/run-qwen-mm-api-mcp.sh'),
      env,
      toolName,
      arguments: toolArguments,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
      clientName: 'ran-agent-media-reader-qwen-mm',
    });
    const text = textFromMcpResult(result);
    if (result?.isError || !text || text.startsWith('Error:')) {
      throw new Error(text || 'empty Qwen-MM response');
    }
    return text;
  } catch (error) {
    throw new MediaReaderError(errorCode, `${errorCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function analyzeImageOcrWithQwenMm(asset, options = {}) {
  const env = options.env || process.env;
  const model = qwenMmModel(env);
  const text = await callQwenMm('ocr', {
    image_path: asset.file_path,
    model,
  }, 'OCR_FAILED', options);
  return {
    text,
    blocks: text ? [{ text }] : [],
    model,
  };
}

export async function analyzeImageVisionWithQwenMm(asset, options = {}) {
  const env = options.env || process.env;
  const model = qwenMmModel(env);
  const prompt = String(options.prompt || options.args?.prompt || '').trim();
  const responseText = await callQwenMm('vision_chat', {
    images: [asset.file_path],
    model,
    text: [
      prompt || '请用中文简洁理解这张图片，重点说明画面主体、场景、动作、重要文字和可能的上下文。',
      '只返回 JSON，不要返回 Markdown。',
      '{"summary":"图片内容摘要","objects":["关键对象1","关键对象2"]}',
    ].join('\n'),
  }, 'VLM_FAILED', options);
  const response = parseJsonContent(responseText);
  const content = response?.choices?.[0]?.message?.content ?? responseText;
  const parsed = parseJsonContent(content);
  return {
    summary: String(parsed.summary || content || '').trim(),
    objects: Array.isArray(parsed.objects) ? parsed.objects.map(String) : [],
    model,
  };
}
