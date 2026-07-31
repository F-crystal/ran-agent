// Tool-less Memory Curator invocation contract (§5.1) for the O2 stewarded
// growth compatibility layer.
// Sole authority: hermes_ombre_stewarded_growth_compatibility_calibration_v0.2.md
// (protocol id `ombre-stewarded-growth-compatibility/2`).
//
// The Curator is an independent, tool-less model call. It judges whether one
// fixed compatibility final-turn experience reaches the Ombre Experience
// Publication Gate and proposes uncommitted first-person candidates. Per
// §5.1 and §6.2 the Curator MUST NOT:
//
// - call any tool — the request body never carries tools / tool_choice /
//   functions fields; the wrapper asserts this before send and freezes
//   tool_inventory_digest to canonicalDigest([]);
// - read the raw MCP registry;
// - write queue state;
// - call Ombre;
// - decide operation success;
// - activate I, or mutate Canon / Relationship / Soul / Grant / permissions.
//
// The input envelope carries only the source event's typed metadata plus
// deletion-domain governed payload texts injected by the caller (read from
// the payload store outside this module) — never any other conversation
// (§3.3). Model output is validated against the frozen candidate schema and
// growth budget profile v1 (§6.3); any violation returns
// { status: 'malformed' } with zero mutation. Model/transport failures are
// typed results ({ status: 'unavailable' | 'timeout' | 'malformed' }), never
// exceptions thrown across this module's boundary.

import {
  canonicalDigest,
  canonicalStringify,
  deepFreezeClone,
  newId,
  sha256Hex,
  utf8ByteLength,
} from './canonical.mjs';
import { getOmbreCompatConfig } from './config.mjs';
import {
  BUDGET_PROFILE_V1,
  COMPAT_CURATOR_PROTOCOL_VERSION,
  COMPAT_SOURCE_EVENT_SCHEMA,
  MODEL_CANDIDATE_KINDS,
  SENSITIVITY_LEVELS,
  compatError,
} from './constants.mjs';

export const CURATOR_ENVELOPE_SCHEMA = 'compat-curator-input/v1';

const DEFAULT_MAX_PAYLOAD_CHARS = 4096;
const MAX_PAYLOAD_TEXT_ENTRIES = 8;
const MAX_PAYLOAD_KEY_CHARS = 64;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ERROR_DETAIL_CHARS = 200;

// Tool-capability fields that must never appear anywhere in a tool-less
// request body. The wrapper scans recursively before send.
const TOOL_FIELD_NAMES = new Set(['tools', 'tool_choice', 'functions', 'function_call']);

// Frozen candidate schema fields (§5.1). Anything else in a model candidate
// is rejected (strict output) or stripped (envelope sanitization).
const CANDIDATE_FIELDS = [
  'candidate_kind',
  'title',
  'first_person_text',
  'source_refs',
  'scope_envelope_digest',
  'sensitivity',
  'counterevidence',
  'uncertainty',
];

const CURATOR_SYSTEM_PROMPT = [
  'You are the tool-less Memory Curator of a pre-Gate-5 Ombre stewarded-growth compatibility pipeline (protocol compat-curator/v1).',
  'You receive exactly one compatibility final-turn source event (typed metadata only) plus its deletion-domain governed payload texts. You never receive any other conversation.',
  'Your job:',
  '- Judge whether the experience reaches the Ombre Experience Publication Gate.',
  '- Propose experience / association / low-impact preference observation / I observation candidate / correction observation candidates.',
  '- Preserve first-person natural narrative in first_person_text.',
  '- Give source_refs, scope_envelope_digest (echo the source event scope digest exactly), sensitivity, counterevidence, and uncertainty for every candidate.',
  '- Default to filtering ordinary greetings, per-message intimate small talk, and ordinary task success.',
  'Hard rules:',
  '- You have no tools. Never call tools, never read registries, never write queue state, never call Ombre, never decide operation success, never activate I, never mutate Canon/Relationship/Soul/Grant/permissions.',
  '- Never claim an action completed unless a matching trusted receipt ref already exists in the source event; never turn model prose into a receipt.',
  '- candidate_kind must be one of: append_experience, append_association, append_low_impact_preference_observation, append_i_observation_candidate, append_correction_or_supersession_observation.',
  '- preference stays an observation, I stays a candidate, correction only appends an observation with a supersedes ref, association never becomes current fact.',
  '- first_person_text is at most 4096 UTF-8 bytes; each candidate has at most 16 source_refs.',
  '- sensitivity must be one of: public, standard, personal, sensitive, sealed; never lower than the source event sensitivity.',
  '- Your output is an uncommitted candidate set, never a publication decision.',
  'Return strict JSON only: {"candidates":[{"candidate_kind":"...","title":"...","first_person_text":"...","source_refs":["..."],"scope_envelope_digest":"...","sensitivity":"...","counterevidence":"...","uncertainty":"..."}]}.',
  'If nothing qualifies, return {"candidates":[]}.',
].join('\n');

// Builds the controlled Curator input envelope. Only typed source-event
// metadata and caller-injected payload texts are included; the digest binds
// the exact material the model sees. Throws compatError on invalid caller
// input (fail closed before any model contact).
export function buildCuratorEnvelope({
  sourceEvent,
  payloadTexts = {},
  maxPayloadChars = DEFAULT_MAX_PAYLOAD_CHARS,
} = {}) {
  const source = pickSourceEventMetadata(sourceEvent);
  const material = {
    schema_version: CURATOR_ENVELOPE_SCHEMA,
    protocol_version: COMPAT_CURATOR_PROTOCOL_VERSION,
    source_event: source,
    payload_texts: normalizePayloadTexts(payloadTexts, maxPayloadChars),
    candidate_kind_allowlist: [...MODEL_CANDIDATE_KINDS],
    budget_profile: BUDGET_PROFILE_V1,
  };
  return deepFreezeClone({ ...material, curator_input_digest: canonicalDigest(material) });
}

// Runs one independent tool-less Curator invocation. Returns:
// - { status: 'completed', invocation, candidates, output_digest }
// - { status: 'unavailable' | 'timeout' | 'malformed', error_code, invocation }
// `config` takes the getOmbreCompatConfig(env).curator shape
// ({ baseUrl, model, apiKey, timeoutMs }). `curatorImpl` defaults to the
// internal HTTP implementation (POST `${baseUrl}/chat/completions`); tests
// inject fakes. An impl may return the raw output text string or
// { output_text, model_version }. This function never throws model,
// transport, or output-validation failures across its boundary.
export async function runCuratorInvocation({
  envelope,
  config = getOmbreCompatConfig().curator,
  curatorImpl = defaultCuratorHttpImpl,
  clock = () => new Date(),
  invocationIdFactory = () => newId('ocq_cur'),
  fetchImpl = fetch,
} = {}) {
  const modelId = typeof config?.model === 'string' ? config.model : '';
  const inputDigest = typeof envelope?.curator_input_digest === 'string'
    ? envelope.curator_input_digest
    : '';
  const invocationId = String(invocationIdFactory());
  const invocation = {
    curator_invocation_id: invocationId,
    curator_invocation_ref: invocationRef('compat-curator-invocation', {
      invocation_id: invocationId,
      input_digest: inputDigest,
      protocol_version: COMPAT_CURATOR_PROTOCOL_VERSION,
    }),
    curator_model_id: modelId,
    curator_model_version: modelId,
    curator_protocol_version: COMPAT_CURATOR_PROTOCOL_VERSION,
    curator_input_digest: inputDigest,
    // The tool inventory is frozen empty; the digest proves it.
    tool_inventory_digest: canonicalDigest([]),
    started_at: isoNow(clock),
    completed_at: null,
  };
  const finish = (result) => {
    invocation.completed_at = isoNow(clock);
    return result;
  };
  const fail = (status, detail) => finish({
    status,
    error_code: status === 'malformed' ? 'COMPAT_CURATOR_MALFORMED' : 'COMPAT_CURATOR_UNAVAILABLE',
    error_detail: String(detail || status).slice(0, MAX_ERROR_DETAIL_CHARS),
    invocation,
  });

  try {
    // Envelope binding: the declared digest must cover the exact envelope
    // material, otherwise the provenance chain is broken before the call.
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !inputDigest) {
      return fail('malformed', 'curator envelope is missing curator_input_digest');
    }
    let digestMatches = false;
    try {
      const { curator_input_digest: _ignored, ...material } = envelope;
      digestMatches = canonicalDigest(material) === inputDigest;
    } catch {
      digestMatches = false;
    }
    if (!digestMatches) {
      return fail('malformed', 'curator envelope digest mismatch');
    }

    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.replace(/\/+$/, '') : '';
    if (!baseUrl || !modelId) {
      return fail('unavailable', 'curator endpoint is not configured');
    }

    // The request body is built here and only here. Hard rule: it never
    // carries tool-capability fields (tools / tool_choice / functions).
    const request = {
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: {
        model: modelId,
        messages: [
          { role: 'system', content: CURATOR_SYSTEM_PROMPT },
          { role: 'user', content: canonicalStringify(envelope) },
        ],
        temperature: 0,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        stream: false,
      },
    };
    assertNoToolFields(request.body);

    const timeoutMs = normalizeTimeout(config.timeoutMs);
    const controller = new AbortController();
    let raw;
    try {
      raw = await raceTimeout(
        Promise.resolve(curatorImpl(request, { config, signal: controller.signal, fetchImpl })),
        timeoutMs,
        controller,
      );
    } catch (error) {
      return fail(errorKind(error), errorDetail(error, 'curator invocation failed'));
    }

    const { outputText, modelVersion } = normalizeImplResult(raw);
    if (modelVersion) invocation.curator_model_version = modelVersion;
    if (!outputText) {
      return fail('malformed', 'curator returned no output text');
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return fail('malformed', 'curator output was not valid JSON');
    }
    const problem = checkCuratorOutput(parsed, envelope?.source_event?.scope_envelope_digest);
    if (problem) {
      return fail('malformed', problem);
    }

    const candidates = parsed.candidates.map((entry) => deepFreezeClone(pickCandidateFields(entry)));
    return finish({
      status: 'completed',
      invocation,
      candidates,
      output_digest: canonicalDigest(outputText),
    });
  } catch (error) {
    // Defensive: unexpected wrapper-internal faults still surface as typed
    // failures, never as exceptions breaking the queue worker.
    return fail('unavailable', errorDetail(error, 'curator wrapper internal error'));
  }
}

// Default tool-less HTTP implementation: POST `${baseUrl}/chat/completions`
// with the wrapper-built body. Transport and HTTP failures are typed
// 'unavailable'; an unparseable or empty completion is 'malformed'.
async function defaultCuratorHttpImpl(request, { signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw typedError('timeout', 'curator request aborted');
    throw typedError('unavailable', errorDetail(error, 'curator request failed'));
  }
  if (!response?.ok) {
    throw typedError('unavailable', `curator HTTP ${response?.status ?? 'error'}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw typedError('malformed', 'curator response was not JSON');
  }
  const outputText = payload?.choices?.[0]?.message?.content;
  if (typeof outputText !== 'string' || outputText.length === 0) {
    throw typedError('malformed', 'curator response carried no completion content');
  }
  return {
    output_text: outputText,
    model_version: typeof payload?.model === 'string' ? payload.model : '',
  };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

// Picks only the typed metadata of a compatibility.final-turn/v1 source
// event (refs, digests, enums, revisions). Payload bodies are never part of
// the source event and therefore never part of the envelope (§3.3, §4.2).
function pickSourceEventMetadata(sourceEvent) {
  if (!sourceEvent || typeof sourceEvent !== 'object' || Array.isArray(sourceEvent)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'curator envelope requires a source event object');
  }
  if (sourceEvent.schema_version !== COMPAT_SOURCE_EVENT_SCHEMA) {
    throw compatError('COMPAT_INGRESS_INVALID', `curator envelope requires ${COMPAT_SOURCE_EVENT_SCHEMA}`);
  }
  const requiredStrings = [
    'event_id',
    'source_event_digest',
    'conversation_id',
    'exchange_id',
    'user_final_payload_ref',
    'user_final_payload_digest',
    'assistant_final_payload_ref',
    'assistant_final_payload_digest',
    'final_content_digest',
    'scope_envelope_ref',
    'scope_envelope_digest',
    'sensitivity',
    'presentation_state',
    'lifecycle_state',
    'trusted_action_receipts_digest',
    'emitted_at',
  ];
  for (const field of requiredStrings) {
    if (typeof sourceEvent[field] !== 'string' || sourceEvent[field].length === 0) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event missing ${field}`);
    }
  }
  const requiredIntegers = [
    'source_revision',
    'user_final_payload_revision',
    'assistant_final_payload_revision',
  ];
  for (const field of requiredIntegers) {
    if (!Number.isInteger(sourceEvent[field]) || sourceEvent[field] < 0) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event ${field} must be a non-negative integer`);
    }
  }
  const receiptRefs = sourceEvent.trusted_action_receipt_refs;
  if (!Array.isArray(receiptRefs) || receiptRefs.some((ref) => typeof ref !== 'string' || !ref)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'source event trusted_action_receipt_refs must be non-empty strings');
  }
  const supersedes = sourceEvent.supersedes_event_id;
  if (supersedes !== null && supersedes !== undefined && typeof supersedes !== 'string') {
    throw compatError('COMPAT_INGRESS_INVALID', 'source event supersedes_event_id must be a string or null');
  }
  return {
    schema_version: sourceEvent.schema_version,
    event_id: sourceEvent.event_id,
    source_revision: sourceEvent.source_revision,
    source_event_digest: sourceEvent.source_event_digest,
    conversation_id: sourceEvent.conversation_id,
    exchange_id: sourceEvent.exchange_id,
    user_final_payload_ref: sourceEvent.user_final_payload_ref,
    user_final_payload_revision: sourceEvent.user_final_payload_revision,
    user_final_payload_digest: sourceEvent.user_final_payload_digest,
    assistant_final_payload_ref: sourceEvent.assistant_final_payload_ref,
    assistant_final_payload_revision: sourceEvent.assistant_final_payload_revision,
    assistant_final_payload_digest: sourceEvent.assistant_final_payload_digest,
    final_content_digest: sourceEvent.final_content_digest,
    scope_envelope_ref: sourceEvent.scope_envelope_ref,
    scope_envelope_digest: sourceEvent.scope_envelope_digest,
    sensitivity: sourceEvent.sensitivity,
    presentation_state: sourceEvent.presentation_state,
    trusted_action_receipt_refs: [...receiptRefs],
    trusted_action_receipts_digest: sourceEvent.trusted_action_receipts_digest,
    lifecycle_state: sourceEvent.lifecycle_state,
    supersedes_event_id: supersedes ?? null,
    emitted_at: sourceEvent.emitted_at,
  };
}

// Normalizes caller-injected payload texts (deletion-domain governed
// referenced content, §3.4). Each text is truncated to maxPayloadChars
// codepoints; truncation is recorded for audit.
function normalizePayloadTexts(payloadTexts, maxPayloadChars) {
  if (!payloadTexts || typeof payloadTexts !== 'object' || Array.isArray(payloadTexts)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'payloadTexts must be an object of string texts');
  }
  if (!Number.isInteger(maxPayloadChars) || maxPayloadChars < 1 || maxPayloadChars > 65536) {
    throw compatError('COMPAT_INGRESS_INVALID', 'maxPayloadChars must be an integer in 1..65536');
  }
  const entries = Object.entries(payloadTexts);
  if (entries.length > MAX_PAYLOAD_TEXT_ENTRIES) {
    throw compatError('COMPAT_INGRESS_INVALID', `payloadTexts carries at most ${MAX_PAYLOAD_TEXT_ENTRIES} entries`);
  }
  const out = {};
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_PAYLOAD_KEY_CHARS) {
      throw compatError('COMPAT_INGRESS_INVALID', 'payloadTexts keys must be non-empty and bounded');
    }
    if (typeof value !== 'string') {
      throw compatError('COMPAT_INGRESS_INVALID', `payload text ${key} must be a string`);
    }
    const chars = [...value];
    const truncated = chars.length > maxPayloadChars;
    out[key] = {
      text: truncated ? chars.slice(0, maxPayloadChars).join('') : value,
      original_chars: chars.length,
      truncated,
    };
  }
  return out;
}

// Strict Curator output validation (§5.1 schema + §6.3 budget). Returns a
// static problem string, or null when the output is schema-valid.
function checkCuratorOutput(parsed, scopeEnvelopeDigest) {
  if (!isPlainObject(parsed)) return 'curator output must be a JSON object';
  if (Object.keys(parsed).some((key) => key !== 'candidates')) return 'curator output has unknown fields';
  if (!Array.isArray(parsed.candidates)) return 'curator output candidates must be an array';
  for (const entry of parsed.candidates) {
    const problem = checkModelCandidate(entry, scopeEnvelopeDigest, { strictKeys: true });
    if (problem) return problem;
  }
  return null;
}

// Frozen candidate schema check. kind allowlist (MODEL_CANDIDATE_KINDS —
// bounded_retrieval_touch is never model-proposable), first_person_text
// bounded in UTF-8 bytes (§6.3), source_refs bounded and string-typed,
// scope digest bound to the envelope scope, sensitivity on the ladder.
function checkModelCandidate(candidate, scopeEnvelopeDigest, { strictKeys }) {
  if (!isPlainObject(candidate)) return 'candidate must be an object';
  if (strictKeys && Object.keys(candidate).some((key) => !CANDIDATE_FIELDS.includes(key))) {
    return 'candidate has unknown fields';
  }
  if (!MODEL_CANDIDATE_KINDS.includes(candidate.candidate_kind)) {
    return 'candidate_kind is not in the model candidate allowlist';
  }
  if (typeof candidate.title !== 'string' || !candidate.title) {
    return 'candidate title must be a non-empty string';
  }
  if (typeof candidate.first_person_text !== 'string' || !candidate.first_person_text) {
    return 'candidate first_person_text must be a non-empty string';
  }
  if (utf8ByteLength(candidate.first_person_text) > BUDGET_PROFILE_V1.max_candidate_payload_utf8_bytes) {
    return `candidate first_person_text exceeds ${BUDGET_PROFILE_V1.max_candidate_payload_utf8_bytes} UTF-8 bytes`;
  }
  if (!Array.isArray(candidate.source_refs)
    || candidate.source_refs.length > BUDGET_PROFILE_V1.max_candidate_source_refs) {
    return `candidate source_refs must be an array of at most ${BUDGET_PROFILE_V1.max_candidate_source_refs} entries`;
  }
  if (candidate.source_refs.some((ref) => typeof ref !== 'string' || !ref)) {
    return 'candidate source_refs entries must be non-empty strings';
  }
  if (typeof candidate.scope_envelope_digest !== 'string' || !candidate.scope_envelope_digest) {
    return 'candidate scope_envelope_digest must be a non-empty string';
  }
  if (scopeEnvelopeDigest && candidate.scope_envelope_digest !== scopeEnvelopeDigest) {
    return 'candidate scope_envelope_digest does not match the envelope scope';
  }
  if (!SENSITIVITY_LEVELS.includes(candidate.sensitivity)) {
    return 'candidate sensitivity is not a known level';
  }
  if (typeof candidate.counterevidence !== 'string') return 'candidate counterevidence must be a string';
  if (typeof candidate.uncertainty !== 'string') return 'candidate uncertainty must be a string';
  return null;
}

function pickCandidateFields(candidate) {
  const out = {};
  for (const field of CANDIDATE_FIELDS) out[field] = candidate[field];
  return out;
}

// Recursive tripwire: a tool-less request body must not contain tool
// capability fields anywhere. Tripping means wrapper construction is broken;
// it fails closed before any bytes leave the process.
function assertNoToolFields(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoToolFields(entry);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (TOOL_FIELD_NAMES.has(key)) {
        throw typedError('malformed', `tool-less request body must not contain ${key}`);
      }
      assertNoToolFields(entry);
    }
  }
}

// Races the impl promise against the timeout; firing aborts the impl's
// signal so the default HTTP transport cancels too.
function raceTimeout(promise, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // abort is best-effort; the typed timeout below is the authority.
      }
      reject(typedError('timeout', `curator invocation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeImplResult(raw) {
  if (typeof raw === 'string') return { outputText: raw, modelVersion: '' };
  if (raw && typeof raw === 'object') {
    const outputText = typeof raw.output_text === 'string'
      ? raw.output_text
      : (typeof raw.outputText === 'string' ? raw.outputText : '');
    const modelVersion = typeof raw.model_version === 'string'
      ? raw.model_version
      : (typeof raw.modelVersion === 'string' ? raw.modelVersion : '');
    return { outputText, modelVersion };
  }
  return { outputText: '', modelVersion: '' };
}

function invocationRef(prefix, material) {
  return `${prefix}:${sha256Hex(canonicalStringify(material)).slice(0, 32)}`;
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function typedError(kind, message) {
  const error = new Error(message);
  error.invocationKind = kind;
  return error;
}

function errorKind(error) {
  if (error?.invocationKind === 'timeout' || isAbortError(error)) return 'timeout';
  if (error?.invocationKind === 'malformed') return 'malformed';
  return 'unavailable';
}

function errorDetail(error, fallback) {
  return String(error?.message || fallback).slice(0, MAX_ERROR_DETAIL_CHARS);
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
