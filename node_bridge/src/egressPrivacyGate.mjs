const NEUTRAL_NOTICE = '这条回复包含内部运行信息，已停止发送。';

const PRIVATE_LINE_RULES = [
  ['bridge_instruction', /\[(?:BRIDGE_REPAIR|INTERNAL_INSTRUCTION|SYSTEM_POLICY)\]|bridge\s+repair\s+instruction/i],
  ['policy_dump', /(?:policy[_ -]?dump|authorization[_ -]?policy)\s*[:=]|["'](?:capability|nonce|actorKey)["']\s*:/i],
  ['private_id', /\b(?:operation|job|outbox|receipt|evidence|actor|nonce|capability)[_-]?(?:id|key|token)?\s*[:=]\s*[A-Za-z0-9_.:-]{3,}/i],
  ['runtime_path', /(?:^|\s)(?:\/(?:opt|private|Users|home|var\/lib|etc)\/[^\s]+|[A-Za-z]:\\[^\s]+)/],
];

export function applyEgressPrivacyGate(text, { technicalDiagnostics = false } = {}) {
  const original = String(text || '').trim();
  if (technicalDiagnostics) {
    return { text: original, redactions: [], excludeFromHistory: false };
  }
  const redactions = new Set();
  const kept = [];
  for (const line of original.split(/\r?\n/)) {
    const rule = PRIVATE_LINE_RULES.find(([, pattern]) => pattern.test(line));
    if (rule) {
      redactions.add(rule[0]);
    } else {
      kept.push(line);
    }
  }
  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned && redactions.size > 0) {
    return { text: NEUTRAL_NOTICE, redactions: [...redactions], excludeFromHistory: true };
  }
  return { text: cleaned, redactions: [...redactions], excludeFromHistory: false };
}
