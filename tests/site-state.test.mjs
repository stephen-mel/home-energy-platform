import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Load the actual site modules with isolated caches and no external connections.
function load(path, dependencies = {}, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  dependencies = { './home-assistant-metrics': path.endsWith('home-assistant-state.ts')
    ? load('src/lib/site/home-assistant-metrics.ts') : {}, './kraken-state-store': {
    readLastKnownKrakenState: async () => null,
    writeLastKnownKrakenState: async () => {},
  }, ...dependencies };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    Error,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console: { error() {} },
    ...globals,
  });
  return exports;
}

const config = (enabled) => ({
  integrations: { kraken: { enabled: true }, homeAssistant: { enabled }, tesla: { enabled: false } },
});

test('Home Assistant is optional and failures do not discard Kraken vehicles', async () => {
  for (const enabled of [false, true]) {
    let calls = 0;
    const kraken = { vehicles: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] };
    const { getSiteState } = load('src/lib/site/get-site-state.ts', {
      './kraken-state': { getKrakenState: async () => kraken },
      './home-assistant-state': { getHomeAssistantSiteState: async () => {
        calls++;
        throw new Error('Connection refused');
      } },
    });
    const state = await getSiteState(config(enabled));
    assert.equal(state.integrations.kraken.data, kraken);
    assert.equal(state.integrations.homeAssistant.data, null);
    assert.equal(calls, enabled ? 1 : 0);
    assert.equal(state.integrations.homeAssistant.error, enabled ? 'Connection refused' : null);
  }
});

test('Home Assistant handles zero or multiple assets and unavailable sensors', async () => {
  let calls = 0;
  const { getHomeAssistantSiteState } = load('src/lib/site/home-assistant-state.ts', {
    '../home-assistant/client': { getHomeAssistantState: async (id) => {
      calls++;
      return { state: id === 'working' ? '42' : 'unavailable' };
    } },
  });
  const assets = ['working', 'missing'].map((entityId) => ({
    id: entityId, name: entityId, metrics: [{ entityId, label: 'Battery', unit: '%', decimals: 0 }],
  }));
  assert.equal((await getHomeAssistantSiteState({ enabled: false, assets })).assets.length, 0);
  assert.equal((await getHomeAssistantSiteState({ enabled: true })).assets.length, 0);
  assert.equal(calls, 0);
  const data = await getHomeAssistantSiteState({ enabled: true, assets });
  assert.equal(data.assets.length, 2);
  assert.equal(data.assets[0].metrics[0].value, 42);
  assert.equal(data.assets[1].metrics[0].value, null);
});

test('Smart Control suspension remains independent of operation; cache survives refresh failures', async () => {
  let now = 1;
  let fail = false;
  let calls = 0;
  const client = {
    getKrakenDevices: async () => {
      calls++;
      if (fail) throw new Error('Offline');
      return [{ id: 'vehicle' }];
    },
    getKrakenVehicleStatus: async () => ({ currentState: 'SMART_CONTROL_NOT_AVAILABLE', isSuspended: false }),
    getKrakenPlannedDispatches: async () => [],
  };
  const krakenModule = load('src/lib/site/kraken-state.ts', { '../kraken/client': client }, { Date: class extends Date { static now() { return now; } } });
  assert.equal(krakenModule.getSmartControlSetting(false), 'Enabled');
  assert.equal(krakenModule.getSmartControlSetting(true), 'Suspended');
  assert.equal(krakenModule.getSmartControlSetting(null), 'Unknown');
  const initial = await krakenModule.getKrakenState();
  assert.equal(initial.stale, false);
  assert.equal(initial.lastSuccessfulUpdate, new Date(now).toISOString());
  assert.equal(initial.vehicles[0].status.currentState, 'SMART_CONTROL_NOT_AVAILABLE');
  assert.equal(await krakenModule.getKrakenState(), initial);
  assert.equal(calls, 1);
  now += 60_001;
  fail = true;
  const stale = await krakenModule.getKrakenState();
  assert.equal(stale.stale, true);
  assert.equal(stale.vehicles, initial.vehicles);
  assert.equal(stale.lastSuccessfulUpdate, initial.lastSuccessfulUpdate);
  assert.equal(initial.stale, false);
  assert.equal(calls, 2);
  const { getSiteState } = load('src/lib/site/get-site-state.ts', {
    './kraken-state': { getKrakenState: async () => stale },
    './home-assistant-state': {},
  });
  const site = await getSiteState(config(false));
  assert.equal(site.integrations.kraken.data, stale);
  fail = false;
  const recovered = await krakenModule.getKrakenState();
  assert.notEqual(recovered, initial);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.lastSuccessfulUpdate, new Date(now).toISOString());
  assert.equal(await krakenModule.getKrakenState(), recovered);
  assert.equal(calls, 3);
  fail = true;
  const fresh = load('src/lib/site/kraken-state.ts', { '../kraken/client': client });
  await assert.rejects(fresh.getKrakenState(), /Offline/);
});


test('Rejected, missing and timed-out HA sensors preserve healthy metrics and assets', async () => {
  const timeoutSignal = {};
  const client = load('src/lib/home-assistant/client.ts', {}, {
    process: { env: { HOME_ASSISTANT_URL: 'http://ha.test', HOME_ASSISTANT_TOKEN: 'test' } },
    AbortSignal: { timeout(ms) { assert.equal(ms, 5_000); return timeoutSignal; } },
    fetch: async (url, options) => {
      assert.equal(options.signal, timeoutSignal);
      if (url.endsWith('/rejected')) throw new Error('Connection refused');
      if (url.endsWith('/timeout')) throw new Error('TimeoutError');
      if (url.endsWith('/missing')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ state: '42' }) };
    },
  });
  const { getHomeAssistantSiteState } = load('src/lib/site/home-assistant-state.ts', {
    '../home-assistant/client': client,
  });
  const metric = (entityId) => ({ entityId, label: entityId, unit: 'kW', decimals: 2 });
  const data = await getHomeAssistantSiteState({ enabled: true, assets: [
    { id: 'mixed', name: 'Mixed sensors', metrics: ['working', 'rejected', 'missing', 'timeout'].map(metric) },
    { id: 'healthy', name: 'Healthy asset', metrics: [metric('other')] },
  ] });
  assert.equal(data.assets.length, 2);
  assert.equal(data.assets[0].metrics[0].value, 42);
  for (const reading of data.assets[0].metrics.slice(1)) assert.equal(reading.value, null);
  assert.equal(data.assets[1].metrics[0].value, 42);
});

test('Powerwall display SOC is opt-in, clamped, preserves raw SOC and ignores Backup Reserve', () => {
  const { normalizeHomeAssistantMetric } = load('src/lib/site/home-assistant-metrics.ts');
  const metric = { entityId: 'sensor.soc', label: 'SOC', unit: '%', decimals: 0,
    normalization: 'powerwall-display-soc', backupReserve: 10 };
  const reading = normalizeHomeAssistantMetric(metric, '21');
  assert.equal(reading.rawValue, 21);
  assert.ok(Math.abs(reading.value - 16.842105263157894) < 1e-10);
  assert.equal(reading.value.toFixed(metric.decimals), '17');
  for (const [raw, expected] of [[5, 0], [100, 100], [-5, 0], [105, 100]]) {
    const result = normalizeHomeAssistantMetric(metric, raw);
    assert.equal(result.rawValue, raw); assert.equal(result.value, expected);
  }
  for (const raw of [null, undefined, '', ' ', 'unknown', 'unavailable', 'bad', NaN, Infinity, -Infinity, {}, true]) {
    const result = normalizeHomeAssistantMetric(metric, raw);
    assert.equal(result.rawValue, null); assert.equal(result.value, null);
  }
  assert.equal(normalizeHomeAssistantMetric({ ...metric, normalization: undefined }, 21).value, 21);
});

test('HA snapshots and live updates use identical normalization without double conversion', async () => {
  const metrics = load('src/lib/site/home-assistant-metrics.ts');
  const { getHomeAssistantSiteState } = load('src/lib/site/home-assistant-state.ts', {
    '../home-assistant/client': { getHomeAssistantState: async () => ({ state: '21' }) },
  });
  const metric = { entityId: 'sensor.soc', label: 'SOC', unit: '%', decimals: 0 };
  const initial = await getHomeAssistantSiteState({ enabled: true, assets: [
    { id: 'powerwall', name: 'Powerwall', metrics: [{ ...metric, normalization: 'powerwall-display-soc' }] },
    { id: 'other', name: 'Other battery', metrics: [metric] },
  ] });
  assert.equal(initial.assets[0].metrics[0].rawValue, 21);
  assert.equal(initial.assets[0].metrics[0].value.toFixed(0), '17');
  assert.equal(initial.assets[1].metrics[0].value, 21);
  const update = { 'sensor.soc': 21 };
  const live = metrics.applyHomeAssistantMetricUpdates(initial, update);
  assert.equal(JSON.stringify(live), JSON.stringify(initial));
  assert.equal(JSON.stringify(metrics.applyHomeAssistantMetricUpdates(live, update)), JSON.stringify(initial));
  assert.equal(JSON.stringify(metrics.applyHomeAssistantMetricUpdates(live, { unrelated: 5 })), JSON.stringify(initial));
  const unavailable = metrics.applyHomeAssistantMetricUpdates(live, { 'sensor.soc': null });
  assert.equal(unavailable.assets[0].metrics[0].value, null);
  assert.equal(unavailable.assets[0].metrics[0].rawValue, null);
});

test('current site enables Powerwall normalization only for the local charge metric', () => {
  const { currentSite } = load('src/lib/site/current-site.ts');
  const configured = currentSite.integrations.homeAssistant.assets.flatMap(a => a.metrics)
    .filter(m => m.normalization);
  assert.equal(configured.length, 1);
  assert.equal(configured[0].entityId, 'sensor.powerwall_192_168_68_74_charge');
  assert.equal(configured[0].normalization, 'powerwall-display-soc');
});
