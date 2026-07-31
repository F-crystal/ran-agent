// Independent tool-less Memory Reviewer invocation contract (§5.2) for the
// O2 stewarded growth compatibility layer.
// Sole authority: hermes_ombre_stewarded_growth_compatibility_calibration_v0.2.md
// (protocol id `ombre-stewarded-growth-compatibility/2`).
//
// The Reviewer is a second tool-less model call, fully separated from the
// Curator: independent invocation, independent invocation id / model id /
// input digest / protocol version, empty tool inventory, and no access to
// Curator-private reasoning — the envelope forwards only the candidates'
// structured fields, never curator raw output text or reasoning (§5.2).
//
// The Reviewer has NO execution, policy, receipt, current-truth, or
// publication authority (§5.2). It returns exactly one typed decision —
// accept / revise / split / reject — plus a typed claim manifest (§4.4).
// Claim outcomes are enum-checked and preserved verbatim: an 'ambiguous'
// outcome is never rewritten to 'succeeded' or 'failed' (§4.4). An
// action_completion claim without trusted receipt refs is a reviewer
// protocol failure and fails closed as { status: 'malformed' }.
//
// Model/transport failures are typed results
// ({ status: 'unavailable' | 'timeout' | 'malformed' }), never exceptions
// thrown across this module's boundary.
//
// This module is deliberately self-contained: the small transport and
// candidate-schema helpers mirror curator.mjs so each invocation module can
// be reviewed and audited independently (§5.2 separation). The schema and
// allowlists themselves are frozen by the shared constants module.

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
  CLAIM_KINDS,
  COMPAT_REVIEWER_PROTOCOL_VERSION,
  COMPAT_SOURCE_EVENT_SCHEMA,
  FORBIDDEN_CLASSES,
  MODEL_CANDIDATE_KINDS,
  REVIEWER_DECISIONS,
  SENSITIVITY_LEVELS,
  compatError,
} from './constants.mjs';

export const REVIEWER_ENVELOPE_SCHEMA = 'compat-reviewer-input/v1';

// Claim outcome enum (§4.4). 'ambiguous' is preserved verbatim; the wrapper
// never rewrites it to a success or failure.
export const CLAIM_OUTCOMES = Object.freeze(['succeeded', 'failed', 'ambiguous', 'none']);

const DEFAULT_MAX_PAYLOAD_CHARS = 4096;
const MAX_PAYLOAD_TEXT_ENTRIES = 8;
const MAX_PAYLOAD_KEY_CHARS = 64;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ERROR_DETAIL_CHARS = 200;

// Tool-capability fields that must never appear anywhere in a tool-less
// request body. The wrapper scans recursively before send.
const TOOL_FIELD_NAMES = new Set(['tools', 'tool_choice', 'functions', 'function_call']);

// Frozen candidate schema fields (§5.1), identical to the Curator schema.
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

// Frozen claim schema fields (§4.4 typed claim manifest).
const CLAIM_FIELDS = [
  'claim_kind',
  'requires_trusted_receipt',
  'receipt_refs',
  'forbidden_classes',
  'outcome',
];

const REVIEWER_SYSTEM_PROMPT = [
  'You are the independent tool-less Memory Reviewer of a pre-Gate-5 Ombre stewarded-growth compatibility pipeline (protocol compat-reviewer/v1).',
  'You are a second invocation fully separated from the Curator. You receive only the source event typed metadata, the candidates\' structured fields, the source payload texts, and the necessary scope. You never receive the Curator\'s private reasoning or raw output.',
  'Check every candidate for: fabricated experience; source-less romanticization; over-inference; turning one emotion into permanent personality; turning address terms or closeness into permission; scope leakage; sensitivity downgrade; unsupported action completion; current fact / task / permission / active-I overreach; ordinary greetings or low-value logs.',
  'Hard rules:',
  '- You have no tools, and no execution, policy, receipt, current-truth, or publication authority.',
  '- Never rewrite an ambiguous outcome into succeeded or failed; every claim outcome must be exactly one of succeeded|failed|ambiguous|none, and ambiguous stays ambiguous.',
  '- Every action_completion claim must list trusted receipt refs from the source event; model prose is never a receipt.',
  '- forbidden_classes entries must come from the provided allowlist; claim_kind must come from the provided allowlist.',
  '- preference stays an observation, I stays a candidate, association never becomes current fact.',
  'Decide exactly one of:',
  '- accept: the candidate payload digest stays unchanged; carry no revised or split candidates.',
  '- revise: carry exactly one revised_candidate (same candidate schema).',
  '- split: carry two or more split_candidates (same candidate schema).',
  '- reject: zero projection operations; carry no candidates.',
  'Return strict JSON only: {"decision":"accept|revise|split|reject","reason_code":"...","claim_manifest":{"claims":[{"claim_kind":"...","requires_trusted_receipt":true,"receipt_refs":["..."],"forbidden_classes":["..."],"outcome":"succeeded|failed|ambiguous|none"}]},"revised_candidate":{...},"split_candidates":[{...}]}.',
  'Include revised_candidate only for revise, split_candidates only for split.',
].join('\n');

// Builds the controlled Reviewer input envelope. Only the source event typed
// metadata, the candidates' structured fields, the source refs they carry,
// the necessary scope, and caller-injected payload texts are included. Any
// non-schema candidate annotation (e.g. curator-private reasoning or raw
// output text) is stripped here — the Reviewer never receives it (§5.2).
// Throws compatError on invalid caller input (fail closed before any model
// contact).
export function buildReviewerEnvelope({
  sourceEvent,
  candidates = [],
  payloadTexts = {},
} = {}) {
  const source = pickSourceEventMetadata(sourceEvent);
  if (!Array.isArray(candidates)) {
    throw compatError('COMPAT_CANDIDATE_INVALID', 'reviewer envelope candidates must be an array');
  }
  const cleanCandidates = candidates.map((entry) => {
    // Whitelist-pick the structured fields only; everything else is dropped.
    const picked = pickCandidateFields(isPlainObject(entry) ? entry : {});
    const problem = checkModelCandidate(picked, source.scope_envelope_digest, { strictKeys: false });
    if (problem) throw compatError('COMPAT_CANDIDATE_INVALID', problem);
    return picked;
  });
  const material = {
    schema_version: REVIEWER_ENVELOPE_SCHEMA,
    protocol_version: COMPAT_REVIEWER_PROTOCOL_VERSION,
    source_event: source,
    candidates: cleanCandidates,
    payload_texts: normalizePayloadTexts(payloadTexts, DEFAULT_MAX_PAYLOAD_CHARS),
    decision_allowlist: [...REVIEWER_DECISIONS],
    claim_kind_allowlist: [...CLAIM_KINDS],
    forbidden_class_allowlist: [...FORBIDDEN_CLASSES],
    outcome_allowlist: [...CLAIM_OUTCOMES],
  };
  return deepFreezeClone({ ...material, reviewer_input_digest: canonicalDigest(material) });
}

// Runs one independent tool-less Reviewer invocation. Returns:
// - { status: 'completed', invocation, decision, reason_code,
//     reviewer_revision, claim_manifest, final_candidates, output_digest }
// - { status: 'unavailable' | 'timeout' | 'malformed', error_code, invocation }
// reviewer_revision is 0 for accept/reject and 1 for revise/split (§5.2).
// `config` takes the getOmbreCompatConfig(env).reviewer shape
// ({ baseUrl, model, apiKey, timeoutMs }). `reviewerImpl` defaults to the
// internal HTTP implementation; tests inject fakes. This function never
// throws model, transport, or output-validation failures across its
// boundary.
export async function runReviewerInvocation({
  envelope,
  config = getOmbreCompatConfig().reviewer,
  reviewerImpl = defaultReviewerHttpImpl,
  clock = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  const modelId = typeof config?.model === 'string' ? config.model : '';
  const inputDigest = typeof envelope?.reviewer_input_digest === 'string'
    ? envelope.reviewer_input_digest
    : '';
  // Independent invocation id, generated inside this module; never reused
  // from the Curator invocation (§5.2 independence proof).
  const invocationId = newId('ocq_rev');
  const invocation = {
    reviewer_invocation_id: invocationId,
    reviewer_invocation_ref: invocationRef('compat-reviewer-invocation', {
      invocation_id: invocationId,
      input_digest: inputDigest,
      protocol_version: COMPAT_REVIEWER_PROTOCOL_VERSION,
    }),
    reviewer_model_id: modelId,
    reviewer_model_version: modelId,
    reviewer_protocol_version: COMPAT_REVIEWER_PROTOCOL_VERSION,
    reviewer_input_digest: inputDigest,
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
    error_code: status === 'malformed' ? 'COMPAT_REVIEWER_MALFORMED' : 'COMPAT_REVIEWER_UNAVAILABLE',
    error_detail: String(detail || status).slice(0, MAX_ERROR_DETAIL_CHARS),
    invocation,
  });

  try {
    // Envelope binding: the declared digest must cover the exact envelope
    // material, otherwise the provenance chain is broken before the call.
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !inputDigest) {
      return fail('malformed', 'reviewer envelope is missing reviewer_input_digest');
    }
    let digestMatches = false;
    try {
      const { reviewer_input_digest: _ignored, ...material } = envelope;
      digestMatches = canonicalDigest(material) === inputDigest;
    } catch {
      digestMatches = false;
    }
    if (!digestMatches) {
      return fail('malformed', 'reviewer envelope digest mismatch');
    }

    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.replace(/\/+$/, '') : '';
    if (!baseUrl || !modelId) {
      return fail('unavailable', 'reviewer endpoint is not configured');
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
          { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
          { role: 'user', content: canonicalStringify(envelope) },
        ],
        temperature: 0,
        stream: false,
      },
    };
    assertNoToolFields(request.body);

    const timeoutMs = normalizeTimeout(config.timeoutMs);
    const controller = new AbortController();
    let raw;
    try {
      raw = await raceTimeout(
        Promise.resolve(reviewerImpl(request, { config, signal: controller.signal, fetchImpl })),
        timeoutMs,
        controller,
      );
    } catch (error) {
      return fail(errorKind(error), errorDetail(error, 'reviewer invocation failed'));
    }

    const { outputText, modelVersion } = normalizeImplResult(raw);
    if (modelVersion) invocation.reviewer_model_version = modelVersion;
    if (!outputText) {
      return fail('malformed', 'reviewer returned no output text');
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return fail('malformed', 'reviewer output was not valid JSON');
    }
    const validated = validateReviewerOutput(parsed, envelope?.source_event?.scope_envelope_digest);
    if (validated.problem) {
      return fail('malformed', validated.problem);
    }

    const finalCandidates = validated.decision === 'accept'
      ? deepFreezeClone(envelope.candidates)
      : validated.decision === 'revise'
        ? [deepFreezeClone(validated.revised_candidate)]
        : validated.decision === 'split'
          ? validated.split_candidates.map((entry) => deepFreezeClone(entry))
          : [];
    const reviewerRevision = validated.decision === 'revise' || validated.decision === 'split' ? 1 : 0;

    return finish({
      status: 'completed',
      invocation,
      decision: validated.decision,
      reason_code: validated.reason_code,
      reviewer_revision: reviewerRevision,
      claim_manifest: deepFreezeClone(validated.claim_manifest),
      final_candidates: finalCandidates,
      output_digest: canonicalDigest(outputText),
    });
  } catch (error) {
    // Defensive: unexpected wrapper-internal faults still surface as typed
    // failures, never as exceptions breaking the queue worker.
    return fail('unavailable', errorDetail(error, 'reviewer wrapper internal error'));
  }
}

// Default tool-less HTTP implementation: POST `${baseUrl}/chat/completions`
// with the wrapper-built body. Transport and HTTP failures are typed
// 'unavailable'; an unparseable or empty completion is 'malformed'.
async function defaultReviewerHttpImpl(request, { signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw typedError('timeout', 'reviewer request aborted');
    throw typedError('unavailable', errorDetail(error, 'reviewer request failed'));
  }
  if (!response?.ok) {
    throw typedError('unavailable', `reviewer HTTP ${response?.status ?? 'error'}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw typedError('malformed', 'reviewer response was not JSON');
  }
  const outputText = payload?.choices?.[0]?.message?.content;
  if (typeof outputText !== 'string' || outputText.length === 0) {
    throw typedError('malformed', 'reviewer response carried no completion content');
  }
  return {
    output_text: outputText,
    model_version: typeof payload?.model === 'string' ? payload.model : '',
  };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

// Strict Reviewer output validation (§5.2 decisions + §4.4 claim manifest).
// Returns { problem } on any violation, or the normalized decision payload.
function validateReviewerOutput(parsed, scopeEnvelopeDigest) {
  if (!isPlainObject(parsed)) return { problem: 'reviewer output must be a JSON object' };
  const topLevel = ['decision', 'reason_code', 'claim_manifest', 'revised_candidate', 'split_candidates'];
  if (Object.keys(parsed).some((key) => !topLevel.includes(key))) {
    return { problem: 'reviewer output has unknown fields' };
  }
  if (!REVIEWER_DECISIONS.includes(parsed.decision)) {
    return { problem: 'reviewer decision must be accept/revise/split/reject' };
  }
  if (typeof parsed.reason_code !== 'string' || !parsed.reason_code) {
    return { problem: 'reviewer reason_code must be a non-empty string' };
  }
  const manifestResult = validateClaimManifest(parsed.claim_manifest);
  if (manifestResult.problem) return { problem: manifestResult.problem };

  const hasRevised = parsed.revised_candidate !== undefined;
  const hasSplit = parsed.split_candidates !== undefined;
  if (parsed.decision === 'accept') {
    // accept: the original candidate payload digest stays unchanged (§5.2).
    if (hasRevised || hasSplit) return { problem: 'accept must not carry revised or split candidates' };
  } else if (parsed.decision === 'revise') {
    // revise: exactly one revised candidate, no split candidates (§5.2).
    if (!isPlainObject(parsed.revised_candidate) || hasSplit) {
      return { problem: 'revise must carry exactly one revised_candidate and no split_candidates' };
    }
    const problem = checkModelCandidate(parsed.revised_candidate, scopeEnvelopeDigest, { strictKeys: true });
    if (problem) return { problem };
  } else if (parsed.decision === 'split') {
    // split: two or more candidates, each independently keyed downstream.
    if (hasRevised || !Array.isArray(parsed.split_candidates) || parsed.split_candidates.length < 2) {
      return { problem: 'split must carry at least two split_candidates and no revised_candidate' };
    }
    for (const entry of parsed.split_candidates) {
      const problem = checkModelCandidate(entry, scopeEnvelopeDigest, { strictKeys: true });
      if (problem) return { problem };
    }
  } else {
    // reject: zero projection operations; any carried candidate is a
    // protocol violation and fails closed.
    if (hasRevised || hasSplit) return { problem: 'reject must not carry any candidate' };
  }

  return {
    decision: parsed.decision,
    reason_code: parsed.reason_code,
    claim_manifest: manifestResult.manifest,
    revised_candidate: parsed.decision === 'revise' ? pickCandidateFields(parsed.revised_candidate) : undefined,
    split_candidates: parsed.decision === 'split' ? parsed.split_candidates.map(pickCandidateFields) : undefined,
  };
}

// Typed claim manifest validation (§4.4). Every action_completion claim must
// list trusted receipt refs; a missing list is a reviewer protocol failure
// and marks the whole invocation malformed. Outcomes are enum-checked and
// preserved verbatim.
function validateClaimManifest(manifest) {
  if (!isPlainObject(manifest)) return { problem: 'claim_manifest must be an object' };
  if (Object.keys(manifest).some((key) => key !== 'claims')) {
    return { problem: 'claim_manifest has unknown fields' };
  }
  if (!Array.isArray(manifest.claims)) return { problem: 'claim_manifest.claims must be an array' };
  const claims = [];
  for (const claim of manifest.claims) {
    if (!isPlainObject(claim)) return { problem: 'claim must be an object' };
    if (Object.keys(claim).some((key) => !CLAIM_FIELDS.includes(key))) {
      return { problem: 'claim has unknown fields' };
    }
    if (!CLAIM_KINDS.includes(claim.claim_kind)) return { problem: 'claim_kind is not in the allowlist' };
    if (typeof claim.requires_trusted_receipt !== 'boolean') {
      return { problem: 'claim requires_trusted_receipt must be a boolean' };
    }
    if (!Array.isArray(claim.receipt_refs) || claim.receipt_refs.some((ref) => typeof ref !== 'string' || !ref)) {
      return { problem: 'claim receipt_refs must be an array of non-empty strings' };
    }
    if (!Array.isArray(claim.forbidden_classes) || claim.forbidden_classes.some((entry) => !FORBIDDEN_CLASSES.includes(entry))) {
      return { problem: 'claim forbidden_classes entries must be in the allowlist' };
    }
    const outcome = claim.outcome === undefined ? 'none' : claim.outcome;
    if (!CLAIM_OUTCOMES.includes(outcome)) {
      return { problem: 'claim outcome must be succeeded|failed|ambiguous|none' };
    }
    if (claim.claim_kind === 'action_completion' && claim.receipt_refs.length === 0) {
      return { problem: 'action_completion claim must list receipt_refs' };
    }
    claims.push({
      claim_kind: claim.claim_kind,
      requires_trusted_receipt: claim.requires_trusted_receipt,
      receipt_refs: [...claim.receipt_refs],
      forbidden_classes: [...claim.forbidden_classes],
      outcome,
    });
  }
  return { manifest: { claims } };
}

// Picks only the typed metadata of a compatibility.final-turn/v1 source
// event (refs, digests, enums, revisions). Payload bodies are never part of
// the source event and therefore never part of the envelope (§3.3, §4.2).
function pickSourceEventMetadata(sourceEvent) {
  if (!sourceEvent || typeof sourceEvent !== 'object' || Array.isArray(sourceEvent)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'reviewer envelope requires a source event object');
  }
  if (sourceEvent.schema_version !== COMPAT_SOURCE_EVENT_SCHEMA) {
    throw compatError('COMPAT_INGRESS_INVALID', `reviewer envelope requires ${COMPAT_SOURCE_EVENT_SCHEMA}`);
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
// referenced content, §3.4). Each text is truncated to a bounded length;
// truncation is recorded for audit.
function normalizePayloadTexts(payloadTexts, maxPayloadChars) {
  if (!payloadTexts || typeof payloadTexts !== 'object' || Array.isArray(payloadTexts)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'payloadTexts must be an object of string texts');
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

// Frozen candidate schema check — identical to the Curator schema (§5.1) so
// revised/split candidates stay within the same budget and allowlist (§6.3).
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
      reject(typedError('timeout', `reviewer invocation timed out after ${timeoutMs}ms`));
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
