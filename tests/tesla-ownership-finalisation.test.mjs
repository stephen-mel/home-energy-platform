import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Error, structuredClone, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    assert.equal(name, 'node:crypto', 'Pure layer must not import filesystem/network/executor clients'); return crypto;
  } }); return exports;
}
const { finaliseConfirmedSmartOwnership: finalise } = load('src/lib/tesla-tariff/ownership-finalisation.ts');
const { deriveOwnershipTransition: derive, ownershipFingerprint: hash } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { prepareSupervisedExperiment: prepare } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const { simulateObservedSmartDate: simulate } = load('src/lib/tesla-tariff/observed-simulation.ts');
const site = load('src/lib/site/current-site.ts').currentSite;
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const at = h => `2026-09-23T${h}:00.000Z`;
const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
function seal(r) {
  r.journal = { originalKey: hash({ mutationId: r.mutationId, original: r.original }),
    classifiedKey: hash({ mutationId: r.mutationId, execution: r.execution }), completedAt: '2026-09-23T07:59:56.000Z' };
  return r;
}
function receipt(change = () => {}) {
  const capture = structuredClone(fixture);
  capture.before.source.observedAt = '2026-09-23T07:59:40.000Z';
  capture.kraken.lastSuccessfulUpdate = capture.before.source.observedAt;
  change(capture);
  const review = prepare(site, { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' }, capture, '2026-09-23T07:59:50.000Z');
  return seal({ version: 1, mutationId: 'fixture-mutation', original: { proposal: review.proposal, payloadJson: review.payloadJson,
    approval: { fingerprint: review.proposal.fingerprint, approvedAt: '2026-09-23T07:59:51.000Z' },
    prior: { generation: null, evidence: null, capturedAt: '2026-09-23T07:59:45.000Z' } }, execution: {
      submittedAt: '2026-09-23T07:59:52.000Z', completedAt: '2026-09-23T07:59:55.000Z', apiWrite: { status: 'accepted', httpStatus: 200 },
      classification: 'submitted-representation-preserved', readback: { ...capture.before,
        source: { ...capture.before.source, observedAt: '2026-09-23T07:59:54.000Z' }, tariff: review.proposal.bound.representation },
    } });
}
function observed(buy, from = 9, to = 11) {
  const result = simulate(fixture.before, { date: '2026-09-23', fromMinute: from * 60, toMinute: to * 60,
    buy, currency: 'GBP', compareDates: [], preserveLabels: true });
  return { ...result.simulated, source: { ...fixture.before.source, observedAt: at('07:59') } };
}
function previous(intervals) {
  return { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: at('06:00'), updatedAt: at('06:00'), validUntil: at('23:00'),
    basis: 'confirmed-write-readback', baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64),
    proposalFingerprint: 'c'.repeat(64), smartEvidenceFingerprint: 'd'.repeat(64), intervals };
}
const owned = (start, end, applied = 0.08, restore = 0.25177) => ({ start: at(start), end: at(end), applied: price(applied), restore: price(restore), restoreBaselineFingerprint: 'e'.repeat(64) });
function transition(before, after, prior, start = at('08:00'), end = at('10:00'), amount = 0.0299, submittedAt = at('07:59')) {
  return derive({ before, after, previous: prior, domain: { start: at('00:00'), end: at('23:00') },
    authorised: [{ start, end, price: price(amount) }], submittedAt });
}

test('confirmed original SMART produces exact immutable transition, retains original bindings and blockers', () => {
  const r = receipt(), snapshot = key(r), result = finalise(r);
  assert.equal(result.status, 'derived', result.code);
  assert.equal(result.evidence.intervals.length, 1);
  assert.equal(result.evidence.intervals[0].start, at('08:00'));
  assert.equal(result.evidence.intervals[0].end, at('10:00'));
  assert.equal(result.evidence.intervals[0].restore.amount, 0.25177);
  assert.equal(result.evidence.intervals[0].applied.amount, 0.0299);
  assert.equal(result.originalProposalFingerprint, r.original.proposal.fingerprint);
  assert.equal(result.originalPayloadKey, r.original.payloadJson);
  assert.equal(result.expectedGeneration, null);
  assert.equal(result.rollbackProven, false); assert.equal(result.writeReady, false);
  assert.ok(result.productionBlockers.includes('ROLLBACK_UNPROVEN'));
  assert.ok(Object.isFrozen(result.evidence.intervals[0])); assert.equal(key(r), snapshot);
  assert.equal(key(result), key(finalise(r)));
});

test('multiple visible SMART dispatches and recurring season dates never expand selected ownership', () => {
  const r = receipt(c => c.kraken.vehicles[0].plannedDispatches.push({ ...c.kraken.vehicles[0].plannedDispatches[0],
    start: '2026-09-23T12:00:00+00:00', end: '2026-09-23T13:00:00+00:00' }));
  const result = finalise(r); assert.equal(result.status, 'derived', result.code);
  assert.equal(result.evidence.intervals.length, 1); assert.equal(result.evidence.intervals[0].end, at('10:00'));
});

test('partial overlap preserves original restoration lineage and outside ownership', () => {
  const before = observed(0.08, 10, 12), after = simulate(before, { date: '2026-09-23', fromMinute: 9 * 60, toMinute: 11 * 60,
    buy: 0.0299, currency: 'GBP', compareDates: [], preserveLabels: true }).simulated;
  const r = transition(before, { ...after, source: before.source }, previous([owned('09:00', '11:00')]));
  assert.equal(r.status, 'derived', r.code); assert.equal(r.intervals.length, 3);
  assert.equal(r.intervals[0].restoreBaselineFingerprint, hash(before.tariff));
  assert.equal(r.intervals[1].restoreBaselineFingerprint, 'e'.repeat(64));
  assert.equal(r.intervals[2].applied.amount, 0.08); assert.equal(r.intervals[2].end, at('11:00'));
});

test('restoring an owned portion retires it, while equal unowned economics do not create ownership', () => {
  const r = transition(observed(0.08), observed(0.0299), previous([owned('08:00', '10:00', 0.08, 0.0299)]));
  assert.equal(r.status, 'derived', r.code); assert.equal(r.intervals.length, 0);
  const equal = transition(observed(0.0299), observed(0.0299), null);
  assert.equal(equal.status, 'derived'); assert.equal(equal.intervals.length, 0);
});

test('contradictory previous ownership, outside import changes and export changes fail closed', () => {
  assert.equal(transition(observed(0.08), observed(0.0299), previous([owned('08:00', '10:00', 0.09)])).status, 'rejected');
  const before = observed(0.25177), after = observed(0.0299, 9, 12);
  assert.equal(transition(before, after, null).code, 'UNAUTHORISED_IMPORT_CHANGE');
  const changed = observed(0.0299);
  for (const p of Object.values(changed.tariff.sell_tariff.energy_charges)) for (const k of Object.keys(p.rates)) p.rates[k] = 0.175;
  assert.equal(transition(before, changed, null).code, 'UNMANAGED_EXPORT_CHANGED');
});

test('elapsed prefix excluded from coverage without losing original restoration; future omission rejected', () => {
  const before = observed(0.08), after = observed(0.0299);
  const input = { before, after, previous: previous([owned('08:00', '10:00')]), submittedAt: at('08:30'),
    domain: { start: at('08:30'), end: at('11:00') }, authorised: [{ start: at('08:30'), end: at('10:00'), price: price(0.0299) }] };
  const r = derive(input); assert.equal(r.status, 'derived', r.code);
  assert.equal(r.intervals[0].end, at('08:30')); assert.equal(r.intervals[1].start, at('08:30'));
  assert.equal(r.intervals[1].restoreBaselineFingerprint, 'e'.repeat(64));
  assert.equal(derive({ ...input, domain: { start: at('08:45'), end: at('11:00') } }).code, 'OWNERSHIP_DOMAIN_INCOMPLETE');
});

test('new ownership cannot include elapsed prefix; half-open neighbour remains unowned', () => {
  const r = transition(observed(0.25177), observed(0.0299), null, at('08:00'), at('10:00'), 0.0299, at('08:30'));
  assert.equal(r.status, 'derived'); assert.equal(r.intervals[0].start, at('08:30')); assert.equal(r.intervals[0].end, at('10:00'));
});

test('explicit BST offset is the same bounded instant; impossible dates fail closed', () => {
  const r = transition(observed(0.25177), observed(0.0299), null, '2026-09-23T09:00:00+01:00', '2026-09-23T11:00:00+01:00');
  assert.equal(r.status, 'derived'); assert.equal(r.intervals[0].start, at('08:00'));
  assert.equal(transition(observed(0.25177), observed(0.0299), null, '2026-02-30T09:00:00Z').status, 'rejected');
});

test('unconfirmed API/classification, changed readback, missing journal binding and invalid provenance reject', () => {
  for (const mutate of [r => { r.execution.apiWrite.status = 'unknown'; }, r => { r.execution.apiWrite.status = 'rejected'; },
    r => { r.execution.classification = 'buy-raised-to-sell'; }, r => { r.execution.readback.tariff.name = 'transformed'; },
    r => { r.execution.readback.source.kind = 'simulation'; }, r => { r.original.prior.generation = 'a'.repeat(36); }]) {
    const r = receipt(); mutate(r); seal(r); assert.equal(finalise(r).status, 'rejected');
  }
  const r = receipt(); r.journal.classifiedKey = 'bad'; assert.equal(finalise(r).code, 'INVALID_CONFIRMATION_BINDING');
});

test('finaliser preserves prior generation, lineage and validity without refreshing ownership', () => {
  const r = receipt(c => { c.before.tariff.energy_charges.Tomorrow.rates.hour_6_minute_0 = 0.08; });
  r.original.prior = { capturedAt: '2026-09-23T07:59:45.000Z', generation: '11111111-1111-1111-1111-111111111111',
    evidence: previous([owned('08:00', '10:00')]) };
  r.original.prior.evidence.validUntil = at('12:00');
  seal(r);
  const result = finalise(r); assert.equal(result.status, 'derived', result.code);
  assert.equal(result.expectedGeneration, r.original.prior.generation);
  assert.equal(result.evidence.validUntil, at('12:00'));
  assert.equal(result.evidence.intervals[0].restoreBaselineFingerprint, 'e'.repeat(64));
  assert.equal(result.evidence.intervals[0].restore.amount, 0.25177);
});

test('separate mutations with equal economics have distinct receipt identity', () => {
  const r = receipt(), a = finalise(r); r.mutationId = 'second-mutation'; seal(r);
  const b = finalise(r); assert.equal(a.status, 'derived'); assert.equal(b.status, 'derived');
  assert.notEqual(a.receiptKey, b.receiptKey); assert.equal(key(a.evidence), key(b.evidence));
});

test('DST repeated local hour retains distinct explicit-offset instants and fails closed on extra fold changes', () => {
  const before = structuredClone(fixture.before); before.source.observedAt = '2026-10-24T23:00:00Z';
  const after = simulate(before, { date: '2026-10-25', fromMinute: 60, toMinute: 120, buy: 0.02,
    currency: 'GBP', compareDates: [], preserveLabels: false }).simulated;
  const input = { before, after, previous: null, submittedAt: '2026-10-24T23:01:00Z',
    domain: { start: '2026-10-24T23:00:00Z', end: '2026-10-26T00:00:00Z' },
    authorised: [{ start: '2026-10-25T01:00:00+01:00', end: '2026-10-25T02:00:00+00:00', price: price(0.02) }] };
  const r = derive(input); assert.equal(r.status, 'derived', r.code);
  assert.equal(r.intervals[0].start, '2026-10-25T00:00:00.000Z'); assert.equal(r.intervals[0].end, '2026-10-25T02:00:00.000Z');
  input.authorised[0].start = '2026-10-25T01:00:00+00:00';
  assert.equal(derive(input).code, 'UNAUTHORISED_IMPORT_CHANGE');
});

test('missing tariff coverage and non-exact currency economics fail closed', () => {
  const before = observed(0.25177), after = observed(0.0299);
  after.tariff.currency = 'EUR'; assert.equal(transition(before, after, null).status, 'rejected');
  const missing = observed(0.0299); missing.tariff.seasons = {};
  assert.equal(transition(before, missing, null).status, 'rejected');
});

test('later recurring date cannot gain ownership from a single absolute selected interval', () => {
  const before = observed(0.25177), after = observed(0.0299);
  const r = derive({ before, after, previous: null, submittedAt: at('07:59'),
    domain: { start: '2027-09-23T07:00:00Z', end: '2027-09-23T11:00:00Z' },
    authorised: [{ start: at('08:00'), end: at('10:00'), price: price(0.0299) }] });
  assert.equal(r.status, 'rejected');
});

test('tampered payload/approval, insufficient readback and malformed receipt return safe rejection only', () => {
  for (const mutate of [r => { r.original.payloadJson = 'SECRET_SENTINEL'; },
    r => { r.original.approval.fingerprint = 'SECRET_SENTINEL'; },
    r => { r.execution.readback = null; },
    r => { r.execution.submittedAt = '2026-02-30T09:00:00Z'; }]) {
    const r = receipt(); mutate(r); seal(r); const result = finalise(r);
    assert.equal(result.status, 'rejected'); assert.equal(result.writeReady, false);
    assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
    assert.equal(result.evidence, undefined);
  }
});

test('elapsed ownership outside selected mutation remains unchanged even if current recurring tariff differs', () => {
  const historical = owned('06:00', '07:00');
  const r = transition(observed(0.25177), observed(0.0299), previous([historical]));
  assert.equal(r.status, 'derived', r.code);
  assert.equal(key(r.intervals[0]), key(historical));
  assert.equal(r.intervals.length, 2);
});

test('API acceptance requires a finite integer numeric HTTP 200–299, even with exact readback', () => {
  const base = receipt();
  for (const value of [undefined, null, NaN, '200', 200.5, 199, 300, Infinity, -Infinity]) {
    const r = structuredClone(base); r.execution.apiWrite.httpStatus = value; seal(r);
    assert.equal(finalise(r).code, 'MUTATION_NOT_CONFIRMED', String(value));
  }
  const missing = structuredClone(base); delete missing.execution.apiWrite.httpStatus; seal(missing);
  assert.equal(finalise(missing).code, 'MUTATION_NOT_CONFIRMED');
  for (const value of [200, 299]) {
    const r = structuredClone(base); r.execution.apiWrite.httpStatus = value; seal(r);
    assert.equal(finalise(r).status, 'derived');
  }
});

test('mutation identity requires a nonempty valid string with consistently rebound journal evidence', () => {
  const base = receipt();
  for (const value of [undefined, null, 123, '', 'invalid id!', 'x'.repeat(129)]) {
    const r = structuredClone(base); r.mutationId = value; seal(r);
    assert.equal(r.journal.originalKey, hash({ mutationId: value, original: r.original }));
    assert.equal(r.journal.classifiedKey, hash({ mutationId: value, execution: r.execution }));
    assert.equal(finalise(r).code, 'INVALID_CONFIRMATION_BINDING', String(value));
  }
  const missing = structuredClone(base); delete missing.mutationId; seal(missing);
  assert.equal(finalise(missing).code, 'INVALID_CONFIRMATION_BINDING');
});

test('multiple prior records overlapped by selected mutation preserve distinct restoration prices and fingerprints', () => {
  const a = owned('08:00', '09:00', 0.08, 0.24);
  const b = { ...owned('09:00', '10:00', 0.08, 0.26), restoreBaselineFingerprint: 'f'.repeat(64) };
  const r = transition(observed(0.08), observed(0.0299), previous([a, b]));
  assert.equal(r.status, 'derived', r.code); assert.equal(r.intervals.length, 2);
  for (const [i, old] of [a, b].entries()) {
    assert.equal(r.intervals[i].start, old.start); assert.equal(r.intervals[i].end, old.end);
    assert.equal(key(r.intervals[i].restore), key(old.restore));
    assert.equal(r.intervals[i].restoreBaselineFingerprint, old.restoreBaselineFingerprint);
  }
  // Prior records overlapping one another are ambiguous, not separate valid lineages.
  b.start = at('08:30');
  assert.equal(transition(observed(0.08), observed(0.0299), previous([a, b])).status, 'rejected');
});

test('structurally resegmented partial restoration retires only restored portion and retains original lineage', () => {
  const before = observed(0.08);
  const simulation = simulate(before, { date: '2026-09-23', fromMinute: 9 * 60, toMinute: 10 * 60,
    buy: 0.25177, currency: 'GBP', compareDates: [], preserveLabels: false });
  assert.equal(simulation.status, 'simulation-only');
  assert.notEqual(key(before.tariff.seasons), key(simulation.simulated.tariff.seasons));
  const old = owned('08:00', '10:00');
  const r = transition(before, simulation.simulated, previous([old]), at('08:00'), at('09:00'), 0.25177);
  assert.equal(r.status, 'derived', r.code); assert.equal(r.intervals.length, 1);
  assert.equal(key(r.intervals[0]), key({ ...old, start: at('09:00') }));
});

function endBoundaryReceipt({ submittedAt, readAt, completedAt, inheritedValidity = null }) {
  const r = receipt();
  const input = structuredClone(r.original.proposal.input);
  input.validFrom = '2026-09-23T09:59:50.000Z';
  input.observedSmart.generatedAt = input.validFrom;
  input.observedSmart.observation.source.observedAt = '2026-09-23T09:59:40.000Z';
  const proposal = load('src/lib/tesla-tariff/proposal-approval.ts').createTariffProposal(input);
  assert.equal(proposal.structurallyValid, true);
  r.original.proposal = proposal;
  r.original.payloadJson = key({ tou_settings: { tariff_content_v2: proposal.bound.representation } });
  r.original.approval = { fingerprint: proposal.fingerprint, approvedAt: '2026-09-23T09:59:51.000Z' };
  r.original.prior.capturedAt = '2026-09-23T09:59:45.000Z';
  if (inheritedValidity) {
    r.original.prior.generation = '11111111-1111-1111-1111-111111111111';
    r.original.prior.evidence = previous([owned('08:00', '10:00', 0.25177, 0.3)]);
    r.original.prior.evidence.validUntil = inheritedValidity;
  }
  r.execution.submittedAt = submittedAt; r.execution.completedAt = completedAt;
  r.execution.readback.source.observedAt = readAt;
  seal(r); r.journal.completedAt = completedAt;
  return r;
}

test('half-open submission/dispatch-end and completion/inherited-validity-end boundaries are exact', () => {
  const end = at('10:00');
  const beforeEnd = { submittedAt: '2026-09-23T09:59:59.997Z', readAt: '2026-09-23T09:59:59.998Z', completedAt: '2026-09-23T09:59:59.999Z' };
  assert.equal(finalise(endBoundaryReceipt({ ...beforeEnd, inheritedValidity: end })).status, 'derived');
  assert.equal(finalise(endBoundaryReceipt({ ...beforeEnd, readAt: end, completedAt: end })).status, 'derived');
  assert.equal(finalise(endBoundaryReceipt({ ...beforeEnd, readAt: end, completedAt: end, inheritedValidity: end })).code, 'INVALID_RESULTING_OWNERSHIP');
  assert.equal(finalise(endBoundaryReceipt({ submittedAt: end, readAt: '2026-09-23T10:00:00.001Z', completedAt: '2026-09-23T10:00:00.002Z' })).code, 'INVALID_CONFIRMATION_TIME');
  const r = transition(observed(0.25177), observed(0.0299), null, at('08:00'), end, 0.0299, end);
  assert.equal(r.status, 'derived'); assert.equal(r.intervals.length, 0);
});

test('spring-forward explicit-offset interval covers real instants without inventing the missing local hour', () => {
  const before = structuredClone(fixture.before); before.source.observedAt = '2026-03-28T23:50:00Z';
  const simulation = simulate(before, { date: '2026-03-29', fromMinute: 30, toMinute: 150, buy: 0.02,
    currency: 'GBP', compareDates: [], preserveLabels: false });
  assert.equal(simulation.status, 'simulation-only');
  const input = { before, after: simulation.simulated, previous: null, submittedAt: '2026-03-29T00:00:00Z',
    domain: { start: '2026-03-29T00:00:00Z', end: '2026-03-29T23:00:00Z' },
    authorised: [{ start: '2026-03-29T00:30:00+00:00', end: '2026-03-29T02:30:00+01:00', price: price(0.02) }] };
  const r = derive(input); assert.equal(r.status, 'derived', r.code); assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].start, '2026-03-29T00:30:00.000Z');
  assert.equal(r.intervals[0].end, '2026-03-29T01:30:00.000Z');
  assert.equal(Date.parse(r.intervals[0].end) - Date.parse(r.intervals[0].start), 3600000);
});

test('local coverage gap or ambiguous overlap adjacent to restoration boundary fails closed', () => {
  const before = observed(0.08);
  const after = simulate(before, { date: '2026-09-23', fromMinute: 9 * 60, toMinute: 10 * 60,
    buy: 0.25177, currency: 'GBP', compareDates: [], preserveLabels: false }).simulated;
  for (const toMinute of [59, 1]) {
    const broken = structuredClone(after);
    const season = Object.values(broken.tariff.seasons).find(s => s.fromMonth === 9 && s.fromDay === 23 && s.toMonth === 9 && s.toDay === 23);
    const periods = Object.values(season.tou_periods).flatMap(t => t.periods).filter(p => p.toHour === 10 && p.toMinute === 0);
    assert.ok(periods.length > 0);
    for (const p of periods) { p.toHour = toMinute === 59 ? 9 : 10; p.toMinute = toMinute; }
    const r = transition(before, broken, previous([owned('08:00', '10:00')]), at('08:00'), at('09:00'), 0.25177);
    assert.equal(r.status, 'rejected'); assert.equal(r.code, 'OWNERSHIP_DOMAIN_INCOMPLETE');
  }
});

test('caller mutations after finalisation cannot change detached evidence or bindings', () => {
  const r = receipt(), result = finalise(r); assert.equal(result.status, 'derived');
  const snapshot = key(result);
  r.execution.readback.tariff.energy_charges.Tomorrow.rates.hour_9_minute_0 = 123;
  r.original.proposal.input.observedSmart.dispatch.end = at('22:00');
  r.original.proposal.input.signal.import[0].price.amount = 456;
  r.original.approval.fingerprint = 'changed'; r.mutationId = 'changed';
  assert.equal(key(result), snapshot);
});

test('nested returned finalisation transition is deeply immutable', () => {
  const result = finalise(receipt()); assert.equal(result.status, 'derived'); const snapshot = key(result);
  function checkFrozen(value) {
    if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(checkFrozen); }
  }
  checkFrozen(result);
  for (const mutate of [() => { result.evidence.intervals[0].applied.amount = 9; },
    () => { result.evidence.intervals[0].restore.amount = 9; },
    () => { result.evidence.intervals[0].restoreBaselineFingerprint = 'changed'; },
    () => result.evidence.intervals.push({}), () => { result.evidence.validUntil = at('23:59'); },
    () => result.productionBlockers.splice(0)]) {
    assert.throws(mutate); assert.equal(key(result), snapshot);
  }
});
