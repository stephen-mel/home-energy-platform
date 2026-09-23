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
  }).outputText, { exports, structuredClone, Date: InputDate, require(name) {
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

const rollback = load('src/lib/tesla-tariff/rollback-evidence.ts');
const tariffTools = load('src/lib/tesla-tariff/experiment-tariff.ts');
const domains = load('src/lib/tariff/comparison-domain.ts', { './compare-price-signal': comparison, './price-signal': curve });
const observed = load('src/lib/tesla-tariff/observed-tariff.ts');
const simulation = load('src/lib/tesla-tariff/observed-simulation.ts', { './observed-tariff': observed });
const syncPlanner = load('src/lib/tesla-tariff/sync-planner.ts', {
  '../tariff/comparison-domain': domains, '../tariff/compare-price-signal': comparison, './dry-run': dryRun,
});
const observedProposal = load('src/lib/tesla-tariff/observed-proposal.ts', {
  '../tariff/comparison-domain': domains, './sync-planner': syncPlanner, './observed-simulation': simulation,
  './experiment-tariff': tariffTools, './rollback-evidence': rollback,
});
const proposals = load('src/lib/tesla-tariff/proposal-approval.ts', {
  './observed-proposal': observedProposal,
  '../tariff/compare-price-signal': comparison, './dry-run': dryRun,
  './experiment-tariff': tariffTools, './rollback-evidence': rollback,
});


test('historical verification survives expiry; delayed/expired approvals and use are independently rejected', () => {
  const r = create(), verified = verify(r);
  assert.equal(baseline.isBaselineHumanVerified(verified), true);
  for (const now of ['2026-09-22T23:00:00Z', '2026-10-01T13:00:00Z']) {
    assert.throws(() => baseline.verifyTariffBaseline(r, { fingerprint: r.fingerprint, verifiedAt: now }));
    const use = baseline.assessBaselineCurrentUse(verified, { now, currentProposal: r });
    assert.equal(use.eligible, false); assert.ok(use.blockers.includes('OUTSIDE_CURRENT_VALIDITY'));
    assert.equal(baseline.isBaselineHumanVerified(verified), true);
  }
  const tariff = config(); tariff.versions[0].normalImport.amount = 0.3;
  assert.ok(baseline.assessBaselineCurrentUse(verified, { now: '2026-09-22T14:00:00Z', currentProposal: create({ tariff }) }).blockers.includes('CURRENT_PROPOSAL_CHANGED'));
});
test('forged displayed period/price and removed diagnostic/blocker arrays cannot be approved or used', () => {
  for (const mutate of [
    r => { r.review.periods[0].toMinute = 1440; },
    r => { r.review.periods[0].importPrice.amount = 0; },
    r => { r.diagnostics = []; r.review.diagnostics = []; r.compatibilityBlockers = []; },
    r => { r.compatibilityBlockers = []; },
  ]) {
    const r = structuredClone(create()); mutate(r);
    assert.equal(baseline.baselineRecordConsistent(r), false);
    assert.throws(() => verify(r));
    const original = verify(create());
    assert.ok(baseline.assessBaselineCurrentUse(original, { now: '2026-09-22T14:00:00Z', currentProposal: r }).blockers.includes('RECORD_INCONSISTENT'));
  }
});
test('canonical economic instants ignore offset spelling/fractions while preserving DST folds', () => {
  const a = create().truth, b = structuredClone(a);
  const offset = date => new Date(Date.parse(date) + 3600000).toISOString().replace('Z', '+01:00');
  for (const w of [...b.import, ...b.export]) { w.start = offset(w.start); w.end = offset(w.end); }
  b.horizon.start = offset(b.horizon.start); b.horizon.end = offset(b.horizon.end);
  assert.equal(comparison.effectivePriceCurveKey(a), comparison.effectivePriceCurveKey(b));
  const w = a.import[0];
  const fold = { ...a, horizon: { start: '2026-10-25T01:00:00+01:00', end: '2026-10-25T01:00:00+00:00' },
    import: [{ ...w, start: '2026-10-25T01:00:00+01:00', end: '2026-10-25T01:00:00+00:00', eligibilityPeriods: [] }], export: [] };
  const utc = structuredClone(fold); utc.import[0].start = '2026-10-25T00:00:00.000Z'; utc.import[0].end = '2026-10-25T01:00:00.000Z';
  assert.equal(comparison.effectivePriceCurveKey(fold), comparison.effectivePriceCurveKey(utc));
  utc.import[0].end = '2026-10-25T01:00:00.001Z';
  assert.notEqual(comparison.effectivePriceCurveKey(fold), comparison.effectivePriceCurveKey(utc));
});
test('rolling horizons use an explicit fully covered common domain; gaps/future coverage are indeterminate', () => {
  const a = create().truth, b = structuredClone(a);
  b.horizon.start = '2026-09-22T00:00:00Z'; b.import[0].start = b.horizon.start; b.export[0].start = b.horizon.start;
  assert.notEqual(comparison.effectivePriceCurveKey(a), comparison.effectivePriceCurveKey(b));
  const domain = { start: '2026-09-22T01:00:00Z', end: '2026-09-22T22:00:00Z' };
  assert.equal(domains.comparePriceSignalsInDomain(a, b, domain).status, 'unchanged');
  assert.equal(domains.comparePriceSignalsInDomain(a, b, a.horizon).status, 'indeterminate');
  b.export = []; assert.equal(domains.comparePriceSignalsInDomain(a, b, domain).status, 'indeterminate');
});
test('generated or caller-labelled restoration candidate has no trusted provenance; wrong/stale evidence fails', () => {
  const representation = tariffTools.experimentTariff();
  const input = { observationId: 'capture-1', energySiteId: 'site-1', representation, now: '2026-09-22T14:00:00Z', maxAgeMs: 60000 };
  const entry = { id: 'capture-1', energySiteId: 'site-1', representationKey: rollback.representationKey(representation), observedAt: '2026-09-22T13:59:30Z', validUntil: '2026-09-22T14:01:00Z', basis: 'verified-write-read-back' };
  assert.equal(rollback.assessRollbackEvidence(input).proven, false);
  assert.equal(rollback.assessRollbackEvidence(input, [entry]).proven, true); // Trusted ledger fixture only.
  for (const changed of [{ ...entry, energySiteId: 'other' }, { ...entry, observedAt: '2026-09-21T13:00:00Z' }, { ...entry, representationKey: 'other' }])
    assert.equal(rollback.assessRollbackEvidence(input, [changed]).proven, false);
});
const proposal = (options = {}) => proposals.createTariffProposal({ proposalId: 'proposal-1', energySiteId: 'site-1', purpose: 'tariff-sync',
  timeZone: 'Europe/London', validFrom: '2026-09-22T12:00:00Z', expiresAt: '2026-09-22T22:00:00Z', signal: create().truth, ...options });
const approved = p => proposals.approveTariffProposal(p, { fingerprint: p.fingerprint, approvedAt: '2026-09-22T13:00:00Z' });
const assess = (p, overrides = {}, ledger = []) => proposals.assessProposalCurrentUse({ approvedProposal: p, currentProposal: p, approval: approved(p),
  now: '2026-09-22T14:00:00Z', targetEnergySiteId: 'site-1', authority: 'confirm', rollback: { representation: {}, maxAgeMs: 60000 }, ...overrides }, ledger);
test('proposal approval is distinct, exact, time/site/purpose-bound and never waives bounded forecast', () => {
  const p = proposal();
  assert.ok(assess(p).blockers.includes('BOUNDED_FORECAST')); assert.ok(assess(p).blockers.includes('ROLLBACK_UNPROVEN'));
  assert.ok(assess(p, { approval: null, authority: 'automatic' }).blockers.includes('EXACT_PROPOSAL_APPROVAL_REQUIRED'));
  assert.ok(assess(p, { authority: 'observe' }).blockers.includes('AUTHORITY_OBSERVE_ONLY'));
  assert.ok(assess(p, { targetEnergySiteId: 'other' }).blockers.includes('TARGET_SITE_MISMATCH'));
  assert.ok(assess(p, { now: '2026-09-23T14:00:00Z' }).blockers.includes('OUTSIDE_CURRENT_VALIDITY'));
  const signal = structuredClone(p.input.signal); signal.import[0].price.amount = 0.05;
  assert.ok(assess(p, { currentProposal: proposal({ signal }) }).blockers.includes('CURRENT_PROPOSAL_CHANGED'));
  assert.throws(() => proposals.approveTariffProposal(p, { fingerprint: create().fingerprint, approvedAt: '2026-09-22T13:00:00Z' }));
});
test('explicit complete experiment can acknowledge buy-below-sell but still independently requires trusted rollback', () => {
  const representation = tariffTools.experimentTariff();
  const p = proposal({ purpose: 'pricing-constraint-experiment', experimentRepresentation: representation, exceptions: ['BUY_BELOW_SELL'] });
  assert.ok(p.sourceDiagnostics.some(d => d.code === 'BOUNDED_FORECAST'));
  assert.equal(p.coverageBasis, 'complete-experiment');
  assert.equal(assess(p).eligible, false);
  const ledger = [{ id: 'evidence-1', energySiteId: 'site-1', representationKey: rollback.representationKey(representation),
    observedAt: '2026-09-22T13:59:30Z', validUntil: '2026-09-22T14:01:00Z', basis: 'verified-write-read-back' }];
  const r = assess(p, { rollback: { observationId: 'evidence-1', representation, maxAgeMs: 60000 } }, ledger);
  assert.equal(r.eligible, true); assert.equal(r.writeReady, false); assert.equal(r.executorAvailable, false);
  const unacknowledged = proposal({ purpose: 'pricing-constraint-experiment', experimentRepresentation: representation });
  assert.ok(assess(unacknowledged).blockers.includes('BUY_BELOW_SELL'));
});

test('SMART moved, cancelled or eligibility changed invalidates transient approval; BOOST does not affect economics', () => {
  const kraken = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
  const siteSignal = load('src/lib/site/get-site-price-signal.ts', {
    '../tariff/price-signal': curve, '../tariff/kraken-dispatches': kraken, '../tariff/effective-tariff': effective,
  });
  const site = load('src/lib/site/current-site.ts').currentSite;
  const signal = (start, type = 'SMART') => siteSignal.getSitePriceSignal(site, { stale: false,
    lastSuccessfulUpdate: '2026-09-22T00:00:00Z', vehicles: [{ id: 'ev', name: 'Car', plannedDispatches: start ? [{
      start, end: '2026-09-22T23:00:00Z', type, energyAddedKwh: null,
    }] : [] }] }, '2026-09-21T23:00:00Z').signal;
  const first = proposal({ signal: signal('2026-09-22T21:30:00Z') });
  assert.ok(first.bound.evidence.every(p => p.state === 'planned-conditional'));
  for (const changed of [signal('2026-09-22T22:00:00Z'), signal(null)]) {
    assert.ok(assess(first, { currentProposal: proposal({ signal: changed }) }).blockers.includes('CURRENT_PROPOSAL_CHANGED'));
  }
  const qualified = signal('2026-09-22T21:30:00Z');
  for (const w of qualified.import) for (const p of w.eligibilityPeriods) p.state = 'observed-qualified';
  assert.notEqual(first.fingerprint, proposal({ signal: qualified }).fingerprint);
  assert.equal(proposal({ signal: signal(null) }).fingerprint, proposal({ signal: signal('2026-09-22T21:30:00Z', 'BOOST') }).fingerprint);
  const changedIdentity = signal(null);
  for (const w of changedIdentity.import) for (const source of w.sources) if (source.tariffVersion) source.tariffVersion = 'new-version';
  assert.notEqual(proposal({ signal: signal(null) }).fingerprint, proposal({ signal: changedIdentity }).fingerprint);
});

test('equivalent UTC eligibility boundaries canonicalize before ordering/state comparison', () => {
  const a = create().truth;
  a.import[0].eligibilityPeriods = [{ start: a.import[0].start, end: a.import[0].end, state: 'planned-conditional',
    assessmentPeriod: { start: a.import[0].start, end: a.import[0].end }, sources: [] }];
  const b = structuredClone(a);
  for (const p of b.import[0].eligibilityPeriods) {
    p.start = new Date(Date.parse(p.start) + 3600000).toISOString().replace('Z', '+01:00');
    p.end = new Date(Date.parse(p.end) + 3600000).toISOString().replace('Z', '+01:00');
  }
  assert.equal(comparison.effectivePriceCurveKey(a), comparison.effectivePriceCurveKey(b));
});

test('proposal diagnostic removal and stale evidence cannot authorize a current proposal', () => {
  const p = proposal(); const edited = structuredClone(p); edited.compatibilityBlockers = []; edited.sourceDiagnostics = [];
  assert.throws(() => approved(edited));
  assert.ok(assess(p, { currentProposal: edited }).blockers.includes('RECORD_INCONSISTENT'));
  const signal = structuredClone(p.input.signal); signal.import[0].stale = true;
  const stale = proposal({ signal });
  assert.ok(assess(stale).blockers.includes('STALE_EVIDENCE'));
});

// Captured 23 September Q7 case. Site/asset IDs are fictitious; prices, sparse
// fields, season dates and exact UTC dispatch boundaries mirror the live reads.
const q7Dispatch = { start: '2026-09-23T08:00:00+00:00', end: '2026-09-23T10:00:00+00:00', type: 'SMART', energyAddedKwh: '-4.6' };
function q7Observation() {
  const ranges = { Yesterday: [9, 21, 9, 21], Today: [9, 22, 9, 22], Tomorrow: [9, 23, 9, 23], TwoDays: [9, 24, 9, 24], ThreeDays: [9, 25, 9, 20] };
  const side = sell => ({ code: 'FLATPEAK', name: sell ? 'Premium export' : 'Next Drive Smart V5.2', utility: 'Eon Next', currency: 'GBP',
    demand_charges: { ALL: { rates: { ALL: 0 } }, ...Object.fromEntries(Object.keys(ranges).map(k => [k, {}])) },
    energy_charges: Object.fromEntries(Object.keys(ranges).map(k => [k, { rates: sell ? { cheap: 0.17 } : { cheap: 0.02993, standard: 0.25177 } }])),
    seasons: Object.fromEntries(Object.entries(ranges).map(([k, [fromMonth, fromDay, toMonth, toDay]]) => [k, { fromMonth, fromDay, toMonth, toDay,
      tou_periods: sell ? { cheap: { periods: [{ toDayOfWeek: 6 }] } } : {
        cheap: { periods: [{ toDayOfWeek: 6, toHour: 6 }] }, standard: { periods: [{ toDayOfWeek: 6, fromHour: 6 }] },
      } }])) });
  return observed.captureObservedTariff({ installation_time_zone: 'Europe/London', tariff_content_v2: { ...side(false), version: 1, sell_tariff: side(true) } }, 'site-q7', '2026-09-23T08:10:28.293Z');
}
const krakenAdapter = load('src/lib/tariff/kraken-dispatches.ts', { './price-signal': curve });
const siteSignals = load('src/lib/site/get-site-price-signal.ts', {
  '../tariff/price-signal': curve, '../tariff/kraken-dispatches': krakenAdapter, '../tariff/effective-tariff': effective,
});
function q7Signal(dispatches = [q7Dispatch]) {
  return siteSignals.getSitePriceSignal(load('src/lib/site/current-site.ts').currentSite, { stale: false, lastSuccessfulUpdate: '2026-09-23T08:08:31.469Z',
    vehicles: [{ id: 'q7-fixture', name: 'Audi Q7', plannedDispatches: dispatches }] }, '2026-09-22T23:00:00Z').signal;
}
const q7Input = () => ({ proposalId: 'q7-sept23', energySiteId: 'site-q7', purpose: 'tariff-sync', timeZone: 'Europe/London',
  validFrom: '2026-09-23T09:10:29+01:00', expiresAt: '2026-09-23T11:00:00+01:00', signal: q7Signal(),
  observedSmart: { observation: q7Observation(), generatedAt: '2026-09-23T08:10:29Z',
    dispatch: { assetId: 'q7-fixture', start: q7Dispatch.start, end: q7Dispatch.end }, previousSignal: q7Signal([]),
    comparisonDomain: { start: '2026-09-22T23:00:00Z', end: '2026-09-23T23:00:00Z' } } });
const approveQ7 = p => proposals.approveTariffProposal(p, { fingerprint: p.fingerprint, approvedAt: '2026-09-23T08:11:00Z' });
const assessQ7 = (p, overrides = {}) => proposals.assessProposalCurrentUse({ approvedProposal: p, currentProposal: p, approval: null,
  now: '2026-09-23T08:12:00Z', targetEnergySiteId: 'site-q7', authority: 'confirm', rollback: { representation: q7Observation().tariff, maxAgeMs: 300000 }, ...overrides });

test('Q7 09:00–11:00 observed simulation binds exact representation, economic/evidence keys, local validity and generation', () => {
  const input = q7Input(), p = proposals.createTariffProposal(input), prepared = p.observedPreparation;
  assert.equal(p.structurallyValid, true);
  assert.equal(tariffTools.inspectTariff(p.bound.representation).exact, false, 'existing explicit schema is not weakened');
  assert.equal(tariffTools.inspectObservedProposalTariff(p.bound.representation).exact, true);
  assert.equal(rollback.representationKey(p.bound.representation), rollback.representationKey(prepared.simulation.simulated.tariff));
  assert.equal(rollback.representationKey(p.bound.representation.sell_tariff), rollback.representationKey(input.observedSmart.observation.tariff.sell_tariff));
  assert.equal(p.bound.generatedAt, input.observedSmart.generatedAt);
  assert.equal(p.bound.economicKey, comparison.effectivePriceCurveKey(input.signal));
  assert.ok(p.bound.dispatchEvidenceKey.includes('q7-fixture'));
  assert.equal(p.bound.localValidity.fromMinute, 540); assert.equal(p.bound.localValidity.toMinute, 660);
  assert.ok(p.bound.evidence.every(e => e.state === 'planned-conditional'));
  assert.equal(prepared.syncPlan.comparison.state, 'changed');
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.syncPlan.comparison.changedPeriods)), [{ start: '2026-09-23T08:00:00.000Z', end: '2026-09-23T10:00:00.000Z', channels: ['import'] }]);
  assert.equal(prepared.simulation.differences[0].newBuy, 0.0299);
  assert.equal(prepared.simulation.differences[0].newSell, 0.17);
  assert.equal(input.signal.export[0].price.amount, 0.175);
  assert.equal(proposals.createTariffProposal(input).fingerprint, p.fingerprint);
});

test('structural validity, approval, compatibility, rollback and write readiness remain independent', () => {
  const p = proposals.createTariffProposal(q7Input()), unapproved = assessQ7(p);
  assert.equal(unapproved.structurallyValid, true); assert.equal(unapproved.humanApproved, false);
  const result = assessQ7(p, { approval: approveQ7(p) });
  assert.equal(result.humanApproved, true); assert.equal(result.writeCompatible, false); assert.equal(result.rollbackProven, false);
  assert.equal(result.writeReady, false); assert.equal(result.executorAvailable, false); assert.equal(result.eligible, false);
  for (const code of ['BUY_BELOW_SELL', 'BOUNDED_FORECAST', 'ROLLBACK_UNPROVEN', 'RESTORATION_REQUIRED', 'OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED']) assert.ok(result.blockers.includes(code), code);
  assert.ok(!result.blockers.includes('REPRESENTATION_UNAVAILABLE'));
  const exceptionInput = q7Input(); exceptionInput.exceptions = ['BUY_BELOW_SELL'];
  const attempted = proposals.createTariffProposal(exceptionInput);
  assert.ok(assessQ7(attempted).blockers.includes('BUY_BELOW_SELL'));
  exceptionInput.purpose = 'pricing-constraint-experiment';
  const wrongPurpose = proposals.createTariffProposal(exceptionInput);
  assert.equal(wrongPurpose.structurallyValid, false); assert.throws(() => approveQ7(wrongPurpose));
});

test('cancelled, removed, moved, shortened or changed-type Q7 dispatch invalidates original approval', () => {
  const p = proposals.createTariffProposal(q7Input()), approval = approveQ7(p);
  for (const dispatches of [[], [{ ...q7Dispatch, start: '2026-09-23T08:30:00+00:00' }],
    [{ ...q7Dispatch, end: '2026-09-23T09:30:00+00:00' }], [{ ...q7Dispatch, type: 'BOOST' }]]) {
    const input = q7Input(); input.signal = q7Signal(dispatches);
    const currentProposal = proposals.createTariffProposal(input);
    assert.equal(currentProposal.structurallyValid, false);
    const r = assessQ7(p, { currentProposal, approval });
    assert.ok(r.blockers.includes('CURRENT_PROPOSAL_CHANGED')); assert.equal(r.humanApproved, false);
  }
  const moved = q7Input(); moved.signal = q7Signal([{ ...q7Dispatch, start: '2026-09-23T08:30:00+00:00' }]);
  moved.observedSmart.dispatch.start = '2026-09-23T08:30:00+00:00';
  const reselection = proposals.createTariffProposal(moved);
  assert.equal(reselection.structurallyValid, true);
  assert.ok(assessQ7(p, { currentProposal: reselection, approval }).blockers.includes('CURRENT_PROPOSAL_CHANGED'));
});

test('11:00 BST expires Q7 proposal exactly, cannot extend expiry or backdate generation', () => {
  const p = proposals.createTariffProposal(q7Input()), approval = approveQ7(p);
  assert.ok(!assessQ7(p, { approval, now: '2026-09-23T09:59:59.999Z' }).blockers.includes('OUTSIDE_CURRENT_VALIDITY'));
  assert.ok(assessQ7(p, { approval, now: '2026-09-23T10:00:00Z' }).blockers.includes('OUTSIDE_CURRENT_VALIDITY'));
  assert.throws(() => proposals.approveTariffProposal(p, { fingerprint: p.fingerprint, approvedAt: '2026-09-23T10:00:00Z' }));
  for (const edit of [i => { i.expiresAt = '2026-09-23T11:01:00+01:00'; },
    i => { i.observedSmart.generatedAt = '2026-09-23T08:00:00Z'; }, i => { i.observedSmart.generatedAt = '2026-09-23T10:00:00Z'; }]) {
    const input = q7Input(); edit(input); const invalid = proposals.createTariffProposal(input);
    assert.equal(invalid.structurallyValid, false); assert.throws(() => approveQ7(invalid));
  }
});

test('Q7 site/representation/evidence/generation tampering and insufficient comparison coverage fail closed', () => {
  const p = proposals.createTariffProposal(q7Input());
  for (const edit of [x => { x.bound.representation.name = 'Changed'; }, x => { x.bound.generatedAt = '2026-09-23T08:11:00Z'; },
    x => { x.bound.dispatchEvidenceKey = 'different'; }, x => { x.compatibilityBlockers = []; }]) {
    const altered = structuredClone(p); edit(altered); assert.throws(() => approveQ7(altered));
    assert.ok(assessQ7(p, { currentProposal: altered }).blockers.includes('RECORD_INCONSISTENT'));
  }
  const mismatch = q7Input(); mismatch.energySiteId = 'another-site';
  assert.equal(proposals.createTariffProposal(mismatch).structurallyValid, false);
  const gap = q7Input(); gap.observedSmart.previousSignal.horizon.start = '2026-09-23T09:00:00Z';
  assert.ok(proposals.createTariffProposal(gap).compatibilityBlockers.includes('COMMON_DOMAIN_UNAVAILABLE'));
  const regenerated = q7Input(); regenerated.observedSmart.generatedAt = '2026-09-23T08:10:28.500Z';
  assert.notEqual(proposals.createTariffProposal(regenerated).fingerprint, p.fingerprint);
});

test('observed strict validation rejects unknown fields, nonzero demand, malformed prices, gaps and overlaps', () => {
  const original = q7Observation().tariff;
  assert.equal(tariffTools.inspectObservedProposalTariff(original).exact, true);
  for (const edit of [t => { t.unknown = true; }, t => { t.demand_charges.ALL.rates.ALL = 1; },
    t => { t.energy_charges.Today.rates.cheap = NaN; }, t => { delete t.seasons.Today; },
    t => { t.seasons.Today.toDay = 23; }, t => { t.seasons.Today.tou_periods.standard.periods[0].fromHour = 7; },
    t => { t.seasons.Today.tou_periods.standard.periods[0].fromHour = 5; }, t => { t.sell_tariff.version = 2; }]) {
    const invalid = structuredClone(original); edit(invalid);
    assert.equal(tariffTools.inspectObservedProposalTariff(invalid).exact, false);
  }
});


const restoration = load('src/lib/tesla-tariff/restoration-review.ts', {
  './experiment-tariff': tariffTools, './observed-tariff': observed, './rollback-evidence': rollback,
  './baseline': baseline, './proposal-approval': proposals,
});
const restoreReview = (overrides = {}) => restoration.reviewObservedRestoration({ before: q7Observation(),
  temporaryProposal: proposals.createTariffProposal(q7Input()), asOf: '2026-09-23T08:12:00Z', maxCaptureAgeMs: 300000, ...overrides });

test('restoration retains exact observed before-state/envelope and binds site, capture, provenance and proposal without minting proof', () => {
  const r = restoreReview(), before = q7Observation();
  assert.equal(r.structurallyComplete, true); assert.equal(r.boundToProposal, true); assert.equal(r.captureFresh, true);
  assert.equal(rollback.representationKey(r.documentedEnvelopeCandidate.tou_settings.tariff_content_v2), rollback.representationKey(before.tariff));
  assert.equal(r.bound.representationKey, rollback.representationKey(before.tariff));
  assert.equal(r.bound.energySiteId, 'site-q7'); assert.equal(r.bound.capturedAt, before.source.observedAt);
  assert.equal(r.bound.provenance.source, 'tesla-site-info');
  assert.equal(r.fingerprint, restoreReview().fingerprint);
  for (const field of ['exactWriteMappingProven', 'acceptanceProven', 'rollbackProven', 'writeReady', 'executorAvailable']) assert.equal(r[field], false);
  assert.equal(r.writePayload, null);
  for (const code of ['ROLLBACK_UNPROVEN', 'BUY_BELOW_SELL', 'BOUNDED_FORECAST', 'RESTORATION_PRICE_TRANSFORMATION_RISK', 'RESTORATION_REQUIRED']) assert.ok(r.blockers.includes(code));
  assert.equal(r.pricingConstraintWitness.buy, 0.02993); assert.equal(r.pricingConstraintWitness.sell, 0.17);
  for (const code of ['SPARSE_DEFAULTS_UNDOCUMENTED', 'SELL_VERSION_ABSENT_PRESERVED', 'EXAMPLE_NOT_EXHAUSTIVE_SCHEMA', 'FIELDS_PRESERVED']) assert.ok(r.mappingFindings.some(f => f.code === code));
  assert.equal('version' in r.documentedEnvelopeCandidate.tou_settings.tariff_content_v2.sell_tariff, false);
  assert.equal(r.lifecycle.length, 6); assert.ok(r.lifecycle.slice(2).every(s => s.status === 'not-performed'));
  assert.equal(r.baselineContext.rollbackProven, false);
});

test('restoration rejects omitted fields, mismatched site/representation/capture, simulation provenance, future or stale captures', () => {
  for (const edit of [b => { b.source.energySiteId = 'other'; }, b => { b.source.observedAt = '2026-09-23T08:10:29Z'; },
    b => { b.tariff.name = 'different'; }, b => { b.source.kind = 'simulation'; }, b => { b.source.observedAt = '2026-09-23T09:00:00Z'; }]) {
    const before = q7Observation(); edit(before); const r = restoreReview({ before });
    assert.equal(r.boundToProposal, false); assert.ok(r.blockers.includes('BEFORE_STATE_BINDING_MISMATCH'));
    assert.ok(r.blockers.includes('ROLLBACK_UNPROVEN'));
  }
  const missing = q7Observation(); missing.diagnostics.push('UNSUPPORTED_FIELDS_OMITTED');
  const incomplete = restoreReview({ before: missing });
  assert.equal(incomplete.structurallyComplete, false); assert.equal(incomplete.documentedEnvelopeCandidate, null);
  assert.ok(incomplete.blockers.includes('CAPTURE_INEXACT'));
  const stale = restoreReview({ asOf: '2026-09-23T09:00:00Z' });
  assert.equal(stale.captureFresh, false); assert.ok(stale.blockers.includes('BEFORE_STATE_RECAPTURE_REQUIRED'));
  const verified = verify(create());
  assert.equal(restoreReview({ baseline: verified }).baselineContext.rollbackProven, false, 'human baseline verification is not restoration proof');
});

const readBackCheck = (intended, readBack) => restoration.compareObservedTariffReadBack({ intended, readBack,
  after: '2026-09-23T08:12:00Z', dates: ['2026-09-23'] });
const laterCapture = intended => ({ ...structuredClone(intended), source: { ...intended.source, kind: 'tesla-site-info', observedAt: '2026-09-23T08:13:00Z' } });
test('exact restoration GET match is observation only; reordered object keys match but metadata change does not prove exact restoration', () => {
  const intended = q7Observation(), readBack = laterCapture(intended);
  readBack.tariff.seasons = Object.fromEntries(Object.entries(readBack.tariff.seasons).reverse());
  const r = readBackCheck(intended, readBack);
  assert.equal(r.outcome, 'exact-observed-match'); assert.equal(r.representationMatches, true);
  assert.equal(r.differences.length, 0); assert.equal(r.writeAcceptance, 'not-established'); assert.equal(r.rollbackProven, false);
  readBack.tariff.name = 'renamed';
  const changed = readBackCheck(intended, readBack);
  assert.equal(changed.outcome, 'different-observed-representation'); assert.equal(changed.differences.length, 0);
  assert.ok(changed.blockers.includes('ROLLBACK_UNPROVEN'));
});

test('buy-raised-to-sell is detected during BOTH temporary and restoration read-back, without altering expected prices', () => {
  const original = q7Observation();
  const temporary = proposals.createTariffProposal(q7Input()).observedPreparation.simulation.simulated;
  for (const intended of [original, temporary]) {
    const readBack = laterCapture(intended);
    for (const c of Object.values(readBack.tariff.energy_charges)) for (const label of Object.keys(c.rates)) if (c.rates[label] < 0.17) c.rates[label] = 0.17;
    const r = readBackCheck(intended, readBack);
    assert.equal(r.outcome, 'different-observed-representation'); assert.ok(r.differences.some(d => d.buyRaisedToSell));
    assert.equal(r.rollbackProven, false); assert.equal(r.causation, 'not-inferred');
    assert.ok(r.differences.some(d => d.expectedBuy < d.actualBuy));
  }
  assert.equal(original.tariff.energy_charges.Tomorrow.rates.cheap, 0.02993);
});

test('missing/wrong-site/out-of-order/omitted read-back is insufficient; empty dates never claim timeline completeness', () => {
  const intended = q7Observation();
  for (const r of [null, { ...laterCapture(intended), source: { ...intended.source, energySiteId: 'wrong' } },
    { ...laterCapture(intended), source: { ...intended.source, observedAt: '2026-09-23T08:12:00Z' } },
    { ...laterCapture(intended), diagnostics: ['UNSUPPORTED_FIELDS_OMITTED'] }]) assert.equal(readBackCheck(intended, r).outcome, 'insufficient-evidence');
  const empty = restoration.compareObservedTariffReadBack({ intended, readBack: laterCapture(intended), after: '2026-09-23T08:12:00Z', dates: [] });
  assert.equal(empty.timelineScope.complete, false); assert.equal(empty.rollbackProven, false);
  const invalidZone = structuredClone(intended); invalidZone.source.timeZone = 'invalid/zone';
  assert.equal(readBackCheck(invalidZone, laterCapture(invalidZone)).outcome, 'insufficient-evidence');
});
