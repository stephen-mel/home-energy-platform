import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, structuredClone, Response, ...globals,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  return exports;
}
const observed = load('src/lib/tesla-tariff/observed-tariff.ts');
const simulation = load('src/lib/tesla-tariff/observed-simulation.ts', { './observed-tariff': observed });
const plain = x => JSON.parse(JSON.stringify(x));
// Mirrors the relevant live 22 September 2026 tariff fields, with a fictitious site
// reference and no credentials/account metadata. Labels intentionally lag the date.
function fixture() {
  const ranges = { Yesterday: [9, 20, 9, 20], Today: [9, 21, 9, 21], Tomorrow: [9, 22, 9, 22], TwoDays: [9, 23, 9, 23], ThreeDays: [9, 24, 9, 19] };
  const side = sell => ({ code: 'FLATPEAK', name: sell ? 'Premium export' : 'Next Drive Smart V5.2', utility: sell ? 'EON Next' : 'Eon Next', currency: 'GBP',
    demand_charges: { ALL: { rates: { ALL: 0 } }, ...Object.fromEntries(Object.keys(ranges).map(k => [k, {}])) },
    energy_charges: Object.fromEntries(Object.keys(ranges).map(k => [k, { rates: sell ? { hour_0_minute_0: 0.17 } : { hour_0_minute_0: 0.02993, hour_6_minute_0: 0.25177 } }])),
    seasons: Object.fromEntries(Object.entries(ranges).map(([k, [fromMonth, fromDay, toMonth, toDay]]) => [k, { fromMonth, fromDay, toMonth, toDay,
      tou_periods: sell ? { hour_0_minute_0: { periods: [{ toDayOfWeek: 6 }] } }
        : { hour_0_minute_0: { periods: [{ toDayOfWeek: 6, toHour: 6 }] }, hour_6_minute_0: { periods: [{ toDayOfWeek: 6, fromHour: 6 }] } } }])) });
  return { response: { installation_time_zone: 'Europe/London', tariff_content_v2: { ...side(false), sell_tariff: side(true), version: 1 } } };
}
const capture = (raw = fixture()) => observed.captureObservedTariff(raw, 'fixture-site', '2026-09-22T12:00:00Z');
const simulate = (date = '2026-09-22', o = capture()) => simulation.simulateObservedSmartDate(o, {
  date, fromMinute: 1320, toMinute: 1440, buy: 0.0299, currency: 'GBP',
  compareDates: ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2027-09-22'],
});

test('captures exact sparse observed tariff, independent identities/currencies/rates and timezone, never rollback proof', () => {
  const raw = fixture(), o = capture(raw);
  assert.deepEqual(plain(o.tariff), raw.response.tariff_content_v2);
  assert.equal(o.source.timeZone, 'Europe/London'); assert.equal(o.rollbackProven, false);
  assert.ok(o.diagnostics.includes('SPARSE_TOU_ZERO_DEFAULT_ASSUMPTION'));
  assert.equal('fromHour' in o.tariff.seasons.Today.tou_periods.hour_0_minute_0.periods[0], false);
  assert.equal(o.tariff.sell_tariff.energy_charges.Today.rates.hour_0_minute_0, 0.17);
  const site = load('src/lib/site/current-site.ts').currentSite;
  assert.equal(site.tariff.versions[0].export.amount, 0.175);
  assert.equal(site.tariff.versions[0].dailyImportWindows[0].price.amount, 0.0299);
});

test('labels have no relative-day semantics and wrapping season spans year-end without gaps', () => {
  const o = capture();
  const result = observed.analyseObservedDates(o, ['2026-09-21', '2026-09-22', '2026-09-24', '2026-12-31', '2027-01-01', '2027-09-19']);
  assert.deepEqual(Array.from(result.days, d => d.periods[0].buySeason), ['Today', 'Tomorrow', 'ThreeDays', 'ThreeDays', 'ThreeDays', 'ThreeDays']);
  assert.ok(result.days.every(d => d.elapsedMinutes === 1440 && d.periods.length === 2));
  assert.deepEqual(Array.from(result.days[0].periods, p => [p.fromMinute, p.toMinute, p.buy, p.sell]), [[0, 360, 0.02993, 0.17], [360, 1440, 0.25177, 0.17]]);
  assert.deepEqual(plain(simulation.observedCoverage(o.tariff)), []);
  assert.ok(result.diagnostics.includes('BUY_BELOW_SELL'));
});

test('season and TOU gaps/overlaps remain explicit, with no guessed price or silent priority', () => {
  for (const [mutate, code] of [
    [t => { delete t.seasons.Tomorrow; }, 'SEASON_GAP'],
    [t => { t.seasons.Copy = structuredClone(t.seasons.Tomorrow); }, 'SEASON_OVERLAP'],
    [t => { t.seasons.Tomorrow.tou_periods.hour_6_minute_0.periods[0].fromHour = 7; }, 'TOU_GAP'],
    [t => { t.seasons.Tomorrow.tou_periods.hour_6_minute_0.periods[0].fromHour = 5; }, 'TOU_OVERLAP'],
  ]) {
    const o = capture(); mutate(o.tariff);
    const result = observed.analyseObservedDates(o, ['2026-09-22']);
    assert.ok(result.diagnostics.includes(code));
    assert.ok(result.days[0].periods.some(p => p.buy === null));
    assert.equal(simulate('2026-09-22', o).status, 'blocked');
  }
});

test('explicit London dates expand to 23/25 elapsed hours and keep repeated clock intervals distinct', () => {
  const r = observed.analyseObservedDates(capture(), ['2026-03-29', '2026-10-25', '2026-02-30']);
  assert.deepEqual(Array.from(r.days, d => d.elapsedMinutes), [1380, 1500]);
  assert.ok(r.days.every(d => new Set(d.periods.map(p => p.offsetMinutes)).size === 2));
  for (const day of r.days) for (let i = 1; i < day.periods.length; i++) assert.equal(day.periods[i - 1].end, day.periods[i].start);
  assert.ok(r.diagnostics.includes('INVALID_CALENDAR_DATE'));
});

test('one-month/day SMART simulation changes only 22:00–midnight, keeps surrounding dates and export intact', () => {
  const o = capture(), before = JSON.stringify(o), result = simulate('2026-09-22', o);
  assert.equal(result.status, 'simulation-only'); assert.equal(result.writeReady, false);
  assert.equal(JSON.stringify(o), before);
  assert.deepEqual(plain(result.simulated.tariff.sell_tariff), plain(o.tariff.sell_tariff));
  assert.deepEqual(plain(simulation.observedCoverage(result.simulated.tariff)), []);
  assert.deepEqual(Array.from(result.differences, p => [p.date, p.fromMinute, p.toMinute, p.oldBuy, p.newBuy, p.oldSell, p.newSell]), [
    ['2026-09-22', 1320, 1440, 0.25177, 0.0299, 0.17, 0.17],
    ['2027-09-22', 1320, 1440, 0.25177, 0.0299, 0.17, 0.17],
  ]);
  assert.equal(result.differences[0].start, '2026-09-22T21:00:00.000Z');
  assert.equal(result.differences[0].end, '2026-09-22T23:00:00.000Z');
  assert.equal(result.simulated.source.kind, 'simulation');
  assert.equal(result.simulated.rollbackProven, false);
});

test('isolating a date inside the wrapping season preserves full annual calendar coverage', () => {
  const result = simulate('2026-12-31');
  assert.equal(result.status, 'simulation-only');
  assert.deepEqual(plain(simulation.observedCoverage(result.simulated.tariff)), []);
  assert.equal(result.differences.length, 1); assert.equal(result.differences[0].date, '2026-12-31');
  const a = observed.analyseObservedDates(result.simulated, ['2026-12-30', '2027-01-01']);
  assert.ok(a.days.every(d => d.periods.at(-1).buy === 0.25177));
});

test('safe capture excludes auth envelopes and unsupported fields, and blocks incomplete simulation', () => {
  const raw = fixture(); raw.access_token = 'SECRET_VALUE'; raw.response.refresh_token = 'SECRET_VALUE';
  raw.response.tariff_content_v2.private_key = 'SECRET_VALUE';
  const o = capture(raw);
  assert.doesNotMatch(JSON.stringify(o), /SECRET_VALUE|private_key|access_token|refresh_token/);
  assert.ok(o.diagnostics.includes('UNSUPPORTED_FIELDS_OMITTED'));
  assert.equal(simulate('2026-09-22', o).status, 'blocked');
  assert.equal(capture({ response: {} }).tariff, null);
});

test('existing site-info endpoint derives observation from the same GET result with no extra calls', async () => {
  let products = 0, reads = 0;
  const route = load('src/app/api/tesla-test/route.ts', {
    '../../../lib/tesla-tariff/observed-tariff': observed,
    '../../../lib/tesla/client': {
      getTeslaProducts: async () => { products++; return { response: [{ energy_site_id: 123 }] }; },
      getTeslaSiteInfo: async id => { assert.equal(id, 123); reads++; return fixture(); },
    },
  });
  const response = await route.GET(); const body = await response.json();
  assert.equal(products, 1); assert.equal(reads, 1);
  assert.equal(body.observedTariff.tariff.name, 'Next Drive Smart V5.2');
});

test('DST-date simulation and repeated identical inputs preserve deterministic elapsed-time differences', () => {
  const first = simulate('2026-10-25'), second = simulate('2026-10-25');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'simulation-only');
  assert.equal(first.differences[0].start, '2026-10-25T22:00:00.000Z');
  assert.equal(first.differences[0].end, '2026-10-26T00:00:00.000Z');
  assert.equal(first.after.days.find(d => d.date === '2026-10-25').elapsedMinutes, 1500);
});

test('nonzero demand charges are preserved in capture but block energy-only simulation', () => {
  const raw = fixture(); raw.response.tariff_content_v2.demand_charges.ALL.rates.ALL = 1;
  const o = capture(raw);
  assert.equal(o.tariff.demand_charges.ALL.rates.ALL, 1);
  const result = simulate('2026-09-22', o);
  assert.equal(result.status, 'blocked'); assert.ok(result.blockers.includes('NONZERO_DEMAND_CHARGES_UNSUPPORTED'));
});
