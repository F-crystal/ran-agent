/**
 * DashScope media generation client (image + speech).
 * Extracted from openclawGatewayClient.mjs during OpenClaw retirement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from './runtimeState.mjs';

const IMAGE_TASK_POLL_MAX_ATTEMPTS = 20;
const IMAGE_TASK_POLL_DELAY_MS = 1500;
const GENERATED_AUDIO_SAMPLE_RATE = 24000;

export function getDashScopeMediaConfig(env = process.env) {
  const directApiBaseUrl = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const compatibleApiBaseUrl = (env.DASHSCOPE_COMPAT_BASE_URL || `${directApiBaseUrl}/compatible-mode/v1`).replace(/\/$/, '');
  const directApiToken = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || '').trim();
  const imageModel = String(env.RAN_AGENT_IMAGE_MODEL || env.DASHSCOPE_IMAGE_MODEL || 'qwen-image').trim();
  const speechModel = String(env.RAN_AGENT_SPEECH_MODEL || env.DASHSCOPE_SPEECH_MODEL || 'qwen3-omni-flash').trim();

  return {
    directApiBaseUrl,
    compatibleApiBaseUrl,
    directApiToken,
    imageModel,
    speechModel,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateImageWithQwen(prompt, options = {}) {
  const config = options.config || getDashScopeMediaConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const sleepImpl = options.sleepImpl || sleep;
  if (!config.directApiToken) {
    throw new Error('image generation requires DASHSCOPE_API_KEY or QWEN_API_KEY');
  }
  const taskId = await createImageTask(prompt, {
    config,
    fetchImpl,
  });
  const taskResult = await pollImageTask(taskId, {
    config,
    fetchImpl,
    sleepImpl,
  });
  const imageUrl = extractGeneratedImageUrl(taskResult);
  if (!imageUrl) {
    throw new Error('qwen-image generation finished without image url');
  }
  logger.info?.(`qwen-image generated image task_id=${taskId}`);
  return {
    reply_text: '好，图给你生成好了。',
    media: {
      type: 'image',
      url: imageUrl,
    },
    model: config.imageModel,
  };
}

async function createImageTask(prompt, options = {}) {
  const config = options.config || {};
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${config.directApiBaseUrl}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.directApiToken}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: config.imageModel || 'qwen-image',
      input: { prompt },
      parameters: {
        n: 1,
        size: '1328*1328',
        watermark: false,
        prompt_extend: true,
        negative_prompt: ' ',
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message || body?.code || `image generation request failed: HTTP ${response.status}`);
  }
  const taskId = String(body?.output?.task_id || '').trim();
  if (!taskId) {
    throw new Error('image generation response missing task_id');
  }
  return taskId;
}

async function pollImageTask(taskId, options = {}) {
  const config = options.config || {};
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  for (let attempt = 1; attempt <= IMAGE_TASK_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(`${config.directApiBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.directApiToken}`,
      },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.message || body?.code || `image task polling failed: HTTP ${response.status}`);
    }
    const taskStatus = String(body?.output?.task_status || '').trim().toUpperCase();
    if (taskStatus === 'SUCCEEDED') {
      return body;
    }
    if (taskStatus === 'FAILED' || taskStatus === 'CANCELED' || taskStatus === 'UNKNOWN') {
      throw new Error(body?.output?.message || `image task ${taskStatus.toLowerCase()}`);
    }
    await sleepImpl(IMAGE_TASK_POLL_DELAY_MS);
  }
  throw new Error('image task polling timed out');
}

function extractGeneratedImageUrl(body) {
  const choices = Array.isArray(body?.output?.results) ? body.output.results : [];
  if (choices.length > 0 && typeof choices[0]?.url === 'string' && choices[0].url.trim()) {
    return choices[0].url.trim();
  }
  const imageUrl = String(body?.output?.image_url || '').trim();
  if (imageUrl) {
    return imageUrl;
  }
  const nestedChoices = Array.isArray(body?.output?.choices) ? body.output.choices : [];
  const nestedUrl = String(nestedChoices[0]?.url || nestedChoices[0]?.image_url || '').trim();
  return nestedUrl;
}

export async function generateSpeechWithQwenOmni(prompt, options = {}) {
  const config = options.config || getDashScopeMediaConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  if (!config.directApiToken) {
    throw new Error('speech generation requires DASHSCOPE_API_KEY');
  }
  const response = await fetchImpl(`${config.compatibleApiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.directApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.speechModel || 'qwen3-omni-flash',
      stream: true,
      stream_options: {
        include_usage: true,
      },
      extra_body: {
        enable_thinking: false,
      },
      modalities: ['text', 'audio'],
      audio: {
        voice: 'Cherry',
        format: 'wav',
      },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await parseSpeechErrorResponse(response);
    throw new Error(body?.error?.message || body?.message || `speech generation failed: HTTP ${response.status}`);
  }
  const body = await parseSpeechGenerationResponse(response);
  const audioData = Array.isArray(body.audioData)
    ? body.audioData.map((item) => String(item || '').trim()).filter(Boolean)
    : String(body.audioData || '').trim();
  if ((Array.isArray(audioData) && audioData.length === 0) || (!Array.isArray(audioData) && !audioData)) {
    throw new Error('speech generation response missing audio data');
  }
  const outputPath = writeGeneratedAudioFile(audioData, {
    env: options.env,
    format: String(body.audioFormat || 'wav').trim() || 'wav',
  });
  logger.info?.(`qwen omni generated speech path=${outputPath}`);
  return {
    reply_text: body.replyText || '好，语音给你生成好了。',
    media: {
      type: 'audio',
      url: outputPath,
      fileName: path.basename(outputPath),
    },
    model: config.speechModel,
  };
}

async function parseSpeechErrorResponse(response) {
  try {
    return await response.json();
  } catch {
    try {
      return { message: await response.text() };
    } catch {
      return {};
    }
  }
}

async function parseSpeechGenerationResponse(response) {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const body = await response.json();
    return {
      replyText: String(body?.choices?.[0]?.message?.content || '').trim(),
      audioData: String(body?.choices?.[0]?.message?.audio?.data || '').trim(),
      audioFormat: String(body?.choices?.[0]?.message?.audio?.format || 'wav').trim() || 'wav',
    };
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error('speech generation response missing stream body');
  }

  const decoder = new TextDecoder();
  let rawBuffer = '';
  let replyText = '';
  const audioData = [];
  let audioFormat = 'wav';

  while (true) {
    const { done, value } = await reader.read();
    rawBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const segments = rawBuffer.split(/\r?\n\r?\n/);
    rawBuffer = segments.pop() || '';
    for (const segment of segments) {
      const parsedChunk = parseSseChunk(segment);
      if (!parsedChunk) {
        continue;
      }
      if (parsedChunk.done) {
        continue;
      }
      const delta = parsedChunk.payload?.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') {
        replyText += delta.content;
      }
      if (typeof delta.audio?.data === 'string') {
        audioData.push(delta.audio.data);
      }
      if (typeof delta.audio?.format === 'string' && delta.audio.format.trim()) {
        audioFormat = delta.audio.format.trim();
      }
    }
    if (done) {
      if (rawBuffer.trim()) {
        const parsedChunk = parseSseChunk(rawBuffer);
        if (parsedChunk?.payload) {
          const delta = parsedChunk.payload?.choices?.[0]?.delta || {};
          if (typeof delta.content === 'string') {
            replyText += delta.content;
          }
          if (typeof delta.audio?.data === 'string') {
            audioData.push(delta.audio.data);
          }
          if (typeof delta.audio?.format === 'string' && delta.audio.format.trim()) {
            audioFormat = delta.audio.format.trim();
          }
        }
      }
      break;
    }
  }

  return {
    replyText: replyText.trim(),
    audioData: audioData.map((item) => item.trim()).filter(Boolean),
    audioFormat,
  };
}

function parseSseChunk(chunkText) {
  const dataLines = String(chunkText || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return { done: true };
  }
  return {
    done: false,
    payload: JSON.parse(data),
  };
}

function writeGeneratedAudioFile(base64Data, options = {}) {
  const generatedDir = path.join(resolveStateDir(options.env), 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const filename = `wechat-audio-${Date.now()}.wav`;
  const outputPath = path.join(generatedDir, filename);
  const sourceBuffer = decodeGeneratedAudioBase64(base64Data);
  const outputBuffer = normalizeGeneratedAudioBuffer(sourceBuffer, options.format);
  fs.writeFileSync(outputPath, outputBuffer);
  return outputPath;
}

function decodeGeneratedAudioBase64(base64Data) {
  const chunks = Array.isArray(base64Data)
    ? base64Data.map((item) => String(item || '').trim()).filter(Boolean)
    : [String(base64Data || '').trim()].filter(Boolean);
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  if (chunks.length === 1) {
    return Buffer.from(chunks[0], 'base64');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
}

function normalizeGeneratedAudioBuffer(buffer, format = 'wav') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('speech generation response missing audio data');
  }

  if (isWavBuffer(buffer)) {
    return buffer;
  }

  const normalizedFormat = String(format || '').trim().toLowerCase();
  if (normalizedFormat === 'wav' || normalizedFormat === 'pcm' || normalizedFormat === 'pcm_s16le' || normalizedFormat === 'raw') {
    return pcmBytesToWav(buffer, GENERATED_AUDIO_SAMPLE_RATE);
  }

  return pcmBytesToWav(buffer, GENERATED_AUDIO_SAMPLE_RATE);
}

function isWavBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

function pcmBytesToWav(pcm, sampleRate) {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  buf.write('RIFF', offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write('WAVE', offset);
  offset += 4;
  buf.write('fmt ', offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset);
  offset += 4;
  buf.writeUInt16LE(2, offset);
  offset += 2;
  buf.writeUInt16LE(16, offset);
  offset += 2;
  buf.write('data', offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);
  return buf;
}
