import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// No network or integration client dependencies are allowed in this graph.
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { ...globals, exports, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const curve = load('src/lib/tariff/price-signal.ts');
const effectiveTariff = load('src/lib/tariff/effective-tariff.ts', { './price-signal': curve });
const { effectivePriceCurveKey } = load('src/lib/tariff/compare-price-signal.ts');
const adapter = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/price-signal': curve, '../tariff/kraken-dispatches': adapter,
  '../tariff/effective-tariff': effectiveTariff,
});
const { default: HomeEnergyPlan } = load('src/components/HomeEnergyPlan.tsx', { 'react/jsx-runtime': jsxRuntime, './home-energy-plan-view': load('src/components/home-energy-plan-view.ts'), './use-dashboard-time': { useDashboardTime: value => value }, '../lib/presentation/local-time': load('src/lib/presentation/local-time.ts') });
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

test('current site does not backdate configured prices before their effective date', () => {
  const { currentSite } = load('src/lib/site/current-site.ts');
  const plan = getSitePriceSignal(currentSite, state([dispatch(2, 3)]), now);
  assert.equal(cheap(plan).length, 1);
  assert.ok([...plan.signal.import, ...plan.signal.export].every(w => w.price === null));
});

test('homeowner UI exposes conditionality, sources, known/unknown prices, dates and stale status', () => {
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: build([dispatch(2, 3)], site(), true) }));
  for (const text of ['Whole-home price signal', 'Whole-home cheap opportunity', '10p/kWh',
    'Kraken planned EV dispatch', 'Price not configured / unknown', 'Kraken schedule is stale',
    'Last successful update', 'Conditional on scheduled vehicle charging', 'Export', '18 Sep']) assert.ok(html.includes(text), text);
  const unavailable = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: getSitePriceSignal(site(), null, now) }));
  assert.match(unavailable, /Kraken schedule is unavailable/);
});

test('adjacent opportunities name each vehicle and show the exact original dispatches beneath the HEP grouping', () => {
  const first = { ...dispatch(2, 3), start: '2026-09-18T02:00:12.345Z', type: 'SMART' };
  const second = { ...dispatch(3, 4), type: 'SMART' };
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
    { kind: 'ev-dispatch', assetId: 'vehicle-a', assetName: 'Family car', start: first.start, end: first.end, dispatchType: 'SMART' },
    { kind: 'ev-dispatch', assetId: 'vehicle-b', assetName: 'City car', start: second.start, end: second.end, dispatchType: 'SMART' },
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

test('overlapping/clipped opportunities retain original intervals and fall back to vehicle IDs', () => {
  const snapshot = state([]);
  const originals = [
    { start: '2026-09-17T23:00:00Z', end: at(3), type: 'SMART', energyAddedKwh: null },
    dispatch(2, 4),
  ];
  snapshot.vehicles = originals.map((d, i) => ({ id: `ev-${i}`, name: '', plannedDispatches: [d] }));
  const plan = getSitePriceSignal(site(), snapshot, now);
  assert.equal(cheap(plan).length, 1); assert.equal(cheap(plan)[0].start, now);
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan }));
  const items = html.split('aria-label="Original Kraken dispatches"')[1].split('</ul>')[0];
  assert.match(items, /ev-0/); assert.match(items, /ev-1/);
  assert.match(items, /Dispatch type: SMART/);
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

const eonSite = () => load('src/lib/site/current-site.ts').currentSite;
const eonDispatch = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
const eonPlan = (dispatches = [], date = '2026-09-22T11:00:00Z', config = eonSite(), stale = false) =>
  getSitePriceSignal(config, state(dispatches, stale), date);
const windowAt = (windows, date) => windows.find(w => Date.parse(w.start) <= Date.parse(date) && Date.parse(w.end) > Date.parse(date));

test('E.ON supplies 25.18p daytime and guaranteed 2.99p London overnight without Kraken; export is independent', () => {
  const config = eonSite(); config.integrations.kraken.enabled = false;
  const plan = eonPlan([], '2026-09-22T00:00:00+01:00', config);
  const overnight = windowAt(plan.signal.import, '2026-09-22T05:59:59+01:00');
  assert.equal(overnight.price.amount, 0.0299);
  assert.equal(overnight.kind, 'guaranteed-off-peak'); assert.equal(overnight.condition, 'none');
  assert.equal(overnight.eligibilityPeriods.length, 0);
  assert.equal(overnight.start, '2026-09-21T23:00:00.000Z');
  assert.equal(overnight.end, '2026-09-22T05:00:00.000Z');
  const daytime = windowAt(plan.signal.import, '2026-09-22T06:00:00+01:00');
  assert.equal(daytime.price.amount, 0.2518); assert.equal(daytime.condition, 'none');
  assert.equal(windowAt(plan.signal.import, '2026-09-23T00:00:00+01:00').price.amount, 0.0299);
  assert.equal(plan.signal.export.length, 1); assert.equal(plan.signal.export[0].price.amount, 0.175);
  assert.equal(plan.signal.export[0].condition, 'none');
  assert.equal(plan.signal.export[0].eligibilityPeriods.length, 0);
  assert.equal(config.tariff.versions[0].standingCharge.amount, 0.60);
  assert.equal(config.tariff.versions[0].pricesIncludeVat, true);
  assert.ok(!JSON.stringify(plan.signal).includes('standingCharge'));
  assert.ok(!JSON.stringify(plan.signal).includes('0.6'));
  // With the integration enabled but no dispatch, the same base economics apply.
  assert.equal(effectivePriceCurveKey(eonPlan([], '2026-09-22T00:00:00+01:00').signal), effectivePriceCurveKey(plan.signal));
});

test('only SMART daytime dispatches create planned/conditional 2.99p opportunities', () => {
  const d = eonDispatch('2026-09-22T12:00:00+01:00', '2026-09-22T14:00:00+01:00');
  for (const stale of [false, true]) {
    const plan = eonPlan([d], '2026-09-22T10:00:00+01:00', eonSite(), stale);
    const opportunity = windowAt(plan.signal.import, d.start);
    assert.equal(opportunity.price.amount, 0.0299); assert.equal(opportunity.kind, 'cheap-opportunity');
    assert.equal(opportunity.condition, 'scheduled-ev-charging'); assert.equal(opportunity.stale, stale);
    assert.ok(opportunity.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
    assert.equal(windowAt(plan.signal.import, d.end).price.amount, 0.2518);
    assert.equal(plan.signal.export[0].price.amount, 0.175);
  }
  const base = effectivePriceCurveKey(eonPlan([]).signal);
  for (const type of ['BOOST', 'OTHER', 'smart', '', undefined]) {
    const plan = eonPlan([{ ...d, type }]);
    assert.equal(cheap(plan).length, 0);
    assert.equal(effectivePriceCurveKey(plan.signal), base);
  }
});

test('22:30–04:00 SMART dispatch becomes conditional until midnight then guaranteed to 06:00', () => {
  const d = eonDispatch('2026-09-22T22:30:00+01:00', '2026-09-23T04:00:00+01:00');
  const plan = eonPlan([d], '2026-09-22T22:00:00+01:00');
  const conditional = windowAt(plan.signal.import, d.start);
  assert.equal(conditional.start, '2026-09-22T21:30:00.000Z');
  assert.equal(conditional.end, '2026-09-22T23:00:00.000Z');
  assert.equal(conditional.price.amount, 0.0299); assert.equal(conditional.condition, 'scheduled-ev-charging');
  const cause = conditional.sources.find(s => s.cause).cause;
  assert.equal(cause.start, d.start); assert.equal(cause.end, d.end);
  const guaranteed = windowAt(plan.signal.import, '2026-09-23T00:00:00+01:00');
  assert.equal(guaranteed.start, '2026-09-22T23:00:00.000Z');
  assert.equal(guaranteed.end, '2026-09-23T05:00:00.000Z');
  assert.equal(guaranteed.kind, 'guaranteed-off-peak'); assert.equal(guaranteed.price.amount, 0.0299);
  assert.equal(guaranteed.condition, 'none'); assert.equal(guaranteed.stale, false);
  assert.equal(guaranteed.eligibilityPeriods.length, 0);
  assert.ok(guaranteed.sources.every(s => s.provider === 'eon-next'));
  assert.equal(windowAt(plan.signal.import, '2026-09-23T06:00:00+01:00').price.amount, 0.2518);
});

test('SMART dispatch wholly overnight cannot make guaranteed tariff conditional or stale', () => {
  const date = '2026-09-22T00:00:00+01:00';
  const d = eonDispatch('2026-09-22T01:15:00+01:00', '2026-09-22T04:45:00+01:00');
  const plan = eonPlan([d], date, eonSite(), true);
  assert.equal(cheap(plan).length, 0);
  assert.equal(effectivePriceCurveKey(plan.signal), effectivePriceCurveKey(eonPlan([], date).signal));
  assert.ok(plan.signal.import.every(w => w.condition === 'none' && !w.stale && w.eligibilityPeriods.length === 0));
});

test('effective dates clip all rates precisely; unknown October prices are never extrapolated', () => {
  const config = eonSite();
  const before = eonPlan([], '2026-09-21T23:30:00+01:00');
  assert.equal(before.signal.import[0].price, null); assert.equal(before.signal.export[0].price, null);
  assert.equal(windowAt(before.signal.import, '2026-09-22T00:00:00+01:00').price.amount, 0.0299);
  const d = eonDispatch('2026-09-30T22:30:00+01:00', '2026-10-01T04:00:00+01:00');
  const plan = eonPlan([d], '2026-09-30T22:00:00+01:00');
  assert.equal(windowAt(plan.signal.import, d.start).price.amount, 0.0299);
  const unknown = windowAt(plan.signal.import, '2026-10-01T00:00:00+01:00');
  assert.equal(unknown.price, null); assert.equal(unknown.kind, 'cheap-opportunity');
  assert.ok(unknown.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
  assert.equal(windowAt(plan.signal.export, '2026-10-01T00:00:00+01:00').price, null);
  assert.ok(eonPlan([], '2026-10-01T00:00:00+01:00').signal.import.every(w => w.price === null));
  // Synthetic second version tests selection, not a claim about future E.ON prices.
  const second = plain(config.tariff.versions[0]);
  config.tariff.versions[0].effectiveTo = '2026-09-23T12:00:00+01:00';
  second.id = 'test-version'; second.effectiveFrom = '2026-09-23T12:00:00+01:00';
  second.normalImport = price(0.40); second.scheduledChargingImport = price(0.05);
  config.tariff.versions.push(second);
  const change = eonPlan([], '2026-09-23T10:00:00+01:00', config);
  assert.equal(windowAt(change.signal.import, '2026-09-23T11:59:59+01:00').price.amount, 0.2518);
  assert.equal(windowAt(change.signal.import, '2026-09-23T12:00:00+01:00').price.amount, 0.40);
  const smartChange = eonPlan([eonDispatch('2026-09-23T11:00:00+01:00', '2026-09-23T13:00:00+01:00')], '2026-09-23T10:00:00+01:00', config);
  assert.equal(windowAt(smartChange.signal.import, '2026-09-23T11:59:59+01:00').price.amount, 0.0299);
  assert.equal(windowAt(smartChange.signal.import, '2026-09-23T12:00:00+01:00').price.amount, 0.05);
});

test('Europe/London local midnight–06:00 is five elapsed hours at spring DST and seven at autumn DST', () => {
  // Widen only this synthetic fixture's validity to exercise timezone arithmetic.
  // The real site has no configured March/October version.
  const config = eonSite();
  config.tariff.versions[0].id = 'dst-test-fixture';
  config.tariff.versions[0].effectiveFrom = '2026-01-01T00:00:00Z';
  config.tariff.versions[0].effectiveTo = '2027-01-01T00:00:00Z';
  for (const [start, end, hours] of [
    ['2026-03-29T00:00:00Z', '2026-03-29T05:00:00.000Z', 5],
    ['2026-10-24T23:00:00Z', '2026-10-25T06:00:00.000Z', 7],
  ]) {
    const first = eonPlan([], start, config).signal.import[0];
    assert.equal(first.kind, 'guaranteed-off-peak'); assert.equal(first.price.amount, 0.0299);
    assert.equal(first.end, end); assert.equal((Date.parse(first.end) - Date.parse(first.start)) / 3600000, hours);
  }
});

test('canonical economics ignore freshness/order/timestamps/standing charge but detect prices, conditions and evidence changes', () => {
  const ds = [eonDispatch('2026-09-22T12:00:00+01:00', '2026-09-22T13:00:00+01:00'),
    eonDispatch('2026-09-22T13:00:00+01:00', '2026-09-22T14:00:00+01:00')];
  const date = '2026-09-22T10:00:00+01:00';
  const original = eonPlan(ds, date).signal;
  const key = effectivePriceCurveKey(original);
  const reordered = eonPlan([...ds].reverse(), date, eonSite(), true).signal;
  reordered.generatedAt = '2026-09-22T10:00:01Z';
  for (const w of reordered.import) for (const source of w.sources) source.observedAt = '2026-09-22T09:59:59Z';
  assert.equal(effectivePriceCurveKey(reordered), key);
  const config = eonSite(); config.tariff.versions[0].standingCharge.amount = 99;
  assert.equal(effectivePriceCurveKey(eonPlan(ds, date, config).signal), key);
  config.tariff.versions[0].normalImport.amount = 0.30;
  assert.notEqual(effectivePriceCurveKey(eonPlan(ds, date, config).signal), key);
  const observed = plain(original);
  observed.import.find(w => w.kind === 'cheap-opportunity').eligibilityPeriods[0].state = 'observed-qualified';
  assert.notEqual(effectivePriceCurveKey(observed), key);
  assert.notEqual(effectivePriceCurveKey(eonPlan([], date).signal), key);
});

test('UI keeps existing structure and labels guaranteed off-peak separately from planned opportunities', () => {
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: eonPlan() }));
  for (const label of ['Guaranteed off-peak tariff', '2.99p/kWh', '25.18p/kWh', '17.5p/kWh']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes('60p/kWh'));
});

test('equivalent horizon instants compare identically and ambiguous versions remain unknown', () => {
  const a = eonPlan([], '2026-09-22T10:00:00+01:00');
  const b = eonPlan([], '2026-09-22T09:00:00Z');
  assert.equal(effectivePriceCurveKey(a.signal), effectivePriceCurveKey(b.signal));
  const config = eonSite();
  config.tariff.versions.push({ ...config.tariff.versions[0], id: 'accidental-overlap' });
  const ambiguous = eonPlan([], '2026-09-22T10:00:00+01:00', config);
  assert.ok([...ambiguous.signal.import, ...ambiguous.signal.export].every(w => w.price === null));
  assert.match(ambiguous.signal.import[0].sources[0].description, /Overlapping tariff versions/);
});

const { homeEnergyPlanView } = load('src/components/home-energy-plan-view.ts');
const renderPlan = plan => renderToStaticMarkup(createElement(HomeEnergyPlan, { plan }));
const defaultUI = plan => renderPlan(plan).split('<details')[0];

test('homeowner daytime summary shows current import, next guaranteed cheap and independent export', () => {
  const plan = eonPlan([], '2026-09-22T12:00:00+01:00');
  const view = homeEnergyPlanView(plan.signal);
  assert.equal(view.currentImport.price.amount, 0.2518);
  assert.equal(view.currentExport.price.amount, 0.175);
  assert.equal(view.cheap.kind, 'guaranteed-off-peak'); assert.equal(view.cheapNow, false);
  const html = defaultUI(plan);
  for (const text of ['Now', '25.18p/kWh', 'Standard rate', 'Next cheap period', '2.99p/kWh', 'Guaranteed', '17.5p/kWh']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('No planned whole-home cheap opportunities'));
  assert.ok(!html.includes('No cheap period'));
});

test('current guaranteed cheap period says cheap now even with overlapping SMART dispatch', () => {
  const plan = eonPlan([eonDispatch('2026-09-22T01:00:00+01:00', '2026-09-22T05:00:00+01:00')], '2026-09-22T02:15:00+01:00');
  const view = homeEnergyPlanView(plan.signal);
  assert.equal(view.cheapNow, true); assert.equal(view.currentImport.kind, 'guaranteed-off-peak');
  const html = defaultUI(plan).split('Next 24 hours')[0];
  assert.match(html, /Cheap period now/); assert.match(html, /Until/);
  assert.doesNotMatch(html, /Next cheap period|Conditional/);
  assert.match(html, /2.99p\/kWh/);
  assert.equal(view.segments[0].start, '2026-09-22T01:15:00.000Z');
});

test('SMART summary attributes vehicle by name, keeps UUID out of default UI and preserves diagnostics in closed details', () => {
  const snapshot = state([eonDispatch('2026-09-22T12:00:00+01:00', '2026-09-22T14:00:00+01:00')], true);
  snapshot.vehicles[0].id = 'uuid-hidden-from-summary'; snapshot.vehicles[0].name = 'Family car';
  const plan = getSitePriceSignal(eonSite(), snapshot, '2026-09-22T11:00:00+01:00');
  const visible = defaultUI(plan), html = renderPlan(plan);
  assert.match(visible, /Family car/); assert.match(visible, /Smart charge · Conditional/);
  assert.doesNotMatch(visible, /uuid-hidden-from-summary|Source:|planned-conditional|half-hourly/);
  assert.match(html, /<details class=/); assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  const details = html.split('<details')[1];
  for (const text of ['Details', 'uuid-hidden-from-summary', 'Family car', 'Source:', 'Kraken schedule is stale',
    'Original Kraken dispatches', 'Dispatch type: SMART', 'half-hourly', 'planned-conditional']) assert.ok(details.includes(text), text);
  const active = getSitePriceSignal(eonSite(), snapshot, '2026-09-22T12:15:00+01:00');
  assert.match(defaultUI(active), /Possible rate if scheduled charging qualifies/);
});

test('24-hour timeline clips elapsed segments and preserves standard, conditional and guaranteed distinction', () => {
  const plan = eonPlan([eonDispatch('2026-09-22T22:30:00+01:00', '2026-09-23T04:00:00+01:00')], '2026-09-22T21:15:00+01:00');
  const view = homeEnergyPlanView(plan.signal);
  assert.equal(Date.parse(view.end) - Date.parse(view.start), 24 * 3600000);
  assert.deepEqual(plain(view.segments.map(s => s.window.kind)), ['standard', 'cheap-opportunity', 'guaranteed-off-peak', 'standard']);
  assert.ok(Math.abs(view.segments.reduce((sum, s) => sum + s.percent, 0) - 100) < 1e-8);
  assert.equal(view.segments[1].percent, 1.5 / 24 * 100);
  assert.equal(view.segments[2].percent, 6 / 24 * 100);
  assert.equal(view.segments.at(-1).end, view.end);
  assert.match(defaultUI(plan), /aria-label="24-hour import prices"/);
});

test('timeline widths use 24 elapsed hours on both London DST transitions', () => {
  const config = eonSite();
  config.tariff.versions[0].effectiveFrom = '2026-01-01T00:00:00Z';
  config.tariff.versions[0].effectiveTo = '2027-01-01T00:00:00Z';
  for (const [start, expectedHours] of [['2026-03-29T00:00:00Z', 5], ['2026-10-24T23:00:00Z', 7]]) {
    const view = homeEnergyPlanView(eonPlan([], start, config).signal);
    assert.equal(Date.parse(view.end) - Date.parse(view.start), 24 * 3600000);
    assert.equal(view.segments[0].percent, expectedHours / 24 * 100);
    assert.ok(Math.abs(view.segments.reduce((sum, s) => sum + s.percent, 0) - 100) < 1e-8);
  }
});

test('unknown rates and missing coverage remain unknown in presentation, never zero', () => {
  const signal = eonPlan([], '2026-10-01T00:00:00+01:00').signal;
  const view = homeEnergyPlanView(signal);
  assert.equal(view.currentImport.price, null); assert.equal(view.cheap, null);
  const empty = homeEnergyPlanView({ ...signal, import: [], export: [] });
  assert.equal(empty.segments.length, 1); assert.equal(empty.segments[0].percent, 100);
  assert.equal(empty.currentImport, null);
  assert.match(defaultUI(eonPlan([], '2026-10-01T00:00:00+01:00')), /Rate unknown/);
});

test('25 September Q7 UTC dispatches are current at 13:15 BST and remain conditional in the timeline', () => {
  const config = load('src/lib/site/current-site.ts').currentSite;
  const dispatches = [
    { start: '2026-09-25T12:00:00+00:00', end: '2026-09-25T13:30:00+00:00', type: 'SMART' },
    { start: '2026-09-25T13:30:00+00:00', end: '2026-09-25T14:00:00+00:00', type: 'SMART' },
  ];
  const snapshot = state(dispatches); snapshot.vehicles[0].status = { activePower: null };
  const current = '2026-09-25T12:15:00Z';
  const activity = load('src/lib/kraken/vehicle-activity.ts').vehicleActivity;
  assert.equal(activity(snapshot.vehicles[0], current).currentDispatches[0].start, dispatches[0].start);
  assert.equal(activity(snapshot.vehicles[0], current).charging, 'Charging power unavailable');
  assert.equal(activity(snapshot.vehicles[0], dispatches[1].start).currentDispatches.length, 1);
  assert.equal(activity(snapshot.vehicles[0], dispatches[1].end).currentDispatches.length, 0);
  snapshot.vehicles[0].status.activePower = { value: 7 };
  assert.equal(activity(snapshot.vehicles[0], current).charging, '7.0 kW');
  // Page loaded before the window; local clock must select the later interval.
  const plan = getSitePriceSignal(config, snapshot, '2026-09-25T11:00:00Z');
  const view = load('src/components/home-energy-plan-view.ts').homeEnergyPlanView(plan.signal, current);
  assert.equal(view.currentImport.price.amount, 0.0299);
  assert.equal(view.currentImport.condition, 'scheduled-ev-charging');
  assert.ok(view.currentImport.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
  assert.equal(view.segments[0].window.kind, 'cheap-opportunity');
  assert.equal(view.segments[0].start, '2026-09-25T12:15:00.000Z');
  assert.equal(view.segments[0].end, '2026-09-25T14:00:00.000Z');
  const format = load('src/lib/presentation/local-time.ts');
  assert.equal(format.formatLocalTime(dispatches[0].start, 'Europe/London'), '13:00');
  assert.equal(format.formatLocalTime(dispatches[0].end, 'Europe/London'), '14:30');
  assert.equal(format.formatLocalTime(dispatches[1].end, 'Europe/London'), '15:00');
  assert.equal(format.formatLocalDateTime(current, 'Europe/London'), '25 Sep, 13:15 UTC+01:00');
  const html = renderToStaticMarkup(createElement(HomeEnergyPlan, { plan: getSitePriceSignal(config, snapshot, current) }));
  assert.match(html, /2\.99p\/kWh/);
  assert.match(html, /25 Sep, 13:15 UTC\+01:00/);
  assert.match(html, /Smart charge · Conditional/);
});

test('GMT and repeated DST hour use absolute dispatch boundaries and explicit 24-hour London formatting', () => {
  const format = load('src/lib/presentation/local-time.ts');
  assert.equal(format.formatLocalDateTime('2026-10-25T00:30:00Z', 'Europe/London'), '25 Oct, 01:30 UTC+01:00');
  assert.equal(format.formatLocalDateTime('2026-10-25T01:30:00Z', 'Europe/London'), '25 Oct, 01:30 UTC+00:00');
  assert.equal(format.formatLocalTime('2026-12-25T13:00:00Z', 'Europe/London'), '13:00');
  const activity = load('src/lib/kraken/vehicle-activity.ts').vehicleActivity;
  const vehicle = { status: { activePower: null }, plannedDispatches: [{ start: '2026-10-25T00:15:00Z', end: '2026-10-25T01:15:00Z', type: 'SMART' }] };
  assert.equal(activity(vehicle, '2026-10-25T01:00:00Z').currentDispatches.length, 1);
  assert.equal(activity(vehicle, '2026-10-25T01:30:00Z').currentDispatches.length, 0);
});


test('dashboard clock hydrates from server time then advances locally without any network or refresh', () => {
  const initial = '2026-09-25T11:00:00Z';
  let effect, tick, cleanup, latest, interval;
  const hook = load('src/components/use-dashboard-time.ts', { react: {
    useState: value => [value, value => { latest = value; }],
    useEffect: callback => { effect = callback; },
  } }, {
    setInterval: (callback, ms) => { tick = callback; interval = ms; return 123; },
    clearInterval: id => { cleanup = id; },
  });
  assert.equal(hook.useDashboardTime(initial), initial);
  const stop = effect();
  assert.ok(Number.isFinite(Date.parse(latest)));
  assert.equal(interval, 30000);
  tick(); stop(); assert.equal(cleanup, 123);
  const component = fs.readFileSync('src/components/HomeEnergyPlan.tsx', 'utf8');
  assert.match(component, /homeEnergyPlanView\(signal, useDashboardTime\(signal.generatedAt\)\)/);
});
