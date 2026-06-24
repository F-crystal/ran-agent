import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from './runtimeState.mjs';

const ENV_DIR_NAME = 'environment';
const LATEST_FILE = 'latest.json';
const PRIVACY_FILE = 'privacy.json';
const WEATHER_CACHE_FILE = 'weather-cache.json';
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_WEATHER_CACHE_MS = 10 * 60 * 1000;

function defaultFetch(...args) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch unavailable');
  }
  return globalThis.fetch(...args);
}

function envDir(env = process.env) {
  const dir = path.join(resolveStateDir(env), ENV_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function envPath(fileName, env = process.env) {
  return path.join(envDir(env), fileName);
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function sha16(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 3) {
  const number = numberOrNull(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function normalizeNanoTime(value) {
  const number = numberOrNull(value);
  if (number === null || number <= 0) return '';
  return new Date(Math.floor(number / 1000000)).toISOString();
}

function normalizeBattery(values = {}) {
  const rawLevel = numberOrNull(values.batteryLevel);
  const percent = rawLevel === null
    ? null
    : Math.max(0, Math.min(100, Math.round(rawLevel <= 1 ? rawLevel * 100 : rawLevel)));
  const state = String(values.batteryState || 'unknown').trim().toLowerCase() || 'unknown';
  return {
    percent,
    state,
    lowPowerMode: values.lowPowerMode === true,
    band: state === 'charging' || state === 'full'
      ? state
      : percent !== null && percent <= 20 ? 'low' : 'ok',
  };
}

function soundBand(dBFS) {
  const value = numberOrNull(dBFS);
  if (value === null) return '';
  if (value <= -45) return 'quiet';
  if (value <= -25) return 'ambient';
  return 'loud';
}

function normalizeReading(reading = {}) {
  const name = String(reading.name || '').trim().toLowerCase();
  const values = reading.values && typeof reading.values === 'object' ? reading.values : {};
  if (name === 'location') {
    const latitude = roundNumber(values.latitude, 3);
    const longitude = roundNumber(values.longitude, 3);
    if (latitude === null || longitude === null) return null;
    return {
      type: 'location',
      value: {
        latitude,
        longitude,
        horizontalAccuracy: roundNumber(values.horizontalAccuracy, 1),
        speed: roundNumber(values.speed, 2),
        observedAt: normalizeNanoTime(reading.time),
      },
    };
  }
  if (name === 'battery') {
    return {
      type: 'battery',
      value: {
        ...normalizeBattery(values),
        observedAt: normalizeNanoTime(reading.time),
      },
    };
  }
  if (name === 'microphone') {
    const dBFS = roundNumber(values.dBFS, 1);
    return {
      type: 'sound',
      value: {
        dBFS,
        band: soundBand(dBFS),
        observedAt: normalizeNanoTime(reading.time),
      },
    };
  }
  if (name === 'barometer') {
    return {
      type: 'barometer',
      value: {
        pressure: roundNumber(values.pressure, 1),
        observedAt: normalizeNanoTime(reading.time),
      },
    };
  }
  return null;
}

export function saveSensorLoggerMessage(message = {}, { env = process.env, now = new Date() } = {}) {
  const payload = Array.isArray(message.payload) ? message.payload : [];
  if (!payload.length) {
    return { ok: false, error: 'payload must include readings' };
  }
  const existing = readJson(envPath(LATEST_FILE, env), {}) || {};
  const latest = {
    ...existing,
    source: 'sensor_logger',
    updatedAt: now.toISOString(),
    messageId: numberOrNull(message.messageId),
    sessionIdHash: sha16(message.sessionId),
    deviceIdHash: sha16(message.deviceId),
  };
  let readings = 0;
  for (const item of payload) {
    const normalized = normalizeReading(item);
    if (!normalized) continue;
    latest[normalized.type] = normalized.value;
    readings += 1;
  }
  latest.place = derivePlace(latest.location, env);
  writeJson(envPath(LATEST_FILE, env), latest);
  return { ok: true, readings, latest };
}

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function distanceMeters(a = {}, b = {}) {
  const lat1 = numberOrNull(a.latitude);
  const lon1 = numberOrNull(a.longitude);
  const lat2 = numberOrNull(b.latitude);
  const lon2 = numberOrNull(b.longitude);
  if ([lat1, lon1, lat2, lon2].some((item) => item === null)) return Infinity;
  const radius = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function derivePlace(location = {}, env = process.env) {
  if (!location) return 'unknown';
  const homeLat = numberOrNull(env.HERMES_ENVIRONMENT_HOME_LAT);
  const homeLon = numberOrNull(env.HERMES_ENVIRONMENT_HOME_LON);
  if (homeLat === null || homeLon === null) {
    return env.HERMES_ENVIRONMENT_CITY_LABEL ? 'city' : 'unknown';
  }
  const radius = parsePositiveInt(env.HERMES_ENVIRONMENT_HOME_RADIUS_M, 200);
  return distanceMeters(location, { latitude: homeLat, longitude: homeLon }) <= radius ? 'home' : 'out';
}

function privacyState(env = process.env) {
  return readJson(envPath(PRIVACY_FILE, env), {}) || {};
}

export function setEnvironmentPrivacyMode({ enabled = false, reason = '', ttlMs = null, expiresAt = '' } = {}, {
  env = process.env,
  now = new Date(),
} = {}) {
  const expires = expiresAt
    ? new Date(expiresAt).toISOString()
    : Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? new Date(now.getTime() + Number(ttlMs)).toISOString()
      : '';
  const payload = {
    enabled: enabled === true,
    reason: String(reason || '').trim(),
    updatedAt: now.toISOString(),
    expiresAt: enabled === true ? expires : '',
  };
  writeJson(envPath(PRIVACY_FILE, env), payload);
  return payload;
}

export function getEnvironmentPrivacyMode(env = process.env, now = new Date()) {
  const state = privacyState(env);
  if (state.enabled !== true) {
    return { enabled: false };
  }
  const expiresAt = String(state.expiresAt || '').trim();
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    setEnvironmentPrivacyMode({ enabled: false, reason: 'expired' }, { env, now });
    return { enabled: false };
  }
  return {
    enabled: true,
    reason: String(state.reason || '').trim(),
    expiresAt,
  };
}

function endOfShanghaiToday(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return new Date(`${parts.year}-${parts.month}-${parts.day}T15:59:59.999Z`);
}

export function detectEnvironmentPrivacyCommand(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (/恢复环境感知|关闭隐私模式|退出隐身模式|可以感知了/.test(normalized)) {
    return { action: 'disable' };
  }
  const hours = normalized.match(/(?:关掉|暂停|关闭).{0,8}(?:环境感知|感知).{0,4}(\d+(?:\.\d+)?)\s*小时/);
  if (hours) {
    return { action: 'enable', ttlMs: Math.round(Number(hours[1]) * 60 * 60 * 1000) };
  }
  const minutes = normalized.match(/(?:关掉|暂停|关闭).{0,8}(?:环境感知|感知).{0,4}(\d+(?:\.\d+)?)\s*分钟/);
  if (minutes) {
    return { action: 'enable', ttlMs: Math.round(Number(minutes[1]) * 60 * 1000) };
  }
  if (/今天别感知我/.test(normalized)) {
    return { action: 'enable', ttl: 'today' };
  }
  if (/打开隐私模式|暂停环境感知|隐身模式/.test(normalized)) {
    return { action: 'enable' };
  }
  return null;
}

function seasonForMonth(month) {
  if ([3, 4, 5].includes(month)) return '春天';
  if ([6, 7, 8].includes(month)) return '夏天';
  if ([9, 10, 11].includes(month)) return '秋天';
  return '冬天';
}

function daypartForShanghai(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false,
  }).format(now));
  if (hour >= 5 && hour < 8) return '早晨';
  if (hour >= 8 && hour < 11) return '上午';
  if (hour >= 11 && hour < 13) return '中午';
  if (hour >= 13 && hour < 17) return '下午';
  if (hour >= 17 && hour < 20) return '傍晚';
  if (hour >= 20 && hour < 24) return '夜晚';
  return '深夜';
}

function shanghaiMonth(now) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
  }).format(now));
}

function skyFromWeather(current = {}) {
  const code = Number(current.weather_code);
  const precipitation = Number(current.precipitation || current.rain || current.showers || current.snowfall || 0);
  if (Number.isFinite(precipitation) && precipitation > 0) return current.snowfall > 0 ? '雪' : '雨';
  if ([95, 96, 99].includes(code)) return '雷';
  if ([45, 48].includes(code)) return '雾';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
  const cloud = Number(current.cloud_cover);
  if (code === 0 || (Number.isFinite(cloud) && cloud < 20)) return '晴';
  if (Number.isFinite(cloud) && cloud < 70) return '多云';
  return '阴';
}

function windBand(speed) {
  const value = Number(speed);
  if (!Number.isFinite(value) || value < 3) return '无风';
  if (value < 20) return '微风';
  if (value < 62) return '大风';
  return '台风';
}

function humidityBand(humidity) {
  const value = Number(humidity);
  if (!Number.isFinite(value)) return '';
  if (value < 35) return '干燥';
  if (value < 55) return '干爽';
  if (value < 75) return '微潮';
  return '潮湿';
}

function placeLabel(place) {
  if (place === 'home') return '在家';
  if (place === 'out') return '外出';
  if (place === 'city') return '城市';
  return '位置未知';
}

function soundLabel(sound = {}) {
  if (sound.band === 'quiet') return '周围偏安静';
  if (sound.band === 'ambient') return '周围有环境声';
  if (sound.band === 'loud') return '周围偏嘈杂';
  return '';
}

function batteryText(battery = {}) {
  if (!battery || battery.percent === null || battery.percent === undefined) return '';
  if (battery.state === 'charging') return `手机电量${battery.percent}%，正在充电`;
  if (battery.state === 'full') return `手机电量${battery.percent}%，已充满`;
  return `手机电量${battery.percent}%，未充电`;
}

function weatherUrls(location, env = process.env) {
  const lat = encodeURIComponent(location.latitude);
  const lon = encodeURIComponent(location.longitude);
  const timezone = encodeURIComponent(env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai');
  return {
    forecast: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_gusts_10m&timezone=${timezone}&forecast_days=1`,
    air: `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,us_aqi,uv_index&timezone=${timezone}&forecast_days=1`,
  };
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'GET' });
  if (!response?.ok) throw new Error('weather fetch failed');
  return response.json();
}

async function getWeatherSnapshot(location, { env = process.env, now = new Date(), fetchImpl = defaultFetch } = {}) {
  if (!location || parseBool(env.HERMES_ENVIRONMENT_WEATHER_ENABLED, true) !== true) return {};
  const cachePath = envPath(WEATHER_CACHE_FILE, env);
  const cache = readJson(cachePath, {}) || {};
  const maxAgeMs = parsePositiveInt(env.HERMES_ENVIRONMENT_WEATHER_CACHE_MS, DEFAULT_WEATHER_CACHE_MS);
  if (cache.updatedAt && Date.parse(cache.updatedAt) + maxAgeMs > now.getTime()) {
    return cache;
  }
  try {
    const urls = weatherUrls(location, env);
    const [forecast, air] = await Promise.all([
      fetchJson(fetchImpl, urls.forecast),
      fetchJson(fetchImpl, urls.air),
    ]);
    const next = {
      updatedAt: now.toISOString(),
      current: forecast?.current || {},
      air: air?.current || {},
    };
    writeJson(cachePath, next);
    return next;
  } catch {
    return cache.current ? cache : {};
  }
}

function contextEnabled(env = process.env) {
  return parseBool(env.HERMES_ENVIRONMENT_CONTEXT_ENABLED, true);
}

export async function buildEnvironmentContext({ env = process.env, now = new Date(), fetchImpl = defaultFetch } = {}) {
  if (!contextEnabled(env)) return '';
  if (getEnvironmentPrivacyMode(env, now).enabled) return '';
  const latest = readJson(envPath(LATEST_FILE, env), null);
  if (!latest?.updatedAt) return '';
  const maxAgeMs = parsePositiveInt(env.HERMES_ENVIRONMENT_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  if (Date.parse(latest.updatedAt) + maxAgeMs < now.getTime()) return '';

  const weather = await getWeatherSnapshot(latest.location, { env, now, fetchImpl });
  const current = weather.current || {};
  const month = shanghaiMonth(now);
  const season = seasonForMonth(month);
  const daypart = daypartForShanghai(now);
  const sky = skyFromWeather(current);
  const wind = windBand(current.wind_speed_10m);
  const humidity = humidityBand(current.relative_humidity_2m);
  const city = String(env.HERMES_ENVIRONMENT_CITY_LABEL || '').trim();
  const temp = numberOrNull(current.temperature_2m);
  const apparent = numberOrNull(current.apparent_temperature);
  const parts = [
    `你可能${placeLabel(latest.place)}`,
    city || '',
    `${season}${daypart}`,
    sky,
    temp === null ? '' : `${Math.round(temp)}C`,
    apparent === null ? '' : `体感${Math.round(apparent)}C`,
    wind,
    humidity,
    batteryText(latest.battery),
    soundLabel(latest.sound),
  ].filter(Boolean);
  if (weather.air?.us_aqi !== undefined || weather.air?.pm2_5 !== undefined) {
    const aqi = weather.air.us_aqi !== undefined ? `AQI ${Math.round(Number(weather.air.us_aqi))}` : '';
    const pm = weather.air.pm2_5 !== undefined ? `PM2.5 ${Math.round(Number(weather.air.pm2_5))}` : '';
    parts.push([aqi, pm].filter(Boolean).join('，'));
  }
  const text = `【环境感知（非用户原话，不要复述）】${parts.join('；')}。仅在自然相关时使用，不要当成天气预报复述。`;
  return text.length > 320 ? `${text.slice(0, 316)}...` : text;
}

export function privacyConfirmation(command, { env = process.env, now = new Date() } = {}) {
  if (!command) return null;
  if (command.action === 'disable') {
    setEnvironmentPrivacyMode({ enabled: false, reason: 'user' }, { env, now });
    return '环境感知已恢复。之后我只会收到轻量环境摘要，不会看到原始定位或原始传感器数据。';
  }
  const expiresAt = command.ttl === 'today' ? endOfShanghaiToday(now).toISOString() : '';
  setEnvironmentPrivacyMode({
    enabled: true,
    reason: 'user',
    ttlMs: command.ttlMs,
    expiresAt,
  }, { env, now });
  return command.ttlMs || expiresAt
    ? '隐私模式已打开，到期前我不会接收环境感知摘要。'
    : '隐私模式已打开。我不会接收环境感知摘要；你说“恢复环境感知”就能重新开启。';
}
