const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const om = require('../openmeteo');

const HOUR = 3600;
const POSITION = { latitude: 54.5, longitude: 10.5 };

// Synthetic Open-Meteo forecast response; hourly series start at the current hour.
function forecastResponse({ now = Date.now(), hours = 30, models = null } = {}) {
  const start = Math.floor(now / 1000 / HOUR) * HOUR;
  const time = Array.from({ length: hours }, (_, i) => start + i * HOUR);
  const series = (fn) => time.map((_, i) => fn(i));
  const hourlyVars = {
    temperature_2m: ['°C', (i) => 10 + i],
    apparent_temperature: ['°C', (i) => 8 + i],
    dew_point_2m: ['°C', () => 5],
    relative_humidity_2m: ['%', () => 80],
    surface_pressure: ['hPa', () => 1013],
    wind_speed_10m: ['m/s', () => 6],
    wind_direction_10m: ['°', () => 180],
    wind_gusts_10m: ['m/s', () => 9],
    precipitation_probability: ['%', () => 50],
    rain: ['mm', () => 0.4],
    showers: ['mm', () => 0.1],
    snowfall: ['cm', () => 0.7],
    precipitation: ['mm', () => 1],
    weather_code: ['wmo code', () => 61],
    is_day: ['', () => 0],
    visibility: ['m', () => null], // not provided by every model
  };
  const suffixes = models || [null];
  const hourly = { time };
  const hourly_units = { time: 'unixtime' };
  for (const suffix of suffixes) {
    for (const [name, [unit, fn]] of Object.entries(hourlyVars)) {
      const key = suffix ? `${name}_${suffix}` : name;
      hourly[key] = series(fn);
      hourly_units[key] = unit;
    }
  }
  const dailyVars = {
    temperature_2m_min: ['°C', 2],
    temperature_2m_max: ['°C', 12],
    relative_humidity_2m_min: ['%', 60],
    relative_humidity_2m_max: ['%', 95],
    surface_pressure_min: ['hPa', 1000],
    surface_pressure_max: ['hPa', 1010],
    precipitation_probability_max: ['%', 70],
    rain_sum: ['mm', 3],
    showers_sum: ['mm', 1],
    snowfall_sum: ['cm', 7],
    wind_gusts_10m_max: ['m/s', 15],
    weather_code: ['wmo code', 95],
    sunrise: ['unixtime', start + 6 * HOUR],
    sunset: ['unixtime', start + 16 * HOUR],
  };
  const daily = { time: [start] };
  const daily_units = { time: 'unixtime' };
  for (const suffix of suffixes) {
    for (const [name, [unit, value]] of Object.entries(dailyVars)) {
      const key = suffix ? `${name}_${suffix}` : name;
      daily[key] = [value];
      daily_units[key] = unit;
    }
  }
  return {
    latitude: 54.49, longitude: 10.49, utc_offset_seconds: 3600, timezone: 'Europe/Berlin',
    current_units: { time: 'unixtime', interval: 'seconds', temperature_2m: '°C', rain: 'mm', showers: 'mm', weather_code: 'wmo code', is_day: '' },
    current: { time: start + 900, interval: 900, temperature_2m: 3, rain: 0.1, showers: 0, weather_code: 3, is_day: 1 },
    hourly_units, hourly, daily_units, daily,
  };
}

function marineResponse({ now = Date.now(), hours = 4 } = {}) {
  const start = Math.floor(now / 1000 / HOUR) * HOUR;
  const time = Array.from({ length: hours }, (_, i) => start + i * HOUR);
  return {
    hourly_units: { time: 'unixtime', sea_surface_temperature: '°C', wave_height: 'm', wave_direction: '°', wave_period: 's', ocean_current_velocity: 'm/s', ocean_current_direction: '°' },
    hourly: {
      time,
      sea_surface_temperature: time.map(() => 10),
      wave_height: time.map(() => 0.5),
      wave_direction: time.map(() => 90),
      wave_period: time.map(() => 3),
      ocean_current_velocity: time.map(() => 0.2),
      ocean_current_direction: time.map(() => 45),
    },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createHost(fetchImpl) {
  const host = {
    id: 'openmeteo-signalk',
    deltas: [], messages: [], errors: [], urls: [],
    emit: (d) => host.deltas.push(d),
    status: (m) => host.messages.push(m),
    error: (m) => host.errors.push(m),
    fetch: async (url) => { host.urls.push(url); return fetchImpl(url); },
  };
  return host;
}

function valuesOf(delta, source) {
  const update = delta.updates.find((u) => u.$source === source);
  return update ? Object.fromEntries(update.values.map((v) => [v.path, v.value])) : null;
}

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('options', () => {
  it('falls back to defaults and clamps limits', () => {
    const c = om.normalizeOptions({ model: 'unknown', offset: 500, horizon: -3, cellSelection: 'moon' });
    assert.deepEqual(c.models, ['best_match']);
    assert.equal(c.offset, om.LIMITS.offset.max);
    assert.equal(c.horizon, om.LIMITS.horizon.min);
    assert.equal(c.cellSelection, 'sea');
    assert.equal(c.groups.temperature, true);
    assert.equal(c.groups.sea, false);
    assert.equal(c.today, true);
    assert.equal(c.distance, null);
  });

  it('accepts an optional second model as additional source', () => {
    assert.deepEqual(om.normalizeOptions({ model: 'icon_seamless', model2: 'ecmwf_ifs025' }).models, ['icon_seamless', 'ecmwf_ifs025']);
    assert.deepEqual(om.normalizeOptions({ model: 'icon_seamless', model2: 'icon_seamless' }).models, ['icon_seamless']);
    assert.deepEqual(om.normalizeOptions({ model: 'icon_seamless', model2: '' }).models, ['icon_seamless']);
    assert.deepEqual(om.normalizeOptions({ model: 'icon_seamless', model2: 'bogus' }).models, ['icon_seamless']);
  });

  it('converts the refresh distance from nm, empty disables it', () => {
    assert.equal(om.normalizeOptions({ distance: 5 }).distance, 5 * 1852);
    assert.equal(om.normalizeOptions({ distance: '' }).distance, null);
    assert.equal(om.normalizeOptions({ distance: null }).distance, null);
    assert.equal(om.normalizeOptions({ distance: 0 }).distance, null);
    assert.equal(om.normalizeOptions({ distance: 0.01 }).distance, om.LIMITS.distance.min * 1852);
  });
});

describe('request', () => {
  it('builds a key-less forecast request with SI-friendly units', () => {
    const c = om.normalizeOptions({ model: 'icon_seamless', offset: 3, horizon: 12, current: true });
    const url = new URL(om.buildForecastUrl(c, POSITION, 4.2));
    assert.equal(url.origin, 'https://api.open-meteo.com');
    const p = url.searchParams;
    assert.equal(p.get('models'), 'icon_seamless');
    assert.equal(p.get('wind_speed_unit'), 'ms');
    assert.equal(p.get('timeformat'), 'unixtime');
    assert.equal(p.get('elevation'), '4.2');
    assert.equal(p.get('forecast_hours'), '14');
    assert.ok(p.get('hourly').split(',').includes('surface_pressure'));
    assert.ok(p.get('daily').split(',').includes('sunrise'));
    assert.ok(!p.get('current').split(',').includes('cape'));
    assert.equal(p.get('apikey'), null);
  });

  it('switches to the customer server with an api key', () => {
    const c = om.normalizeOptions({ apikey: ' secret ' });
    const url = new URL(om.buildForecastUrl(c, POSITION));
    assert.equal(url.origin, 'https://customer-api.open-meteo.com');
    assert.equal(url.searchParams.get('apikey'), 'secret');
    assert.equal(url.searchParams.get('elevation'), null);
  });

  it('requests daily values only for today or sunlight', () => {
    const off = new URL(om.buildForecastUrl(om.normalizeOptions({ today: false }), POSITION));
    assert.equal(off.searchParams.get('daily'), null);
    // today publishes everything, independent of the measurement groups
    const on = new URL(om.buildForecastUrl(om.normalizeOptions({ today: true, variables: { pressure: false } }), POSITION));
    assert.ok(on.searchParams.get('daily').split(',').includes('surface_pressure_min'));
  });
});

describe('conversion', () => {
  it('keeps missing values missing (skunits would return 0)', () => {
    assert.equal(om.toSK('%', null), null);
    assert.equal(om.toSK('', undefined), null);
    assert.equal(om.toSK('unixtime', null), null);
  });

  it('converts Open-Meteo units to SignalK', () => {
    assert.ok(close(om.toSK('°C', 10), 283.15));
    assert.equal(om.toSK('hPa', 1013), 101300);
    assert.equal(om.toSK('%', 50), 0.5);
    assert.ok(close(om.toSK('°', 180), Math.PI));
    assert.ok(close(om.toSK('km/h', 36), 10));
    assert.equal(om.toSK('unixtime', 0), '1970-01-01T00:00:00.000Z');
  });

  it('maps WMO codes to OpenWeather style icons', () => {
    assert.equal(om.weatherIcon(3, 1), '04d');
    assert.equal(om.weatherIcon(61, 0), '10n');
    assert.equal(om.weatherIcon(42, 1), null);
  });
});

describe('forecast values', () => {
  it('publishes the full hour <offset> ahead, today and horizon aggregates', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ offset: 2, horizon: 6 });
    const values = Object.fromEntries(om.forecastValues(forecastResponse({ now }), c, 'best_match', now).map((v) => [v.path, v.value]));

    const start = Math.floor(now / 1000 / HOUR) * HOUR;
    assert.equal(values['environment.forecast.time'], new Date((start + 2 * HOUR) * 1000).toISOString());
    assert.ok(close(values['environment.forecast.temperature'], 12 + 273.15));
    assert.ok(close(values['environment.forecast.temperature.minimum'], 10 + 273.15));
    assert.ok(close(values['environment.forecast.temperature.maximum'], 15 + 273.15));
    assert.equal(values['environment.forecast.precipitation.accumulated'], 6);
    assert.equal(values['environment.forecast.pressure'], 101300);
    assert.equal(values['environment.forecast.relativeHumidity'], 0.8);
    assert.ok(close(values['environment.forecast.precipitation.rain'], 0.5));
    assert.ok(close(values['environment.forecast.precipitation.snow'], 1));
    assert.equal(values['environment.forecast.weather'], 'Rain');
    assert.equal(values['environment.forecast.description'], 'slight rain');
    assert.equal(values['environment.forecast.weather.icon'], '10n');
    assert.ok(close(values['environment.forecast.today.temperature.maximum'], 12 + 273.15));
    assert.equal(values['environment.forecast.today.precipitation.rain'], 4);
    assert.ok(close(values['environment.forecast.today.precipitation.snow'], 10));
    assert.equal(values['environment.forecast.today.description'], 'thunderstorm');
    // not configured / not provided
    assert.equal(values['environment.forecast.weather.visibility'], undefined);
    assert.equal(values['environment.outside.temperature'], undefined);
    assert.equal(values['environment.sunlight.times.sunrise'], undefined);
  });

  it('publishes current conditions and sunlight when enabled', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ current: true });
    const values = Object.fromEntries(om.forecastValues(forecastResponse({ now }), c, 'best_match', now).map((v) => [v.path, v.value]));

    assert.ok(close(values['environment.outside.temperature'], 3 + 273.15));
    assert.ok(close(values['environment.outside.precipitation.rain'], 0.4)); // 0.1 mm / 15 min
    assert.equal(values['environment.outside.weather.icon'], '04d');
    assert.equal(values['environment.outside.precipitation.probability'], undefined);
    assert.match(values['environment.sunlight.times.sunrise'], /^\d{4}-\d{2}-\d{2}T/);
  });

  it('publishes no today values when switched off', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ today: false });
    const values = om.forecastValues(forecastResponse({ now }), c, 'best_match', now);
    assert.ok(values.length > 0);
    assert.ok(!values.some((v) => v.path.startsWith('environment.forecast.today.')));
    assert.ok(!om.buildMeta(c).some((m) => m.path.startsWith('environment.forecast.today.')));
  });

  it('publishes all today values when switched on, independent of groups', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ today: true, variables: { pressure: false, humidity: false } });
    const values = Object.fromEntries(om.forecastValues(forecastResponse({ now }), c, 'best_match', now).map((v) => [v.path, v.value]));
    assert.equal(values['environment.forecast.today.pressure.minimum'], 100000);
    assert.equal(values['environment.forecast.today.relativeHumidity.maximum'], 0.95);
    assert.equal(values['environment.forecast.pressure'], undefined);
  });

  it('reads model-suffixed variables when two models are requested', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ model: 'icon_seamless', model2: 'ecmwf_ifs025' });
    const data = forecastResponse({ now, models: ['icon_seamless', 'ecmwf_ifs025'] });
    const values = Object.fromEntries(om.forecastValues(data, c, 'ecmwf_ifs025', now).map((v) => [v.path, v.value]));
    assert.ok(close(values['environment.forecast.temperature'], 11 + 273.15));
  });

  it('extracts marine values', () => {
    const now = Date.now();
    const c = om.normalizeOptions({ variables: { sea: true } });
    const values = Object.fromEntries(om.marineValues(marineResponse({ now }), c, now).map((v) => [v.path, v.value]));
    assert.ok(close(values['environment.forecast.water.temperature'], 283.15));
    assert.ok(close(values['environment.forecast.current.direction'], Math.PI / 4));
  });
});

describe('OpenMeteo service', () => {
  it('fetches on first position and publishes one update per model source', async () => {
    const host = createHost((url) => jsonResponse(url.includes('marine') ? marineResponse() : forecastResponse()));
    const service = new om.OpenMeteo(host);
    service.start({ model: 'icon_seamless', variables: { sea: true } });

    service.onDelta({ updates: [{ values: [{ path: 'navigation.position', value: POSITION }] }] });
    await service.pending;
    service.stop();

    assert.equal(host.urls.length, 2);
    assert.deepEqual(host.errors, []);
    const delta = host.deltas[1];
    const forecast = valuesOf(delta, 'openmeteo-signalk.icon_seamless');
    const marine = valuesOf(delta, 'openmeteo-signalk.marine');
    assert.ok(forecast['environment.forecast.temperature'] > 273);
    assert.equal(marine['environment.forecast.waves.combinedHeight'], 0.5);
    assert.match(host.messages.at(-1), /^Forecast icon_seamless for /);
  });

  it('refreshes one hour after the last update, without in-between updates by default', async () => {
    const host = createHost(() => jsonResponse(forecastResponse()));
    const service = new om.OpenMeteo(host);
    service.start({});
    service.onPosition(POSITION);
    await service.pending;
    const now = service.lastFetch;

    assert.equal(service.isDue(now + 30 * 60 * 1000), false);
    service.position = { latitude: 55.5, longitude: 10.5 }; // 60 nm north
    assert.equal(service.isDue(now + 30 * 60 * 1000), false); // no distance configured
    // checked one tick early, before the published values time out
    assert.equal(service.isDue(now + 59 * 60 * 1000), true);
    service.stop();
  });

  it('refreshes in between when the vessel moved the configured distance', async () => {
    const host = createHost(() => jsonResponse(forecastResponse()));
    const service = new om.OpenMeteo(host);
    service.start({ distance: 5 });
    service.onPosition(POSITION);
    await service.pending;
    const now = service.lastFetch;

    service.position = { latitude: 54.5 + 4 / 60, longitude: 10.5 }; // 4 nm
    assert.equal(service.isDue(now + 60 * 1000), false);
    service.position = { latitude: 54.5 + 5.1 / 60, longitude: 10.5 }; // 5.1 nm
    assert.equal(service.isDue(now + 60 * 1000), true);
    service.stop();
  });

  it('reports API errors without throwing and backs off', async () => {
    const host = createHost(() => jsonResponse({ error: true, reason: 'Invalid model' }, 400));
    const service = new om.OpenMeteo(host);
    service.start({});
    service.onPosition(POSITION);
    await service.pending;

    assert.deepEqual(host.errors, ['Open-Meteo request failed: Invalid model']);
    assert.equal(service.isDue(service.lastFailure + 30 * 1000), false);
    assert.equal(service.isDue(service.lastFailure + 60 * 1000), true);
    service.stop();
  });

  it('survives a long outage with growing back-off and a single error, then recovers', async () => {
    let online = false;
    const host = createHost(() => {
      if (!online) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      return jsonResponse(forecastResponse());
    });
    const service = new om.OpenMeteo(host);
    service.start({});
    service.position = POSITION;

    const delays = [];
    let now = Date.now();
    for (let i = 0; i < 7; i++) {
      await service.tick(now);
      delays.push(service.retryDelay() / 60000);
      assert.equal(service.isDue(now + service.retryDelay() - 1), false);
      now += service.retryDelay();
    }
    assert.deepEqual(delays, [1, 2, 4, 8, 15, 15, 15]);
    assert.deepEqual(host.errors, ['Open-Meteo unreachable: ENOTFOUND']); // reported once
    assert.equal(host.deltas.length, 1); // meta only, no backlog

    online = true;
    await service.tick(now);
    assert.equal(service.failures, 0);
    assert.equal(host.deltas.length, 2);
    assert.match(host.messages.at(-1), /^Forecast best_match for /);
    service.stop();
  });

  it('reports request timeouts', async () => {
    const host = createHost(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const service = new om.OpenMeteo(host);
    service.start({});
    service.onPosition(POSITION);
    await service.pending;
    service.stop();
    assert.match(host.errors[0], /unreachable: no response within 20 s/);
  });

  it('still publishes the forecast when the marine request fails', async () => {
    const host = createHost((url) => (url.includes('marine') ? jsonResponse({ error: true, reason: 'down' }, 500) : jsonResponse(forecastResponse())));
    const service = new om.OpenMeteo(host);
    service.start({ variables: { sea: true } });
    service.onPosition(POSITION);
    await service.pending;
    service.stop();

    assert.deepEqual(host.errors, []);
    assert.ok(valuesOf(host.deltas[1], 'openmeteo-signalk.best_match'));
    assert.match(host.messages.at(-1), /marine data unavailable/);
  });

  it('discards results that arrive after stop()', async () => {
    let release;
    const host = createHost(() => new Promise((resolve) => { release = () => resolve(jsonResponse(forecastResponse())); }));
    const service = new om.OpenMeteo(host);
    service.start({});
    service.onPosition(POSITION);
    const pending = service.pending;
    service.stop();
    release();
    await pending;
    assert.equal(host.deltas.length, 1); // meta only
  });

  it('ignores invalid positions', () => {
    const host = createHost(() => jsonResponse(forecastResponse()));
    const service = new om.OpenMeteo(host);
    service.start({});
    service.onPosition({ latitude: 'x', longitude: 10 });
    service.onPosition({ latitude: 95, longitude: 10 });
    service.onPosition(null);
    service.stop();
    assert.equal(host.urls.length, 0);
  });
});
