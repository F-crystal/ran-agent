#!/usr/bin/env node

import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function normalizeMcpToolInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  const next = { ...schema };
  if (!next.type && (next.properties || next.required || next.additionalProperties !== undefined)) {
    next.type = 'object';
  }

  if (next.type !== 'object') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (!next.properties || typeof next.properties !== 'object' || Array.isArray(next.properties)) {
    next.properties = {};
  }

  if (next.required !== undefined && !Array.isArray(next.required)) {
    delete next.required;
  }

  return next;
}

export function normalizeToolsListResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) {
    return result;
  }

  return {
    ...result,
    tools: result.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') {
        return tool;
      }

      return {
        ...tool,
        inputSchema: normalizeMcpToolInputSchema(tool.inputSchema),
      };
    }),
  };
}

function normalizeJsonRpcResponse(payload) {
  if (!payload || typeof payload !== 'object' || !payload.result) {
    return payload;
  }

  if (Array.isArray(payload.result.tools)) {
    return {
      ...payload,
      result: normalizeToolsListResult(payload.result),
    };
  }

  return payload;
}

export function runProxy(argv = process.argv.slice(2), options = {}) {
  const child = spawn('npx', ['-y', '@playwright/mcp@latest', ...argv], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  process.stdin.pipe(child.stdin);
  child.stderr.pipe(stderr);

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    if (!line.trim()) {
      stdout.write(`${line}\n`);
      return;
    }

    try {
      stdout.write(`${JSON.stringify(normalizeJsonRpcResponse(JSON.parse(line)))}\n`);
    } catch {
      stdout.write(`${line}\n`);
    }
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  return child;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProxy();
}
