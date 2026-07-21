import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ACTION_TYPES = Object.freeze(['feishu.message.send', 'feishu.document.update']);
const DOC_COMMANDS = new Set(['append', 'str_replace', 'block_insert_after', 'block_replace']);

export function createFeishuActionExecutorAdapter({ env = process.env, execFileImpl = execFile } = {}) {
  if (typeof execFileImpl !== 'function') throw executorError('FEISHU_EXECUTOR_CONFIG_INVALID');
  const bin = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim() || 'lark-cli';
  const timeout = Math.max(1_000, Number(env.FEISHU_SEND_TIMEOUT_SECONDS || 30) * 1_000);
  return Object.freeze({
    issuer: 'bridge:node-feishu-action-executor',
    actionTypes: ACTION_TYPES,
    evidenceType: 'feishu_cli_operation_result',
    boundary: 'bridge_owned',
    async execute({ operation, payload, signal } = {}) {
      if (!operation || !ACTION_TYPES.includes(operation.actionType)) throw executorError('FEISHU_ACTION_INVALID');
      let command;
      try {
        command = buildCommand(operation, payload);
      } catch {
        return trustedResult(operation, { target: String(operation.scope?.target || 'unsupported') }, {
          status: 'rejected', effectId: `${operation.operationId}:rejected`,
          summary: '这一步不受 Node 飞书执行器支持，未执行。', retryable: false,
        });
      }
      try {
        const result = await execFileImpl(bin, command.args, { timeout, signal });
        return normalizeCliOutcome(operation, command, {
          stdout: result?.stdout,
          stderr: result?.stderr,
          exitCode: normalizeExitCode(result?.exitCode, 0),
          signal: result?.signal || '',
          dispatched: result?.dispatched !== false,
          timedOut: result?.timedOut === true,
        });
      } catch (error) {
        return normalizeCliOutcome(operation, command, {
          stdout: error?.stdout,
          stderr: error?.stderr,
          exitCode: normalizeExitCode(error?.exitCode, error?.code),
          signal: error?.signal || '',
          dispatched: error?.dispatched === true ? true : error?.dispatched === false ? false : !isKnownPreDispatchFailure(error),
          timedOut: error?.timedOut === true || String(error?.code || '').toUpperCase() === 'ETIMEDOUT' || error?.killed === true,
        });
      }
    },
    validateResult(value, operation) {
      return value?.nodeOwned === true
        && value.operationId === operation?.operationId
        && ACTION_TYPES.includes(value.actionType)
        && ['succeeded', 'failed', 'partial', 'ambiguous', 'rejected'].includes(value.status)
        && typeof value.effectId === 'string'
        && typeof value.summary === 'string'
        && typeof value.target === 'string'
        && typeof value.retryable === 'boolean';
    },
    normalizeResult(value) {
      return {
        status: value.status,
        effectId: value.effectId,
        summary: value.summary,
        target: value.target,
        retryable: value.retryable,
      };
    },
  });
}

function buildCommand(operation, payload = {}) {
  if (!payload || payload.actionType !== operation.actionType || payload.argumentsDigest !== operation.scope?.argumentsDigest) {
    throw executorError('FEISHU_PRIVATE_PAYLOAD_INVALID');
  }
  const identity = operation.actionType === 'feishu.message.send' ? 'bot' : 'user';
  if (operation.actionType === 'feishu.message.send') {
    const targetType = boundedChoice(payload.targetType, ['chat', 'user'], 'target type');
    const targetId = boundedText(payload.targetId, 'target id', 240);
    const text = boundedText(payload.text, 'message text', 16_000);
    return {
      target: `${targetType}:${shortHash(targetId)}`,
      args: [
        'im', '+messages-send', '--as', identity,
        targetType === 'chat' ? '--chat-id' : '--user-id', targetId,
        '--text', text,
        '--idempotency-key', `ran-node-${operation.idempotencyDigest.slice(-40)}`,
      ],
    };
  }
  const targetId = boundedText(payload.targetId, 'document id', 240);
  const command = boundedChoice(payload.command, [...DOC_COMMANDS], 'document command');
  const args = ['docs', '+update', '--api-version', 'v2', '--doc', targetId, '--command', command, '--as', identity];
  if (payload.docFormat) args.push('--doc-format', boundedChoice(payload.docFormat, ['xml', 'markdown'], 'document format'));
  if (payload.pattern !== undefined) args.push('--pattern', boundedText(payload.pattern, 'document pattern', 8_000, true));
  if (payload.blockId !== undefined) args.push('--block-id', boundedText(payload.blockId, 'block id', 240));
  if (payload.content !== undefined) args.push('--content', boundedText(payload.content, 'document content', 32_000, command === 'str_replace'));
  return { target: `document:${shortHash(targetId)}`, args };
}

function normalizeCliOutcome(operation, command, transport = {}) {
  const stdoutPayloads = parseStructuredPayloads(transport.stdout);
  const stderrPayloads = parseStructuredPayloads(transport.stderr);
  const payloads = [...stdoutPayloads, ...stderrPayloads];
  const businessFailure = payloads.some(isStructuredBusinessFailure)
    || hasExplicitFailureSemantics(transport.stdout)
    || hasExplicitFailureSemantics(transport.stderr);
  const partial = payloads.some(isPartialBusinessResult);
  const exitCode = normalizeExitCode(transport.exitCode, 0);
  const transportUncertain = transport.timedOut === true || Boolean(transport.signal) || exitCode !== 0;
  const dispatched = transport.dispatched !== false;

  if (businessFailure) return normalizedStatus(operation, command, 'failed');
  if (partial) return normalizedStatus(operation, command, 'partial');
  if (!dispatched) return normalizedStatus(operation, command, 'failed');
  if (transportUncertain) return normalizedStatus(operation, command, dispatched ? 'ambiguous' : 'failed');

  if (operation.actionType === 'feishu.message.send') {
    const successes = payloads.map(messageSuccessEvidence).filter(Boolean);
    if (successes.length !== 1) return normalizedStatus(operation, command, 'ambiguous');
    const messageId = successes[0];
    return trustedResult(operation, command, {
      status: 'succeeded',
      effectId: `feishu-message:${messageId}`,
      summary: outcomeSummary(operation.actionType, 'succeeded'),
      retryable: false,
    });
  }
  const successes = payloads.filter(documentSuccessEvidence);
  if (successes.length !== 1) return normalizedStatus(operation, command, 'ambiguous');
  const payload = successes[0];
  return trustedResult(operation, command, {
    status: 'succeeded',
    effectId: `${operation.operationId}:revision:${String(payload?.data?.document?.revision_id || payload?.data?.updated_blocks_count || 'succeeded')}`,
    summary: outcomeSummary(operation.actionType, 'succeeded'),
    retryable: false,
  });
}

function normalizedStatus(operation, command, status) {
  return trustedResult(operation, command, {
    status,
    effectId: `${operation.operationId}:${status}`,
    summary: outcomeSummary(operation.actionType, status),
    retryable: status === 'failed',
  });
}

function trustedResult(operation, command, outcome) {
  return {
    nodeOwned: true,
    operationId: operation.operationId,
    actionType: operation.actionType,
    target: command.target,
    ...outcome,
  };
}

function outcomeSummary(actionType, status) {
  if (actionType === 'feishu.document.update') {
    if (status === 'succeeded') return '飞书文档已更新。';
    if (status === 'partial') return '飞书文档已部分更新。';
    if (status === 'ambiguous') return '文档更新请求已经发出，但当前无法确认最终结果。';
    return '飞书文档更新失败。';
  }
  if (status === 'succeeded') return '飞书消息已发送。';
  if (status === 'ambiguous') return '发送请求已经发出，但当前无法确认是否送达。';
  return '飞书消息发送失败。';
}

function isKnownPreDispatchFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(code);
}

function parseStructuredPayloads(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const whole = parseJsonObject(text);
  if (whole) return [whole];
  return text.split(/\r?\n/).map(parseJsonObject).filter(Boolean);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStructuredBusinessFailure(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.ok === false || payload.success === false) return true;
  if (hasBusinessError(payload.error) || hasBusinessError(payload.data?.error)) return true;
  if (isBusinessErrorCode(payload.code) || isBusinessErrorCode(payload.error?.code) || isBusinessErrorCode(payload.data?.code)) return true;
  const status = String(payload.status || payload.data?.status || payload.result || payload.data?.result || '').trim().toLowerCase();
  return ['error', 'failed', 'failure', 'denied', 'rejected'].includes(status);
}

function hasExplicitFailureSemantics(value) {
  return String(value || '').split(/\r?\n/).some((line) => (
    /^\s*(?:error|failed|failure|denied|rejected)\s*[:：-]/i.test(line)
  ));
}

function hasBusinessError(value) {
  if (value === undefined || value === null || value === false || value === '') return false;
  return typeof value !== 'object' || Object.keys(value).length > 0;
}

function isPartialBusinessResult(payload) {
  const status = String(payload?.status || payload?.data?.status || payload?.result || payload?.data?.result || '').trim().toLowerCase();
  return ['partial', 'partial_success', 'partially_succeeded'].includes(status);
}

function messageSuccessEvidence(payload) {
  const messageId = String(payload?.message_id || payload?.data?.message_id || '').trim();
  if (messageId) return messageId;
  if (payload?.ok === true || payload?.success === true) {
    const explicitId = String(payload?.id || payload?.data?.id || '').trim();
    return explicitId || '';
  }
  return '';
}

function documentSuccessEvidence(payload) {
  const status = String(payload?.data?.result || payload?.result || payload?.status || payload?.data?.status || '').trim().toLowerCase();
  const documentId = String(payload?.document_id || payload?.data?.document_id || '').trim();
  return (payload?.ok === true || payload?.success === true) && (status === 'success' || Boolean(documentId));
}

function isBusinessErrorCode(value) {
  if (value === undefined || value === null || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : String(value).toLowerCase() !== 'ok';
}

function normalizeExitCode(value, fallback) {
  const primary = Number(value);
  if (Number.isInteger(primary)) return primary;
  const secondary = Number(fallback);
  return Number.isInteger(secondary) ? secondary : 1;
}

function shortHash(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function boundedChoice(value, allowed, name) {
  const text = boundedText(value, name, 80);
  if (!allowed.includes(text)) throw executorError('FEISHU_ACTION_UNSUPPORTED');
  return text;
}

function boundedText(value, name, maxLength, allowEmpty = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((!allowEmpty && !text) || text.length > maxLength || text.includes('\0')) throw executorError('FEISHU_ACTION_INVALID', `${name} is invalid`);
  return text;
}

function executorError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
