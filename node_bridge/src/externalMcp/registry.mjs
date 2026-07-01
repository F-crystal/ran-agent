const MAX_TEXT = 360;
const SAFE_TRANSPORTS = new Set(['stdio', 'http', 'streamable-http', 'sse', 'websocket']);
const WRITE_WORDS = /\b(post|submit|send|reply|comment|like|react|follow|dm|message|move|act|trade|save|write|update|create)\b/i;
const DESTRUCTIVE_WORDS = /\b(delete|remove|destroy|purchase|buy|transfer|report|bulk|spend|irreversible|sudo|shell|exec)\b/i;
const READ_WORDS = /\b(read|search|list|get|fetch|observe|watch|mentions|profile|thread|summarize|summary)\b/i;

export function validateManifest(input = {}, options = {}) {
  const errors = [];
  const findings = scanForForbiddenSecrets(input);
  for (const finding of findings) {
    errors.push(`${finding.reason}:${finding.path}`);
  }
  if (hasDangerousStartupCommand(input)) {
    errors.push('dangerous_startup_command:command');
  }
  let manifest = null;
  try {
    manifest = normalizeManifest(input, options);
  } catch (error) {
    errors.push(`invalid_manifest:${error instanceof Error ? error.message : String(error)}`);
  }
  if (errors.length > 0 || !manifest) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return { ok: true, errors: [], manifest };
}

export function normalizeManifest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('manifest must be an object');
  }
  const id = sanitizeId(input.id);
  if (!id) throw new Error('manifest id is required');
  const tools = Array.isArray(input.tools) ? input.tools.map(normalizeTool) : [];
  if (tools.length === 0) throw new Error('at least one tool is required');
  const requiredEnv = normalizeStringList(input.requiredEnv || input.required_env || input.envNames || input.env_names)
    .map((item) => item.replace(/[^A-Z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 32);
  const transport = normalizeTransport(input.transport);
  return {
    id,
    title: sanitizeText(input.title || id),
    source: sanitizeSource(input.source || ''),
    version: sanitizeShort(input.version || ''),
    transport,
    command: sanitizeCommand(input.command || ''),
    args: normalizeStringList(input.args).slice(0, 32),
    requiredEnv,
    profileScope: sanitizeProfileScope(input.profileScope || input.profile_scope || options.profileScope || 'full'),
    proactiveAllowed: input.proactiveAllowed === true,
    tools,
  };
}

export function normalizeTool(tool = {}) {
  const name = sanitizeToolName(tool.name);
  const classification = classifyTool(tool);
  return {
    name,
    title: sanitizeText(tool.title || name),
    description: sanitizeText(tool.description || ''),
    inputSchemaSummary: summarizeSchema(tool.inputSchema || tool.input_schema || {}),
    annotations: normalizeAnnotations(tool.annotations || {}),
    ...classification,
  };
}

export function classifyTool(tool = {}) {
  const name = sanitizeToolName(tool.name);
  const description = String(tool.description || '');
  const haystack = `${name} ${description}`;
  if (DESTRUCTIVE_WORDS.test(haystack)) {
    return tier('T5', 'owner_full', false, true, 'unclassified_or_high_risk');
  }
  if (/draft|propose|plan/i.test(haystack)) {
    return tier('T3', 'full', false, true, 'draft_or_proposal');
  }
  if (WRITE_WORDS.test(haystack)) {
    return tier('T4', 'full', false, true, 'external_side_effect');
  }
  if (READ_WORDS.test(haystack)) {
    const authenticated = /\b(auth|private|mention|feed|account)\b/i.test(haystack);
    return tier(authenticated ? 'T2' : 'T1', authenticated ? 'full' : 'lite', true, false, authenticated ? 'authenticated_read' : 'public_read');
  }
  return tier('T5', 'owner_full', false, true, 'unclassified_or_high_risk');
}

export function scanForForbiddenSecrets(value, path = []) {
  const findings = [];
  scan(value, path, findings);
  return findings;
}

function scan(value, path, findings) {
  const key = String(path[path.length - 1] || '');
  const location = path.join('.') || '<root>';
  if (/session.*path|cache.*path|log.*file|sqlite|cookie.*file/i.test(key)) {
    findings.push({ path: location, reason: 'forbidden_runtime_state' });
    return;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, [...path, String(index)], findings));
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      scan(childValue, [...path, childKey], findings);
    }
    return;
  }
  const text = String(value || '');
  if (!text) return;
  if (/cookie|api[_-]?key|token|secret|password|sessdata|authorization/i.test(key)
    && !/^[A-Z][A-Z0-9_]{2,}$/.test(text)) {
    findings.push({ path: location, reason: 'forbidden_secret' });
    return;
  }
  if (/(sk-[a-z0-9_-]{8,}|xox[baprs]-[a-z0-9_-]+|sessdata=|sessionid=|authorization:\s*bearer|cookie=)/i.test(text)) {
    findings.push({ path: location, reason: 'forbidden_secret' });
  }
}

function hasDangerousStartupCommand(input = {}) {
  const commandLine = [input.command, ...(Array.isArray(input.args) ? input.args : [])].map(String).join(' ');
  return /(\|\s*(sudo|sh|bash)|\bsudo\b|\brm\s+-rf\b|curl\b.*\|\s*(sh|bash|sudo)|wget\b.*\|\s*(sh|bash|sudo))/i.test(commandLine);
}

function tier(tierName, profileScope, proactiveAllowed, confirmationRequired, reason) {
  return {
    tier: tierName,
    profileScope,
    proactiveAllowed,
    confirmationRequired,
    reason,
  };
}

function summarizeSchema(schema) {
  const input = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  const properties = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)
    ? input.properties
    : {};
  return {
    type: sanitizeShort(input.type || 'object') || 'object',
    propertyNames: Object.keys(properties).map(sanitizeShort).filter(Boolean).slice(0, 32),
    required: normalizeStringList(input.required).slice(0, 32),
  };
}

function normalizeAnnotations(annotations) {
  const input = annotations && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : {};
  const output = {};
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint']) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }
  return output;
}

function normalizeTransport(value) {
  const transport = sanitizeShort(value || 'stdio').toLowerCase();
  return SAFE_TRANSPORTS.has(transport) ? transport : 'stdio';
}

function sanitizeProfileScope(value) {
  const normalized = sanitizeShort(value).toLowerCase();
  return ['lite', 'full', 'owner_full'].includes(normalized) ? normalized : 'full';
}

function sanitizeToolName(value) {
  return sanitizeShort(value).toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').replace(/_+/g, '_').slice(0, 120);
}

function sanitizeId(value) {
  return sanitizeShort(value).toLowerCase().replace(/[^a-z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizeCommand(value) {
  return sanitizeShort(value).replace(/[^\w./:-]/g, '').slice(0, 120);
}

function sanitizeSource(value) {
  const text = sanitizeShort(value);
  return /^https?:\/\//i.test(text) || /^io\.|^com\.|^org\./i.test(text) ? text : '';
}

function sanitizeText(value) {
  return redactSecrets(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, MAX_TEXT);
}

function sanitizeShort(value) {
  return redactSecrets(String(value || '').replace(/[\r\n\t]/g, ' ').trim()).slice(0, 160);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/cookie\s*=\s*[^ ]+/gi, 'cookie=[redacted]')
    .replace(/token\s*=\s*[^ ]+/gi, 'token=[redacted]')
    .replace(/session[-_\w]*\s*=\s*[^ ]+/gi, 'session=[redacted]')
    .replace(/sk-[a-z0-9_-]{8,}/gi, '[redacted-secret]')
    .replace(/xox[baprs]-[a-z0-9_-]+/gi, '[redacted-secret]');
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => sanitizeShort(item)).filter(Boolean);
}
