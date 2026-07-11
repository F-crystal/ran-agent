const CLAIM_EFFECT = new Map([
  ['save', 'save'],
  ['post', 'post'],
  ['send', 'send'],
]);


export function buildExternalMcpNarrationCandidate(input = {}) {
  const facts = verifiedItems(input.facts).map((item) => ({ summary: redact(item.summary) })).filter(hasSummary);
  const receipts = verifiedItems(input.receiptSummaries).map((item) => ({
    effect: token(item.effect),
    outcome: token(item.outcome),
    summary: redact(item.summary),
    ...(item.terminal === true ? { terminal: true } : {}),
  })).filter((item) => item.effect && item.outcome && item.summary);
  const requestedClaim = token(input.claim).toLowerCase();
  const claim = supportedClaim(requestedClaim, receipts) ? requestedClaim : null;

  if (requestedClaim && !claim) {
    return {
      kind: 'core_external_activity_narration_candidate',
      status: 'suppressed',
      claim: null,
      facts,
      receipts,
    };
  }
  if (facts.length === 0 && receipts.length === 0) {
    return {
      kind: 'core_external_activity_narration_candidate',
      status: 'silent',
      claim: null,
      facts: [],
      receipts: [],
    };
  }
  return {
    kind: 'core_external_activity_narration_candidate',
    status: 'ready',
    claim,
    facts,
    receipts,
  };
}


function verifiedItems(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item?.verified === true).slice(0, 20);
}


function supportedClaim(claim, receipts) {
  if (!claim) return true;
  if (claim === 'completed') {
    return receipts.some((item) => item.terminal === true && item.outcome === 'completed');
  }
  const effect = CLAIM_EFFECT.get(claim);
  return Boolean(effect && receipts.some((item) => item.effect === effect && item.outcome === 'applied'));
}


function redact(value) {
  return String(value || '')
    .replace(/(^|[\s(])(?:[A-Za-z]:\\|\/)(?!\/)[^\s)]+/g, '$1[redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:Users|opt|private|var|tmp|home)(?:[\\/][^\s)]+)+/g, '[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/\b(?:op|operation|activity|extmcp|session|grant)[-_][a-zA-Z0-9_.:@/-]+\b/gi, '[redacted]')
    .replace(/\b(?:token|api[_-]?key|cookie|password)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, 1_000)
    .trim();
}


function token(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
}


function hasSummary(item) {
  return Boolean(item.summary);
}
