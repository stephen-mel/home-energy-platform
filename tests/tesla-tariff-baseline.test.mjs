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
const effective = load('src/lib/tariff/effective-tariff.ts', { './price-signal': curve });
const dryRun = load('src/lib/tesla-tariff/dry-run.ts', { '../tariff/compare-price-signal': comparison });
const baseline = load('src/lib/tesla-tariff/baseline.ts', {
  '../tariff/effective-tariff': effective, '../tariff/price-signal': curve,
  '../tariff/compare-price-signal': comparison, './dry-run': dryRun,
});
const config = () => load('src/lib/site/current-site.ts').currentSite.tariff;
const create = (options = {}) => baseline.createTariffBaseline({ baselineId: 'baseline-1', sourceReference: 'current-site',
  asOf: '2026-09-22T12:00:00Z', tariff: config(),
  horizon: { start: '2026-09-21T23:00:00Z', end: '2026-09-22T23:00:00Z' }, ...options });
const verify = record => baseline.verifyTariffBaseline(record, { fingerprint: record.fingerprint,
  verifiedAt: '2026-09-22T13:00:00Z', verifierReference: 'homeowner-1' });
const plain = x => JSON.parse(JSON.stringify(x));

test('baseline and review derive 2.99p / 25.18p / 17.5p from effective-dated HEP config', () => {
  const r = create();
  assert.equal(r.state, 'requires-human-verification');
  assert.deepEqual(plain(r.review.periods.map(p => [p.fromMinute, p.toMinute, p.importPrice.amount, p.exportEconomicValue.amount])),
    [[0, 360, 0.0299, 0.175], [360, 1440, 0.2518, 0.175]]);
  const changed = config(); changed.versions[0].normalImport.amount = 0.31;
  changed.versions[0].dailyImportWindows[0].price.amount = 0.04; changed.versions[0].export.amount = 0.16;
  const updated = create({ tariff: changed });
  assert.deepEqual(plain(updated.review.periods.map(p => [p.importPrice.amount, p.exportEconomicValue.amount])), [[0.04, 0.16], [0.31, 0.16]]);
  assert.equal(r.effectivePeriod.end, '2026-09-30T23:00:00.000Z');
});

test('standing charge is absent from the marginal curve and does not change the key', () => {
  const r = create(), tariff = config(); tariff.versions[0].standingCharge.amount = 5;
  assert.equal(create({ tariff }).fingerprint, r.fingerprint);
  assert.doesNotMatch(JSON.stringify(r.proposed), /standingCharge/);
});

test('truth and proposed cheap/export values stay unchanged; compatibility blockers survive human review', () => {
  const r = verify(create());
  assert.equal(r.truth.import[0].price.amount, 0.0299);
  assert.equal(r.proposed.periods[0].buy.amount, 0.0299); assert.equal(r.proposed.periods[0].sell.amount, 0.175);
  assert.ok(r.compatibilityBlockers.some(d => d.code === 'BUY_BELOW_SELL'));
  assert.ok(r.compatibilityBlockers.some(d => d.code === 'BOUNDED_FORECAST'));
  assert.equal(r.state, 'human-verified'); assert.equal(r.writeReady, false); assert.equal(r.observedTeslaState, null);
});

test('no automatic verification; explicit exact fingerprint, time and safe audit reference required', () => {
  const r = create(); assert.equal(r.verification, null); assert.equal(baseline.isBaselineHumanVerified(r), false);
  assert.throws(() => baseline.verifyTariffBaseline(r, { fingerprint: 'another', verifiedAt: r.asOf }));
  assert.throws(() => baseline.verifyTariffBaseline(r, { fingerprint: r.fingerprint, verifiedAt: 'yesterday' }));
  assert.throws(() => baseline.verifyTariffBaseline(r, { fingerprint: r.fingerprint, verifiedAt: '2026-09-21T00:00:00Z' }));
  const checked = verify(r);
  assert.equal(baseline.isBaselineHumanVerified(checked), true); assert.equal(r.verification, null);
  assert.equal(checked.verification.fingerprint, r.fingerprint);
  assert.equal(checked.verification.verifiedAt, '2026-09-22T13:00:00.000Z');
});

test('price, schedule, timezone, version and validity changes invalidate prior confirmation', () => {
  const old = verify(create());
  for (const change of [
    t => { t.versions[0].normalImport.amount += 0.01; },
    t => { t.versions[0].export.amount += 0.01; },
    t => { t.versions[0].dailyImportWindows[0].end = '05:00'; },
    t => { t.timeZone = 'UTC'; },
    t => { t.versions[0].id = 'new-version'; },
    t => { t.versions[0].effectiveTo = '2026-09-29T23:00:00Z'; },
  ]) {
    const tariff = config(); change(tariff); const updated = create({ tariff });
    assert.notEqual(updated.fingerprint, old.fingerprint);
    assert.throws(() => baseline.verifyTariffBaseline(updated, old.verification));
    assert.equal(baseline.isBaselineHumanVerified({ ...updated, state: 'human-verified', verification: old.verification }), false);
  }
  const tampered = structuredClone(old); tampered.proposed.periods[0].buy.amount = 0.175;
  assert.equal(baseline.isBaselineHumanVerified(tampered), false);
});

test('generation timestamp, baseline/audit identity and authority do not change representation key', () => {
  const old = create(); const newRecord = create({ asOf: '2026-09-22T12:05:00Z', baselineId: 'baseline-2', sourceReference: 'another-reference', authority: 'observe' });
  assert.equal(old.fingerprint, newRecord.fingerprint);
});

test('human verification does not turn baseline into experiment rollback proof', () => {
  const unknown = baseline.baselineExperimentContext();
  assert.equal(unknown.kind, 'unknown-tesla-configuration');
  const context = baseline.baselineExperimentContext(verify(create()));
  assert.equal(context.kind, 'hep-human-verified-baseline');
  assert.equal(context.rollbackProven, false); assert.equal(context.rollbackRepresentation, null);
  assert.equal(context.blockers[0].code, 'ROLLBACK_UNPROVEN');
  assert.deepEqual(plain(context.requiredFutureEvidence), ['explicit-write', 'tesla-read-back', 'verified-recorded-result']);
});

test('unknown October stays unknown and cannot be verified or extrapolated', () => {
  const r = create({ asOf: '2026-10-01T12:00:00Z', horizon: { start: '2026-09-30T23:00:00Z', end: '2026-10-01T23:00:00Z' } });
  assert.equal(r.state, 'blocked'); assert.equal(r.tariffIdentity, null);
  assert.ok(r.truth.import.every(w => w.price === null)); assert.ok(r.truth.export.every(w => w.price === null));
  assert.equal(r.proposed.tariffContentV2Fragment, null);
  assert.throws(() => verify(r));
});

test('config/auth extras are not serialized; no network, clock, filesystem or client dependency', () => {
  const tariff = config(); tariff.access_token = 'DO_NOT_COPY'; tariff.versions[0].credentials = { private_key: 'DO_NOT_COPY' };
  tariff.versions[0].normalImport.secret = 'DO_NOT_COPY';
  assert.doesNotMatch(JSON.stringify(create({ tariff })), /DO_NOT_COPY|access_token|private_key/);
  assert.throws(() => create({ baselineId: 'Bearer sensitive' }));
  assert.throws(() => baseline.verifyTariffBaseline(create(), { fingerprint: create().fingerprint, verifiedAt: '2026-09-22T13:00:00Z', verifierReference: 'private_key' }));
  const r = create(); assert.equal(r.writePayload, null); assert.equal(r.inspectionOnly, true);
});

test('deterministic record/key and authority semantics stay separate from economics', () => {
  const first = create(); assert.equal(JSON.stringify(first), JSON.stringify(create()));
  assert.equal(first.authority.effectiveMode, 'confirm');
  for (const authority of ['observe', 'confirm', 'automatic']) {
    const r = create({ authority }); assert.equal(r.fingerprint, first.fingerprint);
    assert.equal(r.authority.requestedMode, authority);
    assert.equal(r.authority.effectiveMode, authority === 'observe' ? 'observe' : 'confirm');
    assert.equal(r.authority.automaticExecutionImplemented, false); assert.equal(r.writeReady, false);
  }
});
