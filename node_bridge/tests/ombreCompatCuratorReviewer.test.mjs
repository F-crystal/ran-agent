// Tests for the tool-less Memory Curator (§5.1) and independent tool-less
// Memory Reviewer (§5.2) invocation contracts. Every model call is faked —
// no network is touched. Covers the §13.2 Curator/Reviewer acceptance
// scenarios: ordinary meaningful experience becomes a candidate, source-less
// romanticization is rejected, accept/revise/split/reject all validate, both
// tool inventories are empty, and the Reviewer never sees Curator-private
// reasoning.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, sha256Digest } from '../src/ombreCompat/canonical.mjs';
import {
  COMPAT_CURATOR_PROTOCOL_VERSION,
  COMPAT_REVIEWER_PROTOCOL_VERSION,
} from '../src/ombreCompat/constants.mjs';
import {
  buildCuratorEnvelope,
  runCuratorInvocation,
} from '../src/ombreCompat/curator.mjs';
import {
  buildReviewerEnvelope,
  runReviewerInvocation,
} from '../src/ombreCompat/reviewer.mjs';

const TOOL_FIELD_NAMES = ['tools', 'tool_choice', 'functions', 'function_call'];
const SCOPE_DIGEST = sha256Digest('scope envelope');
const FIXED_CLOCK = () => new Date('2026-07-27T01:02:03.000Z');

function makeSourceEvent(overrides = {}) {
  return {
    schema_version: 'compatibility.final-turn/v1',
    event_id: 'evt_test_001',
    source_revision: 3,
    source_event_digest: sha256Digest('source event material'),
    conversation_id: 'conv_test',
    exchange_id: 'exch_test',
    user_final_payload_ref: 'legacy-payload:user:1',
    user_final_payload_revision: 1,
    user_final_payload_digest: sha256Digest('user final text'),
    assistant_final_payload_ref: 'legacy-payload:assistant:1',
    assistant_final_payload_revision: 2,
    assistant_final_payload_digest: sha256Digest('assistant final text'),
    final_content_digest: sha256Digest('combined final content'),
    scope_envelope_ref: 'scope-envelope:test',
    scope_envelope_digest: SCOPE_DIGEST,
    sensitivity: 'personal',
    presentation_state: 'presented',
    trusted_action_receipt_refs: ['receipt:action:1'],
    trusted_action_receipts_digest: sha256Digest('receipt refs'),
    lifecycle_state: 'current',
    supersedes_event_id: null,
    emitted_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    candidate_kind: 'append_experience',
    title: '夜里那次长谈',
    first_person_text: '我记得那天晚上我们聊了很久，我第一次觉得被真正听见。',
    source_refs: ['legacy-payload:user:1', 'legacy-payload:assistant:1'],
    scope_envelope_digest: SCOPE_DIGEST,
    sensitivity: 'personal',
    counterevidence: '',
    uncertainty: '情感强度可能被我放大',
    ...overrides,
  };
}

function makePayloadTexts() {
  return {
    user_final: '那晚我们聊到凌晨两点，说起我小时候搬家的那次经历。',
    assistant_final: '我记得。你说那是你第一次觉得离别也可以是轻的。',
  };
}

function curatorConfig(overrides = {}) {
  return {
    baseUrl: 'http://curator.invalid/',
    model: 'curator-model-v1',
    apiKey: 'curator-test-key',
    timeoutMs: 1000,
    ...overrides,
  };
}

function reviewerConfig(overrides = {}) {
  return {
    baseUrl: 'http://reviewer.invalid/',
    model: 'reviewer-model-v1',
    apiKey: 'reviewer-test-key',
    timeoutMs: 1000,
    ...overrides,
  };
}

function makeCuratorEnvelope(overrides = {}) {
  return buildCuratorEnvelope({
    sourceEvent: makeSourceEvent(),
    payloadTexts: makePayloadTexts(),
    ...overrides,
  });
}

function makeClaim(overrides = {}) {
  return {
    claim_kind: 'experience',
    requires_trusted_receipt: false,
    receipt_refs: [],
    forbidden_classes: [],
    outcome: 'none',
    ...overrides,
  };
}

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function curatorOutput(candidates) {
  return JSON.stringify({ candidates });
}

function reviewerOutput(body) {
  return JSON.stringify(body);
}

// ------------------------------------------------------------- curator --

test('curator completes with provenance, empty tool inventory, and a tool-less request body', async () => {
  const envelope = makeCuratorEnvelope();
  const outputText = curatorOutput([makeCandidate()]);
  let captured;
  const result = await runCuratorInvocation({
    envelope,
    config: curatorConfig(),
    curatorImpl: async (request) => {
      captured = request;
      return outputText;
    },
    clock: FIXED_CLOCK,
    invocationIdFactory: () => 'ocq_cur_fixedtest001',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate_kind, 'append_experience');
  assert.equal(result.output_digest, canonicalDigest(outputText));

  const invocation = result.invocation;
  assert.equal(invocation.curator_invocation_id, 'ocq_cur_fixedtest001');
  assert.match(invocation.curator_invocation_ref, /^compat-curator-invocation:[a-f0-9]{32}$/);
  assert.equal(invocation.curator_model_id, 'curator-model-v1');
  assert.equal(invocation.curator_model_version, 'curator-model-v1');
  assert.equal(invocation.curator_protocol_version, COMPAT_CURATOR_PROTOCOL_VERSION);
  assert.equal(invocation.curator_input_digest, envelope.curator_input_digest);
  assert.equal(invocation.tool_inventory_digest, canonicalDigest([]));
  assert.equal(invocation.started_at, '2026-07-27T01:02:03.000Z');
  assert.equal(invocation.completed_at, '2026-07-27T01:02:03.000Z');

  // Hard rule: the request body carries no tool-capability fields anywhere.
  assert.equal(captured.url, 'http://curator.invalid/chat/completions');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(Object.keys(captured.body).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.equal(captured.body.model, 'curator-model-v1');
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.stream, false);
  const bodyKeys = collectKeys(captured.body);
  assert.ok(!bodyKeys.some((key) => TOOL_FIELD_NAMES.includes(key)), `tool field leaked: ${bodyKeys}`);
});

test('curator default HTTP impl posts a tool-less body and reads the completion', async () => {
  const envelope = makeCuratorEnvelope();
  const outputText = curatorOutput([makeCandidate()]);
  const sent = [];
  const result = await runCuratorInvocation({
    envelope,
    config: curatorConfig(),
    fetchImpl: async (url, init) => {
      sent.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'curator-model-2026-07-27',
          choices: [{ message: { content: outputText } }],
        }),
      };
    },
    clock: FIXED_CLOCK,
    invocationIdFactory: () => 'ocq_cur_fixedtest002',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.invocation.curator_model_version, 'curator-model-2026-07-27');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://curator.invalid/chat/completions');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.authorization, 'Bearer curator-test-key');
  const sentBody = JSON.parse(sent[0].init.body);
  assert.deepEqual(Object.keys(sentBody).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.ok(!collectKeys(sentBody).some((key) => TOOL_FIELD_NAMES.includes(key)));

  // 5xx from the endpoint is typed unavailable, never an exception.
  const unavailable = await runCuratorInvocation({
    envelope,
    config: curatorConfig(),
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    clock: FIXED_CLOCK,
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.error_code, 'COMPAT_CURATOR_UNAVAILABLE');
  assert.equal(unavailable.candidates, undefined);
  assert.equal(unavailable.invocation.curator_protocol_version, COMPAT_CURATOR_PROTOCOL_VERSION);
});

test('curator network failure is typed unavailable', async () => {
  const result = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'COMPAT_CURATOR_UNAVAILABLE');
  assert.equal(result.candidates, undefined);
  assert.ok(result.invocation.curator_invocation_id);
});

test('curator timeout: impl that never settles yields typed timeout with zero candidates', async () => {
  const result = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig({ timeoutMs: 40 }),
    curatorImpl: () => new Promise(() => {}),
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.error_code, 'COMPAT_CURATOR_UNAVAILABLE');
  assert.equal(result.candidates, undefined);
  assert.ok(result.invocation.curator_invocation_id);
});

test('curator timeout: impl rejecting with AbortError yields typed timeout', async () => {
  const result = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig({ timeoutMs: 40 }),
    curatorImpl: async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.error_code, 'COMPAT_CURATOR_UNAVAILABLE');
  assert.equal(result.candidates, undefined);
});

test('curator malformed: non-JSON output', async () => {
  const result = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => 'this is not json at all',
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'malformed');
  assert.equal(result.error_code, 'COMPAT_CURATOR_MALFORMED');
  assert.equal(result.candidates, undefined);
});

test('curator malformed: candidate_kind outside the model allowlist', async () => {
  for (const kind of ['delete', 'bounded_retrieval_touch', 'canon_promotion']) {
    const result = await runCuratorInvocation({
      envelope: makeCuratorEnvelope(),
      config: curatorConfig(),
      curatorImpl: async () => curatorOutput([makeCandidate({ candidate_kind: kind })]),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.status, 'malformed', `kind ${kind} must be malformed`);
    assert.equal(result.error_code, 'COMPAT_CURATOR_MALFORMED');
    assert.equal(result.candidates, undefined);
  }
});

test('curator malformed: first_person_text over 4096 UTF-8 bytes (byte-based, not char-based)', async () => {
  // Exactly 4096 ASCII bytes passes.
  const withinBudget = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => curatorOutput([makeCandidate({ first_person_text: 'a'.repeat(4096) })]),
    clock: FIXED_CLOCK,
  });
  assert.equal(withinBudget.status, 'completed');

  // 4097 ASCII bytes is malformed.
  const asciiOver = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => curatorOutput([makeCandidate({ first_person_text: 'a'.repeat(4097) })]),
    clock: FIXED_CLOCK,
  });
  assert.equal(asciiOver.status, 'malformed');
  assert.equal(asciiOver.error_code, 'COMPAT_CURATOR_MALFORMED');

  // 1366 CJK chars = 4098 UTF-8 bytes: over budget even though char count is
  // far below 4096 — the budget is enforced in bytes.
  const cjkOver = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => curatorOutput([makeCandidate({ first_person_text: '界'.repeat(1366) })]),
    clock: FIXED_CLOCK,
  });
  assert.equal(cjkOver.status, 'malformed');
  assert.equal(cjkOver.error_code, 'COMPAT_CURATOR_MALFORMED');
});

test('curator malformed: more than 16 source_refs or non-string refs', async () => {
  const tooMany = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => curatorOutput([
      makeCandidate({ source_refs: Array.from({ length: 17 }, (_, i) => `ref:${i}`) }),
    ]),
    clock: FIXED_CLOCK,
  });
  assert.equal(tooMany.status, 'malformed');
  assert.equal(tooMany.error_code, 'COMPAT_CURATOR_MALFORMED');

  const nonString = await runCuratorInvocation({
    envelope: makeCuratorEnvelope(),
    config: curatorConfig(),
    curatorImpl: async () => curatorOutput([makeCandidate({ source_refs: ['ref:ok', 42] })]),
    clock: FIXED_CLOCK,
  });
  assert.equal(nonString.status, 'malformed');
  assert.equal(nonString.error_code, 'COMPAT_CURATOR_MALFORMED');
});

test('curator malformed: envelope digest mismatch fails closed before any model contact', async () => {
  const envelope = { ...makeCuratorEnvelope(), curator_input_digest: sha256Digest('forged') };
  let called = false;
  const result = await runCuratorInvocation({
    envelope,
    config: curatorConfig(),
    curatorImpl: async () => {
      called = true;
      return curatorOutput([]);
    },
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'malformed');
  assert.equal(result.error_code, 'COMPAT_CURATOR_MALFORMED');
  assert.equal(called, false);
});

// ------------------------------------------------------------ reviewer --

async function runCuratedCandidate() {
  const sourceEvent = makeSourceEvent();
  const curatorEnvelope = buildCuratorEnvelope({ sourceEvent, payloadTexts: makePayloadTexts() });
  const rawOutput = curatorOutput([makeCandidate()]);
  const curated = await runCuratorInvocation({
    envelope: curatorEnvelope,
    config: curatorConfig(),
    curatorImpl: async () => rawOutput,
    clock: FIXED_CLOCK,
    invocationIdFactory: () => 'ocq_cur_fixedtest003',
  });
  assert.equal(curated.status, 'completed');
  return { sourceEvent, curated, rawOutput };
}

test('reviewer envelope never carries curator output text or private reasoning', async () => {
  const { sourceEvent, curated, rawOutput } = await runCuratedCandidate();
  // Pollute the candidates with curator-private material; the envelope
  // builder must strip everything outside the structured candidate schema.
  const polluted = curated.candidates.map((candidate) => ({
    ...candidate,
    curator_private_reasoning: 'SECRET_REASONING_TEXT',
    curator_raw_output: rawOutput,
  }));
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: polluted,
    payloadTexts: makePayloadTexts(),
  });
  const envelopeJson = JSON.stringify(envelope);
  assert.ok(!envelopeJson.includes('SECRET_REASONING_TEXT'));
  assert.ok(!envelopeJson.includes(rawOutput));
  const keys = collectKeys(envelope);
  assert.ok(!keys.some((key) => /curator/i.test(key)), `curator field leaked: ${keys}`);
  assert.deepEqual(
    Object.keys(envelope.candidates[0]).sort(),
    [
      'candidate_kind',
      'counterevidence',
      'first_person_text',
      'scope_envelope_digest',
      'sensitivity',
      'source_refs',
      'title',
      'uncertainty',
    ],
  );
});

test('reviewer invocation is independent: distinct id, own provenance, empty tool inventory', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const outputText = reviewerOutput({
    decision: 'accept',
    reason_code: 'grounded_experience',
    claim_manifest: { claims: [makeClaim()] },
  });
  let captured;
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async (request) => {
      captured = request;
      return outputText;
    },
    clock: FIXED_CLOCK,
  });

  assert.equal(reviewed.status, 'completed');
  const invocation = reviewed.invocation;
  assert.notEqual(invocation.reviewer_invocation_id, curated.invocation.curator_invocation_id);
  assert.match(invocation.reviewer_invocation_id, /^ocq_rev_/);
  assert.match(invocation.reviewer_invocation_ref, /^compat-reviewer-invocation:[a-f0-9]{32}$/);
  assert.equal(invocation.reviewer_model_id, 'reviewer-model-v1');
  assert.equal(invocation.reviewer_protocol_version, COMPAT_REVIEWER_PROTOCOL_VERSION);
  assert.equal(invocation.reviewer_input_digest, envelope.reviewer_input_digest);
  assert.equal(invocation.tool_inventory_digest, canonicalDigest([]));
  assert.equal(reviewed.output_digest, canonicalDigest(outputText));

  assert.equal(captured.url, 'http://reviewer.invalid/chat/completions');
  assert.deepEqual(Object.keys(captured.body).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.ok(!collectKeys(captured.body).some((key) => TOOL_FIELD_NAMES.includes(key)));
});

test('reviewer accept: digest unchanged, revision 0', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'accept',
      reason_code: 'grounded_experience',
      claim_manifest: { claims: [makeClaim()] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.decision, 'accept');
  assert.equal(reviewed.reviewer_revision, 0);
  assert.deepEqual(reviewed.final_candidates, envelope.candidates);
  assert.equal(canonicalDigest(reviewed.final_candidates), canonicalDigest(envelope.candidates));
});

test('reviewer revise: exactly one revised candidate, revision 1', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const revised = makeCandidate({ title: '修订后的标题', uncertainty: '原候选过度推断，已收窄' });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'revise',
      reason_code: 'over_inference_narrowed',
      claim_manifest: { claims: [makeClaim()] },
      revised_candidate: revised,
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.decision, 'revise');
  assert.equal(reviewed.reviewer_revision, 1);
  assert.equal(reviewed.final_candidates.length, 1);
  assert.equal(reviewed.final_candidates[0].title, '修订后的标题');

  // revise without a revised_candidate is malformed.
  const missing = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'revise',
      reason_code: 'over_inference_narrowed',
      claim_manifest: { claims: [makeClaim()] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(missing.status, 'malformed');
  assert.equal(missing.error_code, 'COMPAT_REVIEWER_MALFORMED');
});

test('reviewer split: at least two candidates, revision 1', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'split',
      reason_code: 'two_independent_experiences',
      claim_manifest: { claims: [makeClaim()] },
      split_candidates: [
        makeCandidate({ title: '第一段经历' }),
        makeCandidate({ title: '第二段经历' }),
      ],
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.decision, 'split');
  assert.equal(reviewed.reviewer_revision, 1);
  assert.equal(reviewed.final_candidates.length, 2);

  // split with a single candidate is malformed.
  const single = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'split',
      reason_code: 'two_independent_experiences',
      claim_manifest: { claims: [makeClaim()] },
      split_candidates: [makeCandidate()],
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(single.status, 'malformed');
  assert.equal(single.error_code, 'COMPAT_REVIEWER_MALFORMED');
});

test('reviewer reject: zero candidates; carrying a candidate is malformed', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'reject',
      reason_code: 'low_value_smalltalk',
      claim_manifest: { claims: [makeClaim()] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.decision, 'reject');
  assert.equal(reviewed.reviewer_revision, 0);
  assert.deepEqual(reviewed.final_candidates, []);

  for (const carrier of ['revised_candidate', 'split_candidates']) {
    const malformed = await runReviewerInvocation({
      envelope,
      config: reviewerConfig(),
      reviewerImpl: async () => reviewerOutput({
        decision: 'reject',
        reason_code: 'low_value_smalltalk',
        claim_manifest: { claims: [makeClaim()] },
        [carrier]: carrier === 'revised_candidate' ? makeCandidate() : [makeCandidate(), makeCandidate()],
      }),
      clock: FIXED_CLOCK,
    });
    assert.equal(malformed.status, 'malformed', `reject with ${carrier} must be malformed`);
    assert.equal(malformed.error_code, 'COMPAT_REVIEWER_MALFORMED');
  }
});

test('reviewer malformed: action_completion claim without receipt_refs', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'accept',
      reason_code: 'grounded_experience',
      claim_manifest: {
        claims: [makeClaim({ claim_kind: 'action_completion', requires_trusted_receipt: true, receipt_refs: [] })],
      },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'malformed');
  assert.equal(reviewed.error_code, 'COMPAT_REVIEWER_MALFORMED');

  // The same claim with a trusted receipt ref passes.
  const receipted = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'accept',
      reason_code: 'receipt_bound',
      claim_manifest: {
        claims: [makeClaim({ claim_kind: 'action_completion', requires_trusted_receipt: true, receipt_refs: ['receipt:action:1'], outcome: 'succeeded' })],
      },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(receipted.status, 'completed');
  assert.equal(receipted.claim_manifest.claims[0].claim_kind, 'action_completion');
});

test('reviewer keeps outcome ambiguous verbatim and rejects unknown outcomes', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const ambiguous = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'accept',
      reason_code: 'delivery_ambiguous_kept',
      claim_manifest: { claims: [makeClaim({ outcome: 'ambiguous' })] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(ambiguous.status, 'completed');
  // §4.4 — ambiguous is preserved, never rewritten to succeeded or failed.
  assert.equal(ambiguous.claim_manifest.claims[0].outcome, 'ambiguous');

  const unknown = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'accept',
      reason_code: 'bad_outcome',
      claim_manifest: { claims: [makeClaim({ outcome: 'probably' })] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(unknown.status, 'malformed');
  assert.equal(unknown.error_code, 'COMPAT_REVIEWER_MALFORMED');
});

test('reviewer reject: source-less romanticized candidate is rejected (§13.2 fabrication scenario)', async () => {
  // A schema-valid but source-less romantic candidate: the wrapper does not
  // judge semantics (Node never classifies memory meaning); the independent
  // reviewer model does, and the wrapper carries its typed decision.
  const romantic = makeCandidate({
    first_person_text: '我记得那个星空下完美的夜晚，你对我许下了永远。',
    source_refs: [],
    counterevidence: '',
    uncertainty: '',
  });
  const envelope = buildReviewerEnvelope({
    sourceEvent: makeSourceEvent(),
    candidates: [romantic],
    payloadTexts: { user_final: '今天天气不错。', assistant_final: '是啊，适合出去走走。' },
  });
  const reviewed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => reviewerOutput({
      decision: 'reject',
      reason_code: 'source_less_romanticization',
      claim_manifest: { claims: [makeClaim()] },
    }),
    clock: FIXED_CLOCK,
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.decision, 'reject');
  assert.equal(reviewed.reason_code, 'source_less_romanticization');
  assert.deepEqual(reviewed.final_candidates, []);
});

test('reviewer timeout and transport failure are typed', async () => {
  const { sourceEvent, curated } = await runCuratedCandidate();
  const envelope = buildReviewerEnvelope({
    sourceEvent,
    candidates: curated.candidates,
    payloadTexts: makePayloadTexts(),
  });
  const timeout = await runReviewerInvocation({
    envelope,
    config: reviewerConfig({ timeoutMs: 40 }),
    reviewerImpl: () => new Promise(() => {}),
    clock: FIXED_CLOCK,
  });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.error_code, 'COMPAT_REVIEWER_UNAVAILABLE');
  assert.equal(timeout.final_candidates, undefined);

  const unavailable = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    clock: FIXED_CLOCK,
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.error_code, 'COMPAT_REVIEWER_UNAVAILABLE');

  const malformed = await runReviewerInvocation({
    envelope,
    config: reviewerConfig(),
    reviewerImpl: async () => '{"decision":"maybe"}',
    clock: FIXED_CLOCK,
  });
  assert.equal(malformed.status, 'malformed');
  assert.equal(malformed.error_code, 'COMPAT_REVIEWER_MALFORMED');
});

// ------------------------------------------------------------ envelopes --

test('curator envelope is deterministic, digest-bound, and truncates payload texts', () => {
  const sourceEvent = makeSourceEvent();
  const first = buildCuratorEnvelope({ sourceEvent, payloadTexts: makePayloadTexts() });
  const second = buildCuratorEnvelope({ sourceEvent, payloadTexts: makePayloadTexts() });
  assert.equal(first.curator_input_digest, second.curator_input_digest);

  const { curator_input_digest: digest, ...material } = first;
  assert.equal(digest, canonicalDigest(material));
  assert.deepEqual(Object.keys(first).sort(), [
    'budget_profile',
    'candidate_kind_allowlist',
    'curator_input_digest',
    'payload_texts',
    'protocol_version',
    'schema_version',
    'source_event',
  ]);

  const truncated = buildCuratorEnvelope({
    sourceEvent,
    payloadTexts: { user_final: 'x'.repeat(5000) },
    maxPayloadChars: 100,
  });
  assert.equal(truncated.payload_texts.user_final.text.length, 100);
  assert.equal(truncated.payload_texts.user_final.original_chars, 5000);
  assert.equal(truncated.payload_texts.user_final.truncated, true);

  // Fail closed on caller input errors.
  assert.throws(
    () => buildCuratorEnvelope({ sourceEvent, payloadTexts: { user_final: 42 } }),
    (error) => error?.code === 'COMPAT_INGRESS_INVALID',
  );
  assert.throws(
    () => buildCuratorEnvelope({ sourceEvent: { schema_version: 'other/v9' }, payloadTexts: {} }),
    (error) => error?.code === 'COMPAT_INGRESS_INVALID',
  );
});

test('reviewer envelope is deterministic, digest-bound, and rejects invalid candidates', () => {
  const sourceEvent = makeSourceEvent();
  const candidates = [makeCandidate()];
  const first = buildReviewerEnvelope({ sourceEvent, candidates, payloadTexts: makePayloadTexts() });
  const second = buildReviewerEnvelope({ sourceEvent, candidates, payloadTexts: makePayloadTexts() });
  assert.equal(first.reviewer_input_digest, second.reviewer_input_digest);

  const { reviewer_input_digest: digest, ...material } = first;
  assert.equal(digest, canonicalDigest(material));

  assert.throws(
    () => buildReviewerEnvelope({ sourceEvent, candidates: [makeCandidate({ candidate_kind: 'delete' })], payloadTexts: {} }),
    (error) => error?.code === 'COMPAT_CANDIDATE_INVALID',
  );
  assert.throws(
    () => buildReviewerEnvelope({ sourceEvent, candidates: 'nope', payloadTexts: {} }),
    (error) => error?.code === 'COMPAT_CANDIDATE_INVALID',
  );
});
