import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  return exports;
}
const curve = load('src/lib/tariff/price-signal.ts');
const tariff = load('src/lib/tariff/effective-tariff.ts', { './price-signal': curve });
const kraken = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/effective-tariff': tariff, '../tariff/price-signal': curve, '../tariff/kraken-dispatches': kraken,
});
// Engine has no runtime dependencies: a Tesla adapter/API/LLM import fails here.
const { getOpportunities } = load('src/lib/opportunity/engine.ts');
const { opportunityTelemetryFromHA } = load('src/lib/opportunity/home-assistant-input.ts');
const now = '2026-09-22T21:00:00+01:00';
const date = hour => `2026-09-22T${hour}:00+01:00`;
const dispatch = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
function signal(ds = [], stale = false) {
  const { currentSite } = load('src/lib/site/current-site.ts');
  return getSitePriceSignal(currentSite, { stale, lastSuccessfulUpdate: now,
    vehicles: [{ id: 'ev', name: 'Family car', plannedDispatches: ds }] }, now).signal;
}
const reading = (value, freshness = 'fresh') => ({ value, freshness, source: 'test-observation', observedAt: now });
const telemetry = freshness => ({ solarKw: reading(4, freshness), houseLoadKw: reading(1, freshness), gridImportKw: reading(-3, freshness) });
const run = (options = {}) => getOpportunities({ signal: signal(), now, ...options });
const plain = x => JSON.parse(JSON.stringify(x));
const ofType = (result, type) => result.insights.filter(i => i.type === type);
const allExplanations = [];
function safe(result) {
  for (const insight of result.insights) {
    allExplanations.push(insight.explanation);
    assert.doesNotMatch(insight.explanation, /charge the (?:battery|powerwall)|discharge|set (?:backup )?reserve|change (?:backup )?reserve|switch mode|change operating mode|export the battery|target (?:a )?(?:battery )?soc|Tesla (?:will|should|is doing this because)/i);
    assert.ok(insight.id && insight.window.start && insight.window.end);
    assert.ok(Array.isArray(insight.evidence.prices));
    assert.ok(Array.isArray(insight.evidence.limitations));
  }
  return result;
}

test('25.18p now to guaranteed 2.99p overnight yields exactly 22.19p/kWh gross context', () => {
  const result = safe(run());
  const cheap = ofType(result, 'cheap-import-ahead')[0];
  assert.equal(cheap.financial.grossSpreadPerKwh, 0.2219);
  assert.equal(cheap.financial.currency, 'GBP');
  assert.match(cheap.explanation, /22.19p\/kWh/);
  assert.ok(cheap.evidence.tariffStates.includes('guaranteed'));
  assert.equal(cheap.window.start, '2026-09-22T23:00:00.000Z');
  assert.equal(cheap.financial.instantaneousValuePerHour, null);
  assert.equal(ofType(result, 'expensive-import-exposure').length, 1);
});

test('SMART 22:30–04:00 adds only a conditional 22:30–midnight opportunity before the guaranteed rate', () => {
  const ds = [dispatch(date('22:30'), '2026-09-23T04:00:00+01:00')];
  const result = safe(run({ signal: signal(ds) }));
  const smart = ofType(result, 'smart-opportunity'); assert.equal(smart.length, 1);
  assert.equal(smart[0].window.start, '2026-09-22T21:30:00.000Z');
  assert.equal(smart[0].window.end, '2026-09-22T23:00:00.000Z');
  assert.ok(smart[0].evidence.tariffStates.includes('planned-conditional'));
  assert.match(smart[0].explanation, /not a confirmed billed rate/);
  const lower = smart[0].evidence.prices.find(p => p.role === 'lower-import').window;
  assert.equal(lower.sources.find(s => s.cause).cause.end, ds[0].end);
  assert.equal(ofType(result, 'cheap-import-ahead').filter(i => i.window.start === smart[0].window.end).length, 1);
});

test('SMART entirely overnight and BOOST do not create new economic insights', () => {
  const base = run();
  for (const ds of [
    [dispatch('2026-09-23T01:00:00+01:00', '2026-09-23T03:00:00+01:00')],
    [dispatch(date('22:30'), date('23:30'), 'BOOST')],
  ]) {
    const result = safe(run({ signal: signal(ds) }));
    assert.equal(ofType(result, 'smart-opportunity').length, 0);
    assert.deepEqual(plain(result.insights.map(i => i.id)), plain(base.insights.map(i => i.id)));
  }
});

test('observed solar surplus/export produces economic value, not confirmed export revenue', () => {
  const result = safe(run({ telemetry: telemetry('fresh'), exportContext: { capability: 'available', actualTariff: { status: 'pending', price: null } } }));
  const insight = ofType(result, 'export-value')[0];
  assert.equal(insight.financial.instantaneousValuePerHour, 0.525);
  assert.equal(insight.financial.basis, 'instantaneous-export-economic-value');
  assert.equal(insight.evidence.exportContext.actualTariff.status, 'pending');
  assert.match(insight.explanation, /not confirmed revenue or a forecast/);
  assert.match(insight.explanation, /source of all exported energy is not established/);
});

test('physical export with zero or unknown economic value never implies payment', () => {
  for (const price of [null, { amount: 0, currency: 'GBP', unit: 'kWh' }]) {
    const result = safe(run({ telemetry: telemetry('fresh'), exportContext: {
      capability: 'available', actualTariff: { status: 'none', price: null }, economicValue: { kind: 'override', price },
    } }));
    const observed = ofType(result, 'export-value')[0];
    assert.equal(observed.financial.instantaneousValuePerHour, null);
    assert.match(observed.explanation, /No positive known export economic value/);
    assert.equal(ofType(result, 'gross-export-spread').length, 0);
  }
});

test('high SOC is contextual before a lower rate, without claiming capacity adequacy or Tesla motive', () => {
  const result = safe(run({ telemetry: { batteries: [{ id: 'pw', name: 'Powerwall', socPercent: reading(90), powerToHomeKw: reading(1.5) }] } }));
  const battery = ofType(result, 'stored-energy-context')[0];
  assert.match(battery.explanation, /90%/); assert.match(battery.explanation, /consistent with a stored-energy buffer/);
  assert.match(battery.explanation, /sufficiency is unknown/); assert.match(battery.explanation, /motive are not inferred/);
  assert.equal(battery.financial.grossSpreadPerKwh, null);
  assert.equal(battery.assetId, 'pw');
});

test('missing/stale/unknown telemetry cannot establish current physical behaviour', () => {
  assert.ok(run().limitations.some(l => l.includes('telemetry is not supplied')));
  for (const freshness of ['stale', 'unknown']) {
    const result = safe(run({ telemetry: { ...telemetry(freshness), batteries: [{ id: 'pw', name: 'Powerwall', socPercent: reading(90, freshness), powerToHomeKw: reading(2, freshness) }] } }));
    assert.equal(ofType(result, 'export-value').length, 0);
    const battery = ofType(result, 'stored-energy-context')[0];
    assert.equal(battery.evidence.freshness, freshness);
    assert.match(battery.explanation, /Last supplied/);
    assert.doesNotMatch(battery.explanation, /Battery power is|consistent with/);
  }
  const bad = safe(run({ telemetry: { ...telemetry('fresh'), gridImportKw: reading(null), batteries: [{ id: 'pw', name: 'Battery', socPercent: reading(NaN) }] } }));
  assert.equal(ofType(bad, 'export-value').length, 0); assert.equal(ofType(bad, 'stored-energy-context').length, 0);
});

test('gross import/export spreads retain unknown costs and permissions, never guaranteed profit', () => {
  const result = safe(run());
  assert.equal(ofType(result, 'gross-import-spread')[0].financial.grossSpreadPerKwh, 0.2219);
  assert.equal(ofType(result, 'gross-export-spread')[0].financial.grossSpreadPerKwh, 0.1451);
  for (const insight of [...ofType(result, 'gross-import-spread'), ...ofType(result, 'gross-export-spread')]) {
    assert.match(insight.explanation, /not guaranteed profit/);
    assert.match(insight.evidence.limitations[0], /losses, degradation costs or operating permissions/);
  }
});

test('output is deterministic and metadata-only changes qualify existing economic identities', () => {
  const ds = [dispatch(date('22:30'), date('23:30'))];
  const input = { signal: signal(ds), now }; const before = JSON.stringify(input);
  const first = safe(getOpportunities(input));
  assert.equal(JSON.stringify(first), JSON.stringify(getOpportunities(input)));
  assert.equal(JSON.stringify(input), before);
  const updated = signal(ds, true); updated.generatedAt = date('21:01');
  for (const w of updated.import) for (const source of w.sources) source.observedAt = date('20:59');
  const stale = safe(run({ signal: updated }));
  assert.deepEqual(plain(stale.insights.map(i => i.id)), plain(first.insights.map(i => i.id)));
  assert.equal(ofType(stale, 'smart-opportunity')[0].evidence.freshness, 'stale');
  assert.ok(ofType(stale, 'smart-opportunity')[0].evidence.tariffStates.includes('planned-conditional'));
});

test('flat and unknown signals produce no-additional-opportunity without manufacturing savings', () => {
  const base = signal();
  for (const value of [0.2518, null]) {
    const flat = { ...base, import: [{ ...base.import[0], start: base.horizon.start, end: base.horizon.end,
      price: value === null ? null : { amount: value, currency: 'GBP', unit: 'kWh' }, priceStatus: value === null ? 'unknown' : 'known' }] };
    const result = safe(run({ signal: flat }));
    assert.equal(ofType(result, 'no-additional-opportunity').length, 1);
    assert.ok(result.insights.every(i => i.financial.grossSpreadPerKwh === null));
    if (value === null) assert.equal(result.insights[0].evidence.freshness, 'unknown');
  }
  assert.ok(safe(run({ minimumSpreadPerKwh: 1 })).insights.some(i => i.type === 'no-additional-opportunity'));
});

test('HA input adapter uses explicit metric bindings/polarity, normalized SOC and unknown freshness by default', () => {
  const ha = { assets: [{ id: 'asset', name: 'Any asset', metrics: [
    { entityId: 'soc', unit: '%', value: 16.842105, rawValue: 21 },
    { entityId: 'grid', unit: 'W', value: 3000 },
  ] }] };
  const bindings = { gridImportKw: { assetId: 'asset', entityId: 'grid', multiplier: -1 },
    batteries: [{ id: 'battery', name: 'Battery', socPercent: { assetId: 'asset', entityId: 'soc' } }] };
  const result = opportunityTelemetryFromHA(ha, bindings);
  assert.equal(result.gridImportKw.value, -3); assert.equal(result.gridImportKw.freshness, 'unknown');
  assert.equal(result.batteries[0].socPercent.value, 16.842105);
  assert.equal(opportunityTelemetryFromHA(null, bindings).gridImportKw.value, null);
});

test('currency mismatches and invalid observation times do not invent savings', () => {
  const mixed = signal();
  for (const w of mixed.import.slice(1)) w.price.currency = 'EUR';
  const result = safe(run({ signal: mixed }));
  assert.equal(ofType(result, 'cheap-import-ahead').length, 0);
  assert.equal(run({ now: 'invalid' }).insights.length, 0);
  assert.equal(run({ minimumSpreadPerKwh: -1 }).insights.length, 0);
  assert.ok(allExplanations.length > 0);
});
