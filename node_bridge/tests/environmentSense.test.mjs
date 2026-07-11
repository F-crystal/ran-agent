import test from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

import {
  buildEnvironmentContext,
  detectEnvironmentPrivacyCommand,
  getEnvironmentPrivacyMode,
  saveSensorLoggerMessage,
  setEnvironmentPrivacyMode,
} from '../src/environmentSense.mjs';

function tempEnv(t, extra = {}) {
  return createIsolatedTestEnv(t, {
    HERMES_ENVIRONMENT_CONTEXT_ENABLED: 'true',
    HERMES_ENVIRONMENT_HOME_LAT: '31.2304',
    HERMES_ENVIRONMENT_HOME_LON: '121.4737',
    HERMES_ENVIRONMENT_HOME_RADIUS_M: '250',
    HERMES_ENVIRONMENT_CITY_LABEL: '上海',
    ...extra,
  }, 'environment-sense-');
}

function sensorLoggerPayload() {
  return {
    messageId: 7,
    sessionId: 'session-a',
    deviceId: 'phone-a',
    payload: [
      {
        name: 'location',
        time: 1710000000000000000,
        values: {
          latitude: 31.23041,
          longitude: 121.47372,
          horizontalAccuracy: 12,
          speed: 0,
        },
      },
      {
        name: 'battery',
        time: 1710000001000000000,
        values: {
          batteryLevel: 0.18,
          batteryState: 'unplugged',
          lowPowerMode: true,
        },
      },
      {
        name: 'microphone',
        time: 1710000002000000000,
        values: { dBFS: -48 },
      },
      {
        name: 'barometer',
        time: 1710000003000000000,
        values: { pressure: 1008.2 },
      },
    ],
  };
}

function weatherFetch() {
  return async (url) => {
    const text = String(url);
    if (text.includes('air-quality')) {
      return {
        ok: true,
        async json() {
          return { current: { pm2_5: 12, us_aqi: 44, uv_index: 3 } };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          current: {
            temperature_2m: 30,
            apparent_temperature: 32,
            relative_humidity_2m: 68,
            precipitation: 0,
            weather_code: 0,
            cloud_cover: 8,
            wind_speed_10m: 9,
            wind_gusts_10m: 16,
            surface_pressure: 1008,
          },
        };
      },
    };
  };
}

test('saveSensorLoggerMessage stores sanitized latest state and builds a short context', async (t) => {
  const env = tempEnv(t);
  const saved = saveSensorLoggerMessage(sensorLoggerPayload(), {
    env,
    now: new Date('2026-06-25T06:00:00.000Z'),
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.latest.deviceIdHash.length, 16);
  assert.equal(saved.latest.location.latitude, 31.23);
  assert.equal(saved.latest.location.longitude, 121.474);
  assert.equal(saved.latest.battery.percent, 18);
  assert.equal(saved.latest.sound.band, 'quiet');

  const context = await buildEnvironmentContext({
    env,
    now: new Date('2026-06-25T06:01:00.000Z'),
    fetchImpl: weatherFetch(),
  });

  assert.match(context, /环境感知/);
  assert.match(context, /在家/);
  assert.match(context, /上海/);
  assert.match(context, /夏天/);
  assert.match(context, /下午/);
  assert.match(context, /晴/);
  assert.match(context, /30C/);
  assert.match(context, /体感32C/);
  assert.match(context, /微风/);
  assert.match(context, /微潮/);
  assert.match(context, /电量18%/);
  assert.match(context, /偏安静/);
  assert.ok(context.length < 320);
});

test('privacy mode suppresses environment context until disabled', async (t) => {
  const env = tempEnv(t);
  saveSensorLoggerMessage(sensorLoggerPayload(), {
    env,
    now: new Date('2026-06-25T06:00:00.000Z'),
  });
  setEnvironmentPrivacyMode({ enabled: true, reason: 'test' }, {
    env,
    now: new Date('2026-06-25T06:01:00.000Z'),
  });

  assert.equal(getEnvironmentPrivacyMode(env, new Date('2026-06-25T06:02:00.000Z')).enabled, true);
  const hidden = await buildEnvironmentContext({
    env,
    now: new Date('2026-06-25T06:02:00.000Z'),
    fetchImpl: weatherFetch(),
  });
  assert.equal(hidden, '');

  setEnvironmentPrivacyMode({ enabled: false, reason: 'test' }, {
    env,
    now: new Date('2026-06-25T06:03:00.000Z'),
  });
  const visible = await buildEnvironmentContext({
    env,
    now: new Date('2026-06-25T06:04:00.000Z'),
    fetchImpl: weatherFetch(),
  });
  assert.match(visible, /环境感知/);
});

test('detectEnvironmentPrivacyCommand recognizes explicit chat toggles', () => {
  assert.deepEqual(detectEnvironmentPrivacyCommand('今天别感知我'), { action: 'enable', ttl: 'today' });
  assert.deepEqual(detectEnvironmentPrivacyCommand('关掉环境感知 2 小时'), { action: 'enable', ttlMs: 7200000 });
  assert.deepEqual(detectEnvironmentPrivacyCommand('恢复环境感知'), { action: 'disable' });
  assert.equal(detectEnvironmentPrivacyCommand('我今天有点累'), null);
});
