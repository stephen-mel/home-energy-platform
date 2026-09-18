import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// No network or integration client dependencies are allowed in this graph.
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const curve = load('src/lib/tariff/price-signal.ts');
const adapter = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/price-signal': curve, '../tariff/kraken-dispatches': adapter,
});
const { default: HomeEnergyPlan } = load('src/components/HomeEnergyPlan.tsx', { 'react/jsx-runtime': jsxRuntime });
const now = '2026-09-18T00:00:00.000Z';
const at = hour => `2026-09-18T${String(hour).padStart(2, '0')}:00:00.000Z`;
const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
const dispatch = (start, end) => ({ start: at(start), end: at(end), type: 'SMART', energyAddedKwh: '3' });
const state = (dispatches, stale = false) => ({
  stale, lastSuccessfulUpdate: '2026-09-17T23:59:00.000Z',
  vehicles: [{ id: 'any-ev', plannedDispatches: dispatches }],
});
const site = () => ({
  integrations: { kraken: { enabled: true, wholeHomeDispatchRate: { enabled: true, importPrice: price(0.10) } } },
  tariff: { timeZone: 'Europe/London', normalImport: null, export: null },
});
const build = (dispatches, config = site(), stale = false) => getSitePriceSignal(config, state(dispatches, stale), now);
const cheap = plan => plan.signal.import.filter(w => w.kind === 'cheap-opportunity');
const plain = value => JSON.parse(JSON.stringify(value));

test('one dispatch becomes one conditional whole-home window between unknown baseline prices', () => {
  const plan = build([dispatch(2, 3)]);
  assert.equal(plan.signal.scope, 'whole-home');
  assert.equal(plan.signal.import.length, 3);
  const [before, window, after] = plan.signal.import;
  assert.equal(before.start, now); assert.equal(before.end, at(2)); assert.equal(before.price, null);
  assert.equal(window.start, at(2)); assert.equal(window.end, at(3));
  assert.deepEqual(plain(window.price), price(0.10));
  assert.equal(window.condition, 'scheduled-ev-charging');
  assert.equal(window.sources[0].provider, 'kraken');
  assert.equal(window.sources[0].cause.assetId, 'any-ev');
  assert.equal(window.sources[0].cause.start, at(2));
  assert.equal(after.start, at(3)); assert.equal(after.price, null);
});

test('adjacent slots merge and keep both causing schedules', () => {
  const windows = cheap(build([dispatch(3, 4), dispatch(2, 3)]));
  assert.equal(windows.length, 1); assert.equal(windows[0].start, at(2)); assert.equal(windows[0].end, at(4));
  assert.equal(windows[0].sources.length, 2);
});

test('overlapping dispatches across vehicles form a non-overlapping union without duplicate sources', () => {
  const snapshot = state([dispatch(2, 4), dispatch(2, 4)]);
  snapshot.vehicles.push({ id: 'another-ev', plannedDispatches: [dispatch(3, 5)] });
  const before = JSON.stringify(snapshot);
  const plan = getSitePriceSignal(site(), snapshot, now);
  assert.equal(cheap(plan).length, 1);
  assert.equal(cheap(plan)[0].start, at(2)); assert.equal(cheap(plan)[0].end, at(5));
  assert.equal(cheap(plan)[0].sources.length, 2);
  assert.equal(JSON.stringify(snapshot), before);
  plan.signal.import.slice(1).forEach((w, i) => assert.equal(w.start, plan.signal.import[i].end));
});

test('separated dispatches remain distinct opportunities with a baseline gap', () => {
  const plan = build([dispatch(5, 6), dispatch(1, 2)]);
  assert.equal(cheap(plan).length, 2); assert.equal(plan.signal.import.length, 5);
  assert.equal(plan.signal.import[2].kind, 'standard'); assert.equal(plan.signal.import[2].price, null);
});

test('no dispatch, no EV, unavailable snapshot or disabled Kraken never invents cheap rates', () => {
  for (const snapshot of [state([]), { ...state([]), vehicles: [] }, null]) {
    assert.equal(cheap(getSitePriceSignal(site(), snapshot, now)).length, 0);
  }
  for (const mode of ['integration', 'rule', 'absent-rule']) {
    const config = site();
    if (mode === 'integration') config.integrations.kraken.enabled = false;
    if (mode === 'rule') config.integrations.kraken.wholeHomeDispatchRate.enabled = false;
    if (mode === 'absent-rule') delete config.integrations.kraken.wholeHomeDispatchRate;
    const plan = getSitePriceSignal(config, state([dispatch(2, 3)]), now);
    assert.equal(cheap(plan).length, 0); assert.equal(plan.kraken.status, 'disabled');
  }
  const pluggedIn = state([]);
  pluggedIn.vehicles[0].status = { currentState: 'PLUGGED_IN', isSuspended: false };
  assert.equal(cheap(getSitePriceSignal(site(), pluggedIn, now)).length, 0);
});

test('unknown normal, export and cheap prices remain null and distinct from explicit zero', () => {
  const config = site(); config.integrations.kraken.wholeHomeDispatchRate.importPrice = null;
  const plan = build([dispatch(2, 3)], config);
  assert.ok(plan.signal.import.every(w => w.price === null && w.priceStatus === 'unknown'));
  assert.equal(plan.signal.import.length, 3); // Unknown cheap is still a separate opportunity.
  assert.equal(plan.signal.export.length, 1); assert.equal(plan.signal.export[0].price, null);
  config.tariff.normalImport = price(0); config.tariff.export = price(-0.01);
  const known = build([dispatch(2, 3)], config);
  assert.equal(known.signal.import[0].price.amount, 0);
  assert.equal(known.signal.export[0].price.amount, -0.01);
});

test('configured normal import returns after dispatch; export stays independent', () => {
  const config = site(); config.tariff.normalImport = price(0.30); config.tariff.export = price(0.15);
  const plan = build([dispatch(2, 3)], config);
  assert.deepEqual(plain(plan.signal.import.map(w => w.price.amount)), [0.30, 0.10, 0.30]);
  assert.equal(plan.signal.export.length, 1); assert.equal(plan.signal.export[0].price.amount, 0.15);
  assert.equal(plan.signal.export[0].sources[0].provider, 'site-config');
});

test('stale Kraken schedule retains per-window provenance and original successful timestamp', () => {
  const plan = build([dispatch(2, 3)], site(), true);
  assert.equal(plan.kraken.status, 'stale');
  const window = cheap(plan)[0];
  assert.equal(window.stale, true); assert.equal(window.sources[0].stale, true);
  assert.equal(window.sources[0].observedAt, state([]).lastSuccessfulUpdate);
  assert.equal(plan.kraken.lastSuccessfulUpdate, state([]).lastSuccessfulUpdate);
  assert.equal(plan.signal.import[0].stale, false);
  assert.equal(build([dispatch(2, 3)]).kraken.status, 'available');
});

test('expired and malformed dispatches are ignored; ongoing dispatch is clipped but keeps its original cause', () => {
  const ds = [
    { ...dispatch(2, 3), start: 'invalid' }, dispatch(4, 3), dispatch(2, 2),
    { ...dispatch(2, 3), start: '2026-09-18T02:00:00' },
    { ...dispatch(2, 3), start: '2026-09-17T21:00:00Z', end: now },
    { ...dispatch(2, 3), start: '2026-09-17T23:00:00Z', end: at(1) },
    { ...dispatch(2, 3), start: '2026-09-21T00:00:00Z', end: '2026-09-21T01:00:00Z' },
  ];
  const windows = cheap(build(ds)); assert.equal(windows.length, 1);
  assert.equal(windows[0].start, now); assert.equal(windows[0].end, at(1));
  assert.equal(windows[0].sources[0].cause.start, '2026-09-17T23:00:00Z');
});

test('offset timestamps normalize to UTC instants across midnight/DST', () => {
  const ds = [{ ...dispatch(2, 3), start: '2026-09-18T02:00:00+01:00', end: '2026-09-18T03:00:00+01:00' }];
  const window = cheap(build(ds))[0]; assert.equal(window.start, at(1)); assert.equal(window.end, at(2));
  const dst = curve.buildPriceCurve({ start: '2026-10-25T00:00:00Z', end: '2026-10-25T03:00:00Z' }, null,
    adapter.krakenDispatchPriceWindows(state([{ ...dispatch(2, 3), start: '2026-10-25T01:30:00+01:00', end: '2026-10-25T01:30:00+00:00' }]), null));
  assert.equal(dst[1].start, '2026-10-25T00:30:00.000Z'); assert.equal(dst[1].end, '2026-10-25T01:30:00.000Z');
});

const input = (start, end, amount) => ({ start: at(start), end: at(end), price: price(amount),
  kind: 'standard', condition: 'none', sources: [{ provider: 'other-provider', description: 'Dated tariff rate', observedAt: now, stale: false }] });
test('neutral representation supports arbitrary import/export curves and does not silently choose conflicting prices', () => {
  const config = site(); config.tariff.importWindows = [input(1, 2, 0.20), input(2, 3, 0.25), input(3, 4, 0.40)];
  config.tariff.exportWindows = [input(1, 3, 0.05), input(3, 4, 0.12)];
  const plan = build([], config);
  assert.deepEqual(plain(plan.signal.import.filter(w => w.price).map(w => w.price.amount)), [0.20, 0.25, 0.40]);
  assert.deepEqual(plain(plan.signal.export.filter(w => w.price).map(w => w.price.amount)), [0.05, 0.12]);
  config.tariff.importWindows.push(input(2, 4, 0.35));
  const conflict = build([], config).signal.import.find(w => w.priceStatus === 'conflicting');
  assert.ok(conflict); assert.equal(conflict.price, null);
});

test('current site has no invented monetary prices', () => {
  const { currentSite } = load('src/lib/site/current-site.ts');
  const plan = getSitePriceSignal(currentSite, state([dispatch(2, 3)]), now);
  assert.equal(cheap(plan).length, 1);
  assert.ok([...plan.signal.import, ...plan.signal.export].every(w => w.price === null));
});

test('homeowner UI exposes conditionality, sources, known/unknown prices, dates and stale status', () => {
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: build([dispatch(2, 3)], site(), true) }));
  for (const text of ['Whole-home price signal', 'Whole-home cheap opportunity', '10p/kWh',
    'Kraken planned EV dispatch', 'Price not configured / unknown', 'Kraken schedule is stale',
    'Last successful update', 'Conditional on scheduled vehicle charging', 'Export', '18 Sept']) assert.ok(html.includes(text), text);
  const unavailable = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: getSitePriceSignal(site(), null, now) }));
  assert.match(unavailable, /Kraken schedule is unavailable/);
});

test('adjacent opportunities name each vehicle and show the exact original dispatches beneath the HEP grouping', () => {
  const first = { ...dispatch(2, 3), start: '2026-09-18T02:00:12.345Z', type: 'TYPE_A' };
  const second = { ...dispatch(3, 4), type: 'TYPE_B' };
  const snapshot = state([]);
  snapshot.vehicles = [
    { id: 'vehicle-a', name: 'Family car', plannedDispatches: [first] },
    { id: 'vehicle-b', name: 'City car', plannedDispatches: [second] },
  ];
  const config = site(); config.integrations.kraken.wholeHomeDispatchRate.importPrice = null;
  const plan = getSitePriceSignal(config, snapshot, now);
  assert.equal(cheap(plan).length, 1);
  assert.equal(cheap(plan)[0].start, first.start);
  assert.equal(cheap(plan)[0].end, second.end);
  assert.deepEqual(plain(cheap(plan)[0].sources.map(s => s.cause)), [
    { kind: 'ev-dispatch', assetId: 'vehicle-a', assetName: 'Family car', start: first.start, end: first.end, dispatchType: 'TYPE_A' },
    { kind: 'ev-dispatch', assetId: 'vehicle-b', assetName: 'City car', start: second.start, end: second.end, dispatchType: 'TYPE_B' },
  ]);
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan }));
  assert.match(html, /HEP grouping of planned Kraken opportunities/);
  assert.match(html, /does not confirm a continuous E.ON discounted billing period/);
  assert.match(html, /not confirmed billed rates/);
  assert.doesNotMatch(html, /the paired EV/);
  assert.match(html, /Price not configured \/ unknown/);
  const items = html.split('aria-label="Original Kraken dispatches"')[1].split('</ul>')[0];
  assert.match(items, /Family car \(vehicle-a\)/); assert.match(items, /City car \(vehicle-b\)/);
  for (const original of [first, second]) {
    assert.ok(items.includes(`dateTime="${original.start}"`));
    assert.ok(items.includes(`dateTime="${original.end}"`));
    assert.ok(items.includes(`Dispatch type: ${original.type}`));
  }
  assert.match(items, /03:00:12.345/); // Display preserves seconds/fractions, in the site's timezone.
});

test('overlapping/clipped opportunities retain original intervals and fall back to vehicle IDs and missing types', () => {
  const snapshot = state([]);
  const originals = [
    { start: '2026-09-17T23:00:00Z', end: at(3), type: '', energyAddedKwh: null },
    dispatch(2, 4),
  ];
  snapshot.vehicles = originals.map((d, i) => ({ id: `ev-${i}`, name: '', plannedDispatches: [d] }));
  const plan = getSitePriceSignal(site(), snapshot, now);
  assert.equal(cheap(plan).length, 1); assert.equal(cheap(plan)[0].start, now);
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan }));
  const items = html.split('aria-label="Original Kraken dispatches"')[1].split('</ul>')[0];
  assert.match(items, /ev-0/); assert.match(items, /ev-1/);
  assert.match(items, /Dispatch type: Not supplied/); assert.match(items, /Dispatch type: SMART/);
  for (const original of originals) {
    assert.ok(items.includes(`dateTime="${original.start}"`));
    assert.ok(items.includes(`dateTime="${original.end}"`));
  }
});

test('all Kraken eligibility periods are planned/conditional, independently of fresh or stale provenance', () => {
  for (const stale of [false, true]) {
    const snapshot = state([dispatch(2, 4)], stale);
    // Even current vehicle status must not act as qualification/promotion logic.
    snapshot.vehicles[0].status = { currentState: 'SMART_CONTROL_IN_PROGRESS', activePower: { value: 7 } };
    const raw = adapter.krakenDispatchPriceWindows(snapshot, null);
    assert.equal(raw[0].eligibility.state, 'planned-conditional');
    assert.equal(raw[0].eligibility.intervalMinutes, 30);
    const plan = getSitePriceSignal(site(), snapshot, now);
    const window = cheap(plan)[0];
    assert.equal(window.stale, stale); assert.equal(window.eligibilityPeriods.length, 4);
    for (const period of window.eligibilityPeriods) {
      assert.equal(period.state, 'planned-conditional');
      assert.equal(period.sources[0].stale, stale);
      assert.equal(period.sources[0].observedAt, snapshot.lastSuccessfulUpdate);
      assert.equal(Date.parse(period.end) - Date.parse(period.start), 30 * 60_000);
      assert.equal(period.start, period.assessmentPeriod.start);
      assert.equal(period.end, period.assessmentPeriod.end);
    }
  }
});

test('grouped opportunities keep half-hour eligibility and exact per-vehicle dispatch coverage', () => {
  const first = { ...dispatch(2, 3), start: '2026-09-18T02:15:00Z' };
  const second = { ...dispatch(3, 4), end: '2026-09-18T03:45:00Z' };
  const snapshot = state([]);
  snapshot.vehicles = [
    { id: 'ev-a', name: 'First car', plannedDispatches: [first] },
    { id: 'ev-b', name: 'Second car', plannedDispatches: [second] },
  ];
  const plan = getSitePriceSignal(site(), snapshot, now);
  const [window] = cheap(plan);
  assert.equal(cheap(plan).length, 1);
  assert.equal(window.start, '2026-09-18T02:15:00.000Z');
  assert.equal(window.end, '2026-09-18T03:45:00.000Z');
  assert.equal(window.eligibilityPeriods.length, 4);
  const [a, b, c, d] = window.eligibilityPeriods;
  assert.equal(a.assessmentPeriod.start, at(2));
  assert.equal(a.start, '2026-09-18T02:15:00.000Z'); // No inferred eligibility before the original start.
  assert.equal(a.end, '2026-09-18T02:30:00.000Z');
  assert.equal(b.end, at(3)); assert.equal(c.start, at(3));
  assert.equal(d.end, '2026-09-18T03:45:00.000Z');
  assert.equal(d.assessmentPeriod.end, at(4)); // Coverage does not qualify this whole half-hour.
  for (const [period, id, original] of [[a, 'ev-a', first], [b, 'ev-a', first], [c, 'ev-b', second], [d, 'ev-b', second]]) {
    assert.equal(period.sources[0].cause.assetId, id);
    assert.equal(period.sources[0].cause.start, original.start);
    assert.equal(period.sources[0].cause.end, original.end);
    assert.equal(period.sources[0].cause.dispatchType, original.type);
    assert.equal(period.state, 'planned-conditional');
  }
});

test('neutral representation can retain different supplied evidence states within a grouped forecast without promotion', () => {
  const inputs = ['planned-conditional', 'observed-qualified', 'billed-verified'].map((evidence, i) => ({
    ...input(2, 3, 0.10),
    start: new Date(Date.parse(at(2)) + i * 30 * 60_000).toISOString(),
    end: new Date(Date.parse(at(2)) + (i + 1) * 30 * 60_000).toISOString(),
    kind: 'cheap-opportunity', condition: 'scheduled-ev-charging',
    eligibility: { state: evidence, intervalMinutes: 30 },
  }));
  const result = curve.buildPriceCurve({ start: at(2), end: '2026-09-18T03:30:00Z' }, null, inputs);
  assert.equal(result.length, 1);
  assert.deepEqual(plain(result[0].eligibilityPeriods.map(p => p.state)),
    ['planned-conditional', 'observed-qualified', 'billed-verified']);
  // The builder carries explicitly supplied evidence; it does not infer/upgrade it.
  assert.equal(result[0].stale, false);
});

test('no dispatch supplies no cheap eligibility, even with fresh Kraken data', () => {
  const plan = build([]);
  assert.equal(cheap(plan).length, 0);
  assert.ok([...plan.signal.import, ...plan.signal.export].every(w => w.eligibilityPeriods.length === 0));
});

test('UI explains planned status, half-hour billing and early charging completion', () => {
  const config = site(); config.integrations.kraken.wholeHomeDispatchRate.importPrice = null;
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: build([dispatch(2, 7)], config) }));
  for (const text of ['Planned / conditional', 'half-hourly meter readings', 'actually charging',
    'If charging finishes early or the schedule changes', 'shorter than this planned range',
    'not confirmed billed rates', 'Price not configured / unknown']) assert.ok(html.includes(text), text);
});
