export function getQuickAckConfig(env = {}, platform = '') {
  const platformKey = String(platform || '').trim().toLowerCase() === 'feishu'
    ? 'FEISHU_QUICK_ACK_TIMEOUT_MS'
    : String(platform || '').trim().toLowerCase() === 'wechat'
      ? 'WECHAT_QUICK_ACK_TIMEOUT_MS'
      : '';
  const timeoutMs = Math.max(0, parseIntegerEnv(
    platformKey ? env[platformKey] : undefined,
    parseIntegerEnv(env.NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS, 0)
  ));
  const ackText = String(env.NODE_BRIDGE_QUICK_ACK_TEXT || '收到，正在处理。').trim()
    || '收到，正在处理。';
  return {
    enabled: false,
    timeoutMs,
    ackText,
  };
}

export function quickAckDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseIntegerEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
