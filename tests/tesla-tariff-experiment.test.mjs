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
const tariffTools = load('src/lib/tesla-tariff/experiment-tariff.ts');
const harness = load('src/lib/tesla-tariff/experiment.ts', {
  '../tariff/compare-price-signal': comparison, './experiment-tariff': tariffTools,
});
const date = time => `2026-09-22T${time}:00+01:00`;
const ds = (start, end, type = 'SMART') => ({ start, end, type, energyAddedKwh: null });
function signal(dispatches = []) {
  const { currentSite } = load('src/lib/site/current-site.ts');
  return getSitePriceSignal(currentSite, { stale: false, lastSuccessfulUpdate: date('00:00'),
    vehicles: [{ id: 'ev', name: 'Family car', plannedDispatches: dispatches }] }, date('00:00')).signal;
}
const plain = x => JSON.parse(JSON.stringify(x));
const tariff = (buy = 0.2518, sell = 0.175) => {
  const t = tariffTools.experimentTariff();
  t.energy_charges.Annual.rates.TEST = buy;
  t.sell_tariff.energy_charges.Annual.rates.TEST = sell;
  return t;
};
const capture = (value = tariff(), format = 'tariff-content-v2', capturedAt = date('21:00')) => ({
  energySiteId: '12345', capturedAt, format, value,
});
const prepare = (options = {}) => harness.prepareTariffExperiment({ experimentId: 'price-test-v1', asOf: date('21:05'),
  timeZone: 'Europe/London', before: capture(), signal: signal([ds(date('22:30'), '2026-09-23T04:00:00+01:00')]), ...options });
const compare = (value, options = {}) => harness.compareTariffExperiment({ before: capture(), intended: tariffTools.experimentTariff(),
  readBack: value === null ? null : capture(value, 'tariff-content-v2', date('21:10')), ...options });

test('intended test preserves exactly 2.99p buy / 17.5p sell without changing HEP truth', () => {
  const original = signal(); const before = JSON.stringify(original);
  const result = prepare({ signal: original });
  assert.equal(result.intended.buy.amount, 0.0299); assert.equal(result.intended.sell.amount, 0.175);
  assert.equal(result.intended.tariffContentV2.energy_charges.Annual.rates.TEST, 0.0299);
  assert.equal(result.intended.tariffContentV2.sell_tariff.energy_charges.Annual.rates.TEST, 0.175);
  assert.equal(result.hepContext.signal.import.find(w => w.kind === 'standard').price.amount, 0.2518);
  assert.equal(JSON.stringify(original), before);
  assert.ok(result.warnings.some(d => d.code === 'BUY_BELOW_SELL_EXPERIMENT'));
});

test('complete exact setting-content capture permits human review and round-trips exact rollback', () => {
  const original = tariff(); const result = prepare({ before: capture(original) });
  assert.equal(result.state, 'ready-for-human-approval'); assert.equal(result.blockers.length, 0);
  assert.deepEqual(plain(result.rollback.tariffContentV2), plain(original));
  assert.deepEqual(plain(result.before.originalTariffSnapshot), plain(original));
  assert.notEqual(result.rollback.tariffContentV2, original);
  assert.equal(result.rollback.proof, 'validated-exact-setting-content');
  assert.equal(result.writeReady, false); assert.equal(result.writePayload, null);
});

test('site_info alone never proves an exact inverse mapping; pricing flag cannot override it', () => {
  for (const flag of [true, false]) {
    const result = prepare({ before: capture({ response: { tariff_content_v2: tariff(), rate_plan_manager_no_pricing_constraint: flag } }, 'site-info') });
    assert.equal(result.state, 'blocked'); assert.equal(result.rollback.tariffContentV2, null);
    assert.equal(result.before.noPricingConstraintFlag, flag);
    assert.ok(result.blockers.some(d => d.code === 'ROLLBACK_UNPROVEN'));
  }
});

test('missing fields, unsupported fields, currency, annual gaps and minute overlaps block rollback', () => {
  const changes = [
    t => { delete t.sell_tariff; },
    t => { t.demand_charges = {}; },
    t => { t.currency = 'USD'; },
    t => { t.seasons.Annual.toMonth = 9; },
    t => { t.seasons.Annual.tou_periods.TEST.periods[0].fromHour = 1; },
    t => { t.seasons.Annual.tou_periods.TEST.periods.push({ ...t.seasons.Annual.tou_periods.TEST.periods[0] }); },
    t => { t.energy_charges.Annual.rates.EXTRA = 1; },
    t => { t.seasons.Annual.tou_periods.TEST.periods[0].fromMinute = 0.5; },
    t => { t.seasons.Annual.fromMonth = 13; },
  ];
  for (const change of changes) {
    const t = tariff(); change(t); const result = prepare({ before: capture(t) });
    assert.equal(result.state, 'blocked'); assert.equal(result.rollback.tariffContentV2, null);
  }
  assert.equal(prepare({ before: capture(null) }).state, 'blocked');
});

test('supported multi-rate complete tariff is preserved exactly for rollback', () => {
  const t = tariff();
  const period = t.seasons.Annual.tou_periods.TEST.periods[0];
  period.toHour = 6;
  t.seasons.Annual.tou_periods.DAY = { periods: [{ ...period, fromHour: 6, toHour: 0 }] };
  t.energy_charges.Annual.rates.DAY = 0.3;
  const result = prepare({ before: capture(t) });
  assert.equal(result.state, 'ready-for-human-approval');
  assert.deepEqual(plain(result.rollback.tariffContentV2), plain(t));
});

test('read-back classifications preserve, raise buy to sell, or report other transformations', () => {
  assert.equal(compare(tariff(0.0299, 0.175)).outcome, 'preserved');
  assert.equal(compare(tariff(0.175, 0.175)).outcome, 'buy-raised-to-sell');
  for (const [buy, sell] of [[0.2, 0.175], [0.0299, 0.0299], [0.2518, 0.175]]) {
    assert.equal(compare(tariff(buy, sell)).outcome, 'different');
  }
  const result = compare(tariff(0.175, 0.175));
  assert.equal(result.writeAcceptance, 'not-established'); assert.equal(result.causation, 'not-inferred');
});

test('missing, ambiguous, wrong-site, out-of-order and incomplete observations are insufficient', () => {
  assert.equal(compare(null).outcome, 'unreadable/insufficient');
  assert.equal(compare({}).outcome, 'unreadable/insufficient');
  const complete = tariff(0.0299, 0.175);
  for (const readBack of [
    { ...capture(complete, 'tariff-content-v2', date('21:10')), energySiteId: 'other-site' },
    capture(complete, 'tariff-content-v2', date('20:00')),
    capture({ response: { tariff_content: complete, tariff_content_v2: complete } }, 'site-info', date('21:10')),
  ]) assert.equal(compare(complete, { readBack }).outcome, 'unreadable/insufficient');
  assert.equal(compare(complete, { intended: {} }).outcome, 'unreadable/insufficient');
});

test('recognized site_info read-back can be observed without assuming rollback or flag causation', () => {
  const result = compare(null, { readBack: capture({ response: { tariff_content_v2: tariff(0.0299, 0.175),
    rate_plan_manager_no_pricing_constraint: true } }, 'site-info', date('21:10')) });
  assert.equal(result.outcome, 'preserved'); assert.equal(result.readBack.exactRollbackTariff, null);
  assert.equal(result.causation, 'not-inferred');
});

test('SMART conditions, exact vehicle dispatch and half-hour states remain separate from guaranteed rate', () => {
  const result = prepare();
  const smart = result.hepContext.smartPeriods[0];
  assert.equal(smart.start, '2026-09-22T21:30:00.000Z'); assert.equal(smart.end, '2026-09-22T23:00:00.000Z');
  assert.ok(smart.eligibilityPeriods.every(p => p.state === 'planned-conditional'));
  assert.equal(smart.sources.find(s => s.cause).cause.end, '2026-09-23T04:00:00+01:00');
  assert.ok(result.hepContext.guaranteedPeriods.every(w => w.condition === 'none' && !w.eligibilityPeriods.length));
  for (const state of ['observed-qualified', 'billed-verified']) {
    const s = signal([ds(date('22:30'), date('23:30'))]);
    for (const w of s.import) for (const p of w.eligibilityPeriods) p.state = state;
    assert.ok(prepare({ signal: s }).hepContext.smartPeriods[0].eligibilityPeriods.every(p => p.state === state));
  }
});

test('auth envelopes and unknown fields are never serialized; omission cannot prove rollback', () => {
  const t = tariff(); t.access_token = 'DO_NOT_SERIALIZE_A';
  t.sell_tariff.private_key = 'DO_NOT_SERIALIZE_B';
  t.energy_charges.Annual.rates.refresh_token = 1234567;
  const s = signal(); s.credentials = { password: 'DO_NOT_SERIALIZE_C' };
  s.import[0].sources[0].authorization = 'DO_NOT_SERIALIZE_D';
  const result = prepare({ before: capture(t), signal: s });
  assert.equal(result.state, 'blocked');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_SERIALIZE|access_token|refresh_token|private_key|1234567/);
  const fromEnvelope = prepare({ before: capture({ access_token: 'DO_NOT_SERIALIZE_A', response: {
    tariff_content_v2: tariff(), refresh_token: 'DO_NOT_SERIALIZE_B' } }, 'site-info') });
  assert.doesNotMatch(JSON.stringify(fromEnvelope), /DO_NOT_SERIALIZE|access_token|refresh_token/);
});

test('explicit invalid identity/time blocks; records have placeholders and are deterministic without I/O', () => {
  const a = prepare(), b = prepare();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(plain(a.later), { readBack: null, comparison: null, rollbackReadBack: null, rollbackVerification: null });
  assert.equal(a.inspectionOnly, true); assert.equal(a.writeReady, false);
  assert.ok(!('command' in a)); assert.ok(!('endpoint' in a));
  assert.equal(prepare({ asOf: 'yesterday' }).state, 'blocked');
  assert.equal(prepare({ timeZone: 'invalid/zone' }).state, 'blocked');
  assert.equal(prepare({ before: capture(tariff(), 'tariff-content-v2', date('22:00')) }).state, 'blocked');
  assert.equal(prepare({ experimentId: 'Bearer credential' }).experimentId, null);
});

test('embedded site_info identity must agree with the attributed experiment site', () => {
  const body = { response: { energy_site_id: 'different-site', tariff_content_v2: tariff(0.0299, 0.175) } };
  assert.equal(compare(null, { readBack: capture(body, 'site-info', date('21:10')) }).outcome, 'unreadable/insufficient');
  assert.ok(prepare({ before: capture(body, 'site-info') }).blockers.some(d => d.code === 'SITE_IDENTITY_MISMATCH'));
});
