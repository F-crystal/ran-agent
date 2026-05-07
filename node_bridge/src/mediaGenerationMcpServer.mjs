#!/usr/bin/env node
import readline from 'node:readline';
import {
  generateImageWithQwen,
  generateSpeechWithQwenOmni,
  getOpenClawGatewayConfig,
} from './openclawGatewayClient.mjs';

const SERVER_INFO = {
  name: 'ran-agent-media-generation',
  version: '0.1.0',
};

function buildWeChatMediaMarker(result, extra = {}) {
  const media = result?.media && typeof result.media === 'object' ? result.media : null;
  if (!media?.type || !media?.url) {
    return '';
  }
  return `WECHAT_MEDIA: ${JSON.stringify({
    source: 'media_generation_mcp',
    kind: extra.kind || media.type,
    type: media.type,
    url: media.url,
    fileName: media.fileName || undefined,
    model: result?.model || '',
  })}`;
}

function buildToolResultPayload(result, extra = {}) {
  const payload = {
    ok: true,
    ...extra,
    reply_text: String(result?.reply_text || '').trim(),
    media: result?.media || null,
    model: result?.model || '',
  };
  const marker = buildWeChatMediaMarker(result, extra);
  return {
    content: [
      {
        type: 'text',
        text: [
          JSON.stringify(payload, null, 2),
          marker,
          marker ? '保留上面的 WECHAT_MEDIA 行供微信桥接层发送媒体；不要改写 URL、model 或 source。' : '',
        ].filter(Boolean).join('\n'),
      },
    ],
    structuredContent: payload,
  };
}

function buildErrorResult(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: String(message || 'tool failed'),
      },
    ],
    structuredContent: {
      ok: false,
      error: String(message || 'tool failed'),
    },
  };
}

function buildTools() {
  return [
    {
      name: 'generate_image',
      title: 'Generate Image',
      description: 'Generate an image for the current conversation. Use when the user naturally asks to draw, create, make, or send a picture, poster, avatar, wallpaper, or illustration.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A concise prompt describing the visual result to generate.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    {
      name: 'generate_speech',
      title: 'Generate Speech',
      description: 'Generate spoken audio for the current conversation. Use when the user naturally asks to read text aloud, say a sentence, send a voice message, synthesize speech, or create audio.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The exact text to speak.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ];
}

async function callTool(name, args = {}, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;

  if (name === 'generate_image') {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) {
      return buildErrorResult('generate_image requires prompt');
    }
    try {
      const result = await generateImageWithQwen(prompt, {
        config,
        fetchImpl,
        logger,
        sleepImpl: options.sleepImpl,
      });
      return buildToolResultPayload(result, { kind: 'image', prompt });
    } catch (error) {
      return buildErrorResult(error instanceof Error ? error.message : String(error));
    }
  }

  if (name === 'generate_speech') {
    const text = String(args.text || args.prompt || '').trim();
    if (!text) {
      return buildErrorResult('generate_speech requires text');
    }
    try {
      const result = await generateSpeechWithQwenOmni(text, {
        config,
        fetchImpl,
        logger,
        env: options.env,
      });
      return buildToolResultPayload(result, { kind: 'speech', text });
    } catch (error) {
      return buildErrorResult(error instanceof Error ? error.message : String(error));
    }
  }

  return buildErrorResult(`unknown tool: ${name}`);
}

export async function handleMediaGenerationMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    };
  }

  if (method === 'tools/list') {
    return {
      tools: buildTools(),
    };
  }

  if (method === 'tools/call') {
    const params = request?.params || {};
    return await callTool(String(params.name || ''), params.arguments || {}, options);
  }

  throw new Error(`unsupported MCP method: ${method}`);
}

function writeJsonRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`);
}

export function runMediaGenerationMcpServer(options = {}) {
  const logger = options.logger || {
    info: (message) => process.stderr.write(`${message}\n`),
    warn: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) {
      return;
    }
    try {
      const result = await handleMediaGenerationMcpRequest(request, {
        ...options,
        logger,
      });
      writeJsonRpcResponse(request.id, result);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMediaGenerationMcpServer();
}
