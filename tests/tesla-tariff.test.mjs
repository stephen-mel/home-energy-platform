import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Load the pure adapter with an allowlist. Any accidental Tesla/network dependency fails.
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
const compare = load('src/lib/tariff/compare-price-signal.ts');
const adapter = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const effective = load('src/lib/tariff/effective-tariff.ts', { './price-signal': curve });
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/price-signal': curve, '../tariff/kraken-dispatches': adapter, '../tariff/effective-tariff': effective,
});
const { dryRunTeslaTariff } = load('src/lib/tesla-tariff/dry-run.ts', { '../tariff/compare-price-signal': compare });
const site = () => load('src/lib/site/current-site.ts').currentSite;
const ds = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
const snapshot = (dispatches = [], stale = false) => ({ stale, lastSuccessfulUpdate: '2026-09-22T00:00:00Z',
  vehicles: [{ id: 'vehicle-a', name: 'Family car', plannedDispatches: dispatches }] });
const plan = (dispatches = [], date = '2026-09-22T00:00:00+01:00', config = site(), stale = false) =>
  getSitePriceSignal(config, snapshot(dispatches, stale), date).signal;
const run = (signal, previousEconomicKey) => dryRunTeslaTariff(signal, { timeZone: 'Europe/London', previousEconomicKey });
const codes = result => result.diagnostics.map(d => d.code);
const assertCoverage = result => {
  assert.equal(result.candidate.periods[0].start, new Date(result.hep.horizon.start).toISOString());
  assert.equal(result.candidate.periods.at(-1).end, new Date(result.hep.horizon.end).toISOString());
  result.candidate.periods.forEach((p, i, all) => {
    assert.ok(Date.parse(p.end) > Date.parse(p.start));
    if (i) assert.equal(all[i - 1].end, p.start);
  });
};

test('standard import 25.18p/export 17.5p are pricing-compatible and serialize without clamping', () => {
  const config = site(); config.tariff.versions[0].dailyImportWindows = [];
  const result = run(plan([], undefined, config));
  assert.equal(result.pricingCompatible, true); assertCoverage(result);
  for (const p of result.candidate.periods) { assert.equal(p.buy.amount, 0.2518); assert.equal(p.sell.amount, 0.175); }
  const fragment = result.candidate.tariffContentV2Fragment;
  assert.equal(fragment.currency, 'GBP'); assert.equal(fragment.version, 1);
  for (const rates of Object.values(fragment.energy_charges)) assert.deepEqual(Object.values(rates.rates), [0.2518]);
  for (const rates of Object.values(fragment.sell_tariff.energy_charges)) assert.deepEqual(Object.values(rates.rates), [0.175]);
  assert.equal(result.writeReady, false); assert.equal(result.writePayload, null);
  assert.ok(codes(result).includes('BOUNDED_FORECAST'));
});

test('guaranteed cheap rates below export are explicitly incompatible and never modified', () => {
  const signal = plan(); const before = JSON.stringify(signal); const result = run(signal);
  assert.equal(result.pricingCompatible, false); assertCoverage(result);
  assert.ok(codes(result).includes('BUY_BELOW_SELL'));
  const cheap = result.candidate.periods.find(p => p.importKind === 'guaranteed-off-peak');
  assert.equal(cheap.buy.amount, 0.0299); assert.equal(cheap.sell.amount, 0.175);
  assert.equal(cheap.condition, 'none');
  assert.equal(JSON.stringify(signal), before);
  assert.ok(JSON.stringify(result.candidate.tariffContentV2Fragment.energy_charges).includes('0.0299'));
});

test('daytime SMART periods appear and preserve conditional evidence without a Tesla guarantee', () => {
  const result = run(plan([ds('2026-09-22T12:00:00+01:00', '2026-09-22T14:00:00+01:00')]));
  const smart = result.candidate.periods.find(p => p.condition === 'scheduled-ev-charging');
  assert.equal(smart.start, '2026-09-22T11:00:00.000Z'); assert.equal(smart.end, '2026-09-22T13:00:00.000Z');
  assert.equal(smart.buy.amount, 0.0299);
  assert.ok(smart.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
  assert.equal(smart.eligibilityPeriods[0].sources[0].cause.assetName, 'Family car');
  assert.ok(codes(result).includes('CONDITIONAL_RATE')); assertCoverage(result);
});

test('moving SMART wholly inside guaranteed overnight requires no economic update; BOOST has no effect', () => {
  const first = run(plan([ds('2026-09-22T01:00:00+01:00', '2026-09-22T02:00:00+01:00')]));
  const moved = run(plan([ds('2026-09-22T03:00:00+01:00', '2026-09-22T05:00:00+01:00')]), first.comparison.economicKey);
  assert.equal(moved.comparison.economicChanged, false);
  assert.equal(JSON.stringify(moved.candidate), JSON.stringify(first.candidate));
  const boosted = run(plan([ds('2026-09-22T12:00:00+01:00', '2026-09-22T14:00:00+01:00', 'BOOST')]), first.comparison.economicKey);
  assert.equal(boosted.comparison.economicChanged, false);
});

test('overlapping SMART/guaranteed periods and midnight yield complete, non-overlapping candidate coverage', () => {
  const result = run(plan([ds('2026-09-22T22:30:00+01:00', '2026-09-23T04:00:00+01:00'),
    ds('2026-09-22T23:00:00+01:00', '2026-09-23T03:00:00+01:00')]));
  assertCoverage(result);
  const conditional = result.candidate.periods.find(p => p.condition === 'scheduled-ev-charging');
  assert.equal(conditional.end, '2026-09-22T23:00:00.000Z');
  const overnight = result.candidate.periods.find(p => p.start === conditional.end);
  assert.equal(overnight.condition, 'none'); assert.equal(overnight.localDate, '2026-09-23');
  assert.equal(overnight.fromMinute, 0); assert.equal(overnight.toMinute, 360);
});

test('London DST retains real elapsed coverage; spring gaps and conflicting repeated minutes are not silently filled', () => {
  const config = site();
  config.tariff.versions[0].effectiveFrom = '2026-01-01T00:00:00Z';
  config.tariff.versions[0].effectiveTo = '2027-01-01T00:00:00Z';
  for (const date of ['2026-03-29T00:00:00Z', '2026-10-24T23:00:00Z']) {
    const result = run(plan([], date, config)); assertCoverage(result);
    assert.ok(new Set(result.candidate.periods.map(p => p.utcOffset)).size > 1);
    if (date.includes('03-29')) assert.ok(codes(result).includes('INCOMPLETE_LOCAL_DAY'));
    else assert.ok(!codes(result).includes('DST_FOLD_CONFLICT'));
  }
  // Synthetic standard-only fixture isolates incompatible repeated local rates.
  config.tariff.versions[0].dailyImportWindows = [];
  const fold = run(plan([ds('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z')], '2026-10-24T23:00:00Z', config));
  assert.ok(codes(fold).includes('DST_FOLD_CONFLICT'));
  assert.equal(fold.candidate.tariffContentV2Fragment, null); assertCoverage(fold);
});

test('deterministic output and comparison ignore metadata freshness but detect moved outside-overnight dispatches', () => {
  const d = ds('2026-09-22T12:00:00+01:00', '2026-09-22T14:00:00+01:00');
  const signal = plan([d]); const a = run(signal);
  assert.equal(JSON.stringify(a), JSON.stringify(run(signal)));
  const stale = plan([d], undefined, undefined, true); stale.generatedAt = '2026-09-22T00:01:00Z';
  const b = run(stale, a.comparison.economicKey);
  assert.equal(b.comparison.economicChanged, false); assert.ok(codes(b).includes('STALE_SOURCE'));
  assert.equal(JSON.stringify(a.candidate.tariffContentV2Fragment), JSON.stringify(b.candidate.tariffContentV2Fragment));
  const c = run(plan([ds('2026-09-22T13:00:00+01:00', '2026-09-22T15:00:00+01:00')]), a.comparison.economicKey);
  assert.equal(c.comparison.economicChanged, true);
  assert.equal(a.comparison.economicChanged, null);
});

test('unknown October, incomplete curves, negative values, sub-minute boundaries and invalid timezone are diagnosed', () => {
  const unknown = run(plan([], '2026-10-01T00:00:00+01:00'));
  assert.ok(codes(unknown).includes('UNKNOWN_PRICE')); assert.equal(unknown.candidate.tariffContentV2Fragment, null);
  const incomplete = plan(); incomplete.export = [];
  assert.ok(codes(run(incomplete)).includes('INVALID_COVERAGE'));
  const overlap = plan(); overlap.import.push({ ...overlap.import[0] });
  assert.ok(codes(run(overlap)).includes('INVALID_COVERAGE'));
  const subminute = run(plan([], '2026-09-22T12:00:01Z'));
  assert.ok(codes(subminute).includes('SUB_MINUTE_BOUNDARY')); assert.equal(subminute.candidate.tariffContentV2Fragment, null);
  const negative = plan(); negative.import[0].price = { amount: -0.01, currency: 'GBP', unit: 'kWh' };
  assert.ok(codes(run(negative)).includes('NEGATIVE_PRICE'));
  assert.equal(run(negative).candidate.periods[0].buy.amount, -0.01);
  assert.ok(codes(dryRunTeslaTariff(plan(), { timeZone: 'invalid/zone' })).includes('INVALID_TIMEZONE'));
});
