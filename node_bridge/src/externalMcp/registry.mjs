import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

const MAX_TEXT = 360;
const MAX_SCHEMA_FIELDS = 64;
const LEGACY_SCHEMA_SUMMARY_FIELDS = 32;
const MAX_SCHEMA_SCAN_NODES = 512;
const MAX_SCHEMA_SCAN_DEPTH = 32;
const SAFE_TRANSPORTS = new Set(['stdio', 'http', 'streamable-http', 'sse', 'websocket']);
const WRITE_WORDS = /\b(post|submit|send|reply|comment|like|react|follow|dm|message|move|act|trade|save|write|update|create)\b/i;
const DESTRUCTIVE_WORDS = /\b(delete|remove|destroy|purchase|buy|transfer|report|bulk|spend|irreversible|sudo|shell|exec)\b/i;
const READ_WORDS = /\b(read|search|list|get|fetch|observe|watch|mentions|profile|thread|summarize|summary)\b/i;
const ACCOUNT_BOUNDARY_WORDS = /(?:\b(?:oauth|authorization|bearer|api[ _.-]?key|private[ _.-]?key|client[ _.-]?secret|login|log[ _.-]?in|signin|sign[ _.-]?in|signup|sign[ _.-]?up|register|registration|account|cookie|token|access[ _.-]?token|refresh[ _.-]?token|session|session[ _.-]?id|sessdata|jsessionid|phpsessid|jwt|csrf|xsrf|password|secret|credential|credentials)\b|登录|登入|注册|账号|帐号|账户|帐户|密码|口令|凭证|令牌|密钥|私钥|授权|鉴权)/i;

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
  const activityKind = normalizeActivityKind(input.activityKind || input.activity_kind || input.kind || '');
  const tools = Array.isArray(input.tools) ? input.tools.map((item) => normalizeTool(item, { activityKind })) : [];
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
    url: sanitizeUrl(input.url || input.endpoint || input.remoteUrl || input.remote_url || ''),
    activityKind,
    command: sanitizeCommand(input.command || ''),
    args: normalizeStringList(input.args).slice(0, 32),
    requiredEnv,
    profileScope: sanitizeProfileScope(input.profileScope || input.profile_scope || options.profileScope || 'full'),
    proactiveAllowed: input.proactiveAllowed === true,
    tools,
  };
}

export function normalizeTool(tool = {}, options = {}) {
  const name = sanitizeToolName(tool.name);
  const inputSchemaSummary = summarizeToolSchema(tool);
  const classification = classifyTool(tool, options);
  return {
    name,
    title: sanitizeText(tool.title || name),
    description: sanitizeText(tool.description || ''),
    inputSchemaSummary,
    annotations: normalizeAnnotations(tool.annotations || {}),
    ...classification,
  };
}

export function classifyTool(tool = {}, options = {}) {
  const rawName = String(tool.name || '');
  const name = sanitizeToolName(tool.name);
  const title = String(tool.title || '');
  const description = String(tool.description || '');
  const rawSchema = rawInputSchema(tool);
  const schema = summarizeToolSchema(tool);
  const schemaRisk = rawSchema === null ? inspectSchemaSummaryRisk(schema) : inspectSchemaRisk(rawSchema);
  const haystack = `${rawName} ${name} ${title} ${description} ${schema.propertyNames.join(' ')} ${schema.required.join(' ')}`;
  if (DESTRUCTIVE_WORDS.test(haystack)) {
    return tier('T5', 'owner_full', false, true, 'unclassified_or_high_risk');
  }
  if (hasAccountBoundaryText(haystack) || schemaRisk.accountBoundary || schemaRisk.truncated) {
    return tier('T5', 'owner_full', false, true, 'unclassified_or_high_risk');
  }
  if (isSandboxActivityTool(haystack, options)) {
    return tier('T3', 'full', true, false, 'sandbox_activity');
  }
  if (/draft|propose|plan/i.test(haystack)) {
    return tier('T3', 'full', false, true, 'draft_or_proposal');
  }
  if (WRITE_WORDS.test(haystack)) {
    return tier('T4', 'full', false, true, 'external_side_effect');
  }
  if (READ_WORDS.test(haystack)) {
    const authenticated = /\b(auth|private|mention|feed)\b/i.test(haystack) || hasAccountBoundaryText(haystack);
    return tier(authenticated ? 'T2' : 'T1', authenticated ? 'full' : 'lite', true, false, authenticated ? 'authenticated_read' : 'public_read');
  }
  return tier('T5', 'owner_full', false, true, 'unclassified_or_high_risk');
}

export async function admitExternalMcpCandidate(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now || input.now) || new Date();
  const validated = validateManifest(input, options);
  if (!validated.ok) {
    const entry = writeRegistryEntry({
      state: 'denied',
      enabled: false,
      reason: 'manifest_validation_failed',
      errors: validated.errors,
      manifest: null,
      candidateId: sanitizeId(input.id || ''),
      now,
    }, env);
    return { ok: false, state: 'denied', entry, errors: validated.errors };
  }

  const decision = await classifyAdmission(validated.manifest, options);
  const entry = writeRegistryEntry({
    state: decision.state,
    enabled: decision.state === 'auto_admitted',
    reason: decision.reason,
    errors: [],
    manifest: decision.manifest || validated.manifest,
    excludedTools: decision.excludedTools || [],
    candidateId: validated.manifest.id,
    now,
  }, env);
  return { ok: true, state: decision.state, entry };
}

export function listExternalMcpRegistryEntries(options = {}) {
  const env = options.env || process.env;
  return readRegistry(env);
}

export function listEnabledExternalMcpManifests(options = {}) {
  return listExternalMcpRegistryEntries(options)
    .filter((entry) => entry.enabled === true && entry.manifest)
    .map(enabledManifestForEntry)
    .filter(Boolean);
}

export function getExternalMcpRegistryEntry(serverId, options = {}) {
  const id = sanitizeId(serverId);
  return listExternalMcpRegistryEntries(options).find((entry) => entry.serverId === id) || null;
}

async function classifyAdmission(manifest, options = {}) {
  if (isLocalExecutableManifest(manifest)) {
    return { state: 'needs_owner', reason: 'local_executable_requires_owner' };
  }
  if (!['http', 'streamable-http', 'sse'].includes(manifest.transport)) {
    return { state: 'needs_owner', reason: 'unsupported_transport_requires_owner' };
  }
  if (manifest.transport === 'sse') {
    return { state: 'needs_owner', reason: 'legacy_sse_requires_owner' };
  }
  const urlSafety = await validateRemoteMcpUrl(manifest.url, options);
  if (!urlSafety.ok) {
    return { state: 'denied', reason: urlSafety.reason };
  }
  if (manifest.requiredEnv.length > 0 || manifestMetadataRequiresAccount(manifest)) {
    return { state: 'needs_owner', reason: 'account_or_oauth_requires_owner' };
  }
  const subset = autoAdmittableToolSubset(manifest);
  if (subset.tools.length > 0) {
    return {
      state: 'auto_admitted',
      reason: subset.excludedTools.length > 0 ? 'safe_remote_sandbox_tool_subset' : 'safe_remote_sandbox',
      manifest: { ...manifest, tools: subset.tools },
      excludedTools: subset.excludedTools,
    };
  }
  if (manifest.tools.some((tool) => tool.tier === 'T5')) {
    return { state: 'denied', reason: 'high_risk_tools_denied' };
  }
  if (manifest.tools.some((tool) => tool.tier === 'T4')) {
    return { state: 'needs_owner', reason: 'write_tools_require_owner' };
  }
  if (manifest.tools.some((tool) => tool.reason === 'authenticated_read')) {
    return { state: 'needs_owner', reason: 'authenticated_read_requires_owner' };
  }
  return { state: 'needs_owner', reason: 'non_activity_requires_owner' };
}

function autoAdmittableToolSubset(manifest) {
  const tools = manifest.tools.filter((tool) => isAutoAdmittableTool(manifest, tool));
  return {
    tools,
    excludedTools: manifest.tools
      .filter((tool) => !tools.includes(tool))
      .map(excludedToolSummary),
  };
}

function isAutoAdmittableTool(manifest, tool) {
  if (manifest.activityKind === 'game') return tool.tier === 'T3' && tool.reason === 'sandbox_activity';
  if (['forum', 'browser'].includes(manifest.activityKind)) return tool.tier === 'T1' && tool.reason === 'public_read';
  return false;
}

function enabledManifestForEntry(entry) {
  const validated = validateManifest(entry.manifest || {});
  if (!validated.ok) return null;
  if (!['safe_remote_sandbox', 'safe_remote_sandbox_tool_subset'].includes(String(entry.reason || ''))) {
    return validated.manifest;
  }
  const subset = autoAdmittableToolSubset(validated.manifest);
  return subset.tools.length > 0 ? { ...validated.manifest, tools: subset.tools } : null;
}

function excludedToolSummary(tool) {
  return {
    name: tool.name,
    title: tool.title,
    tier: tool.tier,
    profileScope: tool.profileScope,
    confirmationRequired: tool.confirmationRequired,
    reason: tool.reason,
  };
}

async function validateRemoteMcpUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return { ok: false, reason: 'remote_url_required' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'remote_https_required' };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, reason: 'ssrf_hostname_denied' };
  }
  const literalIp = net.isIP(parsed.hostname) ? parsed.hostname : '';
  if (literalIp) {
    return isBlockedIp(literalIp)
      ? { ok: false, reason: 'ssrf_ip_denied' }
      : { ok: true, reason: 'url_safe' };
  }
  try {
    const records = await lookupHost(parsed.hostname, options.lookupImpl);
    if (records.length === 0 || records.some((item) => isBlockedIp(item.address))) {
      return { ok: false, reason: 'dns_ssrf_check_failed' };
    }
    return { ok: true, reason: 'url_safe' };
  } catch {
    return { ok: false, reason: 'dns_ssrf_check_failed' };
  }
}

async function lookupHost(hostname, lookupImpl) {
  if (typeof lookupImpl === 'function') {
    const records = await lookupImpl(hostname);
    return normalizeLookupRecords(records);
  }
  return normalizeLookupRecords(await dns.lookup(hostname, { all: true, verbatim: true }));
}

function normalizeLookupRecords(records) {
  const list = Array.isArray(records) ? records : records ? [records] : [];
  return list
    .map((item) => (typeof item === 'string' ? { address: item } : item))
    .filter((item) => item && typeof item.address === 'string' && item.address.trim());
}

function isLocalExecutableManifest(manifest) {
  return manifest.transport === 'stdio' || Boolean(manifest.command) || manifest.args.length > 0;
}

function manifestRequiresAccount(manifest) {
  return hasAccountBoundaryText(JSON.stringify(manifest));
}

function manifestMetadataRequiresAccount(manifest) {
  return manifestRequiresAccount({ ...manifest, tools: [] });
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

function isSandboxActivityTool(haystack, options = {}) {
  if (normalizeActivityKind(options.activityKind || '') !== 'game') return false;
  if (hasAccountBoundaryText(haystack) || /\b(file|shell|exec|auth|payment|pay|forum|post|reply|comment|like|follow)\b/i.test(haystack)) {
    return false;
  }
  return /\b(game|sandbox|simulation|simulator|cmd|command|observe|wait|gaze|look|summon|feed|clean|shelter|choose|name|status|trends|folio|chronicle|encyclopedia)\b|游戏|生态|模拟/i.test(haystack);
}

function hasAccountBoundaryText(value) {
  const text = String(value || '');
  const identifierSplit = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ');
  return ACCOUNT_BOUNDARY_WORDS.test(text) || ACCOUNT_BOUNDARY_WORDS.test(identifierSplit);
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
  const propertyNames = [];
  const required = [];
  collectSchemaFields(input, { propertyNames, required });
  return {
    type: sanitizeShort(input.type || 'object') || 'object',
    propertyNames,
    required,
  };
}

function summarizeToolSchema(tool = {}) {
  const rawSchema = rawInputSchema(tool);
  if (rawSchema !== null) return summarizeSchema(rawSchema);
  return normalizeSchemaSummary(tool.inputSchemaSummary || tool.input_schema_summary || {});
}

function rawInputSchema(tool = {}) {
  if (Object.prototype.hasOwnProperty.call(tool, 'inputSchema')) return tool.inputSchema;
  if (Object.prototype.hasOwnProperty.call(tool, 'input_schema')) return tool.input_schema;
  return null;
}

function normalizeSchemaSummary(summary = {}) {
  const input = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  return {
    type: sanitizeShort(input.type || 'object') || 'object',
    propertyNames: normalizeStringList(input.propertyNames || input.property_names).slice(0, MAX_SCHEMA_FIELDS),
    required: normalizeStringList(input.required).slice(0, MAX_SCHEMA_FIELDS),
  };
}

function collectSchemaFields(schema, output, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 6) return;
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  for (const [key, child] of Object.entries(properties)) {
    pushUniqueBounded(output.propertyNames, sanitizeShort(key), MAX_SCHEMA_FIELDS);
    collectSchemaFields(child, output, depth + 1);
  }
  for (const item of normalizeStringList(schema.required)) {
    pushUniqueBounded(output.required, item, MAX_SCHEMA_FIELDS);
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    collectSchemaFields(schema.items, output, depth + 1);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = Array.isArray(schema[key]) ? schema[key] : [];
    for (const variant of variants) collectSchemaFields(variant, output, depth + 1);
  }
}

function pushUniqueBounded(list, value, max) {
  if (!value || list.length >= max || list.includes(value)) return;
  list.push(value);
}

function inspectSchemaRisk(schema) {
  const state = {
    accountBoundary: false,
    truncated: false,
    nodes: 0,
    seen: new WeakSet(),
  };
  scanSchemaRisk(schema, state, 0);
  return {
    accountBoundary: state.accountBoundary,
    truncated: state.truncated,
  };
}

function inspectSchemaSummaryRisk(summary) {
  const normalized = normalizeSchemaSummary(summary);
  return {
    accountBoundary: hasAccountBoundaryText(`${normalized.type} ${normalized.propertyNames.join(' ')} ${normalized.required.join(' ')}`),
    truncated: normalized.propertyNames.length >= LEGACY_SCHEMA_SUMMARY_FIELDS
      || normalized.required.length >= LEGACY_SCHEMA_SUMMARY_FIELDS,
  };
}

function scanSchemaRisk(value, state, depth) {
  if (state.accountBoundary || state.truncated) return;
  if (typeof value === 'string') {
    if (hasAccountBoundaryText(value)) state.accountBoundary = true;
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_SCAN_NODES || depth > MAX_SCHEMA_SCAN_DEPTH) {
    state.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanSchemaRisk(item, state, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (hasAccountBoundaryText(key)) {
      state.accountBoundary = true;
      return;
    }
    scanSchemaRisk(child, state, depth + 1);
  }
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

function normalizeActivityKind(value) {
  const normalized = sanitizeShort(value).toLowerCase();
  return ['game', 'forum', 'browser', 'api'].includes(normalized) ? normalized : '';
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

function sanitizeUrl(value) {
  const text = sanitizeShort(value);
  return /^https?:\/\//i.test(text) ? text : '';
}

function sanitizeText(value) {
  return redactSecrets(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, MAX_TEXT);
}

function sanitizeShort(value) {
  return redactSecrets(String(value || '').replace(/[\r\n\t]/g, ' ').trim()).slice(0, 160);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'authorization=[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|sessdata)\s*[:=]\s*[^ ,;}]+/gi, '$1=[redacted]')
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

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return {
    registry: path.join(root, 'registry.json'),
  };
}

function readRegistry(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(env).registry, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries, env) {
  const target = paths(env).registry;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function writeRegistryEntry({ state, enabled, reason, errors, manifest, excludedTools, candidateId, now }, env) {
  const serverId = sanitizeId(manifest?.id || candidateId || '');
  const previous = readRegistry(env).find((entry) => entry.serverId === serverId);
  const entry = {
    serverId,
    state,
    enabled,
    reason,
    errors: Array.isArray(errors) ? errors : [],
    manifest,
    excludedTools: Array.isArray(excludedTools) ? excludedTools : [],
    createdAt: previous?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
  writeRegistry([...readRegistry(env).filter((item) => item.serverId !== serverId), entry], env);
  return entry;
}

function isBlockedHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return !normalized
    || normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.lan');
}

function isBlockedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) {
    const lower = String(address || '').toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return lower === '::1'
      || lower === '::'
      || lower.startsWith('fe80:')
      || lower.startsWith('fc')
      || lower.startsWith('fd')
      || (mapped ? isBlockedIpv4(mapped[1]) : false);
  }
  return true;
}

function isBlockedIpv4(address) {
  const parts = String(address || '').split('.').map((item) => Number.parseInt(item, 10));
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}
