const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');

// Minimal stand-in for the SignalK server app object. Every member used by
// index.js has to be present, otherwise the plugin fails at startup.
function createApp() {
  const app = {
    deltas: [],
    status: [],
    errors: [],
    unsubscribed: 0,
    debug: () => {},
    error: (msg) => app.errors.push(msg),
    setPluginStatus: (msg) => app.status.push(msg),
    setPluginError: (msg) => app.errors.push(msg),
    getSelfPath: () => undefined,
    handleMessage: (id, delta) => app.deltas.push({ id, delta }),
    subscriptionmanager: {
      subscribe: (subscription, unsubscribes) => {
        app.subscription = subscription;
        unsubscribes.push(() => {
          app.unsubscribed += 1;
        });
      },
    },
  };
  return app;
}

const pathRe = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)*$/;

describe('plugin', () => {
  it('has required interface', () => {
    const plugin = pluginFactory(createApp());
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(plugin.id, 'openmeteo-signalk');
    assert.ok(plugin.name);
    assert.ok(plugin.schema);
  });

  it('has a JSON serialisable schema with model and offset', () => {
    const { schema } = pluginFactory(createApp());
    const copy = JSON.parse(JSON.stringify(schema));
    assert.deepEqual(copy, schema);
    assert.ok(schema.required.includes('model'));
    assert.ok(schema.required.includes('offset'));
    assert.ok(schema.properties.model.enum.includes(schema.properties.model.default));
    assert.equal(schema.properties.model.enum.length, schema.properties.model.enumNames.length);
  });

  it('offers an optional second model, the today switch and an optional refresh distance', () => {
    const { schema } = pluginFactory(createApp());
    const { model, model2, today, distance } = schema.properties;
    assert.deepEqual(model2.enum, ['', ...model.enum]);
    assert.equal(model2.enum.length, model2.enumNames.length);
    assert.equal(model2.default, '');
    assert.equal(today.type, 'boolean');
    assert.equal(distance.type, 'number');
    assert.equal(distance.default, undefined); // empty: no in-between refresh
    assert.ok(!schema.required.includes('model2') && !schema.required.includes('distance'));
  });

  it('starts with empty configuration (no api key needed), publishes meta and stops cleanly', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start({}, () => {});

    assert.deepEqual(app.errors, []);
    assert.equal(app.deltas.length, 1);
    assert.equal(app.deltas[0].id, 'openmeteo-signalk');
    const meta = app.deltas[0].delta.updates[0].meta;
    assert.ok(Array.isArray(meta) && meta.length > 0);
    assert.ok(meta.every((m) => typeof m.path === 'string' && pathRe.test(m.path) && m.value));
    assert.ok(meta.every((m) => m.value.timeout > 0 && m.value.description));
    assert.ok(app.subscription.subscribe.some((s) => s.path === 'navigation.position'));

    plugin.stop();
    assert.equal(app.unsubscribed, 1);
  });

  it('supports restart without duplicating meta', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start({ model: 'icon_seamless', offset: 2 });
    const first = app.deltas[0].delta.updates[0].meta.length;
    plugin.stop();
    plugin.start({ model: 'icon_seamless', offset: 2 });
    const second = app.deltas[1].delta.updates[0].meta.length;

    assert.equal(first, second);
    plugin.stop();
    assert.equal(app.unsubscribed, 2);
  });

  it('publishes meta only for the selected measurements', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start({ current: true, variables: { wind: false, sea: true } });
    const paths = app.deltas[0].delta.updates[0].meta.map((m) => m.path);

    assert.ok(!paths.includes('environment.forecast.wind.speed'));
    assert.ok(paths.includes('environment.forecast.waves.combinedHeight'));
    assert.ok(paths.includes('environment.outside.temperature'));
    assert.ok(paths.includes('environment.sunlight.times.sunrise'));
    assert.equal(new Set(paths).size, paths.length);
  });
});

describe('source priority', () => {
  function createServer(groups) {
    const app = createApp();
    app.activated = 0;
    app.config = { settings: { priorityGroups: groups } };
    app.activateSourcePriorities = () => { app.activated += 1; };
    return app;
  }

  it('ranks two models as a priority group on start', () => {
    const app = createServer(undefined);
    const plugin = pluginFactory(app);
    plugin.start({ model: 'ecmwf_ifs', model2: 'icon_eu' });
    plugin.stop();
    assert.deepEqual(app.config.settings.priorityGroups,
      [{ id: 'openmeteo-signalk', sources: ['openmeteo-signalk.ecmwf_ifs', 'openmeteo-signalk.icon_eu'] }]);
    assert.equal(app.activated, 1);

    plugin.start({ model: 'ecmwf_ifs', model2: 'icon_eu' }); // unchanged - no re-activation
    plugin.stop();
    assert.equal(app.activated, 1);

    plugin.start({ model: 'ecmwf_ifs' });                   // single model - group removed
    plugin.stop();
    assert.deepEqual(app.config.settings.priorityGroups, []);
    assert.equal(app.activated, 2);
  });

  it('starts on servers without source priorities', () => {
    const app = createApp();
    const plugin = pluginFactory(app);
    plugin.start({ model: 'ecmwf_ifs', model2: 'icon_eu' });
    plugin.stop();
    assert.deepEqual(app.errors, []);
  });
});
