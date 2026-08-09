import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MINUTES_ACTION_TYPE = 'feishu.minutes_to_doc';
const DOCUMENT_WRITE_ACTION_TYPE = 'document.write';
const RESULT_STATUSES = new Set(['succeeded', 'failed', 'ambiguous']);

export function createFeishuMinutesDocumentExecutorAdapter({
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const run = createLarkRunner({ env, execFileImpl, prefix: 'FEISHU_MINUTES_DOCUMENT' });

  return Object.freeze({
    issuer: 'bridge:lark-cli-minutes-document-adapter',
    actionTypes: [MINUTES_ACTION_TYPE],
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

      return executeDocumentWrite({ operation, run, signal, scope: {
        operation: 'create',
        target: { folderTitle: scope.folderTitle, documentTitle: scope.documentTitle },
        content: { body: scope.contentXml },
      } });
    },
    validateResult(value, operation) {
      return validateDocumentResult(value, operation);
    },
    normalizeResult(value) {
      return normalizeDocumentResult(value);
    },
  });
}

export function createFeishuDocumentWriteExecutorAdapter({
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const run = createLarkRunner({ env, execFileImpl, prefix: 'FEISHU_DOCUMENT' });
  return Object.freeze({
    issuer: 'bridge:lark-cli-document-write-adapter',
    actionTypes: [DOCUMENT_WRITE_ACTION_TYPE],
    evidenceType: 'feishu_document_readback',
    boundary: 'authenticated_private',
    async execute({ operation, signal } = {}) {
      return executeDocumentWrite({
        operation,
        run,
        signal,
        scope: normalizeDocumentWriteOperation(operation),
      });
    },
    validateResult(value, operation) {
      return validateDocumentResult(value, operation);
    },
    normalizeResult(value) {
      return normalizeDocumentResult(value);
    },
  });
}

async function executeDocumentWrite({ operation, run, signal, scope }) {
  let documentId = scope.target.documentId || '';
  let parentToken = '';
  if (scope.operation === 'create') {
    const folders = await run([
      'drive', '+search', '--query', `"${scope.target.folderTitle}"`, '--only-title', '--doc-types', 'folder', '--mine', '--page-size', '2',
    ], signal);
    const folderMatches = folders?.data?.results;
    const folderMatch = folderMatches?.[0];
    parentToken = String(folderMatch?.result_meta?.token || '');
    const resolvedFolderTitle = String(folderMatch?.title || folderMatch?.result_meta?.title || folderMatch?.title_highlighted || '')
      .replace(/<\/?h(?:b)?>/g, '');
    if (folderMatches?.length !== 1 || !parentToken || resolvedFolderTitle !== scope.target.folderTitle) {
      throw clientError('FEISHU_FOLDER_MATCH_AMBIGUOUS');
    }
    let created;
    try {
      created = await run([
        'docs', '+create', '--api-version', 'v2', '--parent-token', parentToken, '--content', scope.content.body,
      ], signal);
    } catch (error) {
      if (unknownDispatchOutcome(error)) return documentResult(operation, 'ambiguous');
      throw error;
    }
    documentId = String(created?.data?.document?.document_id || '');
    if (!documentId) return documentResult(operation, 'ambiguous');
  } else {
    try {
      await run([
        'docs', '+update', '--api-version', 'v2', '--doc', documentId, '--content', scope.content.body,
      ], signal);
    } catch (error) {
      if (unknownDispatchOutcome(error)) return documentResult(operation, 'ambiguous');
      throw error;
    }
  }

  try {
    const fetched = await run([
      'docs', '+fetch', '--api-version', 'v2', '--doc', documentId, '--doc-format', 'xml', '--detail', 'simple',
    ], signal);
    const document = fetched?.data?.document;
    if (String(document?.document_id || '') !== documentId
      || canonicalDocumentXml(document?.content) !== canonicalDocumentXml(scope.content.body)) {
      return documentResult(operation, 'failed', { documentId, parentToken });
    }
    if (scope.operation === 'create'
      && !await documentBelongsToFolder({ run, signal, documentId, parentToken })) {
      return documentResult(operation, 'failed', { documentId, parentToken });
    }
  } catch {
    return documentResult(operation, 'failed', { documentId, parentToken });
  }
  return documentResult(operation, 'succeeded', {
    documentId,
    parentToken,
    contentHash: `sha256:${createHash('sha256').update(scope.content.body, 'utf8').digest('hex')}`,
  });
}

async function documentBelongsToFolder({ run, signal, documentId, parentToken }) {
  let pageToken = '';
  do {
    const params = { folder_token: parentToken, page_size: 200 };
    if (pageToken) params.page_token = pageToken;
    const listed = await run(['drive', 'files', 'list', '--params', JSON.stringify(params)], signal);
    const files = Array.isArray(listed?.data?.files) ? listed.data.files : [];
    const match = files.find((item) => String(item?.token || '') === documentId);
    if (match) {
      return match.type === 'docx' && String(match.parent_token || '') === parentToken;
    }
    pageToken = listed?.data?.has_more === true ? String(listed.data.page_token || '') : '';
  } while (pageToken);
  return false;
}

function canonicalDocumentXml(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().replace(/>\s+</g, '><');
}

function documentResult(operation, status, {
  documentId = '',
  parentToken = '',
  contentHash = '',
} = {}) {
  const evidenceDigest = status === 'succeeded'
    ? createHash('sha256').update(JSON.stringify([documentId, parentToken, contentHash]), 'utf8').digest('hex')
    : '';
  return {
    authenticated: true,
    operationId: operation.operationId,
    status,
    effectId: `feishu-doc:${documentId || operation.operationId}${evidenceDigest ? `:evidence-${evidenceDigest}` : ''}`,
    documentId,
    parentToken,
    contentHash,
  };
}

function validateDocumentResult(value, operation) {
  if (value?.authenticated !== true
    || value?.operationId !== operation?.operationId
    || !RESULT_STATUSES.has(value?.status)
    || !/^feishu-doc:[A-Za-z0-9_-]+(?::evidence-[a-f0-9]{64})?$/.test(String(value?.effectId || ''))) return false;
  if (value.status !== 'succeeded') return true;
  return /^[A-Za-z0-9_-]{1,160}$/.test(String(value.documentId || ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(value.contentHash || ''))
    && (operation?.scope?.operation === 'update'
      || /^[A-Za-z0-9_-]{3,160}$/.test(String(value.parentToken || '')));
}

function normalizeDocumentResult(value) {
  return { status: value.status, effectId: value.effectId };
}

function createLarkRunner({ env, execFileImpl, prefix }) {
  const command = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim();
  const identity = 'user';
  const timeoutMs = positiveInt(env.FEISHU_DOCUMENT_ACTION_TIMEOUT_MS, 60_000);
  if (!command || typeof execFileImpl !== 'function') throw clientError(`${prefix}_CONFIG`);
  return async (args, signal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let stdout;
    try {
      ({ stdout } = await execFileImpl(command, [...args, '--format', 'json', '--as', identity], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        signal: requestSignal,
      }));
    } catch (cause) {
      throw clientError(`${prefix}_COMMAND_FAILED`, cause);
    }
    let payload;
    try {
      payload = JSON.parse(String(stdout || ''));
    } catch (cause) {
      throw clientError(`${prefix}_RESPONSE_INVALID`, cause);
    }
    if (payload?.ok !== true || payload?.identity !== identity) {
      throw clientError(`${prefix}_COMMAND_REJECTED`);
    }
    return payload;
  };
}

function unknownDispatchOutcome(error) {
  const causeCode = String(error?.cause?.code || '');
  return ['ABORT_ERR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(causeCode)
    || /_RESPONSE_INVALID$/.test(String(error?.code || ''));
}

function normalizeOperation(operation) {
  if (!operation || operation.actionType !== MINUTES_ACTION_TYPE) {
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

function normalizeDocumentWriteOperation(operation) {
  if (!operation || operation.actionType !== DOCUMENT_WRITE_ACTION_TYPE) {
    throw clientError('FEISHU_DOCUMENT_ACTION_INVALID');
  }
  const scope = operation.scope && typeof operation.scope === 'object' && !Array.isArray(operation.scope)
    ? operation.scope
    : {};
  if (scope.provider !== 'feishu' || !['create', 'update'].includes(scope.operation)) {
    throw clientError('FEISHU_DOCUMENT_SCOPE_INVALID');
  }
  const target = scope.target && typeof scope.target === 'object' && !Array.isArray(scope.target) ? scope.target : {};
  const documentTitle = title(target.documentTitle, 'FEISHU_DOCUMENT_SCOPE_INVALID');
  const normalizedTarget = scope.operation === 'create'
    ? { folderTitle: title(target.folderTitle, 'FEISHU_DOCUMENT_SCOPE_INVALID'), documentTitle }
    : { documentId: identifier(target.documentId), documentTitle };
  const content = scope.content && typeof scope.content === 'object' && !Array.isArray(scope.content) ? scope.content : {};
  const body = validateContent(content.body, documentTitle);
  const expectedHash = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  if (content.format !== 'docx_xml'
    || content.hash !== expectedHash
    || content.ref !== `inline:${content.hash}`
    || operation.payloadRef !== content.ref) {
    throw clientError('FEISHU_DOCUMENT_CONTENT_INVALID');
  }
  return { operation: scope.operation, target: normalizedTarget, content: { body, hash: content.hash } };
}

function title(value, code = 'FEISHU_MINUTES_DOCUMENT_SCOPE_INVALID') {
  const text = String(value || '').trim();
  if (!text || text.length > 80 || /[\r\n\t\0]/.test(text)) {
    throw clientError(code);
  }
  return text;
}

function identifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(text)) throw clientError('FEISHU_DOCUMENT_SCOPE_INVALID');
  return text;
}

function validateContent(value, documentTitle) {
  const contentXml = String(value || '').trim();
  if (contentXml.length < 40
    || contentXml.length > 2_000
    || Buffer.byteLength(contentXml, 'utf8') > 7_000
    || contentXml.includes('\0')
    || /<\/?(?:root|content)\b|<(?:img|source|whiteboard|sheet|task|chat_card)\b/i.test(contentXml)) {
    throw clientError('FEISHU_DOCUMENT_CONTENT_INVALID');
  }
  const escapedTitle = documentTitle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (!contentXml.includes(`<title>${escapedTitle}</title>`)) {
    throw clientError('FEISHU_DOCUMENT_CONTENT_INVALID');
  }
  return contentXml;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 180_000 ? parsed : fallback;
}

function clientError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
