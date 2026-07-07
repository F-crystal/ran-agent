export function getQuickAckConfig(env = {}, platform = '') {
  const enabled = isTruthy(env.NODE_BRIDGE_QUICK_ACK_ENABLED);
  const platformKey = String(platform || '').trim().toLowerCase() === 'feishu'
    ? 'FEISHU_QUICK_ACK_TIMEOUT_MS'
    : String(platform || '').trim().toLowerCase() === 'wechat'
      ? 'WECHAT_QUICK_ACK_TIMEOUT_MS'
      : '';
  const timeoutMs = Math.max(0, parseIntegerEnv(
    platformKey ? env[platformKey] : undefined,
    parseIntegerEnv(env.NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS, 0)
  ));
  const ackText = String(env.NODE_BRIDGE_QUICK_ACK_TEXT || '收到，正在处理，稍后发送结果。').trim()
    || '收到，正在处理，稍后发送结果。';
  return {
    enabled: enabled && timeoutMs > 0,
    timeoutMs,
    ackText,
  };
}

export function quickAckDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parseIntegerEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
