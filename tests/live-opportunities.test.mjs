import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { ...globals, exports, require(name) {
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
const engine = load('src/lib/opportunity/engine.ts');
const metrics = load('src/lib/site/home-assistant-metrics.ts');
const input = load('src/lib/opportunity/home-assistant-input.ts');
const liveInput = load('src/lib/opportunity/live-site-input.ts', {
  '../site/home-assistant-metrics': metrics, './home-assistant-input': input, './engine': engine,
});
const localTime = load('src/lib/presentation/local-time.ts');
const view = load('src/components/energy-opportunities-view.ts', { '../lib/presentation/local-time': localTime });
const { opportunityCards } = view;
const { default: EnergyOpportunities } = load('src/components/EnergyOpportunities.tsx', {
  'react/jsx-runtime': jsx, './energy-opportunities-view': view, '../lib/presentation/local-time': localTime,
});
const { currentSite } = load('src/lib/site/current-site.ts');
const now = '2026-09-22T21:00:00+01:00';
const date = time => `2026-09-22T${time}:00+01:00`;
const dispatch = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
function plan(ds = [], stale = false) {
  return getSitePriceSignal(currentSite, ds === null ? null : { stale, lastSuccessfulUpdate: now,
    vehicles: [{ id: 'opaque-ev-id', name: 'Family car', plannedDispatches: ds }] }, now);
}
const initial = { assets: currentSite.integrations.homeAssistant.assets.map(a => ({ ...a,
  metrics: a.metrics.map(m => ({ ...m, value: null, rawValue: null })),
})) };
const bindings = currentSite.opportunities.telemetry;
const updates = Object.fromEntries(initial.assets.flatMap(a => a.metrics.map(m => [m.entityId, null])));
updates[bindings.solarKw.entityId] = 4;
updates[bindings.houseLoadKw.entityId] = 1;
updates[bindings.gridImportKw.entityId] = -3;
updates[bindings.batteries[0].socPercent.entityId] = 21;
updates[bindings.batteries[0].powerToHomeKw.entityId] = 1.5;
const run = (options = {}) => liveInput.liveSiteOpportunities({ initial, updates, status: 'live', haEnabled: true,
  signal: plan().signal, now, receivedAt: now, configuration: currentSite.opportunities, ...options });
const cards = (options = {}) => opportunityCards(run(options).result, 'Europe/London');
const types = cards => Array.from(cards, c => c.insight.type);
const markup = result => renderToStaticMarkup(React.createElement(EnergyOpportunities, { result, timeZone: 'Europe/London' }));

test('real configured tariff selects one clear 22.19p spread message, not duplicate cards', () => {
  const selected = cards({ haEnabled: false });
  assert.deepEqual(types(selected), ['cheap-import-ahead']);
  assert.equal(selected[0].label, 'Guaranteed');
  assert.match(selected[0].summary, /25.18p\/kWh.*2.99p\/kWh.*at midnight.*22.19p\/kWh/);
});

test('overnight SMART changes and BOOST do not change homeowner economic cards', () => {
  const base = cards({ haEnabled: false });
  for (const ds of [
    [dispatch('2026-09-23T01:00:00+01:00', '2026-09-23T02:00:00+01:00')],
    [dispatch('2026-09-23T03:00:00+01:00', '2026-09-23T05:00:00+01:00')],
    [dispatch(date('22:30'), date('23:30'), 'BOOST')],
  ]) {
    const selected = cards({ signal: plan(ds).signal, haEnabled: false });
    assert.deepEqual(types(selected), types(base));
    assert.equal(selected[0].summary, base[0].summary);
    assert.equal(selected[0].insight.id, base[0].insight.id);
  }
});

test('outside SMART shows conditional named opportunity and guaranteed context; removal clears it', () => {
  const selected = cards({ signal: plan([dispatch(date('22:30'), '2026-09-23T00:00:00+01:00')]).signal });
  assert.deepEqual(types(selected), ['smart-opportunity', 'cheap-import-ahead', 'export-value']);
  assert.equal(selected[0].label, 'Conditional');
  assert.match(selected[0].summary, /Family car.*22:30.*00:00.*may cost 2.99p\/kWh.*if EV charging qualifies/);
  assert.equal(selected[1].label, 'Guaranteed');
  assert.ok(!types(cards({ signal: plan([]).signal })).includes('smart-opportunity'));
});

test('live configured HA values use normalized SOC and correct flow signs', () => {
  const { snapshot, result } = run();
  const soc = snapshot.assets.flatMap(a => a.metrics).find(m => m.entityId === bindings.batteries[0].socPercent.entityId);
  assert.equal(soc.rawValue, 21); assert.ok(Math.abs(soc.value - 16.84210526) < 0.00001);
  const selected = opportunityCards(result, 'Europe/London');
  assert.deepEqual(types(selected), ['cheap-import-ahead', 'export-value', 'stored-energy-context']);
  assert.match(selected[1].summary, /3 kW.*£0.525\/hour.*not confirmed revenue or a forecast/);
  assert.match(selected[2].summary, /16.8%.*sufficiency remain unknown/);
  const changed = cards({ updates: { ...updates, [bindings.gridImportKw.entityId]: 3 } });
  assert.ok(!types(changed).includes('export-value'));
});

test('missing Kraken or HA never removes the independent tariff insights', () => {
  assert.ok(types(cards({ signal: plan(null).signal })).includes('export-value'));
  for (const override of [{ haEnabled: false }, { updates: {}, receivedAt: null, status: 'connecting' }, { initial: { assets: [] }, updates: {} }]) {
    const selected = cards(override);
    assert.equal(selected[0].insight.type, 'cheap-import-ahead');
    assert.ok(!types(selected).includes('export-value'));
  }
});

test('partial initial stream is not treated as a fresh full snapshot; disconnect qualifies last-known data', () => {
  const partial = cards({ updates: { [bindings.gridImportKw.entityId]: -3 } });
  assert.ok(!types(partial).includes('export-value'));
  const disconnected = run({ status: 'disconnected' });
  assert.ok(!types(opportunityCards(disconnected.result, 'Europe/London')).includes('export-value'));
  assert.match(markup(disconnected.result), /Last-known evidence/);
  assert.match(markup(run({ status: 'connecting' }).result), /freshness are unknown/);
  const stale = run({ signal: plan([dispatch(date('22:30'), date('23:30'))], true).signal });
  const smart = opportunityCards(stale.result, 'Europe/London')[0];
  assert.equal(smart.label, 'Conditional'); assert.match(smart.warning, /Last-known/);
});

test('accessible compact presentation caps at three, retains details and never gives battery commands', () => {
  for (const signal of [plan().signal, plan([dispatch(date('22:30'), date('23:30'))]).signal]) {
    const { result } = run({ signal });
    const html = markup(result);
    assert.equal((html.match(/<article/g) ?? []).length, 3);
    assert.match(html, /<summary[^>]*>Details/);
    assert.match(html, /Evidence:.*Freshness:/);
    assert.doesNotMatch(html, /opaque-ev-id|sensor\.|charge the (?:battery|powerwall)|discharge the|set reserve|switch mode|target SOC/i);
    assert.doesNotMatch(html, /No additional opportunity identified/);
  }
});

test('only supplied observed or billed evidence can label SMART as observed or verified', () => {
  for (const [state, label] of [['planned-conditional', 'Conditional'], ['observed-qualified', 'Observed · not bill-verified'], ['billed-verified', 'Verified']]) {
    const signal = plan([dispatch(date('22:30'), date('23:30'))]).signal;
    for (const w of signal.import) for (const p of w.eligibilityPeriods) p.state = state;
    assert.equal(cards({ signal })[0].label, label);
  }
});

test('one shared stream updates both views, cleans up, and does not connect for tariff-only sites', () => {
  let state, effect, subscriptions = 0, cleanups = 0, onMetrics, onStatus;
  const hooks = {
    useState(initial) { state ??= initial; return [state, next => { state = typeof next === 'function' ? next(state) : next; }]; },
    useEffect(callback) { effect = callback; },
  };
  const { default: LiveHomeEnergy } = load('src/components/LiveHomeEnergy.tsx', {
    react: hooks, 'react/jsx-runtime': jsx,
    '../lib/home-assistant/browser-stream': { watchHomeAssistant(metrics, status) {
      subscriptions++; onMetrics = metrics; onStatus = status; return () => { cleanups++; };
    } },
    '../lib/opportunity/live-site-input': liveInput,
    './HomeEnergyTelemetry': { default: () => null }, './EnergyOpportunities': { default: EnergyOpportunities },
  });
  const props = { initial, plan: plan(), haEnabled: true, configuration: currentSite.opportunities };
  LiveHomeEnergy(props);
  assert.equal(subscriptions, 0); // Initial rendering is useful without opening a connection.
  const cleanup = effect(); assert.equal(subscriptions, 1);
  onMetrics(updates); onStatus('live');
  // Keep test time in configured tariff horizon; production uses event receipt time.
  state.now = now;
  const tree = LiveHomeEnergy(props);
  assert.equal(tree.props.children[0].props.status, 'live');
  const renderedSoc = tree.props.children[0].props.initial.assets[0].metrics.find(m => m.entityId === bindings.batteries[0].socPercent.entityId).value;
  const battery = tree.props.children[2].props.result.insights.find(i => i.type === 'stored-energy-context');
  assert.equal(battery.evidence.telemetry.find(t => t.role === 'soc').reading.value, renderedSoc);
  assert.ok(tree.props.children[2].props.result.insights.some(i => i.type === 'export-value'));
  assert.equal(subscriptions, 1);
  onStatus('disconnected'); state.now = now;
  assert.ok(!LiveHomeEnergy(props).props.children[2].props.result.insights.some(i => i.type === 'export-value'));
  cleanup(); assert.equal(cleanups, 1);
  LiveHomeEnergy({ ...props, haEnabled: false });
  assert.equal(effect(), undefined); assert.equal(subscriptions, 1);
});

test('grouped dispatches preserve truthful vehicle attribution and exact times in Details', () => {
  const grouped = getSitePriceSignal(currentSite, { stale: false, lastSuccessfulUpdate: now, vehicles: [
    { id: 'one', name: 'First car', plannedDispatches: [dispatch(date('22:00'), date('22:30'))] },
    { id: 'two', name: 'Second car', plannedDispatches: [dispatch(date('22:30'), date('23:00'))] },
  ] }, now);
  const { result } = run({ signal: grouped.signal });
  const selected = opportunityCards(result, 'Europe/London');
  assert.match(selected[0].summary, /First car, Second car.*grouped/);
  const html = markup(result);
  assert.match(html, /First car:.*22:00.*22:30.*SMART planned dispatch/);
  assert.match(html, /Second car:.*22:30.*23:00.*SMART planned dispatch/);
  assert.match(html, /do not confirm continuous discounted billing/);
});

test('deterministic local formatter preserves London summer/winter and both DST boundaries', () => {
  const fixtures = [
    ['2026-09-22T15:07:00Z', '22 Sep, 16:07 UTC+01:00'],
    ['2026-01-22T16:07:00Z', '22 Jan, 16:07 UTC+00:00'],
    ['2026-03-29T00:59:00Z', '29 Mar, 00:59 UTC+00:00'],
    ['2026-03-29T01:00:00Z', '29 Mar, 02:00 UTC+01:00'],
    ['2026-10-25T00:30:00Z', '25 Oct, 01:30 UTC+01:00'],
    ['2026-10-25T01:30:00Z', '25 Oct, 01:30 UTC+00:00'],
  ];
  for (const [timestamp, expected] of fixtures) {
    assert.equal(localTime.formatLocalDateTime(timestamp, 'Europe/London'), expected);
  }
  // Supplied timezone is respected, including non-whole-hour offsets.
  assert.equal(localTime.formatLocalDateTime('2026-09-22T15:07:00Z', 'Asia/Kolkata'), '22 Sep, 20:37 UTC+05:30');
});

test('next midnight uses tariff-local calendar days across DST and year rollover', () => {
  for (const [asOf, next] of [
    ['2026-09-22T20:00:00Z', '2026-09-22T23:00:00Z'],
    ['2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z'],
    ['2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z'],
    ['2026-12-31T20:00:00Z', '2027-01-01T00:00:00Z'],
  ]) assert.equal(localTime.isNextLocalMidnight(next, asOf, 'Europe/London'), true);
  for (const target of ['2026-09-23T00:00:00Z', '2026-09-23T23:00:00Z', '2026-09-22T23:00:01Z', '2026-09-22T23:00:00.001Z']) {
    assert.equal(localTime.isNextLocalMidnight(target, now, 'Europe/London'), false);
  }
  assert.equal(localTime.isNextLocalMidnight('2026-09-22T23:00:00Z', '2026-09-22T23:00:00Z', 'Europe/London'), false);
});

test('guaranteed card uses midnight only for the next local midnight, otherwise explicit local time', () => {
  const { result } = run();
  assert.match(opportunityCards(result, 'Europe/London')[0].summary, /at midnight/);
  for (const [start, expected] of [
    ['2026-09-22T22:30:00Z', 'at 22 Sep, 23:30 UTC+01:00'],
    ['2026-09-23T23:00:00Z', 'at 24 Sep, 00:00 UTC+01:00'],
  ]) {
    const changed = structuredClone(result);
    const cheap = changed.insights.find(i => i.type === 'cheap-import-ahead');
    cheap.evidence.prices.find(p => p.role === 'lower-import').window.start = start;
    assert.ok(opportunityCards(changed, 'Europe/London')[0].summary.includes(expected));
  }
});

test('server/client markup is identical despite locale literals, ordering and short-name differences', () => {
  const { result } = run({ signal: plan([dispatch(date('22:30'), date('23:30'))]).signal });
  const server = markup(result);
  const alternativeIntl = {
    DateTimeFormat: class {
      constructor(locale, options) {
        assert.equal(options.timeZone, 'Europe/London');
        assert.equal(options.month, '2-digit');
        assert.equal(options.timeZoneName, undefined);
        this.formatter = new Intl.DateTimeFormat(locale, options);
      }
      formatToParts(date) {
        return this.formatter.formatToParts(date).map(p => p.type === 'literal' ? { ...p, value: ' at ' } : p).reverse();
      }
      format() { throw new Error('Locale-formatted strings must not enter rendered output'); }
    },
  };
  const clientTime = load('src/lib/presentation/local-time.ts', {}, { Intl: alternativeIntl });
  const clientView = load('src/components/energy-opportunities-view.ts', { '../lib/presentation/local-time': clientTime });
  const { default: ClientComponent } = load('src/components/EnergyOpportunities.tsx', {
    'react/jsx-runtime': jsx, './energy-opportunities-view': clientView, '../lib/presentation/local-time': clientTime,
  });
  const client = renderToStaticMarkup(React.createElement(ClientComponent, { result, timeZone: 'Europe/London' }));
  assert.equal(client, server);
  assert.match(server, /22 Sep, 21:00 UTC\+01:00/);
});
