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

const rollback = load('src/lib/tesla-tariff/rollback-evidence.ts');
const tariffTools = load('src/lib/tesla-tariff/experiment-tariff.ts');
const proposals = load('src/lib/tesla-tariff/proposal-approval.ts', {
  '../tariff/compare-price-signal': comparison, './dry-run': dryRun,
  './experiment-tariff': tariffTools, './rollback-evidence': rollback,
});
const domains = load('src/lib/tariff/comparison-domain.ts', { './compare-price-signal': comparison, './price-signal': curve });

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
