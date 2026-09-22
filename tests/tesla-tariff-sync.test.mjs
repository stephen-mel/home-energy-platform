import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Only pure imports are allowed. No client, OAuth, filesystem, fetch, timers or clock.
class InputDate extends Date {
  constructor(...args) { assert.ok(args.length, 'Planner must not read the wall clock'); super(...args); }
  static now() { throw new Error('Planner must not read the wall clock'); }
}
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date: InputDate, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  return exports;
}
const curve = load('src/lib/tariff/price-signal.ts');
const comparison = load('src/lib/tariff/compare-price-signal.ts');
const kraken = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const effective = load('src/lib/tariff/effective-tariff.ts', { './price-signal': curve });
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/price-signal': curve, '../tariff/kraken-dispatches': kraken, '../tariff/effective-tariff': effective,
});
const dryRun = load('src/lib/tesla-tariff/dry-run.ts', { '../tariff/compare-price-signal': comparison });
const { planTeslaTariffSync, decideSyncStatus } = load('src/lib/tesla-tariff/sync-planner.ts', {
  '../tariff/compare-price-signal': comparison, './dry-run': dryRun,
});
const date = time => `2026-09-22T${time}:00+01:00`;
const ds = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
function signal(dispatches = []) {
  const { currentSite } = load('src/lib/site/current-site.ts');
  return getSitePriceSignal(currentSite, { stale: false, lastSuccessfulUpdate: date('00:00'),
    vehicles: [{ id: 'ev', name: 'Family car', plannedDispatches: dispatches }] }, date('00:00')).signal;
}
const plan = (current, previous) => planTeslaTariffSync({ signal: current, previousSignal: previous, timeZone: 'Europe/London' });
const plain = value => JSON.parse(JSON.stringify(value));
const codes = result => result.compatibility.blockers.map(d => d.code);

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('identical HEP curves need no update without concealing existing compatibility blockers', () => {
  const current = signal(); const result = plan(current, structuredClone(current));
  assert.equal(result.status, 'no-update');
  assert.equal(result.comparison.state, 'unchanged');
  assert.deepEqual(plain(result.comparison.changedPeriods), []);
  assert.equal(result.comparison.economicKey, comparison.effectivePriceCurveKey(current));
  assert.equal(result.compatibility.representable, false);
  assert.ok(codes(result).includes('BUY_BELOW_SELL'));
  assert.ok(codes(result).includes('BOUNDED_FORECAST'));
});

test('freshness, provenance and generation timestamps alone never request an update', () => {
  const before = signal([ds(date('22:30'), '2026-09-23T00:00:00+01:00')]);
  const after = structuredClone(before); after.generatedAt = date('00:05');
  for (const w of [...after.import, ...after.export]) {
    w.stale = true;
    for (const source of w.sources) { source.stale = true; source.observedAt = date('00:03'); source.description = 'Changed metadata'; }
    w.sources.reverse();
  }
  const result = plan(after, before);
  assert.equal(result.status, 'no-update');
  assert.ok(result.compatibility.warnings.some(d => d.code === 'STALE_SOURCE'));
  assert.ok(result.compatibility.warnings.some(d => d.code === 'CONDITIONAL_RATE'));
});

test('SMART moving wholly inside guaranteed overnight and BOOST changes need no update', () => {
  const before = signal([ds(date('01:00'), date('02:00'))]);
  for (const after of [signal([ds(date('03:00'), date('05:00'))]), signal([ds(date('22:30'), date('23:30'), 'BOOST')])]) {
    assert.equal(plan(after, before).status, 'no-update');
  }
});

test('SMART 22:30–midnight identifies the exact changed import interval and preserves planned evidence', () => {
  const before = signal(); const after = signal([ds(date('22:30'), '2026-09-23T00:00:00+01:00')]);
  const result = plan(after, before);
  assert.equal(result.comparison.state, 'changed');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(plain(result.comparison.changedPeriods), [{
    start: '2026-09-22T21:30:00.000Z', end: '2026-09-22T23:00:00.000Z', channels: ['import'],
  }]);
  const conditional = result.candidate.periods.find(p => p.condition === 'scheduled-ev-charging');
  assert.ok(conditional.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
  assert.equal(conditional.eligibilityPeriods[0].sources[0].cause.assetName, 'Family car');
});

test('decision contract: representable change requires update, every blocking diagnostic prevents it', () => {
  // Synthetic blocker-free evidence tests the future contract only. The real adapter
  // always emits BOUNDED_FORECAST, so no real v1 plan is asserted representable.
  assert.equal(decideSyncStatus('changed', []), 'update-required');
  assert.equal(decideSyncStatus('unestablished', []), 'update-required');
  assert.equal(decideSyncStatus('unchanged', []), 'no-update');
  for (const code of ['BOUNDED_FORECAST', 'BUY_BELOW_SELL', 'FUTURE_UNKNOWN_BLOCKER']) {
    assert.equal(decideSyncStatus('changed', [{ code, severity: 'error', message: 'Fixture' }]), 'blocked');
  }
});

test('2.99p buy / 17.5p sell blocks changed economics without mutating either price', () => {
  const before = signal(); const after = freeze(signal([ds(date('22:30'), date('23:30'))]));
  const original = JSON.stringify(after); const result = plan(after, before);
  assert.equal(result.status, 'blocked');
  assert.equal(result.compatibility.pricingCompatible, false);
  assert.ok(codes(result).includes('BUY_BELOW_SELL'));
  const cheap = result.candidate.periods.find(p => p.condition === 'scheduled-ev-charging');
  assert.equal(cheap.buy.amount, 0.0299); assert.equal(cheap.sell.amount, 0.175);
  assert.equal(JSON.stringify(after), original);
  assert.equal(result.hep, after);
  assert.ok(JSON.stringify(result.candidate.tariffContentV2Fragment).includes('0.0299'));
});

test('pricing-compatible changed curves still retain the bounded forecast blocker', () => {
  const before = signal(), after = structuredClone(before);
  for (const w of before.export) w.price.amount = 0.01;
  for (const w of after.export) w.price.amount = 0.02;
  const result = plan(after, before);
  assert.equal(result.compatibility.pricingCompatible, true);
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('BOUNDED_FORECAST'));
  assert.ok(result.comparison.changedPeriods.every(p => p.channels.join() === 'export'));
});

test('incomplete coverage and unknown prices keep original adapter diagnostics', () => {
  const before = signal();
  for (const [change, expected] of [
    [s => { s.export = []; }, 'INVALID_COVERAGE'],
    [s => { s.import[0].price = null; s.import[0].priceStatus = 'unknown'; }, 'UNKNOWN_PRICE'],
  ]) {
    const after = structuredClone(before); change(after);
    const result = plan(after, before);
    assert.equal(result.status, 'blocked'); assert.ok(codes(result).includes(expected));
    const original = dryRun.dryRunTeslaTariff(after, { timeZone: 'Europe/London' });
    assert.deepEqual(plain(result.compatibility.blockers), plain(original.diagnostics.filter(d => d.severity === 'error')));
  }
});

test('missing/invalid baseline does not invent unchanged status; changed horizon is explicit', () => {
  const current = signal();
  const first = plan(current);
  assert.equal(first.status, 'blocked'); assert.equal(first.comparison.state, 'unestablished');
  assert.equal(first.comparison.changedPeriods, null);
  assert.ok(first.reasons.some(r => r.code === 'BASELINE_MISSING'));
  const invalid = structuredClone(current); invalid.export = [];
  const result = plan(current, invalid);
  assert.equal(result.comparison.state, 'unestablished');
  assert.ok(result.reasons.some(r => r.code === 'BASELINE_INVALID'));
  const shifted = structuredClone(current);
  shifted.horizon.start = new Date(Date.parse(current.horizon.start) + 3600_000).toISOString();
  for (const side of ['import', 'export']) shifted[side][0].start = shifted.horizon.start;
  const moved = plan(shifted, current);
  assert.equal(moved.comparison.state, 'changed');
  assert.ok(moved.limitations.some(l => l.code === 'HORIZON_CHANGED'));
  assert.deepEqual(plain(moved.comparison.changedPeriods), [{
    start: '2026-09-21T23:00:00.000Z', end: '2026-09-22T00:00:00.000Z', channels: ['import', 'export'],
  }]);
});

test('deterministic pure planner never produces an executable write or command', () => {
  const current = freeze(signal([ds(date('22:30'), date('23:30'))]));
  const before = freeze(signal());
  const first = plan(current, before);
  assert.equal(JSON.stringify(first), JSON.stringify(plan(current, before)));
  for (const result of [first, plan(before, before), plan(current)]) {
    assert.equal(result.inspectionOnly, true); assert.equal(result.writeReady, false); assert.equal(result.writePayload, null);
    assert.equal('command' in result, false); assert.equal('endpoint' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /energy_cmds|access_token|\/api\/1\//);
  }
});
