import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ACTION_TYPE = 'feishu.minutes_to_doc';

export function createFeishuMinutesDocumentExecutorAdapter({
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const command = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim();
  const identity = 'user';
  const timeoutMs = positiveInt(env.FEISHU_DOCUMENT_ACTION_TIMEOUT_MS, 60_000);
  if (!command || typeof execFileImpl !== 'function') {
    throw clientError('FEISHU_MINUTES_DOCUMENT_CONFIG');
  }

  async function run(args, signal) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let stdout;
    try {
      ({ stdout } = await execFileImpl(command, [...args, '--format', 'json', '--as', identity], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        signal: requestSignal,
      }));
    } catch {
      throw clientError('FEISHU_MINUTES_DOCUMENT_COMMAND_FAILED');
    }
    let payload;
    try {
      payload = JSON.parse(String(stdout || ''));
    } catch {
      throw clientError('FEISHU_MINUTES_DOCUMENT_RESPONSE_INVALID');
    }
    if (payload?.ok !== true || payload?.identity !== identity) {
      throw clientError('FEISHU_MINUTES_DOCUMENT_COMMAND_REJECTED');
    }
    return payload;
  }

  return Object.freeze({
    issuer: 'bridge:lark-cli-minutes-document-adapter',
    actionTypes: [ACTION_TYPE],
    evidenceType: 'feishu_minutes_document_readback',
    boundary: 'authenticated_private',
    async execute({ operation, signal } = {}) {
      const scope = normalizeOperation(operation);
      const minutes = await run([
        'minutes', '+search', '--query', scope.minuteTitle, '--owner-ids', 'me', '--page-size', '2',
      ], signal);
      if (minutes?.data?.items?.length !== 1 || typeof minutes.data.items[0]?.token !== 'string') {
        throw clientError('FEISHU_MINUTES_MATCH_AMBIGUOUS');
      }

      const folders = await run([
        'drive', '+search', '--query', scope.folderTitle, '--only-title', '--doc-types', 'folder', '--mine', '--page-size', '2',
      ], signal);
      const folderMatches = folders?.data?.results;
      const folderToken = folderMatches?.[0]?.result_meta?.token;
      if (folderMatches?.length !== 1 || typeof folderToken !== 'string') {
        throw clientError('FEISHU_FOLDER_MATCH_AMBIGUOUS');
      }

      const created = await run([
        'docs', '+create', '--api-version', 'v2', '--parent-token', folderToken, '--content', scope.contentXml,
      ], signal);
      const documentId = created?.data?.document?.document_id;
      if (typeof documentId !== 'string' || !documentId) {
        throw clientError('FEISHU_DOCUMENT_CREATE_UNVERIFIED');
      }

      const fetched = await run([
        'docs', '+fetch', '--api-version', 'v2', '--doc', documentId, '--doc-format', 'xml', '--detail', 'simple',
      ], signal);
      if (!JSON.stringify(fetched?.data || {}).includes(scope.documentTitle)) {
        throw clientError('FEISHU_DOCUMENT_READBACK_MISMATCH');
      }
      return {
        authenticated: true,
        operationId: operation.operationId,
        ok: true,
        effectId: `feishu-doc:${documentId}`,
      };
    },
    validateResult(value, operation) {
      return value?.authenticated === true
        && value?.ok === true
        && value?.operationId === operation?.operationId
        && /^feishu-doc:[A-Za-z0-9_-]+$/.test(String(value?.effectId || ''));
    },
    normalizeResult(value) {
      return { status: value.ok === true ? 'succeeded' : 'failed', effectId: value.effectId };
    },
  });
}

function normalizeOperation(operation) {
  if (!operation || operation.actionType !== ACTION_TYPE) {
    throw clientError('FEISHU_MINUTES_DOCUMENT_ACTION_INVALID');
  }
  const scope = operation.scope && typeof operation.scope === 'object' && !Array.isArray(operation.scope)
    ? operation.scope
    : {};
  const minuteTitle = title(scope.minuteTitle);
  const folderTitle = title(scope.folderTitle);
  const documentTitle = title(scope.documentTitle);
  const contentXml = String(scope.contentXml || '').trim();
  if (contentXml.length < 40
    || contentXml.length > 2_000
    || Buffer.byteLength(contentXml, 'utf8') > 7_000
    || contentXml.includes('\0')
    || /<\/?(?:root|content)\b|<(?:img|source|whiteboard|sheet|task|chat_card)\b/i.test(contentXml)) {
    throw clientError('FEISHU_MINUTES_DOCUMENT_CONTENT_INVALID');
  }
  const escapedTitle = documentTitle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (!contentXml.includes(`<title>${escapedTitle}</title>`)) {
    throw clientError('FEISHU_MINUTES_DOCUMENT_CONTENT_INVALID');
  }
  return { minuteTitle, folderTitle, documentTitle, contentXml };
}

function title(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80 || /[\r\n\t\0]/.test(text)) {
    throw clientError('FEISHU_MINUTES_DOCUMENT_SCOPE_INVALID');
  }
  return text;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 180_000 ? parsed : fallback;
}

function clientError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
