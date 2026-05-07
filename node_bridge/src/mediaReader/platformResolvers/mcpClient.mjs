import readline from 'node:readline';
import { spawn } from 'node:child_process';

export function parseJsonArrayEnv(value, fallback = []) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to fallback.
  }
  return fallback;
}

export function textFromMcpResult(result) {
  if (typeof result === 'string') return result;
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((item) => item?.type === 'text' ? String(item.text || '') : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function callMcpToolViaStdio({
  command,
  args = [],
  env = process.env,
  toolName,
  arguments: toolArguments = {},
  timeoutMs = 15000,
  clientName = 'ran-agent-media-reader-platform-resolver',
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finishReject(new Error(`MCP backend timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finishResolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }

    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (payload.id === 2) {
        if (payload.error) {
          finishReject(new Error(payload.error.message || 'MCP backend tool call failed'));
        } else {
          finishResolve(payload.result);
        }
      }
    });

    child.on('error', finishReject);
    child.on('exit', (code, signal) => {
      if (!settled && code !== 0) {
        finishReject(new Error(`MCP backend exited code=${code} signal=${signal || ''}`));
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: clientName, version: '0.1.0' },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments,
      },
    })}\n`);
  });
}
