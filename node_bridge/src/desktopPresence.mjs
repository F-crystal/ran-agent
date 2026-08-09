import { readJsonState } from './atomicState.mjs';

const STATES = new Set(['available', 'gaming', 'focused', 'busy', 'dnd']);

function validSignal(value) {
  return Boolean(value && value.schemaVersion === 1 && STATES.has(value.state)
    && Number.isFinite(Date.parse(value.observedAt)) && Number.isFinite(Date.parse(value.expiresAt)));
}

export function createDesktopPresenceProvider({ statePath, externalMcpRuntime, now = () => new Date() } = {}) {
  if (typeof statePath !== 'string' || !statePath.trim()) {
    throw Object.assign(new Error('desktop presence requires one state path'), { code: 'PRESENCE_STATE_PATH_REQUIRED' });
  }
  return () => {
    const activities = externalMcpRuntime?.store?.list?.() || [];
    if (activities.some((item) => item?.status === 'active' && item?.domain === 'game')) return 'gaming';
    const signal = readJsonState(statePath, {
      validate: validSignal, missingValue: null, critical: false,
    });
    const current = now().getTime();
    if (!signal || !Number.isFinite(current) || Date.parse(signal.observedAt) > current + 300_000
      || Date.parse(signal.expiresAt) <= current) return 'unknown';
    return signal.state;
  };
}
